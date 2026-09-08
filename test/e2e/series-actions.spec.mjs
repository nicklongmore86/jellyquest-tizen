// Series-level Resume / Continue / Restart Episode actions. The Series entry
// surface is the season browser itself; selected Episodes still route to the
// existing Detail screen and are covered in series-routing.spec.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { assertPainted } from './support/paint.mjs';
import { startServer } from './support/server.mjs';

const server = await startServer();
const simulatorUrl = `${server.baseUrl}/dev/simulator.html`;
test.after(() => server.close());

async function withPage(profileIndex, run) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(5000);
        await page.goto(simulatorUrl);
        await page.waitForSelector('.jq-profile-card');
        await page.locator('.jq-profile-card').nth(profileIndex).click();
        await page.waitForSelector('.jq-home-row-heading');
        await run(page);
    } finally {
        await browser.close();
    }
}

async function openSeriesOne(page) {
    // Programmatic activation avoids the spatial polyfill's mouse-origin
    // ranking branch; the televisions have no pointer.
    await page.evaluate(() => document.querySelector('[data-item-id="series-1"]').click());
    await page.waitForSelector('.jq-series-episodes .jq-media-card');
}

async function addSeriesProgress(page) {
    await page.evaluate(() => {
        const getEpisodes = window.ApiClient.getEpisodes.bind(window.ApiClient);
        window.ApiClient.getEpisodes = function (id, options) {
            return getEpisodes(id, options).then((result) => ({
                ...result,
                Items: result.Items.map((episode) => {
                    if (episode.Id === 'episode-38') return {
                        ...episode,
                        UserData: { PlaybackPositionTicks: 1200000000, LastPlayedDate: '2026-08-30T12:00:00Z', Played: false },
                    };
                    if (episode.Id === 'episode-56') return {
                        ...episode,
                        UserData: { PlaybackPositionTicks: 2400000000, LastPlayedDate: '2026-09-07T12:00:00Z', Played: false },
                    };
                    return episode;
                }),
            }));
        };
    });
}

function actionLabels(page) {
    return page.locator('.jq-series-actions .jq-detail-action')
        .evaluateAll((buttons) => buttons.map((button) => button.textContent));
}

test('Series selects the most recently played resumable episode client-side and focuses its painted Resume action', async () => withPage(0, async (page) => {
    await addSeriesProgress(page);
    await page.evaluate(() => {
        window.__seriesEpisodeCalls = [];
        const getEpisodes = window.ApiClient.getEpisodes.bind(window.ApiClient);
        window.ApiClient.getEpisodes = function (id, options) {
            window.__seriesEpisodeCalls.push({ id, options: { ...options } });
            return getEpisodes(id, options);
        };
    });
    await openSeriesOne(page);

    assert.deepEqual(await actionLabels(page), ['Resume', 'Continue', 'Restart Episode']);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Resume');
    await assertPainted(page.locator(':focus'));
    assert.deepEqual(await page.evaluate(() => window.__seriesEpisodeCalls), [{
        id: 'series-1',
        options: { UserId: 'user-alice', IsMissing: false, IsVirtualUnaired: false },
    }]);
}));

test('Series Resume, Continue, and Restart Episode send exact episode ids, serverId, and positions', async () => {
    for (const scenario of [
        { action: 'Resume', id: 'episode-56', ticks: 2400000000 },
        { action: 'Continue', id: 'episode-57', ticks: 0 },
        { action: 'Restart Episode', id: 'episode-56', ticks: 0 },
    ]) {
        await withPage(0, async (page) => {
            await addSeriesProgress(page);
            await openSeriesOne(page);
            assert.equal((await actionLabels(page)).includes(scenario.action), true,
                `${scenario.action} must be present before it can be activated`);
            await page.getByRole('button', { name: scenario.action, exact: true }).click();
            await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
            assert.deepEqual(await page.evaluate(() => window.playbackManager.__calls.slice(-1)[0]), {
                ids: [scenario.id], serverId: 'dev-server-1', startPositionTicks: scenario.ticks,
            });
        });
    }
});

test('Series asks Jellyfin Next Up only when no episode is in progress', async () => withPage(1, async (page) => {
    await page.evaluate(() => {
        window.__nextUpCalls = [];
        const getNextUpEpisodes = window.ApiClient.getNextUpEpisodes.bind(window.ApiClient);
        window.ApiClient.getNextUpEpisodes = function (options) {
            window.__nextUpCalls.push({ ...options });
            return getNextUpEpisodes(options);
        };
    });
    await openSeriesOne(page);

    assert.deepEqual(await actionLabels(page), ['Continue']);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Continue');
    await assertPainted(page.locator(':focus'));
    assert.deepEqual(await page.evaluate(() => window.__nextUpCalls), [{
        SeriesId: 'series-1', UserId: 'user-bob', Limit: 1, EnableRewatching: false,
    }]);

    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.playbackManager.__calls.length > 0);
    assert.deepEqual(await page.evaluate(() => window.playbackManager.__calls[0]), {
        ids: ['episode-1'], serverId: 'dev-server-1', startPositionTicks: 0,
    });
}));

test('a fully watched Series hides Continue when Jellyfin has no Next Up episode', async () => withPage(0, async (page) => {
    await page.evaluate(() => {
        const getEpisodes = window.ApiClient.getEpisodes.bind(window.ApiClient);
        window.ApiClient.getEpisodes = function (id, options) {
            return getEpisodes(id, options).then((result) => ({
                ...result,
                Items: result.Items.map((episode) => ({
                    ...episode,
                    UserData: { ...episode.UserData, PlaybackPositionTicks: 0, Played: true },
                })),
            }));
        };
        window.ApiClient.getNextUpEpisodes = () => Promise.resolve({ Items: [], TotalRecordCount: 0 });
    });
    await openSeriesOne(page);

    assert.deepEqual(await actionLabels(page), [], 'fully watched must not fall back to Continue S1 E1');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('jq-series-season-button')), true);
    await assertPainted(page.locator(':focus'));
}));

test('an in-progress final episode hides Continue and does not ask Jellyfin Next Up', async () => withPage(0, async (page) => {
    await page.evaluate(() => {
        window.__nextUpCount = 0;
        const getEpisodes = window.ApiClient.getEpisodes.bind(window.ApiClient);
        window.ApiClient.getEpisodes = function (id, options) {
            return getEpisodes(id, options).then((result) => ({
                ...result,
                Items: result.Items.map((episode, index, episodes) => ({
                    ...episode,
                    UserData: index === episodes.length - 1
                        ? { PlaybackPositionTicks: 900000000, LastPlayedDate: '2026-09-08T00:00:00Z', Played: false }
                        : { PlaybackPositionTicks: 0, Played: true },
                })),
            }));
        };
        window.ApiClient.getNextUpEpisodes = function () {
            window.__nextUpCount += 1;
            return Promise.resolve({ Items: [{ Id: 'wrong-next-up' }] });
        };
    });
    await openSeriesOne(page);

    assert.deepEqual(await actionLabels(page), ['Resume', 'Restart Episode']);
    assert.equal(await page.evaluate(() => window.__nextUpCount), 0);
}));
