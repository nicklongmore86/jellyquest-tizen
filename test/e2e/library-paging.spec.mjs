// Library offset paging (StartIndex/Limit) layered on PR #24's windowing.
//
// Before this, the screen asked for Limit 50 with no StartIndex: on the
// household's MEASURED server (680 Movies + 34 Series eligible) it reached 50
// items, about 7%, and no key press could reach the rest. These specs drive
// the real screen through its own API surface and assert what the remote can
// actually reach, what stays mounted while it does, and that a page landing
// asynchronously never moves the cursor.
//
// NOTHING here asserts that paging is stable. It cannot: the fixture serves a
// fixed list, and on the real server SortBy=SortName,Id returns HTTP 200 and
// is silently ignored, so there is no unique tie-breaker and no contract to
// test against. What is tested is the dedup FLOOR -- a repeated item is
// mounted once -- which cannot recover a skipped one.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { assertPainted } from './support/paint.mjs';
import { startServer } from './support/server.mjs';

const server = await startServer();
const simulatorUrl = `${server.baseUrl}/dev/simulator.html`;
test.after(() => server.close());

// Mirrors src/overlay/screens/library.js. A drift here should fail loudly
// rather than quietly weaken every bound below.
const WINDOW_SIZE = 36;
const COLUMNS = 6;
const PAGE_SIZE = 96;
const PREFETCH_REMAINING = 48;
const ITEM_COUNT = 680;
// Rows, not items. ITEM_COUNT is the household's MEASURED movie count and is
// deliberately not rounded to a multiple of COLUMNS, so the last row is
// naturally partial and every walk below has to be written in terms of rows.
const EDGE_ROWS = 2;
const rowsFor = (count) => Math.ceil(count / COLUMNS);
const ROWS = rowsFor(ITEM_COUNT);
// The first item of the last row of `count` items -- where a column-0 descent
// actually ends, which is not count - COLUMNS unless count divides evenly.
const lastRowStart = (count) => (rowsFor(count) - 1) * COLUMNS;
// One full page plus a short one, ending in a partial row. See its use below.
const SHORT_PAGE_TOTAL = 152;
// How many cards are mounted once the window has slid to the very end.
// moveWindow() clamps its start with Math.ceil(.../COLUMNS) * COLUMNS -- it
// must, or the final partial row would be unreachable -- so at a count that is
// not a multiple of COLUMNS the last window can be up to COLUMNS - 1 cards
// SHORT of WINDOW_SIZE. MEASURED: 32 at both 680 and 5,000 items with six
// columns and a 36-card window (44 at a 48-card one); it was exactly 48 at
// four columns, where 680 - 48 already divided evenly.
// This is a bound on mounted cards, so a short final window is safe by
// construction; only the exact figure moved.
const finalWindowSize = (count) => (count <= WINDOW_SIZE
    ? count
    : count - Math.ceil((count - WINDOW_SIZE) / COLUMNS) * COLUMNS);

async function signInAsAlice(page) {
    await page.goto(simulatorUrl);
    await page.waitForSelector('.jq-profile-card');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.jq-shell');
    await page.waitForSelector('.jq-media-card');
}

// Installs a paging server over the screen's own getItems and renders the
// Library. The real fixture still sees every request first, so the option
// shape the screen sends stays validated by the strict stub, not by this.
//
// options:
//   total       how many distinct items exist
//   itemType    'Movie' (220x410 poster) or 'Episode' (220x204 still)
//   overlap     items each page after the first re-serves from the previous
//               page, modelling a server that repeats across a boundary
//   omitTotal   drop TotalRecordCount, so exhaustion rests on a short page
//   holdFrom    StartIndex from which responses are held until released
//   failFrom    StartIndex from which responses reject
//   totalSays   report this TotalRecordCount instead of the real one, so a
//               response can CONTRADICT the count in either direction
//   contradict  a response shape that disagrees with the count, applied from
//               the second response on: 'duplicate' re-serves the first page,
//               'short' returns 20 items, 'empty' returns none, 'oneItem'
//               returns a single item. 'duplicateOnce'/'shortOnce' apply only
//               to the second response and then behave normally.
//   yieldPlan   response sizes cycled from the second response on, so a
//               server can oscillate between page sizes
//   growingTotal report a TotalRecordCount that is always ahead of what has
//               been served, so it can never be reached
//   firstPage   serve only this many items in the FIRST response, so the
//               screen arrives with a window that is not yet full. A
//               short-but-positive first page is a shape appendPage()
//               explicitly accepts and keeps paging from.
async function renderPaged(page, options) {
    const config = Object.assign({
        total: ITEM_COUNT, itemType: 'Movie', overlap: 0,
        omitTotal: false, holdFrom: null, failFrom: null,
        totalSays: null, contradict: null, yieldPlan: null, growingTotal: false,
        firstPage: null,
    }, options);
    await page.evaluate((config) => {
        const items = [];
        for (let i = 0; i < config.total; i++) {
            items.push({
                Id: 'page-' + i,
                Name: 'Paged item ' + i,
                Type: config.itemType,
                ImageTags: { Primary: 'page-tag' },
            });
        }
        window.__pageRequests = [];
        window.__held = [];
        window.__failNext = config.failFrom;
        const real = window.ApiClient.getItems;
        window.ApiClient.getItems = function (user, requested) {
            // Let the strict fixture reject an unmodelled option for real.
            real(user, requested);
            window.__pageRequests.push({ StartIndex: requested.StartIndex, Limit: requested.Limit });
            // CONVENTIONAL, not measured: an omitted StartIndex is treated
            // as zero. The server's OpenAPI document marks startIndex
            // optional with no specified default, and a probe of the live
            // server for it returned 401 -- so this is the usual convention
            // for an offset parameter, not an observed behaviour. It is here
            // only so that a screen sending no StartIndex fails each test
            // below on the behaviour that test checks, rather than failing
            // all of them at setup with an empty first page. Production never
            // depends on it: library.js always sends a numeric StartIndex.
            const start = requested.StartIndex || 0;
            // A repeated boundary: re-serve `overlap` items already returned.
            const from = start === 0 ? 0 : Math.max(0, start - config.overlap);
            let served = items.slice(from, from + requested.Limit);
            const nth = window.__pageRequests.length;
            const only = config.contradict === 'duplicateOnce' || config.contradict === 'shortOnce';
            if (nth > 1 && (!only || nth === 2)) {
                if (config.contradict === 'duplicate' || config.contradict === 'duplicateOnce') {
                    served = items.slice(0, requested.Limit);
                } else if (config.contradict === 'short' || config.contradict === 'shortOnce') {
                    served = items.slice(from, from + 20);
                } else if (config.contradict === 'empty') {
                    served = [];
                } else if (config.contradict === 'oneItem') {
                    served = items.slice(from, from + 1);
                }
            }
            if (config.firstPage !== null && nth === 1) {
                served = items.slice(0, config.firstPage);
            }
            if (config.yieldPlan && nth > 1) {
                served = items.slice(from, from + config.yieldPlan[(nth - 2) % config.yieldPlan.length]);
            }
            const body = { Items: served };
            if (config.growingTotal) {
                body.TotalRecordCount = from + served.length + 500;
            } else if (!config.omitTotal) {
                body.TotalRecordCount = config.totalSays === null ? items.length : config.totalSays;
            }
            if (window.__failNext !== null && start >= window.__failNext) {
                return Promise.reject(new Error('page fetch failed'));
            }
            if (config.holdFrom !== null && start >= config.holdFrom) {
                return new Promise((resolve) => window.__held.push(() => resolve(body)));
            }
            return Promise.resolve(body);
        };
        window.__maxLibraryCards = 0;
        window.__libraryCardObserver = new MutationObserver(() => {
            window.__maxLibraryCards = Math.max(
                window.__maxLibraryCards,
                document.querySelectorAll('.jq-library-grid .jq-media-card').length
            );
        });
        window.__libraryCardObserver.observe(document.getElementById('jellyquest-root'),
            { childList: true, subtree: true });
        window.JellyQuestLibraryScreen.render(
            window.JellyQuestShell.getContent(),
            { title: 'Paging test' },
            { onSelectItem() {}, onBack() {} }
        );
    }, config);
    if (config.failFrom !== 0) await page.waitForSelector('[data-item-id="page-0"]');
}

function focusSnapshot(page) {
    return page.evaluate(() => {
        const active = document.activeElement;
        return {
            id: active && active.getAttribute('data-item-id'),
            className: active ? active.className : '',
            body: active === document.body,
            attached: Boolean(active && document.body.contains(active)),
            painted: Boolean(active && active.getClientRects().length),
        };
    });
}

async function pressAndAssertFocus(page, key) {
    await page.keyboard.press(key);
    const focus = await focusSnapshot(page);
    assert.equal(focus.body, false, `${key} must not leave focus on body`);
    assert.equal(focus.attached, true, `${key} must not leave focus detached`);
    assert.equal(focus.painted, true, `${key} must not leave focus non-rendered`);
    return focus.id;
}

// The mounted-card bound from PR #24, re-asserted after every move: paging
// must not be able to raise it however many pages have been fetched.
async function assertWindow(page) {
    const state = await page.evaluate(() => ({
        ids: Array.from(document.querySelectorAll('.jq-library-grid .jq-media-card'),
            (card) => Number(card.dataset.itemId.slice('page-'.length))),
        max: window.__maxLibraryCards,
    }));
    assert.ok(state.ids.length <= WINDOW_SIZE,
        `mounted ${state.ids.length} cards, limit is ${WINDOW_SIZE}`);
    assert.ok(state.max <= WINDOW_SIZE,
        `observed ${state.max} simultaneously mounted cards, limit is ${WINDOW_SIZE}`);
    assert.equal(new Set(state.ids).size, state.ids.length,
        'the mounted window must not contain duplicates');
    for (let i = 1; i < state.ids.length; i++) {
        assert.equal(state.ids[i], state.ids[i - 1] + 1, 'the mounted window must stay in item order');
    }
    return state.ids;
}


// A page landing does NOT mount its cards: the window still holds at most
// WINDOW_SIZE, and the arriving items are rows below it. What does change is
// the grid's bottom padding, which stands in for the rows the window is not
// holding -- so it grows by exactly the items the page contributed. That is
// the observable signal that a page was appended.
function gridPaddingBottom(page) {
    return page.evaluate(() =>
        parseFloat(document.querySelector('.jq-library-grid').style.paddingBottom) || 0);
}

async function waitForAppendedPage(page, paddingBefore) {
    await page.waitForFunction((before) =>
        (parseFloat(document.querySelector('.jq-library-grid').style.paddingBottom) || 0) > before,
    paddingBefore, { timeout: 5000 });
}

// Movie is the real Library case (Movie,Series is the query's type filter).
// Episode is deliberately synthetic -- the Library query excludes episodes --
// and exercises the other media-card row pitch the app renders, because the
// polyfill's up-traversal rejects a candidate whose `top` is negative before
// it tests any visible portion, and how far one row's pitch scrolls the
// screen is what decides whether the return trip strands.
for (const [itemType, cardHeight] of [['Movie', 410], ['Episode', 204]]) {
    test(`Library pages through all ${ITEM_COUNT} ${itemType} items and walks back up at 220x${cardHeight}`, async () => {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
            page.setDefaultTimeout(5000);
        page.setDefaultTimeout(5000);
            await signInAsAlice(page);
            await renderPaged(page, { itemType });

            // Only the first page exists on arrival: the defect being fixed is
            // that this was the ONLY page there would ever be.
            assert.deepEqual(await page.evaluate(() => window.__pageRequests),
                [{ StartIndex: 0, Limit: PAGE_SIZE }]);

            // The card box, because a grid measured at some other height is
            // three copies of the same shallow test; and the scroll range,
            // because a grid that cannot scroll further than a row or two is
            // structurally incapable of stranding the return trip and would
            // pass against a build with the bug.
            const measure = () => page.evaluate((columns) => {
                const cards = document.querySelectorAll('.jq-library-grid .jq-media-card');
                const first = cards[0].getBoundingClientRect();
                const screen = document.querySelector('.jq-library-screen');
                return {
                    width: Math.round(first.width),
                    height: Math.round(first.height),
                    pitch: Math.round(cards[columns].getBoundingClientRect().top - first.top),
                    range: screen.scrollHeight - screen.clientHeight,
                };
            }, COLUMNS);

            const onArrival = await measure();
            assert.deepEqual({ width: onArrival.width, height: onArrival.height },
                { width: 220, height: cardHeight },
                `cards must actually render at 220x${cardHeight}`);
            // On arrival the grid is exactly one page deep -- 24 rows, of
            // which the viewport shows two or three -- so it already scrolls
            // further than the mounted window is tall. The depth this test is
            // really about is the depth PAGING produces, asserted again below
            // just before the return trip.
            assert.ok(onArrival.range > onArrival.pitch * (WINDOW_SIZE / COLUMNS),
                `one page must scroll further than the mounted window is tall: `
                + `${onArrival.range}px range against a ${onArrival.pitch}px row pitch`);
            assert.equal((await assertWindow(page)).length, WINDOW_SIZE);

            const rows = ROWS;
            for (let row = 0; row < rows; row++) {
                assert.equal((await focusSnapshot(page)).id, 'page-' + row * COLUMNS);
                await assertPainted(page.locator(':focus'));
                await assertWindow(page);
                if (row + 1 < rows) {
                    // Crossing a page boundary means the next row exists only
                    // once its page has landed. Waiting for it here is the
                    // reachability assertion: before paging, everything past
                    // item 49 never appeared and this would time out.
                    await page.waitForSelector(`[data-item-id="page-${(row + 1) * COLUMNS}"]`);
                    assert.equal(await pressAndAssertFocus(page, 'ArrowDown'),
                        'page-' + (row + 1) * COLUMNS);
                }
            }

            // Every page, in order, exactly once -- and the last one short.
            const expected = [];
            for (let start = 0; start < ITEM_COUNT; start += PAGE_SIZE) {
                expected.push({ StartIndex: start, Limit: PAGE_SIZE });
            }
            assert.deepEqual(await page.evaluate(() => window.__pageRequests), expected);

            // Up is the direction that strands: a candidate BEHIND the cursor
            // has its top-left corner as its far corner, and the polyfill
            // rejects a negative `top` outright. What decides whether it CAN
            // strand is the container's scroll range against one row's pitch,
            // so assert it here, where paging has made it as deep as it gets
            // and the return trip is about to run against it. A grid too
            // shallow to strand cannot fail this test however broken the
            // reveal margin is.
            const beforeReturn = await measure();
            assert.deepEqual({ width: beforeReturn.width, height: beforeReturn.height },
                { width: 220, height: cardHeight },
                `cards must still render at 220x${cardHeight} on appended pages`);
            assert.ok(beforeReturn.range > beforeReturn.pitch * 100,
                `paging must leave a grid deep enough to strand the return trip: `
                + `${beforeReturn.range}px range against a ${beforeReturn.pitch}px row pitch`);
            for (let row = rows - 1; row >= 0; row--) {
                assert.equal((await focusSnapshot(page)).id, 'page-' + row * COLUMNS);
                await assertPainted(page.locator(':focus'));
                await assertWindow(page);
                if (row > 0) {
                    assert.equal(await pressAndAssertFocus(page, 'ArrowUp'),
                        'page-' + (row - 1) * COLUMNS);
                }
            }
            assert.equal(await pressAndAssertFocus(page, 'ArrowUp'), null);
            assert.equal(await page.evaluate(
                () => document.activeElement.classList.contains('jq-back-button')), true,
                'ArrowUp must finish on "< Back" above the first row');
            await assertPainted(page.locator('.jq-back-button'));
            assert.equal(await page.evaluate(
                () => document.querySelector('.jq-library-screen').scrollTop), 0,
                'reaching the top must scroll the screen back to its beginning');

            // No page fetch may raise the mounted-card bound.
            assert.equal(await page.evaluate(() => window.__maxLibraryCards), WINDOW_SIZE);
        } finally {
            await browser.close();
        }
    });
}

test(`fetching all ${Math.ceil(ITEM_COUNT / PAGE_SIZE)} pages never mounts more than ${WINDOW_SIZE} cards`, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(5000);
        await signInAsAlice(page);
        await renderPaged(page, {});
        for (let row = 1; row < ROWS; row++) {
            await page.waitForSelector(`[data-item-id="page-${row * COLUMNS}"]`);
            await page.keyboard.press('ArrowDown');
        }
        const state = await page.evaluate(() => ({
            requests: window.__pageRequests.length,
            max: window.__maxLibraryCards,
            mounted: document.querySelectorAll('.jq-library-grid .jq-media-card').length,
            last: document.activeElement.dataset.itemId,
        }));
        assert.equal(state.requests, Math.ceil(ITEM_COUNT / PAGE_SIZE),
            'the whole library must be reached in ceil(total / PAGE_SIZE) requests');
        assert.equal(state.last, 'page-' + lastRowStart(ITEM_COUNT),
            'the last row must be reachable by remote');
        assert.equal(state.max, WINDOW_SIZE,
            `${Math.ceil(ITEM_COUNT / PAGE_SIZE)} pages of items must still mount at most ${WINDOW_SIZE} cards`);
        assert.equal(state.mounted, finalWindowSize(ITEM_COUNT),
            'the window resting on the last row holds what a row-aligned start leaves');
    } finally {
        await browser.close();
    }
});

// ---- Regression: a short first page must FILL, never SLIDE ---------------
//
// The window trigger's arithmetic is stated for a FULL window, where
// windowEnd = windowStart + WINDOW_SIZE. That is false while a short first
// page is still filling the window: windowEnd is then bounded by the item
// count, so `windowEnd - EDGE_ROWS * COLUMNS` is an absolute index near the
// START of the list, the slide fires far too early, and the cards it evicts
// can include the one the cursor is on.
//
// MEASURED before the fix, with COLUMNS = 6: a first response of 13 items with
// TotalRecordCount 300, the cursor moved to index 1, then 96 more items
// delivered. The test read 1 >= 13 - 12, fired, advanced the start to 6 and
// removed the focused node; focus landed on <body>. Asynchronous completion
// beating newer intent is this repo's recurring cursor-loss shape, so this is
// asserted on the DOM, not inferred: removeChild is instrumented and must
// never be handed the active element.
//
// FIRST_PAGE is deliberately in the window's trigger zone but not at its end,
// and INDEX is deliberately near the START of the list -- the two facts that
// together made the old arithmetic degenerate.
const FIRST_PAGE = 13;

test('a short first page fills the window instead of sliding it off the cursor', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(5000);
        await signInAsAlice(page);
        await page.evaluate(() => {
            window.__removedActive = 0;
            const removeChild = Node.prototype.removeChild;
            Node.prototype.removeChild = function (child) {
                if (child === document.activeElement) window.__removedActive++;
                return removeChild.call(this, child);
            };
        });
        await renderPaged(page, { total: 300, firstPage: FIRST_PAGE, holdFrom: FIRST_PAGE });

        // PRECONDITIONS. Without all three this test cannot detect the defect:
        // the window must really be short, more items must really be coming,
        // and the cursor must sit inside what the broken trigger would evict.
        assert.equal(await page.locator('.jq-library-grid .jq-media-card').count(), FIRST_PAGE,
            'the screen must arrive with a window shorter than WINDOW_SIZE');
        assert.ok(FIRST_PAGE < WINDOW_SIZE, 'the first page must not fill the window');
        await page.waitForFunction(() => window.__held.length === 1);

        assert.equal(await pressAndAssertFocus(page, 'ArrowRight'), 'page-1');
        const focusedIndex = 1;
        assert.ok(focusedIndex >= FIRST_PAGE - EDGE_ROWS * COLUMNS,
            'the cursor must be inside the zone the short-window trigger misreads');
        assert.ok(focusedIndex < COLUMNS,
            'the cursor must be inside the row a one-row slide would evict');

        const paddingBefore = await gridPaddingBottom(page);
        await page.evaluate(() => window.__held[0]());
        await waitForAppendedPage(page, paddingBefore);

        const focus = await focusSnapshot(page);
        assert.equal(focus.id, 'page-1', 'the arriving page must not move the cursor');
        assert.equal(focus.body, false, 'the arriving page must not drop focus onto <body>');
        assert.equal(focus.attached, true, 'focus must not be left on a detached node');
        assert.equal(focus.painted, true);
        assert.equal(await page.evaluate(() => window.__removedActive), 0,
            'no window update may remove the focused node');
        await assertPainted(page.locator(':focus'));

        // ...and the window must have FILLED, not stayed short: the whole
        // point of running the forward test on a landing page is that the rows
        // the page made available become reachable.
        const ids = await assertWindow(page);
        assert.equal(ids.length, WINDOW_SIZE, 'the arriving page must fill the window to its bound');
        assert.equal(ids[0], 0, 'filling must not move the window start');

        // Downward traversal must be usable straight afterwards, with no
        // lateral move needed to unstick it.
        for (let row = 1; row <= 3; row++) {
            assert.equal(await pressAndAssertFocus(page, 'ArrowDown'), 'page-' + (row * COLUMNS + 1));
        }
        assert.equal(await page.evaluate(() => window.__removedActive), 0);
    } finally {
        await browser.close();
    }
});

test('a page held until after the user selects the rail does not take the cursor', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(5000);
        await signInAsAlice(page);
        await renderPaged(page, { holdFrom: PAGE_SIZE });

        // Walk into the prefetch zone so the second page is actually in flight
        // while the user moves on. A held response, not an instant one: the
        // recurring bug in this repo is an async completion overriding newer
        // intent, and an instantly-resolved promise cannot express it.
        for (let row = 0; row * COLUMNS < PAGE_SIZE - PREFETCH_REMAINING + COLUMNS; row++) {
            await page.keyboard.press('ArrowDown');
        }
        await page.waitForFunction(() => window.__held.length === 1);

        assert.equal(await page.evaluate(() => window.__pageRequests.length), 2,
            'the second page must be in flight before the user moves on');

        await page.evaluate(() => document.querySelector('.jq-nav-search').focus());
        await assertPainted(page.locator('.jq-nav-search'));
        const paddingBefore = await gridPaddingBottom(page);
        await page.evaluate(() => window.__held[0]());
        await waitForAppendedPage(page, paddingBefore);

        const focus = await focusSnapshot(page);
        assert.ok(focus.className.includes('jq-nav-search'),
            `the arriving page must leave the newer rail selection alone, focus was ${focus.className}`);
        assert.equal(focus.body, false);
        assert.equal(focus.attached, true);
        assert.equal(focus.painted, true);
        await assertPainted(page.locator('.jq-nav-search'));
    } finally {
        await browser.close();
    }
});

test('a page held until after the user moves on lands on neither <body> nor a detached node', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(5000);
        await signInAsAlice(page);
        await renderPaged(page, { holdFrom: PAGE_SIZE });

        for (let row = 0; row * COLUMNS < PAGE_SIZE - PREFETCH_REMAINING + COLUMNS; row++) {
            await page.keyboard.press('ArrowDown');
        }
        await page.waitForFunction(() => window.__held.length === 1);

        // Keep moving while the page is in flight, so the card that held focus
        // when the request began is not the card holding it when it lands.
        const before = await pressAndAssertFocus(page, 'ArrowRight');
        const paddingBefore = await gridPaddingBottom(page);
        await page.evaluate(() => window.__held[0]());
        await waitForAppendedPage(page, paddingBefore);

        const focus = await focusSnapshot(page);
        assert.equal(focus.id, before, 'the arriving page must not move the cursor off the focused card');
        assert.equal(focus.body, false);
        assert.equal(focus.attached, true, 'focus must not be left on a detached node');
        assert.equal(focus.painted, true);
        await assertPainted(page.locator(':focus'));
        await assertWindow(page);
    } finally {
        await browser.close();
    }
});

test('a failed page is visible on screen, leaves focus alone, and clears when a retry succeeds', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(5000);
        await signInAsAlice(page);
        await renderPaged(page, { failFrom: PAGE_SIZE });

        for (let row = 0; row * COLUMNS < PAGE_SIZE - PREFETCH_REMAINING + COLUMNS; row++) {
            await page.keyboard.press('ArrowDown');
        }
        const message = page.getByText('More of your library couldn’t be loaded. Try again.', { exact: true });
        await message.waitFor({ state: 'visible', timeout: 2000 });
        // The TV has no console: the failure has to be on the screen, and on
        // the screen where the cursor actually is -- the grid carries its
        // off-screen rows as padding, so an in-flow message after it would sit
        // hundreds of rows below the viewport.
        await assertPainted(message);
        assert.equal(await message.evaluate((el) => getComputedStyle(el).color), 'rgb(255, 107, 107)');

        const focus = await focusSnapshot(page);
        assert.equal(focus.body, false, 'a failed page must not drop focus to body');
        assert.equal(focus.attached, true);
        assert.equal(focus.painted, true);
        assert.ok(focus.id.startsWith('page-'), 'a failed page must leave the cursor on its card');

        // A retry is user-initiated (the next focus move inside the trigger
        // zone) and rate-limited, so wait out the cooldown rather than
        // hammering, then prove the message clears on success.
        await page.evaluate(() => { window.__failNext = null; });
        const paddingBefore = await gridPaddingBottom(page);
        await page.waitForTimeout(2100);
        await page.keyboard.press('ArrowRight');
        await waitForAppendedPage(page, paddingBefore);
        assert.equal(await message.isVisible(), false, 'a successful retry must clear the message');
        await assertWindow(page);
    } finally {
        await browser.close();
    }
});

test('a page that repeats items from the previous one mounts each Id once', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(5000);
        await signInAsAlice(page);
        // 24 repeated items per boundary. This is the dedup FLOOR only: it
        // proves a REPEAT is dropped. It does not and cannot prove the server
        // never SKIPS an item across a boundary -- nothing recovers that, and
        // the ordering it would depend on is empirical, not contractual.
        await renderPaged(page, { total: 200, overlap: 24 });

        const seen = [(await focusSnapshot(page)).id];
        for (let row = 1; row < rowsFor(200); row++) {
            await page.waitForSelector(`[data-item-id="page-${row * COLUMNS}"]`);
            seen.push(await pressAndAssertFocus(page, 'ArrowDown'));
            await assertWindow(page);
        }
        assert.equal(new Set(seen).size, seen.length, 'no item may be visited twice');
        assert.deepEqual(seen, Array.from({ length: rowsFor(200) }, (_, row) => 'page-' + row * COLUMNS),
            'every distinct item must be reachable exactly once, in order');
    } finally {
        await browser.close();
    }
});

test('cards appended by a later page keep strictly positive spacing on both axes', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(5000);
        await signInAsAlice(page);
        await renderPaged(page, { total: 300 });

        // Walk far enough that the whole mounted window is cards created by a
        // page AFTER the first, so this measures appended geometry rather than
        // the initial render's.
        for (let row = 1; row <= 40; row++) {
            await page.waitForSelector(`[data-item-id="page-${row * COLUMNS}"]`);
            await page.keyboard.press('ArrowDown');
        }
        const ids = await assertWindow(page);
        assert.equal(ids.length, WINDOW_SIZE);
        assert.ok(ids[0] >= PAGE_SIZE,
            `the mounted window must consist of appended cards, starts at ${ids[0]}`);

        const rects = await page.locator('.jq-library-grid > *').evaluateAll((children) =>
            children.map((child) => {
                const { left, right, top, bottom, width, height } = child.getBoundingClientRect();
                return { left, right, top, bottom, width, height };
            }));
        assert.equal(rects.length, WINDOW_SIZE);
        for (const [i, rect] of rects.entries()) {
            assert.ok(rect.width > 0 && rect.height > 0, 'appended cards must have visible geometry');
            if (i % COLUMNS !== 0) {
                const separation = rect.left - rects[i - 1].right;
                assert.ok(separation > 0, `appended x separation ${separation}px must be positive`);
            }
            if (i >= COLUMNS) {
                const separation = rect.top - rects[i - COLUMNS].bottom;
                assert.ok(separation > 0, `appended y separation ${separation}px must be positive`);
            }
        }
    } finally {
        await browser.close();
    }
});

// PR #19 gives each card three artwork attempts, shared across window
// recreations. Paging appends items; the question this measures is whether it
// ALSO recreates them, which would spend the budget faster and blank an
// appended card permanently. It does not: a page append calls
// moveWindow(windowStart), whose removal loop is empty, so the recreation rate
// of an appended card is the windowing rate and no other. The number below is
// the measurement, not an assumption.
test('an appended card keeps the same three-attempt artwork budget across recreations', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(5000);
        let requests = 0;
        await page.route('**/paged-retry.webp', async (route) => {
            requests++;
            await route.fulfill({ status: 503, body: 'Temporary failure' });
        });
        await signInAsAlice(page);
        await page.evaluate(() => {
            const getImageUrl = window.ApiClient.getImageUrl;
            window.ApiClient.getImageUrl = function (id, options) {
                if (id === 'page-100') return '/paged-retry.webp';
                if (id.indexOf('page-') === 0) return null;
                return getImageUrl.call(this, id, options);
            };
        });
        await renderPaged(page, { total: 200 });

        // page-100 is in the SECOND page: it exists only because paging
        // fetched it, and its budget was opened after the initial render.
        const targetRow = Math.floor(100 / COLUMNS);
        for (let row = 1; row <= targetRow; row++) {
            await page.waitForSelector(`[data-item-id="page-${row * COLUMNS}"]`);
            await page.keyboard.press('ArrowDown');
        }
        await page.waitForFunction(() => document.querySelector('[data-item-id="page-100"]')
            .getAttribute('data-artwork-state') === 'error');
        assert.equal(requests, 1, 'the appended card gets its first attempt on first sight');

        for (let visit = 0; visit < 5; visit++) {
            for (let row = 0; row < 12; row++) await pressAndAssertFocus(page, 'ArrowDown');
            assert.equal(await page.locator('[data-item-id="page-100"]').count(), 0,
                'the appended card must actually leave the DOM');
            for (let row = 0; row < 12; row++) await pressAndAssertFocus(page, 'ArrowUp');
            await page.waitForSelector('[data-item-id="page-100"]');
            await page.waitForTimeout(50);
        }
        // MEASURED: 3. Ten recreations of an appended card cost three network
        // attempts in total, the same cap PR #19 set, so paging cannot exhaust
        // the budget faster than windowing already could.
        assert.equal(requests, 3,
            'an appended card must retain the per-render three-attempt budget');
        assert.equal(await page.locator('[data-item-id="page-100"]')
            .getAttribute('data-artwork-state'), 'error',
            'a spent budget leaves the card text-only rather than retrying forever');
    } finally {
        await browser.close();
    }
});

test('exhaustion rests on a short page when the server omits TotalRecordCount', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(5000);
        await signInAsAlice(page);
        // 152, not the 150 this used at four columns: the point of the count
        // is (a) one full page plus one short one and (b) a naturally partial
        // LAST ROW, and 150 is an exact multiple of six, which would have
        // quietly dropped (b). 152 = 96 + 56 keeps both.
        await renderPaged(page, { total: SHORT_PAGE_TOTAL, omitTotal: true });
        for (let row = 1; row < rowsFor(SHORT_PAGE_TOTAL); row++) {
            await page.waitForSelector(`[data-item-id="page-${row * COLUMNS}"]`);
            await page.keyboard.press('ArrowDown');
        }
        // PRECONDITION for what follows: the last row really is partial, so
        // the ArrowRight walk below measures a short row rather than a full
        // one that happens to end there.
        assert.ok(SHORT_PAGE_TOTAL % COLUMNS !== 0 && SHORT_PAGE_TOTAL > PAGE_SIZE,
            'the fixture must be one full page plus a short one ending in a partial row');
        // The naturally partial last row is reached, both of its cards
        // included -- SHORT_PAGE_TOTAL is not a multiple of COLUMNS.
        assert.equal((await focusSnapshot(page)).id, 'page-' + lastRowStart(SHORT_PAGE_TOTAL));
        assert.equal(await pressAndAssertFocus(page, 'ArrowRight'),
            'page-' + (SHORT_PAGE_TOTAL - 1));

        // SHORT_PAGE_TOTAL items is one full page and one short one. Without a
        // total, the short page is what says "stop" -- and nothing may request past it,
        // however many more times the cursor re-enters the prefetch zone.
        for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
        for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowDown');
        assert.deepEqual(await page.evaluate(() => window.__pageRequests), [
            { StartIndex: 0, Limit: PAGE_SIZE },
            { StartIndex: PAGE_SIZE, Limit: PAGE_SIZE },
        ]);
    } finally {
        await browser.close();
    }
});

// ---- Regression: a page landing while the cursor is AT the boundary ------
//
// This is the case the two held-response tests above do not reach. They
// release page 2 with the cursor on the rail or mid-page, where the window's
// upper bound still has room to grow. With the cursor on the LAST LOADED ROW
// the window is full, so appending items does not raise nextEnd -- the next
// row was never mounted, ArrowDown had no candidate, no focus event fired,
// and downward traversal was stuck until the user happened to press Left or
// Right. Mounting the row is also not sufficient on its own: the polyfill
// will not move to a candidate it cannot see, and the screen is scrolled to
// what was the end, so the reveal has to be re-run too.
test('a page landing while the cursor sits on the last loaded row unsticks ArrowDown', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(5000);
        await signInAsAlice(page);
        await renderPaged(page, { total: 300, holdFrom: PAGE_SIZE });

        // Walk to the last row of page 1: items 0..95, so row PAGE_SIZE / COLUMNS - 1.
        const lastLoadedRow = PAGE_SIZE / COLUMNS - 1;
        for (let row = 1; row <= lastLoadedRow; row++) await page.keyboard.press('ArrowDown');
        assert.equal((await focusSnapshot(page)).id, 'page-' + lastLoadedRow * COLUMNS);
        assert.equal(await page.evaluate(() => window.__held.length), 1,
            'page 2 must be in flight, held, with the cursor already at the boundary');
        assert.equal(await page.locator(`[data-item-id="page-${PAGE_SIZE}"]`).count(), 0);

        // Waiting at the boundary is the honest state while the page is in
        // flight: there is genuinely nothing below to move to.
        assert.equal(await pressAndAssertFocus(page, 'ArrowDown'), 'page-' + lastLoadedRow * COLUMNS);

        const paddingBefore = await gridPaddingBottom(page);
        await page.evaluate(() => window.__held[0]());
        await waitForAppendedPage(page, paddingBefore);

        // The landing page must not have moved the cursor...
        assert.equal((await focusSnapshot(page)).id, 'page-' + lastLoadedRow * COLUMNS,
            'the arriving page must not move the cursor');
        // ...and the very next ArrowDown must advance, with NO lateral move
        // needed to unstick it.
        assert.equal(await pressAndAssertFocus(page, 'ArrowDown'), 'page-' + PAGE_SIZE,
            'ArrowDown must advance into the newly paged row without a lateral move first');
        assert.equal(await pressAndAssertFocus(page, 'ArrowDown'), 'page-' + (PAGE_SIZE + COLUMNS));
        await assertWindow(page);
    } finally {
        await browser.close();
    }
});

// ---- Regression: responses that contradict TotalRecordCount -------------
//
// TotalRecordCount is a hint. An earlier revision stopped paging on ANY
// duplicate-only or short page, so a single contradictory response silently
// presented a partial library as the whole one. Only an EMPTY page genuinely
// blocks progress: every non-empty response advances the raw offset, so
// asking again is a new offset, not a repeat of the same one.
//
// `visited` is the full column-0 descent, so its length is the number of rows
// the remote can actually reach and its entries are in item order.
// A press that does not move the cursor is not proof the descent is over: a
// page can be in flight, and the row it will mount does not exist yet. At four
// columns a row needed four new items and the timing happened to work; at six
// it needs six, and breaking on the first stall silently cut the
// one-item-per-page descent short at 11 responses instead of the 17 the
// request ceiling actually allows. So settle before concluding: only STALL_LIMIT
// consecutive non-moves, each after a pause long enough for a landed page to
// have mounted its row, ends the walk.
const STALL_LIMIT = 3;
const STALL_SETTLE_MS = 120;

async function walkToEnd(page) {
    const visited = [(await focusSnapshot(page)).id];
    let stalls = 0;
    for (let step = 0; step < 800 && stalls < STALL_LIMIT; step++) {
        await page.keyboard.press('ArrowDown');
        const id = (await focusSnapshot(page)).id;
        if (id === visited[visited.length - 1]) {
            stalls++;
            await page.waitForTimeout(STALL_SETTLE_MS);
            continue;
        }
        stalls = 0;
        visited.push(id);
    }
    return visited;
}

for (const [label, options, expected] of [
    // The server re-serves page 1 as page 2, i.e. it SKIPS items 96..191.
    // Dedup mounts each Id once; it cannot recover the skipped range, and
    // this asserts exactly that -- browsing continues past the gap and the
    // gap stays a gap.
    // Stated as ITEMS reachable, not rows: how many rows those items occupy
    // is a function of COLUMNS, and writing the row count directly is what
    // made every case here need rewriting when the grid widened.
    ['a duplicate-only page', { total: 300, contradict: 'duplicateOnce' },
        // The server re-serves items 0..95 as page 2, so 96..191 are SKIPPED
        // and 204 of the 300 items are reachable. The gap falls at grid index
        // 96, i.e. the row boundary right after the first page.
        { requests: [0, 96, 192, 288], items: 204, boundary: [96, 'page-192'] }],
    // A short page while the count still says more remain.
    ['a short but positive page', { total: 300, contradict: 'shortOnce' },
        { requests: [0, 96, 116, 212], items: 300, boundary: [96, 'page-96'] }],
    // An understated count, overrun by the very first response.
    ['an understated TotalRecordCount', { total: 300, totalSays: 50 },
        { requests: [0, 96, 192, 288], items: 300 }],
    // An overstated count: the run past the real end returns empty and stops.
    ['an overstated TotalRecordCount', { total: 300, totalSays: 900 },
        { requests: [0, 96, 192, 288, 300], items: 300 }],
    // No count at all: the short page is the only end-signal there is.
    ['no TotalRecordCount at all', { total: 300, omitTotal: true },
        { requests: [0, 96, 192, 288], items: 300 }],
]) {
    test(`${label} must not silently truncate the library`, async () => {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
            page.setDefaultTimeout(5000);
            await signInAsAlice(page);
            await renderPaged(page, options);

            const visited = await walkToEnd(page);
            assert.deepEqual(await page.evaluate(() => window.__pageRequests.map((r) => r.StartIndex)),
                expected.requests, 'request offsets');
            assert.equal(visited.length, rowsFor(expected.items),
                `rows reachable by remote: ${visited.length}, from ${expected.items} items`);
            assert.equal(new Set(visited).size, visited.length, 'no row may be visited twice');
            if (expected.boundary) {
                // The boundary is stated as a GRID INDEX (a position in the
                // deduplicated item list), which is what the fixture actually
                // controls; the row it lands on follows from COLUMNS.
                const [gridIndex, after] = expected.boundary;
                assert.equal(gridIndex % COLUMNS, 0,
                    'the fixture boundary must fall on a row boundary to be walkable');
                const boundaryRow = gridIndex / COLUMNS;
                assert.equal(visited[boundaryRow - 1], 'page-' + (gridIndex - COLUMNS),
                    'the last row before the boundary');
                // What the server actually returned next -- NOT a recovery of
                // anything it skipped.
                assert.equal(visited[boundaryRow], after);
                // ...and browsing carries on past it rather than dead-ending
                // there, which is the truncation this whole table is about.
                assert.equal(visited[boundaryRow + 1],
                    'page-' + (Number(after.slice('page-'.length)) + COLUMNS),
                    'the descent must continue past the boundary row');
            }
            await assertWindow(page);
        } finally {
            await browser.close();
        }
    });
}

test('an empty page stops paging, because only an empty page cannot advance the offset', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(5000);
        await signInAsAlice(page);
        await renderPaged(page, { total: 300, contradict: 'empty' });
        const visited = await walkToEnd(page);
        assert.deepEqual(await page.evaluate(() => window.__pageRequests.map((r) => r.StartIndex)), [0, 96],
            'an empty response must not be re-requested at the same offset');
        assert.equal(visited.length, PAGE_SIZE / COLUMNS,
            'browsing stops at the first page, which is the honest limit of what arrived');
    } finally {
        await browser.close();
    }
});

test('a server that repeats every page stops after MAX_BARREN_PAGES', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(5000);
        await signInAsAlice(page);
        await renderPaged(page, { total: 300, contradict: 'duplicate' });
        await walkToEnd(page);
        // One good page, then three consecutive pages adding nothing new.
        assert.deepEqual(await page.evaluate(() => window.__pageRequests.map((r) => r.StartIndex)),
            [0, 96, 192, 288]);
    } finally {
        await browser.close();
    }
});

test('a server returning one item per page is bounded by the request ceiling', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(5000);
        await signInAsAlice(page);
        await renderPaged(page, { total: 300, contradict: 'oneItem' });

        // NOT walkToEnd(). Requests are strictly user-paced: one is issued
        // only from a focus MOVE inside the prefetch zone. A one-item response
        // adds a whole new ROW only every COLUMNS responses, so a purely
        // vertical descent parks on the last row, stops firing focus events,
        // and stops asking -- which at six columns ends the descent after 11
        // responses and would have quietly re-stated this ceiling as 11. That
        // is the "cursor stops at the last loaded row until the page lands"
        // state library.js documents, and the way out of it is exactly the
        // lateral move it names. So nudge, the way a viewer would, and keep
        // nudging until the SCREEN ITSELF stops issuing requests. That is what
        // makes the number below a bound rather than an artefact of how far
        // one particular walk happened to get.
        let requests = 0;
        for (let step = 0; step < 400; step++) {
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('ArrowRight');
            await page.keyboard.press('ArrowLeft');
            await page.waitForTimeout(10);
            const now = await page.evaluate(() => window.__pageRequests.length);
            if (now === requests && step > 40) break;
            requests = now;
        }
        // Each response advances the offset by one, so nothing loops -- but
        // nothing finishes either. MINIMUM_PAGE_REQUESTS (16) is the floor
        // that binds here: the ratio ceiling only exceeds it once enough
        // items have actually been fetched, which is precisely what this
        // server refuses to do.
        requests = await page.evaluate(() => window.__pageRequests.length);
        assert.equal(requests, 17, `bounded at ${requests} responses`);
    } finally {
        await browser.close();
    }
});

// ---- What the request bounds actually cover -----------------------------
//
// The ratio ceiling binds exactly when the average yield falls below
// PAGE_SIZE / MAX_REQUEST_RATIO = 24 new items per response, and never above
// it at any library size. A server yielding just OVER that line therefore
// slips past it, and if its TotalRecordCount also keeps growing, the
// short-page stop can never fire either. MEASURED before the count was
// latched: 163 responses, offsets out to 4041, after 1,000 ArrowDown presses.
//
// The count is now latched from the first response that supplies one, which
// bounds that shape by the server's own opening claim. These two tests are the
// pair: the pathological server must be bounded, and the legitimate large one
// must NOT be -- a guard that closed the first by truncating the second would
// be worse than the defect.
test('a server oscillating short pages behind a growing TotalRecordCount is bounded by the latched count', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(5000);
        await signInAsAlice(page);
        // Item supply far larger than the bound, so a regression shows up as a
        // rising request count rather than as the fixture simply running out.
        await renderPaged(page, { total: 8000, yieldPlan: [24, 25], growingTotal: true });

        const visited = await walkToEnd(page);
        const requests = await page.evaluate(() => window.__pageRequests.length);
        // MEASURED: 22 with the latch, 163 without it under the same probe.
        assert.equal(requests, 22, `bounded at ${requests} responses`);
        assert.equal(new Set(visited).size, visited.length, 'no row may be visited twice');

        // The harm this shape does is traffic, not a broken screen: it must
        // still be usable, still bounded at WINDOW_SIZE, still focus-safe.
        const focus = await focusSnapshot(page);
        assert.equal(focus.body, false);
        assert.equal(focus.attached, true);
        assert.equal(focus.painted, true);
        await assertWindow(page);
    } finally {
        await browser.close();
    }
});

test('a legitimate 5,000-item server returning full pages is not truncated by any guard', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(5000);
        await signInAsAlice(page);
        await renderPaged(page, { total: 5000 });

        // 5,000 items in COLUMNS columns is rowsFor(5000) rows. Pressing
        // without reading focus back each time keeps this to ~2s; the
        // assertions below would fail loudly if any press had been dropped or
        // any page had lagged.
        const rows = rowsFor(5000);
        for (let row = 1; row < rows; row++) await page.keyboard.press('ArrowDown');

        const state = await page.evaluate(() => ({
            focus: document.activeElement.dataset.itemId,
            requests: window.__pageRequests.length,
            mounted: document.querySelectorAll('.jq-library-grid .jq-media-card').length,
            max: window.__maxLibraryCards,
        }));
        assert.equal(state.focus, 'page-' + lastRowStart(5000),
            `every one of the ${rows} rows must be reachable by remote`);
        // 53 responses is well past MINIMUM_PAGE_REQUESTS (16), so this also
        // demonstrates that the floor under the ratio ceiling does not bind on
        // a library that legitimately needs more requests than it.
        assert.equal(state.requests, Math.ceil(5000 / PAGE_SIZE),
            `a full-page server must need exactly ceil(5000 / PAGE_SIZE) responses, took ${state.requests}`);
        assert.equal(state.mounted, finalWindowSize(5000),
            'the window resting on the last row holds what a row-aligned start leaves');
        assert.equal(state.max, WINDOW_SIZE, 'the mounted bound must hold across 53 pages');
    } finally {
        await browser.close();
    }
});
