// Home screen (see docs/rebuild-plan.md, Phase 3): Continue Watching +
// Recently Added rows.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { assertPainted } from './support/paint.mjs';
import { startServer } from './support/server.mjs';

const server = await startServer();
const simulatorUrl = `${server.baseUrl}/dev/simulator.html`;
test.after(() => server.close());

async function signInAsAlice(page) {
    await page.goto(simulatorUrl);
    await page.waitForSelector('.jq-profile-card');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.jq-shell');
    await page.waitForSelector('.jq-media-card');
}

async function beginDelayedHomeSignIn(page) {
    await page.goto(simulatorUrl);
    await page.waitForSelector('.jq-profile-card');
    await page.evaluate(() => {
        const getItems = window.ApiClient.getItems;
        window.__releaseHomeRows = [];
        window.ApiClient.getItems = function () {
            const receiver = this;
            const args = arguments;
            return new Promise((resolve) => {
                window.__releaseHomeRows.push(() => resolve(getItems.apply(receiver, args)));
            });
        };
    });
    await page.keyboard.press('Enter');
    await page.waitForSelector('.jq-shell');
    await page.waitForFunction(() => window.__releaseHomeRows.length === 2);
}

async function releaseHomeRows(page) {
    await page.evaluate(() => window.__releaseHomeRows.splice(0).forEach((release) => release()));
    await page.waitForSelector('.jq-media-card');
}

test('shows Continue Watching only for items with saved progress, and Recently Added for Movies and Series', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInAsAlice(page);

        const headings = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.jq-home-row-heading')).map((h) => h.textContent)
        );
        assert.deepEqual(headings, ['Continue Watching', 'Recently Added']);

        const continueWatching = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.jq-home-row-section')[0].querySelectorAll('.jq-media-card'))
                .map((c) => c.getAttribute('data-item-id'))
        );
        // Fixture: two Movies and an Episode have playback progress for Alice.
        assert.deepEqual(continueWatching, ['movie-1', 'episode-516', 'movie-3']);
    } finally {
        await browser.close();
    }
});

test('autofocuses the first card, and arrow keys move within and between rows', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInAsAlice(page);

        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-item-id')), 'movie-1');

        await page.keyboard.press('ArrowDown');
        const afterDown = await page.evaluate(() => document.activeElement.getAttribute('data-item-id'));
        assert.notEqual(afterDown, 'movie-1', 'Down should leave Continue Watching for Recently Added');

        await page.keyboard.press('ArrowUp');
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-item-id')), 'movie-1');
    } finally {
        await browser.close();
    }
});

test('a delayed Home render preserves a newer rendered rail selection', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await beginDelayedHomeSignIn(page);

        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        assert.equal(await page.evaluate(() => document.activeElement.classList.contains('jq-nav-search')), true,
            'the delayed-response precondition must leave a real selection on Search');
        await assertPainted(page.locator(':focus'));

        await releaseHomeRows(page);

        assert.equal(await page.evaluate(() => document.activeElement.classList.contains('jq-nav-search')), true,
            'late Home completion must not override the newer Search selection');
        await assertPainted(page.locator(':focus'));
    } finally {
        await browser.close();
    }
});

test('a delayed Home render still autofocuses its first card without newer user input', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await beginDelayedHomeSignIn(page);

        await releaseHomeRows(page);

        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-item-id')), 'movie-1',
            'Home must keep its ordinary first-card autofocus when focus has not moved');
        await assertPainted(page.locator(':focus'));
    } finally {
        await browser.close();
    }
});

test('a Recently Added row with more than 8 items shows a "See All" that opens the Library grid', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInAsAlice(page);

        await page.evaluate(() => document.querySelector('.jq-see-all').click());
        await page.waitForSelector('.jq-library-grid .jq-media-card');
        assert.equal(await page.evaluate(() => document.querySelector('.jq-library-heading').textContent), 'Recently Added');

        const items = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.jq-library-grid .jq-media-card')).map((c) => c.getAttribute('data-item-id'))
        );
        assert.equal(items.length, 48);

        // "< Back" returns to Home, reachable via Up from the grid.
        await page.evaluate(() => document.querySelector('.jq-back-button').click());
        await page.waitForSelector('.jq-home-screen');
    } finally {
        await browser.close();
    }
});

test('selecting a card opens Detail for that item', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInAsAlice(page);

        await page.keyboard.press('Enter'); // movie-1, autofocused
        await page.waitForSelector('.jq-detail-screen');
        assert.match(await page.evaluate(() => document.querySelector('.jq-detail-title').textContent), /The Long Winter/);
    } finally {
        await browser.close();
    }
});
