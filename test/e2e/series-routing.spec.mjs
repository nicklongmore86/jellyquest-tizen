// Series/Episode routing. These tests pin the route boundary and the playable
// Episode detail behavior; the Series browse screen S4 put behind that
// boundary has its own suite in series-browse.spec.mjs.
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

// `.first()` because Home grew a Next Up row and an id can now legitimately
// appear twice on the screen: MEASURED, the library-wide /Shows/NextUp call
// returns an in-progress episode ITSELF, so episode-516 is in both Continue
// Watching and Next Up. Either card opens the same Detail screen, which is
// what these tests are about.
async function openHomeItem(page, itemId) {
    await page.locator(`[data-item-id="${itemId}"]`).first().click();
}


test('Episode Detail reuses browse-card context and autofocuses Resume', async () => withPage(async (page) => {
    await openHomeItem(page, 'episode-516');
    await page.waitForSelector('.jq-detail-screen');

    assert.equal(await page.locator('.jq-detail-title-name').textContent(), 'PAW Patrol');
    assert.equal(await page.locator('.jq-detail-context').textContent(), 'S6 E27 · PAW Patrol 6x27');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Resume');
    await assertPainted(page.locator('.jq-detail-context'));
    await assertPainted(page.locator(':focus'));
}));

test('Episode Detail exits from its first action to the rail with one ArrowLeft', async () => withPage(async (page) => {
    await openHomeItem(page, 'episode-516');
    await page.waitForSelector('.jq-detail-overview');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Resume');

    await page.keyboard.press('ArrowLeft');

    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('jq-rail-item')), true);
    await assertPainted(page.locator(':focus'));
}));

test('Movie Detail exits from its first action to the rail with one ArrowLeft', async () => withPage(async (page) => {
    // Programmatic activation matches detail.spec.mjs's established Movie
    // setup and does not leave a pointer starting point in the polyfill.
    await page.evaluate(() => document.querySelector('[data-item-id="movie-1"]').click());
    await page.getByRole('button', { name: 'Trailer', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Resume');

    await page.keyboard.press('ArrowLeft');

    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('jq-rail-item')), true);
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

test('Series routes to its own screen and offers its series-level playback actions', async () => withPage(async (page) => {
    await page.evaluate(() => {
        const getEpisodes = window.ApiClient.getEpisodes.bind(window.ApiClient);
        window.ApiClient.getEpisodes = function (id, options) {
            return getEpisodes(id, options).then((result) => ({
                ...result,
                Items: result.Items.map((episode) => episode.Id === 'episode-1' ? {
                    ...episode,
                    UserData: { PlaybackPositionTicks: 300000000, LastPlayedDate: '2026-09-08T00:00:00Z', Played: false },
                } : episode),
            }));
        };
    });
    await openHomeItem(page, 'series-1');
    await page.waitForSelector('.jq-series-episodes .jq-media-card');

    assert.equal(await page.locator('.jq-series-title').textContent(), 'Northern Stories 1');
    // The Series object remains a folder and is never sent to playback; these
    // controls resolve to Episodes behind the Series route.
    assert.deepEqual(await page.locator('.jq-series-actions .jq-detail-action')
        .evaluateAll((buttons) => buttons.map((button) => button.textContent)),
    ['Resume', 'Continue', 'Restart Episode']);
    assert.equal(await page.evaluate(() => window.playbackManager.__calls.length), 0);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Resume');
    await assertPainted(page.locator(':focus'));
}));
