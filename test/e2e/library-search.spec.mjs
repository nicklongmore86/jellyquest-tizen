// Library grid and Search screens (see docs/rebuild-plan.md, Phase 3).
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
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

test('library grid: full rows and a naturally partial last row both navigate correctly', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInAsAlice(page);
        await page.evaluate(() => document.querySelector('.jq-see-all').click());
        await page.waitForSelector('.jq-library-grid .jq-media-card');

        // The first 48-item window is 12 full rows; the final shift exposes
        // the response's naturally partial row without mounting all 50.
        assert.equal(await page.locator('.jq-library-grid .jq-media-card').count(), 48);
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
        for (let row = 0; row < 12; row++) await page.keyboard.press('ArrowDown');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.itemId), ids[48]);
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.itemId), ids[49]);
        await page.keyboard.press('ArrowUp');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.itemId), ids[45]);
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
