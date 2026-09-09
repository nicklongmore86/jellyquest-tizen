// Library grid and Search screens (see docs/rebuild-plan.md, Phase 3).
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { startServer } from './support/server.mjs';

const server = await startServer();
const simulatorUrl = `${server.baseUrl}/dev/simulator.html`;
test.after(() => server.close());

// Mirrors src/overlay/screens/library.js. MEASURED against
// dev/fixtures/api-client-stub.js, the Recently Added "See All" response is 54
// Movie+Series items -- an exact multiple of six, so the production fixture
// alone no longer exercises a partial last row and the second test below
// stubs one deliberately.
const COLUMNS = 6;
const WINDOW_SIZE = 48;
const LIBRARY_ITEMS = 54;

async function signInAsAlice(page) {
    await page.goto(simulatorUrl);
    await page.waitForSelector('.jq-profile-card');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.jq-shell');
    await page.waitForSelector('.jq-media-card');
}

test('library grid: the production fixture navigates across the whole windowed grid', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInAsAlice(page);
        await page.evaluate(() => document.querySelector('.jq-see-all').click());
        await page.waitForSelector('.jq-library-grid .jq-media-card');

        // The first 48-item window is WINDOW_SIZE / COLUMNS full rows; the
        // final shift exposes the rest of the response without mounting all
        // LIBRARY_ITEMS at once.
        assert.equal(await page.locator('.jq-library-grid .jq-media-card').count(), WINDOW_SIZE);
        assert.equal(
            await page.locator('.jq-library-grid').evaluate((grid) => getComputedStyle(grid).gridTemplateColumns),
            Array(COLUMNS).fill('220px').join(' '),
            'the row arithmetic below is only meaningful against COLUMNS rendered tracks');
        assert.ok(LIBRARY_ITEMS > WINDOW_SIZE, 'the fixture must be deeper than one window to shift it');
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-item-id')), 'movie-10');
        await page.keyboard.press('ArrowDown');
        const secondRowFirst = await page.evaluate(() => document.activeElement.getAttribute('data-item-id'));
        assert.notEqual(secondRowFirst, 'movie-10');
        await page.keyboard.press('ArrowUp');
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-item-id')), 'movie-10');
        const ids = await page.evaluate(() => window.ApiClient.getItems(window.ApiClient.getCurrentUserId(), {
            Recursive: true, IncludeItemTypes: 'Movie,Series',
            SortBy: 'DateCreated', SortOrder: 'Descending', Limit: 50,
        }).then(result => result.Items.map(item => item.Id)));
        // The first item of the last row; presses past it are no-ops.
        const lastRowStart = (Math.ceil(LIBRARY_ITEMS / COLUMNS) - 1) * COLUMNS;
        for (let row = 0; row < Math.ceil(LIBRARY_ITEMS / COLUMNS); row++) await page.keyboard.press('ArrowDown');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.itemId), ids[lastRowStart]);
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.itemId), ids[lastRowStart + 1]);
        // Up lands in the same column of the row above.
        await page.keyboard.press('ArrowUp');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.itemId),
            ids[lastRowStart + 1 - COLUMNS]);
    } finally {
        await browser.close();
    }
});

// The .jq-grid precondition is that every row is full except, naturally, the
// last. The production fixture happens to be an exact multiple of six, so it
// cannot exercise that on its own any more; this stubs a count that can.
// PARTIAL_ITEMS % COLUMNS is asserted below rather than assumed, so a future
// COLUMNS change makes this test fail loudly instead of quietly becoming a
// second copy of the one above.
// 58 = 9 full rows of six plus a short row of four. Deliberately not a row of
// ONE: a single-card last row has no in-row neighbour at all, and the
// polyfill's next-best candidate for ArrowRight there is a card on a
// different row -- a degenerate shape that says nothing about partial rows.
const PARTIAL_ITEMS = 58;

test('library grid: a naturally partial last row is fully reachable in both directions', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInAsAlice(page);
        await page.evaluate((count) => {
            const items = [];
            for (let i = 0; i < count; i++) {
                items.push({ Id: 'partial-' + i, Name: 'Partial ' + i, Type: 'Movie' });
            }
            const getItems = window.ApiClient.getItems;
            window.ApiClient.getItems = (user, options) => getItems(user, options).then(() => ({
                Items: items, TotalRecordCount: items.length,
            }));
            window.JellyQuestLibraryScreen.render(
                window.JellyQuestShell.getContent(),
                { title: 'Partial row' },
                { onSelectItem() {}, onBack() {} }
            );
        }, PARTIAL_ITEMS);
        await page.waitForSelector('[data-item-id="partial-0"]');

        const shortRow = PARTIAL_ITEMS % COLUMNS;
        assert.notEqual(shortRow, 0, 'the fixture must not divide evenly, or this tests nothing');
        assert.equal(
            await page.locator('.jq-library-grid').evaluate((grid) => getComputedStyle(grid).gridTemplateColumns),
            Array(COLUMNS).fill('220px').join(' '),
            'the grid must render exactly COLUMNS 220px tracks');

        const rows = Math.ceil(PARTIAL_ITEMS / COLUMNS);
        const lastRowStart = (rows - 1) * COLUMNS;
        for (let row = 1; row < rows; row++) await page.keyboard.press('ArrowDown');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.itemId), 'partial-' + lastRowStart);

        // Every card of the short row, and no phantom past its end.
        for (let column = 1; column < shortRow; column++) {
            await page.keyboard.press('ArrowRight');
            assert.equal(await page.evaluate(() => document.activeElement.dataset.itemId),
                'partial-' + (lastRowStart + column));
        }
        assert.ok(shortRow > 1, 'the short row must have an in-row neighbour to walk');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.itemId),
            'partial-' + (PARTIAL_ITEMS - 1), 'the walk must end on the last item in the library');

        // ...and back up out of it, one row per press, all the way to Back.
        for (let row = rows - 2; row >= 0; row--) {
            await page.keyboard.press('ArrowUp');
            assert.equal(await page.evaluate(() => document.activeElement.dataset.itemId),
                'partial-' + (row * COLUMNS + shortRow - 1));
        }
        await page.keyboard.press('ArrowUp');
        assert.equal(await page.evaluate(() => document.activeElement.classList.contains('jq-back-button')), true);
    } finally {
        await browser.close();
    }
});

test('the hardware Back button returns Detail to the library grid it was opened from, then the grid back to Home', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInAsAlice(page);
        await page.evaluate(() => document.querySelector('.jq-see-all').click());
        await page.waitForSelector('.jq-library-grid .jq-media-card');

        await page.keyboard.press('Enter'); // movie-10, autofocused
        await page.waitForSelector('.jq-detail-screen');
        assert.match(await page.evaluate(() => document.querySelector('.jq-detail-title').textContent), /Open Water/);

        // Escape doubles as Back in the simulator (see app.js's BACK_KEY_CODES).
        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-library-grid .jq-media-card');
        assert.equal(await page.evaluate(() => document.querySelector('.jq-library-heading').textContent), 'Recently Added');

        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-home-row-heading');
    } finally {
        await browser.close();
    }
});

test('search: filters as you type, shows nothing for no matches, and opens Detail on selection', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInAsAlice(page);

        await page.evaluate(() => document.querySelector('.jq-nav-search').click());
        await page.waitForSelector('.jq-search-input');
        assert.equal(await page.evaluate(() => document.activeElement.tagName), 'INPUT');

        await page.evaluate(() => {
            const input = document.querySelector('.jq-search-input');
            input.value = 'blue';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.waitForSelector('.jq-search-results .jq-media-card');
        const results = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.jq-search-results .jq-media-card')).map((c) => c.getAttribute('data-item-id'))
        );
        assert.deepEqual(results, ['movie-9']);

        await page.evaluate(() => {
            const input = document.querySelector('.jq-search-input');
            input.value = 'zzz-no-such-movie';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.waitForFunction(() => document.querySelector('.jq-search-empty') && !document.querySelector('.jq-search-empty').hidden);

        await page.evaluate(() => {
            const input = document.querySelector('.jq-search-input');
            input.value = 'blue';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.waitForSelector('.jq-search-results .jq-media-card');
        await page.evaluate(() => document.querySelector('.jq-search-results .jq-media-card').click());
        await page.waitForSelector('.jq-detail-screen');
        assert.match(await page.evaluate(() => document.querySelector('.jq-detail-title').textContent), /Blue Hour/);
    } finally {
        await browser.close();
    }
});

test('the hardware Back button returns from Search to Home', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInAsAlice(page);

        await page.evaluate(() => document.querySelector('.jq-nav-search').click());
        await page.waitForSelector('.jq-search-input');
        await page.keyboard.press('Escape'); // Escape doubles as Back in the simulator
        await page.waitForSelector('.jq-home-row-heading');
    } finally {
        await browser.close();
    }
});

test('a Movie remains a poster after returning from Detail to Library', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInAsAlice(page);
        await page.locator('.jq-see-all').click();
        await page.waitForSelector('.jq-library-grid [data-item-id="movie-10"]');
        await page.locator('.jq-library-grid [data-item-id="movie-10"]').click();
        await page.waitForSelector('.jq-detail-screen');
        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-library-grid [data-item-id="movie-10"]');
        assert.deepEqual(await page.locator('.jq-library-grid [data-item-id="movie-10"]').evaluate((card) => ({
            height: card.getBoundingClientRect().height,
            poster: card.classList.contains('jq-media-card-poster'),
            landscape: card.classList.contains('jq-media-card-episode'),
        })), { height: 410, poster: true, landscape: false });
    } finally {
        await browser.close();
    }
});

test('switching between Home and Search via the rail always lands on a fresh screen', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInAsAlice(page);

        await page.evaluate(() => document.querySelector('.jq-nav-search').click());
        await page.waitForSelector('.jq-search-input');
        await page.evaluate(() => document.querySelector('.jq-nav-home').click());
        await page.waitForSelector('.jq-home-row-heading');
        assert.equal(await page.evaluate(() => document.querySelectorAll('.jq-search-input').length), 0);
    } finally {
        await browser.close();
    }
});
