import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { assertPainted } from './support/paint.mjs';
import { startServer } from './support/server.mjs';

const server = await startServer();
const simulatorUrl = `${server.baseUrl}/dev/simulator.html`;
test.after(() => server.close());

const ITEM_COUNT = 680;
const WINDOW_SIZE = 36;
// src/overlay/screens/library.js's track count. 680 is the household's
// MEASURED movie count and is deliberately NOT rounded to a multiple of it:
// 680 / 6 leaves a naturally partial last row of two cards, which is exactly
// the shape the .jq-grid precondition allows, so the walks below are written
// per-row rather than assuming every row is full.
const COLUMNS = 6;
const ROWS = Math.ceil(ITEM_COUNT / COLUMNS);
const rowLength = (row) => Math.min(COLUMNS, ITEM_COUNT - row * COLUMNS);
// ArrowDown presses that must carry the window far enough forward to evict
// item 0. The window is WINDOW_SIZE / COLUMNS rows and shifts one row at a
// time once the cursor is within EDGE_ROWS of its end, so anything past the
// window's own depth does it; the assertions that follow prove it did.
const EVICTION_ROWS = WINDOW_SIZE / COLUMNS + 3;

async function signInAsAlice(page) {
    await page.goto(simulatorUrl);
    await page.waitForSelector('.jq-profile-card');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.jq-shell');
    await page.waitForSelector('.jq-media-card');
}

async function renderItems(page, count, itemType = 'Movie') {
    await page.evaluate(({ count, itemType }) => {
        const items = [];
        for (let i = 0; i < count; i++) {
            items.push({
                Id: 'window-' + i,
                Name: 'Window item ' + i,
                Type: itemType,
                ImageTags: { Primary: 'window-tag' },
            });
        }
        const getItems = window.ApiClient.getItems;
        window.ApiClient.getItems = function (user, options) {
            return getItems(user, options).then(function () { return { Items: items }; });
        };
        window.__maxLibraryCards = 0;
        window.__libraryCardObserver = new MutationObserver(function () {
            window.__maxLibraryCards = Math.max(
                window.__maxLibraryCards,
                document.querySelectorAll('.jq-library-grid .jq-media-card').length
            );
        });
        window.__libraryCardObserver.observe(document.getElementById('jellyquest-root'), { childList: true, subtree: true });
        window.JellyQuestLibraryScreen.render(
            window.JellyQuestShell.getContent(),
            { title: 'Window test' },
            { onSelectItem() {}, onBack() {} }
        );
    }, { count, itemType });
    await page.waitForSelector('[data-item-id="window-0"]');
}

async function focusSnapshot(page) {
    return page.evaluate(() => {
        const active = document.activeElement;
        return {
            id: active && active.getAttribute('data-item-id'),
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

async function assertWindow(page) {
    const ids = await page.locator('.jq-library-grid .jq-media-card').evaluateAll(cards =>
        cards.map(card => Number(card.dataset.itemId.slice('window-'.length))));
    assert.ok(ids.length <= WINDOW_SIZE, `mounted ${ids.length} cards, limit is ${WINDOW_SIZE}`);
    assert.ok(await page.evaluate(() => window.__maxLibraryCards) <= WINDOW_SIZE,
        `observed ${await page.evaluate(() => window.__maxLibraryCards)} simultaneously mounted cards`);
    assert.equal(new Set(ids).size, ids.length, 'the mounted window must not contain duplicates');
    for (let i = 1; i < ids.length; i++) {
        assert.equal(ids[i], ids[i - 1] + 1, 'the mounted window must stay in item order');
    }
    return ids;
}

// Movie is the real Library case. Episode is deliberately synthetic because
// the Library query excludes episodes; it exercises the window calculations
// at the app's other media-card row pitch rather than implying episodes can
// appear on this screen.
for (const [itemType, cardHeight] of [['Movie', 410], ['Episode', 204]]) {
    test(`Library windows 680 ${itemType} items and traverses both directions at 220x${cardHeight}`, async () => {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
            await signInAsAlice(page);
            await renderItems(page, ITEM_COUNT, itemType);

            const geometry = await page.evaluate((COLUMNS) => {
                const cards = document.querySelectorAll('.jq-library-grid .jq-media-card');
                const first = cards[0].getBoundingClientRect();
                const nextRow = cards[COLUMNS].getBoundingClientRect();
                const screen = document.querySelector('.jq-library-screen');
                return {
                    width: Math.round(first.width),
                    height: Math.round(first.height),
                    pitch: Math.round(nextRow.top - first.top),
                    range: screen.scrollHeight - screen.clientHeight,
                    template: getComputedStyle(document.querySelector('.jq-library-grid')).gridTemplateColumns,
                };
            }, COLUMNS);
            assert.deepEqual({ width: geometry.width, height: geometry.height }, { width: 220, height: cardHeight });
            // PRECONDITIONS. The up-traversal below is only a real test if the
            // grid is deep enough to strand a return trip, and the row
            // arithmetic is only meaningful if the grid really renders COLUMNS
            // tracks -- a grid that silently rendered four would make 170 rows
            // out of these 680 cards and every id below would describe a
            // different layout while still walking cleanly.
            assert.equal(geometry.template, Array(COLUMNS).fill('220px').join(' '),
                'the grid must render exactly COLUMNS 220px tracks');
            assert.ok(geometry.range > geometry.pitch * 100,
                `fixture must be deep enough to strand traversal: ${geometry.range}px range, ${geometry.pitch}px pitch`);
            assert.ok(ROWS > WINDOW_SIZE / COLUMNS,
                'fixture must be deeper than the DOM window to move it at all');
            assert.equal((await assertWindow(page)).length, WINDOW_SIZE);

            for (let row = 0; row < ROWS; row++) {
                assert.equal((await focusSnapshot(page)).id, 'window-' + row * COLUMNS);
                await assertPainted(page.locator(':focus'));
                for (let column = 1; column < rowLength(row); column++) {
                    assert.equal(await pressAndAssertFocus(page, 'ArrowRight'), 'window-' + (row * COLUMNS + column));
                }
                for (let column = rowLength(row) - 2; column >= 0; column--) {
                    assert.equal(await pressAndAssertFocus(page, 'ArrowLeft'), 'window-' + (row * COLUMNS + column));
                }
                await assertWindow(page);
                if (row + 1 < ROWS) {
                    assert.equal(await pressAndAssertFocus(page, 'ArrowDown'), 'window-' + ((row + 1) * COLUMNS));
                }
            }

            for (let row = ROWS - 1; row >= 0; row--) {
                assert.equal((await focusSnapshot(page)).id, 'window-' + row * COLUMNS);
                await assertPainted(page.locator(':focus'));
                await assertWindow(page);
                if (row > 0) {
                    assert.equal(await pressAndAssertFocus(page, 'ArrowUp'), 'window-' + ((row - 1) * COLUMNS));
                }
            }
            assert.equal(await pressAndAssertFocus(page, 'ArrowUp'), null);
            assert.equal(await page.evaluate(() => document.activeElement.classList.contains('jq-back-button')), true);
            await assertPainted(page.locator('.jq-back-button'));
        } finally {
            await browser.close();
        }
    });
}

test('Library card recreation shares the three-attempt artwork retry budget', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        let requests = 0;
        await page.route('**/window-retry.webp', async (route) => {
            requests++;
            await route.fulfill({ status: 503, body: 'Temporary failure' });
        });
        await signInAsAlice(page);
        await page.evaluate(() => {
            const getImageUrl = window.ApiClient.getImageUrl;
            window.ApiClient.getImageUrl = function (id, options) {
                if (id === 'window-0') return '/window-retry.webp';
                return getImageUrl.call(this, id, options);
            };
        });
        await renderItems(page, 80);
        assert.ok((await assertWindow(page)).length <= WINDOW_SIZE);
        await page.waitForFunction(() => document.querySelector('[data-item-id="window-0"]').getAttribute('data-artwork-state') === 'error');

        for (let visit = 0; visit < 5; visit++) {
            for (let row = 0; row < EVICTION_ROWS; row++) await pressAndAssertFocus(page, 'ArrowDown');
            assert.equal(await page.locator('[data-item-id="window-0"]').count(), 0, 'first item must actually leave the DOM');
            for (let row = 0; row < EVICTION_ROWS; row++) await pressAndAssertFocus(page, 'ArrowUp');
            await page.waitForSelector('[data-item-id="window-0"]');
            await page.waitForTimeout(50);
        }
        assert.equal(requests, 3, 'card recreation must retain the per-render three-attempt budget');
    } finally {
        await browser.close();
    }
});

test('Library artwork recreation assigns twice but causes one observed network download', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        const cdp = await page.context().newCDPSession(page);
        const cacheUrl = `${server.baseUrl}/dev/fixtures/artwork/poster-1.webp?window-cache=unique`;
        const requestUrls = new Map();
        await cdp.send('Network.enable');
        cdp.on('Network.requestWillBeSent', event => requestUrls.set(event.requestId, event.request.url));
        await signInAsAlice(page);
        await page.evaluate(() => {
            const getImageUrl = window.ApiClient.getImageUrl;
            window.__windowCacheUrlCalls = 0;
            window.ApiClient.getImageUrl = function (id, options) {
                if (id === 'window-0') {
                    window.__windowCacheUrlCalls++;
                    return '/dev/fixtures/artwork/poster-1.webp?window-cache=unique';
                }
                if (id.indexOf('window-') === 0) return null;
                return getImageUrl.call(this, id, options);
            };
        });
        await renderItems(page, 80);
        assert.ok((await assertWindow(page)).length <= WINDOW_SIZE);
        await page.waitForFunction(() => document.querySelector('[data-item-id="window-0"] img')?.naturalWidth > 0);
        for (let row = 0; row < EVICTION_ROWS; row++) await pressAndAssertFocus(page, 'ArrowDown');
        assert.equal(await page.locator('[data-item-id="window-0"]').count(), 0);
        for (let row = 0; row < EVICTION_ROWS; row++) await pressAndAssertFocus(page, 'ArrowUp');
        await page.waitForFunction(() => document.querySelector('[data-item-id="window-0"] img')?.naturalWidth > 0);

        const matchingRequests = Array.from(requestUrls).filter(([, url]) => url === cacheUrl);
        assert.equal(await page.evaluate(() => window.__windowCacheUrlCalls), 2,
            'recreated artwork must resolve and assign the same URL again');
        assert.equal(matchingRequests.length, 1,
            'two image assignments must produce only one observed network download');
    } finally {
        await browser.close();
    }
});

test('a late Library response does not steal a newer rail selection', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInAsAlice(page);
        await page.evaluate(() => {
            const getItems = window.ApiClient.getItems;
            window.ApiClient.getItems = function (user, options) {
                getItems(user, options);
                return new Promise(function (resolve) { window.__resolveLibrary = resolve; });
            };
            window.JellyQuestLibraryScreen.render(
                window.JellyQuestShell.getContent(),
                { title: 'Delayed library' },
                { onSelectItem() {}, onBack() {} }
            );
            document.querySelector('.jq-nav-search').focus();
        });
        await assertPainted(page.locator('.jq-nav-search'));
        await page.evaluate(() => {
            window.__resolveLibrary({ Items: [
                { Id: 'late-1', Name: 'Late item', Type: 'Movie' },
            ] });
        });
        await page.waitForSelector('[data-item-id="late-1"]');
        assert.equal(await page.evaluate(() => document.activeElement.classList.contains('jq-nav-search')), true,
            'the completed request must preserve the newer rail focus');
        await assertPainted(page.locator('.jq-nav-search'));
    } finally {
        await browser.close();
    }
});
