// Series/Episode routing seam. Series browsing itself belongs to S4; these
// tests pin only the route boundary and the playable Episode detail behavior.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { assertPainted } from './support/paint.mjs';
import { startServer } from './support/server.mjs';

const server = await startServer();
const simulatorUrl = `${server.baseUrl}/dev/simulator.html`;
test.after(() => server.close());

async function withPage(run) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(5000);
        await page.goto(simulatorUrl);
        await page.waitForSelector('.jq-profile-card');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.jq-home-row-heading');
        await run(page);
    } finally {
        await browser.close();
    }
}

async function openHomeItem(page, itemId) {
    await page.locator(`[data-item-id="${itemId}"]`).click();
}

async function reopenSeries(page) {
    await page.locator('.jq-nav-home').click();
    await page.waitForSelector('[data-item-id="series-1"]');
    await openHomeItem(page, 'series-1');
    await page.waitForSelector('.jq-series-screen');
}

test('Episode Detail reuses browse-card context and autofocuses Resume', async () => withPage(async (page) => {
    await openHomeItem(page, 'episode-516');
    await page.waitForSelector('.jq-detail-screen');

    assert.equal(await page.locator('.jq-detail-title').textContent(), 'PAW Patrol');
    assert.equal(await page.locator('.jq-detail-context').textContent(), 'S6 E27 · PAW Patrol 6x27');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Resume');
    await assertPainted(page.locator('.jq-detail-context'));
    await assertPainted(page.locator(':focus'));
}));

test('Episode Resume and Play use ids, item serverId, and the requested position', async () => {
    for (const scenario of [
        { itemId: 'episode-516', action: 'Resume', ticks: 6000000000 },
        { itemId: 'episode-515', action: 'Play', ticks: 0 },
    ]) {
        await withPage(async (page) => {
            if (scenario.itemId === 'episode-515') {
                await page.evaluate(() => {
                    const getItems = window.ApiClient.getItems.bind(window.ApiClient);
                    window.ApiClient.getItems = function (userId, options) {
                        if (options.Filters === 'IsResumable') {
                            return getItems(userId, { ...options, Filters: undefined }).then((result) => ({
                                ...result,
                                Items: result.Items.filter((item) => item.Id === 'episode-515'),
                            }));
                        }
                        return getItems(userId, options);
                    };
                    document.querySelector('.jq-nav-home').click();
                });
                await page.waitForSelector('[data-item-id="episode-515"]');
            }
            await openHomeItem(page, scenario.itemId);
            await page.getByRole('button', { name: scenario.action, exact: true }).waitFor();
            assert.equal(await page.evaluate(() => document.activeElement.textContent), scenario.action);
            await assertPainted(page.locator(':focus'));
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => window.playbackManager.__calls.length > 0);
            assert.deepEqual(await page.evaluate(() => window.playbackManager.__calls.slice(-1)[0]), {
                ids: [scenario.itemId],
                serverId: 'dev-server-1',
                startPositionTicks: scenario.ticks,
            });
        });
    }
});

test('Series uses its dedicated inert seam without show queries or playback controls', async () => withPage(async (page) => {
    await page.evaluate(() => {
        window.__showQueries = 0;
        window.ApiClient.getEpisodes = function () { window.__showQueries += 1; throw new Error('out-of-scope episode query'); };
        window.ApiClient.getSeasons = function () { window.__showQueries += 1; throw new Error('out-of-scope season query'); };
    });
    await openHomeItem(page, 'series-1');
    await page.waitForSelector('.jq-series-screen');

    assert.equal(await page.locator('.jq-series-title').textContent(), 'Northern Stories 1');
    assert.equal(await page.locator('.jq-series-status').textContent(), 'Series browsing is not available yet.');
    assert.equal(await page.locator('.jq-detail-action').count(), 0);
    assert.equal(await page.evaluate(() => window.__showQueries), 0);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('jq-back-button')), true);
    await assertPainted(page.locator('.jq-series-status'));
    await assertPainted(page.locator(':focus'));
}));

test('Series seam exits by Enter, hardware Back, and ArrowLeft to the rail', async () => withPage(async (page) => {
    await openHomeItem(page, 'series-1');
    await page.waitForSelector('.jq-series-screen');

    await page.keyboard.press('Enter');
    await page.waitForSelector('.jq-home-row-heading');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.itemId), 'movie-1');

    await reopenSeries(page);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.jq-home-row-heading');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.itemId), 'movie-1');

    await reopenSeries(page);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('jq-nav-requests')), true);
    await assertPainted(page.locator(':focus'));
}));
