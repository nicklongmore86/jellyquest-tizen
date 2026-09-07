// Walking a row or grid to its END with the remote.
//
// Every other spec reaches the far side of a row programmatically --
// `document.querySelector('.jq-see-all').click()` in home.spec.mjs and
// library-search.spec.mjs -- which is exactly why none of them noticed that
// the far side was unreachable by remote. A Recently Added row of 8 cards
// plus "See All" is 1972px of content in a 1568px scrollport, nothing
// scrolled it, and the spatial-navigation polyfill will not move focus to an
// element it cannot see: focus dead-ended on the last card with any pixels
// on screen and the rest of the row was permanently unreachable on the TV.
//
// So these tests navigate with ArrowLeft/Right/Up/Down and Enter only. No
// .click() on anything they are trying to reach, and no page.evaluate() that
// moves focus -- otherwise they would pass against the broken build too.
//
// Both directions matter, and the reverse one is the harder half. The
// polyfill's hitTest() rejects a candidate on its TOP-LEFT CORNER
// (`elementRect.top < 0 || elementRect.left < 0`) before it examines any
// visible portion, so a row above the scrollport that is half revealed is
// discarded outright and Up dead-ends -- which a grid only a couple of
// screens tall never shows, because the return trip reaches the top before
// the margin can strand anything.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { startServer } from './support/server.mjs';

const server = await startServer();
const simulatorUrl = `${server.baseUrl}/dev/simulator.html`;
test.after(() => server.close());

// A press budget generous enough for any fixture-sized row but small enough
// that a navigation loop fails the test instead of hanging it.
const MAX_PRESSES = 40;

async function signInAsAlice(page) {
    await page.goto(simulatorUrl);
    await page.waitForSelector('.jq-profile-card');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.jq-shell');
    await page.waitForSelector('.jq-media-card');
}

// A stable identity for whatever currently has focus, plus the geometry
// needed to check it is really on screen rather than merely focused.
function focusState(page) {
    return page.evaluate(() => {
        const active = document.activeElement;
        const rect = active.getBoundingClientRect();
        return {
            id: active.getAttribute('data-item-id') || active.className.split(' ').pop(),
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
        };
    });
}

// Presses `key` until focus stops moving, returning every element it landed
// on in order. Asserts as it goes that focus is never parked on something
// clipped off the screen -- a cursor the viewer cannot see is the same
// failure as a cursor that cannot move.
async function walk(page, key, viewport) {
    const visited = [];
    let previous = await focusState(page);
    visited.push(previous.id);
    for (let press = 0; press < MAX_PRESSES; press++) {
        await page.keyboard.press(key);
        const current = await focusState(page);
        assert.ok(
            current.left >= 0 && current.right <= viewport.width
            && current.top >= 0 && current.bottom <= viewport.height,
            `${key} put focus on ${current.id} at `
            + `${current.left},${current.top}-${current.right},${current.bottom}, `
            + `outside the ${viewport.width}x${viewport.height} screen`
        );
        if (current.id === previous.id) return visited;
        visited.push(current.id);
        previous = current;
    }
    throw new Error(`focus never settled after ${MAX_PRESSES} ${key} presses: ${visited.join(' -> ')}`);
}

// The ids of a container's children, in DOM order, using the same identity
// walk() reports -- so "the last card" is read off the real row rather than
// hard-coded against the fixture's current size.
function childIds(page, selector) {
    return page.evaluate((sel) => Array.from(document.querySelector(sel).children)
        .map((child) => child.getAttribute('data-item-id') || child.className.split(' ').pop()), selector);
}

// Both preconditions the tall-grid tests rest on, measured off the rendered
// page rather than taken on trust from what was requested.
//
// The card box, because a stylesheet override that quietly loses to
// cards.css turns these into three copies of the 130px test that pass while
// proving nothing about the geometry in their own names. And the scroll
// range against one row's pitch, because a grid that cannot scroll further
// than a single row cannot strand the return trip no matter how the reveal
// margin is computed -- it would pass against a build with the bug.
async function assertMeasuredGeometry(page, cardHeight) {
    const measured = await page.evaluate(() => {
        const cards = document.querySelectorAll('.jq-library-grid .jq-media-card');
        const first = cards[0].getBoundingClientRect();
        const screen = document.querySelector('.jq-library-screen');
        return {
            width: Math.round(first.width),
            height: Math.round(first.height),
            // Row pitch straight off the layout: the top-to-top distance
            // between the first card and the one directly below it.
            pitch: Math.round(cards[4].getBoundingClientRect().top - first.top),
            range: screen.scrollHeight - screen.clientHeight,
        };
    });
    assert.deepEqual({ width: measured.width, height: measured.height },
        { width: 220, height: cardHeight },
        `cards must actually render at 220x${cardHeight}, not whatever cards.css says`);
    assert.ok(measured.range > measured.pitch * 4,
        `the grid must scroll far enough to strand a return trip: `
        + `${measured.range}px of range against a ${measured.pitch}px row pitch`);
}

// Leaves the content area for the persistent rail and opens one of its
// destinations, remote-only: Left into the rail, Up to its top, Down to the
// item, Enter. The existing specs click the rail button instead; this route
// is the one a viewer actually has.
async function openViaRail(page, railClass) {
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.activeElement.classList.contains('jq-rail-item'));
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowUp');
    for (let i = 0; i < 4; i++) {
        if (await page.evaluate((cls) => document.activeElement.classList.contains(cls), railClass)) break;
        await page.keyboard.press('ArrowDown');
    }
    assert.equal(await page.evaluate((cls) => document.activeElement.classList.contains(cls), railClass), true,
        `never reached .${railClass} walking the rail`);
    await page.keyboard.press('Enter');
}

test('Home: ArrowRight reaches the last card and the "See All" button of a row wider than the screen', async () => {
    const browser = await chromium.launch();
    const viewport = { width: 1920, height: 1080 };
    try {
        const page = await browser.newPage({ viewport });
        await signInAsAlice(page);

        // The row has to actually overflow, or this test proves nothing.
        const overflow = await page.evaluate(() => {
            const row = document.querySelectorAll('.jq-home-row')[1];
            return { scrollWidth: row.scrollWidth, clientWidth: row.clientWidth, scrollLeft: row.scrollLeft };
        });
        assert.ok(overflow.scrollWidth > overflow.clientWidth,
            `Recently Added must overflow to exercise this: ${overflow.scrollWidth} <= ${overflow.clientWidth}`);
        assert.equal(overflow.scrollLeft, 0, 'a freshly rendered row starts at its beginning');

        await page.keyboard.press('ArrowDown'); // Continue Watching -> Recently Added
        const row = await childIds(page, '.jq-home-row-section:last-of-type .jq-home-row');
        assert.equal(row[row.length - 1], 'jq-see-all', 'fixture: See All is the last thing in the row');

        const visited = await walk(page, 'ArrowRight', viewport);
        assert.deepEqual(visited, row, 'ArrowRight must visit every item in the row, in order');
        assert.equal(await page.evaluate(() => document.activeElement.classList.contains('jq-see-all')), true,
            'the walk must finish on See All');

        // The last real card, not just the button, has to be reachable too.
        assert.ok(visited.includes(row[row.length - 2]), 'the last media card must be reachable');

        // And the row must be walkable back, not a one-way trip. The walk
        // runs past the first card into the rail -- Left out of a row is
        // how every screen reaches the rail -- so check it passed through
        // every card rather than where it stopped.
        const back = await walk(page, 'ArrowLeft', viewport);
        assert.deepEqual(back.slice(0, row.length), row.slice().reverse(),
            'ArrowLeft must visit every item back to the first card, in order');
        assert.equal(await page.evaluate(() => document.querySelectorAll('.jq-home-row')[1].scrollLeft), 0,
            'returning to the first card must scroll the row back to its beginning');
    } finally {
        await browser.close();
    }
});

test('Home: Enter on the keyboard-reached "See All" opens the Library grid', async () => {
    const browser = await chromium.launch();
    const viewport = { width: 1920, height: 1080 };
    try {
        const page = await browser.newPage({ viewport });
        await signInAsAlice(page);
        await page.keyboard.press('ArrowDown');
        await walk(page, 'ArrowRight', viewport);

        await page.keyboard.press('Enter');
        await page.waitForSelector('.jq-library-grid .jq-media-card');
        assert.equal(await page.evaluate(() => document.querySelector('.jq-library-heading').textContent),
            'Recently Added');
    } finally {
        await browser.close();
    }
});

test('Search: ArrowRight reaches the last result of a results row wider than the screen', async () => {
    const browser = await chromium.launch();
    const viewport = { width: 1920, height: 1080 };
    try {
        const page = await browser.newPage({ viewport });
        await signInAsAlice(page);
        await openViaRail(page, 'jq-nav-search');
        await page.waitForSelector('.jq-search-input');

        // The input is autofocused, so this is the on-screen keyboard's path.
        await page.keyboard.type('Northern Stories 1'); // series-1 and series-10 through series-19
        await page.waitForSelector('.jq-search-results .jq-media-card');
        // Wait for the whole result set, not just the first card: the row
        // has to be longer than the screen for this to test anything, and
        // the assertion below compares against every result.
        await page.waitForFunction(
            () => document.querySelectorAll('.jq-search-results .jq-media-card').length === 11,
            null, { timeout: 2000 });

        const row = await childIds(page, '.jq-search-results');
        const lastCardRight = await page.evaluate(() =>
            document.querySelector('.jq-search-results').lastElementChild.getBoundingClientRect().right);
        assert.ok(lastCardRight > 1920,
            `the results row must run past the screen to exercise this: last card ends at ${lastCardRight}`);
        await page.keyboard.press('ArrowDown'); // input -> first result
        const visited = await walk(page, 'ArrowRight', viewport);
        assert.deepEqual(visited, row, 'ArrowRight must visit every search result, in order');
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-item-id')),
            row[row.length - 1], 'the walk must finish on the last result');
    } finally {
        await browser.close();
    }
});

test('Library: ArrowDown reaches the bottom row of a grid taller than the screen', async () => {
    const browser = await chromium.launch();
    const viewport = { width: 1920, height: 1080 };
    try {
        const page = await browser.newPage({ viewport });
        await signInAsAlice(page);

        // Inject a known geometry through the screen's own API request.
        // Navigation below still uses only the remote; the production grid
        // now also exceeds a screen (covered in library-search.spec.mjs).
        await page.evaluate(() => {
            const items = [];
            for (let i = 1; i <= 28; i++) items.push({ Id: 'grid-' + i, Name: 'Item ' + i, Type: 'Movie' });
            const getItems = window.ApiClient.getItems;
            window.ApiClient.getItems = (user, options) => getItems(user, options).then(() => ({ Items: items.slice(0, options.Limit) }));
            window.JellyQuestLibraryScreen.render(
                window.JellyQuestShell.getContent(),
                { title: 'Everything' },
                { onSelectItem() {}, onBack() {} }
            );
        });
        await page.waitForSelector('.jq-library-grid .jq-media-card');

        const overflow = await page.evaluate(() => {
            const screen = document.querySelector('.jq-library-screen');
            return { scrollHeight: screen.scrollHeight, clientHeight: screen.clientHeight };
        });
        assert.ok(overflow.scrollHeight > overflow.clientHeight,
            `the grid must overflow vertically: ${overflow.scrollHeight} <= ${overflow.clientHeight}`);

        const visited = await walk(page, 'ArrowDown', viewport);
        // 28 cards in 4 columns is 7 rows; ArrowDown from the autofocused
        // first card must reach the first card of every one of them.
        assert.deepEqual(visited, ['grid-1', 'grid-5', 'grid-9', 'grid-13', 'grid-17', 'grid-21', 'grid-25']);

        // Back up the same way. The walk runs one step past the top row
        // onto "< Back", which is how the grid reaches it, and landing
        // there must have scrolled the screen fully home.
        const back = await walk(page, 'ArrowUp', viewport);
        assert.deepEqual(back, ['grid-25', 'grid-21', 'grid-17', 'grid-13', 'grid-9', 'grid-5', 'grid-1', 'jq-focusable']);
        assert.equal(await page.evaluate(() => document.activeElement.classList.contains('jq-back-button')), true);
        assert.equal(await page.evaluate(() => document.querySelector('.jq-library-screen').scrollTop), 0,
            'reaching the top of the grid must scroll the screen back to its beginning');
    } finally {
        await browser.close();
    }
});

// The reverse trip over a grid deep enough to strand it. Down was never the
// hard direction: it settles the cursor near the bottom of the scrollport,
// which leaves the row above fully revealed for free. Up is the one that
// strands, and what decides whether it can is the container's SCROLL RANGE
// against one row's pitch -- not its row count. A 7-row grid of 130px cards
// has 143px of range, less than the 150px pitch, so the return trip has
// nothing to strand on and it looks fine however broken the margin is; the
// same 7 rows at 330px have 1543px of range and stranded on card 17. These
// use 15 rows so traversal crosses the 12-row DOM window in both directions,
// and assert the measured scroll range.
//
// Card heights cover today's 130px .jq-media-card and the 330px poster and
// 124px still that card artwork introduces. Overriding that height is
// fiddlier than it looks and got it wrong once: the simulator loads
// jellyquest.css from a <link> in <body>, AFTER anything addStyleTag() puts
// in <head>, so an equal-specificity rule loses on document order and
// silently does nothing -- these cases ran at 130px and reported a clean
// pass. Hence both a more specific selector, which cannot lose on order,
// and assertMeasuredGeometry() below, which fails the test if the box it
// depends on is not the box it asked for.
for (const cardHeight of [130, 330, 124]) {
    test(`Library: ArrowUp walks a windowed 15-row grid of 220x${cardHeight} cards back to the top`, async () => {
        const browser = await chromium.launch();
        const viewport = { width: 1920, height: 1080 };
        try {
            const page = await browser.newPage({ viewport });
            await signInAsAlice(page);
            // Two selectors deep, so it beats cards.css wherever that lands
            // in document order. Reset the poster padding as well as its height;
            // otherwise the 346px artwork reservation sets the card's minimum
            // rendered size and none of these requested geometries takes effect.
            // Applied at every height, including the real 130px, so the override
            // path itself is always exercised.
            await page.addStyleTag({
                content: `.jq-library-grid .jq-media-card { height: ${cardHeight}px; padding-top: 16px; }`,
            });
            // Setup only; every move below is a key press. The fixture
            // validates the query. Returning more than its Limit deliberately
            // models an already-in-memory result large enough to move the
            // rendering window; pagination remains outside this test.
            await page.evaluate(() => {
                const items = [];
                for (let i = 1; i <= 60; i++) items.push({ Id: 'grid-' + i, Name: 'Item ' + i, Type: 'Movie' });
                const getItems = window.ApiClient.getItems;
                window.ApiClient.getItems = (user, options) => getItems(user, options).then(() => ({ Items: items }));
                window.JellyQuestLibraryScreen.render(
                    window.JellyQuestShell.getContent(),
                    { title: 'Everything' },
                    { onSelectItem() {}, onBack() {} }
                );
            });
            await page.waitForSelector('.jq-library-grid .jq-media-card');

            await assertMeasuredGeometry(page, cardHeight);

            // 60 cards in 4 columns is 15 rows; Down must cross the window
            // boundary and reach every one.
            const down = await walk(page, 'ArrowDown', viewport);
            assert.equal(down.length, 15, `ArrowDown must reach all 15 rows, got ${down.join(' -> ')}`);
            assert.equal(down[down.length - 1], 'grid-57');

            // ...and Up must bring the cursor all the way back, one row per
            // press, ending on "< Back" above the grid with the screen
            // scrolled home. Before the leading margin was sized to reveal a
            // whole neighbouring row, this stranded at grid-73 with the row
            // above spanning y = -86 to y = 44.
            const up = await walk(page, 'ArrowUp', viewport);
            assert.deepEqual(up.slice(0, 15), down.slice().reverse(),
                'ArrowUp must retrace every row it came down through');
            assert.equal(await page.evaluate(() => document.activeElement.classList.contains('jq-back-button')), true,
                'ArrowUp must finish on "< Back" above the first row');
            assert.equal(await page.evaluate(() => document.querySelector('.jq-library-screen').scrollTop), 0,
                'reaching the top of the grid must scroll the screen back to its beginning');
        } finally {
            await browser.close();
        }
    });
}

// The overlay must never scroll the page underneath it. jellyfin-web stays
// mounted below #jellyquest-root on a real TV -- its router, its view tree
// and dialogHelper, which blurs and restores focus on its own -- and this
// listener is document-wide by necessity. The simulator loads no
// jellyfin-web, so it cannot reproduce the real hazard; this stands in for
// it with a scroll container of the same shape outside the overlay root.
test('focus outside #jellyquest-root never scrolls the host page', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInAsAlice(page);

        const scrolled = await page.evaluate(() => {
            const host = document.createElement('div');
            host.id = 'host-scroller';
            host.style.cssText = 'position:fixed;top:0;left:0;width:400px;height:300px;overflow:hidden;z-index:0';
            const tall = document.createElement('div');
            tall.style.cssText = 'height:3000px;position:relative';
            const button = document.createElement('button');
            button.id = 'host-button';
            button.style.cssText = 'position:absolute;top:1200px;left:0;width:200px;height:60px';
            tall.appendChild(button);
            host.appendChild(tall);
            document.body.appendChild(host);
            // preventScroll so the browser's own focus scrolling cannot be
            // mistaken for -- or mask -- the overlay's handler.
            button.focus({ preventScroll: true });
            return {
                hostScrollTop: host.scrollTop,
                bodyScrollTop: document.body.scrollTop,
                documentScrollTop: document.documentElement.scrollTop,
                focused: document.activeElement.id,
                overflows: host.scrollHeight > host.clientHeight,
                insideOverlay: document.getElementById('jellyquest-root').contains(button),
            };
        });

        assert.equal(scrolled.insideOverlay, false, 'the fixture must sit outside the overlay root');
        assert.equal(scrolled.overflows, true, 'the fixture must be scrollable, or it proves nothing');
        assert.equal(scrolled.focused, 'host-button', 'the fixture must actually have taken focus');
        assert.equal(scrolled.hostScrollTop, 0, 'the overlay must not scroll a host container it does not own');
        assert.equal(scrolled.bodyScrollTop, 0);
        assert.equal(scrolled.documentScrollTop, 0);
    } finally {
        await browser.close();
    }
});
