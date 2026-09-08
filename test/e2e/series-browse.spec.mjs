// The Series browse screen (S4): a season dropdown and the selected season's
// episode list. The S3 seam's own tests live in series-routing.spec.mjs and
// are updated there; this file covers the browser itself.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { assertPainted } from './support/paint.mjs';
import { startServer } from './support/server.mjs';

const server = await startServer();
const simulatorUrl = `${server.baseUrl}/dev/simulator.html`;
test.after(() => server.close());

const WINDOW_SIZE = 48;
const COLUMNS = 4;

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

// Records every getEpisodes/getSeasons call so the measured accept-and-ignore
// trap can be asserted on the REQUEST, not only on what came back.
async function recordShowQueries(page) {
    await page.evaluate(() => {
        window.__showCalls = { seasons: [], episodes: [] };
        const getSeasons = window.ApiClient.getSeasons.bind(window.ApiClient);
        const getEpisodes = window.ApiClient.getEpisodes.bind(window.ApiClient);
        window.ApiClient.getSeasons = function (id, options) {
            window.__showCalls.seasons.push({ id, options: { ...options } });
            return getSeasons(id, options);
        };
        window.ApiClient.getEpisodes = function (id, options) {
            window.__showCalls.episodes.push({ id, options: { ...options } });
            return getEpisodes(id, options);
        };
    });
}

// The app.js route (Home card -> showSeries) is exercised by the series-1
// tests below. This renders the screen directly for the shows that are not
// reachable from Home's eight-item Recently Added row -- the same idiom
// library-windowing.spec.mjs uses -- while still driving the real screen.
async function renderSeriesDirectly(page, item) {
    await page.evaluate((seriesItem) => {
        window.__selected = [];
        window.JellyQuestSeriesScreen.render(
            window.JellyQuestShell.getContent(),
            seriesItem,
            {
                onBack() {},
                onSelectItem(episode) { window.__selected.push(episode.Id); },
                onSeasonChange() {},
                onPlay(episode, startPositionTicks) {
                    window.__directPlays = window.__directPlays || [];
                    window.__directPlays.push({ id: episode.Id, startPositionTicks });
                    return Promise.resolve();
                },
            }
        );
    }, item);
    await page.waitForSelector('.jq-series-screen');
}

test('the direct-render harness can activate a Series action without an uncaught callback error', async () => withPage(async (page) => {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await renderSeriesDirectly(page, {
        Id: 'series-paw-patrol', Name: 'PAW Patrol', Type: 'Series', ServerId: 'dev-server-1',
    });
    await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(await page.evaluate(() => window.__directPlays), [{
        id: 'episode-516', startPositionTicks: 6000000000,
    }]);
}));

// Programmatic activation, matching detail.spec.mjs's and
// series-routing.spec.mjs's established convention: a real Playwright click
// leaves a pointer starting point in the polyfill, which then ranks arrow
// candidates from that PIXEL rather than from the focused element (its
// selectBestCandidateFromEdge -> getDistanceFromPoint branch). The
// televisions have no pointer, so that ranking is a harness artifact.
async function openSeriesOne(page) {
    await page.evaluate(() => document.querySelector('[data-item-id="series-1"]').click());
    await page.waitForSelector('.jq-series-season-button');
}

async function instrumentSeriesWithProgress(page) {
    await page.evaluate(() => {
        window.__seriesEpisodeQueryCount = 0;
        const getEpisodes = window.ApiClient.getEpisodes.bind(window.ApiClient);
        window.ApiClient.getEpisodes = function (id, options) {
            window.__seriesEpisodeQueryCount += 1;
            return getEpisodes(id, options).then((result) => ({
                ...result,
                Items: result.Items.map((episode) => episode.Id === 'episode-1' ? {
                    ...episode,
                    UserData: {
                        PlaybackPositionTicks: 300000000,
                        LastPlayedDate: '2026-09-08T00:00:00Z',
                        Played: false,
                    },
                } : episode),
            }));
        };
    });
}

function cardText(page) {
    return page.locator('.jq-series-episodes .jq-media-card').evaluateAll((cards) => cards.map((card) => ({
        id: card.getAttribute('data-item-id'),
        title: card.querySelector('.jq-media-card-title').textContent,
        meta: card.querySelector('.jq-media-card-meta')?.textContent ?? '',
    })));
}

function focusSnapshot(page) {
    return page.evaluate(() => {
        const active = document.activeElement;
        return {
            id: active && active.getAttribute('data-item-id'),
            className: active ? active.className : '',
            text: active ? active.textContent : '',
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
    return focus;
}

async function openSeasonMenu(page) {
    await page.evaluate(() => document.querySelector('.jq-series-season-button').click());
    await page.waitForSelector('.jq-series-season-menu:not([hidden])');
}

test('a show opens on its first season with the contextual episode label', async () => withPage(async (page) => {
    await recordShowQueries(page);
    await openSeriesOne(page);
    await page.waitForSelector('.jq-series-episodes .jq-media-card');

    assert.equal(await page.locator('.jq-series-title').textContent(), 'Northern Stories 1');
    assert.equal(await page.locator('.jq-series-season-button').textContent(), 'Season 1 ▾');

    const cards = await cardText(page);
    assert.equal(cards.length, 15, 'season 1 of the fixture show has 15 episodes');
    // Household decision 3, and the first production caller of cards.js's
    // context:'series' branch (shipped by PR #30 with no caller at all): the
    // EPISODE's name leads, because the show's name is already at the top of
    // this page. The browse form would put 'Northern Stories 1' here.
    assert.deepEqual(cards[0], { id: 'episode-1', title: 'Quiet Signal Episode 1', meta: 'S1 E1' });
    assert.deepEqual(cards[14], { id: 'episode-15', title: 'Quiet Signal Episode 15', meta: 'S1 E15' });
    for (const card of cards) {
        assert.notEqual(card.title, 'Northern Stories 1', 'the show name must not lead inside the show');
    }

    // The show action resolver has completed before the cards mount. Alice
    // has no progress in this series and the fixture has no Next Up answer,
    // so the season selector remains the primary focus target.
    // Removing the identity clause in
    // focus.js's focusFirst() (`document.activeElement !== expectedFocus`)
    // breaks exactly this assertion -- see the PR body's mutation run.
    const focus = await focusSnapshot(page);
    assert.equal(focus.className.includes('jq-series-season-button'), true,
        'focus must land on the season selector once the show has loaded');
    await assertPainted(page.locator(':focus'));
    assert.equal(await page.locator('.jq-series-status').isVisible(), false);
}));

test('episode requests carry the virtual-record switches and no ignored sort or filter', async () => withPage(async (page) => {
    await recordShowQueries(page);
    await openSeriesOne(page);
    await page.waitForSelector('.jq-series-episodes .jq-media-card');

    const calls = await page.evaluate(() => window.__showCalls);
    assert.deepEqual(calls.seasons, [{ id: 'series-1', options: { UserId: 'user-alice' } }]);
    assert.deepEqual(calls.episodes, [{
        id: 'series-1',
        options: { UserId: 'user-alice', IsMissing: false, IsVirtualUnaired: false },
    }]);
    // MEASURED on the household server: this endpoint accepts and silently
    // ignores Filters/SortBy/SortOrder, so sending them would look like it
    // worked and be wrong. Asserted as absent from the REQUEST.
    for (const call of calls.episodes) {
        for (const ignored of ['Filters', 'SortBy', 'SortOrder']) {
            assert.equal(ignored in call.options, false, `${ignored} is ignored by the server and must not be sent`);
        }
    }
}));

test('the episode list is ordered client-side, not in the order the server replied', async () => withPage(async (page) => {
    // The server's accept-and-ignore behaviour means a response can arrive in
    // any order at all. Reversing it here is the only way to tell a screen
    // that sorts from one that merely renders what it was handed.
    await page.evaluate(() => {
        const getEpisodes = window.ApiClient.getEpisodes.bind(window.ApiClient);
        window.ApiClient.getEpisodes = function (id, options) {
            return getEpisodes(id, options).then((result) => ({
                ...result,
                Items: result.Items.slice().reverse(),
            }));
        };
    });
    await openSeriesOne(page);
    await page.waitForSelector('.jq-series-episodes .jq-media-card');

    const cards = await cardText(page);
    assert.deepEqual(cards.map((card) => card.meta),
        Array.from({ length: 15 }, (_, index) => `S1 E${index + 1}`));
}));

test('choosing a season reuses the whole-series list and leaves the cursor on the selector', async () => withPage(async (page) => {
    await recordShowQueries(page);
    await openSeriesOne(page);
    await page.waitForSelector('.jq-series-episodes .jq-media-card');

    await openSeasonMenu(page);
    // The dropdown opens on the season the viewer is already in.
    assert.equal((await focusSnapshot(page)).text, 'Season 1');
    await assertPainted(page.locator(':focus'));
    assert.equal(await page.locator('.jq-series-season-option').count(), 24);

    assert.equal((await pressAndAssertFocus(page, 'ArrowDown')).text, 'Season 2');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() =>
        document.querySelector('.jq-series-episodes .jq-media-card .jq-media-card-meta')?.textContent === 'S2 E1');

    assert.equal(await page.locator('.jq-series-season-button').textContent(), 'Season 2 ▾');
    const cards = await cardText(page);
    assert.equal(cards[0].id, 'episode-16');
    assert.equal(cards.every((card) => card.meta.startsWith('S2 ')), true);

    const focus = await focusSnapshot(page);
    assert.equal(focus.className.includes('jq-series-season-button'), true,
        'the cursor stays on the selector across a season change');
    await assertPainted(page.locator(':focus'));

    const calls = await page.evaluate(() => window.__showCalls.episodes.map((call) => call.options.SeasonId));
    assert.deepEqual(calls, [undefined], 'season switches must not refetch a list already needed by show actions');
}));

test('an episode opens Detail, and Back returns to the season it was chosen from', async () => withPage(async (page) => {
    await openSeriesOne(page);
    await page.waitForSelector('.jq-series-episodes .jq-media-card');
    await openSeasonMenu(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() =>
        document.querySelector('.jq-series-episodes .jq-media-card .jq-media-card-meta')?.textContent === 'S2 E1');

    await page.evaluate(() => document.querySelector('[data-item-id="episode-17"]').click());
    await page.waitForSelector('.jq-detail-screen');
    // Household decision 5: an episode opens Detail rather than playing.
    assert.equal(await page.evaluate(() => window.playbackManager.__calls.length), 0);
    assert.equal(await page.locator('.jq-detail-title-name').textContent(), 'Northern Stories 1');
    assert.equal(await page.locator('.jq-detail-context').textContent(), 'S2 E2 · Quiet Signal Episode 17');

    await page.keyboard.press('Escape');
    await page.waitForSelector('.jq-series-season-button');
    assert.equal(await page.locator('.jq-series-season-button').textContent(), 'Season 2 ▾',
        'returning from Detail must come back to the season the episode came from');
    await page.waitForFunction(() =>
        document.querySelector('.jq-series-episodes .jq-media-card .jq-media-card-meta')?.textContent === 'S2 E1');
    await assertPainted(page.locator(':focus'));
}));

test('Back from an unplayed Episode Detail reuses the ordered Series list', async () => withPage(async (page) => {
    await page.evaluate(() => {
        window.__seriesEpisodeQueries = [];
        const getEpisodes = window.ApiClient.getEpisodes.bind(window.ApiClient);
        window.ApiClient.getEpisodes = function (id, options) {
            return getEpisodes(id, options).then((result) => {
                window.__seriesEpisodeQueries.push({
                    items: result.Items.length,
                    bytes: new Blob([JSON.stringify(result)]).size,
                });
                return result;
            });
        };
    });
    await openSeriesOne(page);
    await page.waitForSelector('.jq-series-episodes .jq-media-card');
    await openSeasonMenu(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-item-id="episode-17"]');

    await page.evaluate(() => document.querySelector('[data-item-id="episode-17"]').click());
    await page.waitForSelector('.jq-detail-screen');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.jq-series-season-button');
    // Completion condition accepts both the correct list and an empty/foreign
    // cached list, so the content assertion below—not a timeout—distinguishes
    // them. A reversed list also completes here with the wrong card order.
    await page.waitForFunction(() =>
        document.querySelector('.jq-series-episodes .jq-media-card')
        || document.querySelector('.jq-series-status')?.textContent === 'No episodes in this season yet.');

    assert.equal(await page.locator('.jq-series-season-button').textContent(), 'Season 2 ▾');
    const queries = await page.evaluate(() => window.__seriesEpisodeQueries);
    assert.equal(queries.length, 1, `expected one whole-series response, got ${JSON.stringify(queries)}`);
    assert.equal(queries[0].items, 354);
    assert.deepEqual(await page.locator('.jq-series-episodes .jq-media-card').evaluateAll((cards) =>
        cards.map((card) => ({
            id: card.getAttribute('data-item-id'),
            meta: card.querySelector('.jq-media-card-meta')?.textContent ?? '',
        }))), Array.from({ length: 15 }, (_, index) => ({
        id: `episode-${index + 16}`, meta: `S2 E${index + 1}`,
    })));
}));

// NON-REGRESSION GUARD: master also fetched twice because it had no cache.
// With the navigation-local cache this becomes load-bearing: a playback
// request can update episode UserData, so Back must refetch before deriving
// Resume/Continue rather than reuse the pre-playback list.
test('playback from Episode Detail invalidates the ordered Series list before Back', async () => withPage(async (page) => {
    await page.evaluate(() => {
        window.__seriesEpisodeQueryCount = 0;
        const getEpisodes = window.ApiClient.getEpisodes.bind(window.ApiClient);
        window.ApiClient.getEpisodes = function (id, options) {
            window.__seriesEpisodeQueryCount += 1;
            return getEpisodes(id, options);
        };
    });
    await openSeriesOne(page);
    await page.waitForSelector('.jq-series-episodes .jq-media-card');
    await page.evaluate(() => document.querySelector('[data-item-id="episode-1"]').click());
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(() => window.playbackManager.__calls.length > 0);
    await page.evaluate(() => window.playbackManager.__endPlayback());
    await page.keyboard.press('Escape');
    await page.waitForSelector('.jq-series-episodes .jq-media-card');

    assert.equal(await page.evaluate(() => window.__seriesEpisodeQueryCount), 2,
        'return after playback must refetch current UserData');
}));

test('playback from a Series action invalidates the ordered list before a later Detail return', async () => withPage(async (page) => {
    await instrumentSeriesWithProgress(page);
    await openSeriesOne(page);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.waitForFunction(() => window.playbackManager.__calls.length > 0);
    await page.evaluate(() => {
        window.playbackManager.__endPlayback();
        document.querySelector('[data-item-id="episode-3"]').click();
    });
    await page.waitForSelector('.jq-detail-screen');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.jq-series-episodes .jq-media-card');

    assert.equal(await page.evaluate(() => window.__seriesEpisodeQueryCount), 2,
        'a Series action can change progress, so a later Detail return must refetch UserData');
}));

test('a rejected Series playback request still invalidates the ordered list', async () => withPage(async (page) => {
    await instrumentSeriesWithProgress(page);
    await page.evaluate(() => {
        window.playbackManager.play = () => Promise.reject(new Error('player unavailable'));
    });
    await openSeriesOne(page);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.waitForFunction(() =>
        document.querySelector('.jq-series-play-error')?.textContent === 'Could not start playback. Try again.');
    await page.evaluate(() => document.querySelector('[data-item-id="episode-3"]').click());
    await page.waitForSelector('.jq-detail-screen');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.jq-series-episodes .jq-media-card');

    assert.equal(await page.evaluate(() => window.__seriesEpisodeQueryCount), 2,
        'rejected Series playback must invalidate conservatively');
}));

test('a rejected Detail playback request still invalidates the ordered list', async () => withPage(async (page) => {
    await page.evaluate(() => {
        window.__seriesEpisodeQueryCount = 0;
        const getEpisodes = window.ApiClient.getEpisodes.bind(window.ApiClient);
        window.ApiClient.getEpisodes = function (id, options) {
            window.__seriesEpisodeQueryCount += 1;
            return getEpisodes(id, options);
        };
        window.playbackManager.play = () => Promise.reject(new Error('player unavailable'));
    });
    await openSeriesOne(page);
    await page.waitForSelector('.jq-series-episodes .jq-media-card');
    await page.evaluate(() => document.querySelector('[data-item-id="episode-1"]').click());
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(() =>
        document.querySelector('.jq-detail-error')?.textContent === 'Could not start playback. Try again.');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.jq-series-episodes .jq-media-card');

    assert.equal(await page.evaluate(() => window.__seriesEpisodeQueryCount), 2,
        'rejected Detail playback must invalidate conservatively');
}));

test('the browser exits by Enter on Back, hardware Back, and ArrowLeft to the rail', async () => withPage(async (page) => {
    await openSeriesOne(page);
    await page.waitForSelector('.jq-series-episodes .jq-media-card');

    // Up from the selector reaches Back; Enter there leaves the screen.
    assert.equal((await pressAndAssertFocus(page, 'ArrowUp')).className.includes('jq-back-button'), true);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.jq-home-row-heading');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('jq-media-card')), true);
    await assertPainted(page.locator(':focus'));

    await openSeriesOne(page);
    await page.waitForSelector('.jq-series-episodes .jq-media-card');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.jq-home-row-heading');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('jq-media-card')), true);
    await assertPainted(page.locator(':focus'));

    await openSeriesOne(page);
    await page.waitForSelector('.jq-series-episodes .jq-media-card');
    assert.equal((await pressAndAssertFocus(page, 'ArrowLeft')).className.includes('jq-rail-item'), true);
    await assertPainted(page.locator(':focus'));
}));

test('hardware Back closes the season dropdown before it leaves the screen', async () => withPage(async (page) => {
    await openSeriesOne(page);
    await page.waitForSelector('.jq-series-episodes .jq-media-card');
    await openSeasonMenu(page);

    await page.keyboard.press('Escape');
    await page.waitForSelector('.jq-series-season-menu[hidden]', { state: 'attached' });
    assert.equal(await page.locator('.jq-series-screen').count(), 1, 'Back must close the dropdown, not the screen');
    assert.equal((await focusSnapshot(page)).className.includes('jq-series-season-button'), true);
    await assertPainted(page.locator(':focus'));

    // And a second Back now leaves, so the exit is only ever one press behind.
    await page.keyboard.press('Escape');
    await page.waitForSelector('.jq-home-row-heading');
}));

test('ArrowLeft from the first episode column reaches the rail', async () => withPage(async (page) => {
    await openSeriesOne(page);
    await page.waitForSelector('.jq-series-episodes .jq-media-card');

    assert.equal((await pressAndAssertFocus(page, 'ArrowDown')).id, 'episode-1');
    assert.equal((await pressAndAssertFocus(page, 'ArrowLeft')).className.includes('jq-rail-item'), true);
    await assertPainted(page.locator(':focus'));
}));

test('a show with no seasons says so, asks for no episodes, and keeps a visible cursor', async () => withPage(async (page) => {
    await recordShowQueries(page);
    // MEASURED on the household server: NHL is a real series in the library
    // with zero seasons and zero episodes.
    await renderSeriesDirectly(page, { Id: 'series-nhl', Name: 'NHL', Type: 'Series' });
    await page.waitForFunction(() =>
        document.querySelector('.jq-series-status')?.textContent === 'No episodes are available for this show yet.');

    assert.equal(await page.locator('.jq-series-episodes .jq-media-card').count(), 0);
    assert.equal(await page.locator('.jq-series-season-button').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__showCalls.episodes), []);
    assert.equal((await focusSnapshot(page)).className.includes('jq-back-button'), true);
    await assertPainted(page.locator('.jq-series-status'));
    await assertPainted(page.locator(':focus'));
}));

test('the deepest measured show mounts one season, without its virtual records', async () => withPage(async (page) => {
    await recordShowQueries(page);
    // MEASURED: PAW Patrol is the household's deepest series -- 346 real
    // episodes across 13 seasons, plus 129 VIRTUAL placeholder records that a
    // naive fetch would return as well (475 in total).
    await renderSeriesDirectly(page, { Id: 'series-paw-patrol', Name: 'PAW Patrol', Type: 'Series' });
    await page.waitForSelector('.jq-series-episodes .jq-media-card');

    await openSeasonMenu(page);
    assert.equal(await page.locator('.jq-series-season-option').count(), 13);
    await page.keyboard.press('Escape');

    const cards = await cardText(page);
    assert.equal(cards.length, 27, 'the fixture season is 27 episodes and all of them fit one window');
    assert.ok(cards.length <= WINDOW_SIZE, `mounted ${cards.length} cards, limit is ${WINDOW_SIZE}`);
    for (const card of cards) {
        assert.equal(card.title.includes('Virtual'), false, 'virtual placeholder records must not be mounted');
    }
    assert.equal(cards[0].title, 'PAW Patrol 1x1');
    assert.equal(cards[0].meta, 'S1 E1');
}));

test('a season larger than one window mounts at most a window and traverses both ways', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(15000);
        await page.goto(simulatorUrl);
        await page.waitForSelector('.jq-profile-card');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.jq-home-row-heading');

        // DELIBERATELY SYNTHETIC, and labelled as such. No measured household
        // season is this large -- PAW Patrol's 346 episodes are split across
        // 13 seasons. But that per-season split was never probed (the
        // fixture's own comment calls it INFERRED), and a single-season show
        // of several hundred episodes is not ruled out by anything measured.
        // This exercises the bound that exists for that case; it does not
        // claim such a season exists in the library.
        const EPISODE_COUNT = 346;
        await page.evaluate((count) => {
            const items = [];
            for (let i = 1; i <= count; i++) {
                items.push({
                    Id: 'deep-' + i, Name: 'Deep episode ' + i, Type: 'Episode',
                    SeriesId: 'series-1', SeriesName: 'Northern Stories 1', SeasonId: 'season-1',
                    ParentIndexNumber: 1, IndexNumber: i, ImageTags: { Primary: 'deep-tag' },
                });
            }
            window.ApiClient.getSeasons = () => Promise.resolve({
                Items: [{ Id: 'season-1', Name: 'Season 1', Type: 'Season', IndexNumber: 1 }],
                TotalRecordCount: 1,
            });
            window.ApiClient.getEpisodes = () => Promise.resolve({ Items: items, TotalRecordCount: items.length });
            window.__maxSeriesCards = 0;
            new MutationObserver(() => {
                window.__maxSeriesCards = Math.max(window.__maxSeriesCards,
                    document.querySelectorAll('.jq-series-episodes .jq-media-card').length);
            }).observe(document.getElementById('jellyquest-root'), { childList: true, subtree: true });
            window.JellyQuestSeriesScreen.render(
                window.JellyQuestShell.getContent(),
                { Id: 'series-1', Name: 'Deep show', Type: 'Series' },
                { onBack() {}, onSelectItem() {}, onSeasonChange() {} }
            );
        }, EPISODE_COUNT);
        await page.waitForSelector('[data-item-id="deep-1"]');

        const mountedIds = () => page.locator('.jq-series-episodes .jq-media-card')
            .evaluateAll((cards) => cards.map((card) => Number(card.dataset.itemId.slice('deep-'.length))));

        const assertWindow = async () => {
            const ids = await mountedIds();
            assert.ok(ids.length <= WINDOW_SIZE, `mounted ${ids.length} cards, limit is ${WINDOW_SIZE}`);
            assert.equal(new Set(ids).size, ids.length, 'the mounted window must not contain duplicates');
            for (let i = 1; i < ids.length; i++) {
                assert.equal(ids[i], ids[i - 1] + 1, 'the mounted window must stay in item order');
            }
            return ids;
        };
        assert.equal((await assertWindow()).length, WINDOW_SIZE);

        // Into the grid, then all the way down and all the way back up.
        assert.equal((await pressAndAssertFocus(page, 'ArrowDown')).id, 'deep-1');
        const rows = Math.ceil(EPISODE_COUNT / COLUMNS);
        for (let row = 1; row < rows; row++) {
            const focus = await pressAndAssertFocus(page, 'ArrowDown');
            assert.equal(focus.id, 'deep-' + (row * COLUMNS + 1));
            await assertWindow();
        }
        for (let row = rows - 2; row >= 0; row--) {
            const focus = await pressAndAssertFocus(page, 'ArrowUp');
            assert.equal(focus.id, 'deep-' + (row * COLUMNS + 1));
            await assertWindow();
        }
        assert.ok(await page.evaluate(() => window.__maxSeriesCards) <= WINDOW_SIZE,
            'no moment of the traversal may mount more than one window');
        // And back out of the grid to the selector, so the whole list is exitable.
        assert.equal((await pressAndAssertFocus(page, 'ArrowUp')).className.includes('jq-series-season-button'), true);
        await assertPainted(page.locator(':focus'));
    } finally {
        await browser.close();
    }
});

test('a season with no episodes says so and leaves a usable cursor on the selector', async () => withPage(async (page) => {
    // The fixture models no empty season -- every one of series-1's 24 and
    // PAW Patrol's 13 carries episodes -- so the empty response is stubbed
    // HERE, in the spec, exactly as the ordering and windowing tests above
    // stub theirs. dev/fixtures/api-client-stub.js is deliberately untouched;
    // its strictness is load-bearing and this test does not need it relaxed.
    await page.evaluate(() => {
        window.ApiClient.getEpisodes = () => Promise.resolve({ Items: [], TotalRecordCount: 0 });
    });
    await openSeriesOne(page);
    await page.waitForFunction(() =>
        document.querySelector('.jq-series-status')?.textContent === 'No episodes in this season yet.');

    assert.equal(await page.locator('.jq-series-episodes .jq-media-card').count(), 0);
    assert.equal(await page.locator('.jq-series-status').isVisible(), true);
    await assertPainted(page.locator('.jq-series-status'));

    // A television with no console needs the message AND a way out of the
    // state it describes: the cursor stays on the selector, so another season
    // is one press away, and the rail is one press left of that.
    assert.equal((await focusSnapshot(page)).className.includes('jq-series-season-button'), true);
    await assertPainted(page.locator(':focus'));
    assert.equal((await pressAndAssertFocus(page, 'ArrowLeft')).className.includes('jq-rail-item'), true);
    await assertPainted(page.locator(':focus'));
}));

test('a client without the show endpoints says so and leaves a usable cursor on Back', async () => withPage(async (page) => {
    // jellyquest.js is injected ahead of jellyfin-web's own bundle and app.js
    // already polls for ApiClient to appear (the Phase 5 boot race), so "the
    // client is present but does not carry the Show endpoints" is the shape
    // this guard exists for. Removing the method reproduces it without
    // touching the fixture.
    await page.evaluate(() => { delete window.ApiClient.getSeasons; });
    await renderSeriesDirectly(page, { Id: 'series-1', Name: 'Northern Stories 1', Type: 'Series' });
    await page.waitForFunction(() =>
        document.querySelector('.jq-series-status')?.textContent === 'Shows are unavailable right now. Try again.');

    assert.equal(await page.locator('.jq-series-status').isVisible(), true);
    await assertPainted(page.locator('.jq-series-status'));
    assert.equal(await page.locator('.jq-series-season-button').count(), 0);
    assert.equal(await page.locator('.jq-series-episodes .jq-media-card').count(), 0);

    // This branch returns before anything is awaited, so the cursor is where
    // the synchronous render put it: on Back, which is the only way out.
    assert.equal((await focusSnapshot(page)).className.includes('jq-back-button'), true);
    await assertPainted(page.locator(':focus'));
    assert.equal((await pressAndAssertFocus(page, 'ArrowLeft')).className.includes('jq-rail-item'), true);
    await assertPainted(page.locator(':focus'));
}));

test('a failed season request says so on screen and leaves the cursor on Back', async () => withPage(async (page) => {
    await page.evaluate(() => {
        window.ApiClient.getSeasons = () => Promise.reject(new Error('seasons unavailable'));
    });
    await renderSeriesDirectly(page, { Id: 'series-1', Name: 'Northern Stories 1', Type: 'Series' });
    await page.waitForFunction(() =>
        document.querySelector('.jq-series-status')?.textContent === 'Couldn’t load this show’s seasons. Try again.');

    assert.equal((await focusSnapshot(page)).className.includes('jq-back-button'), true);
    await assertPainted(page.locator('.jq-series-status'));
    await assertPainted(page.locator(':focus'));
}));

test('a failed episode request says so, and re-choosing the season is the retry', async () => withPage(async (page) => {
    await page.evaluate(() => {
        const getEpisodes = window.ApiClient.getEpisodes.bind(window.ApiClient);
        window.__failEpisodes = true;
        window.ApiClient.getEpisodes = function (id, options) {
            if (window.__failEpisodes) return Promise.reject(new Error('episodes unavailable'));
            return getEpisodes(id, options);
        };
    });
    await openSeriesOne(page);
    await page.waitForFunction(() =>
        document.querySelector('.jq-series-status')?.textContent === 'Couldn’t load this show’s episodes. Try again.');

    assert.equal(await page.locator('.jq-series-episodes .jq-media-card').count(), 0);
    assert.equal((await focusSnapshot(page)).className.includes('jq-series-season-button'), true);
    await assertPainted(page.locator('.jq-series-status'));

    await page.evaluate(() => { window.__failEpisodes = false; });
    await openSeasonMenu(page);
    await page.keyboard.press('Enter'); // the same season again
    await page.waitForSelector('.jq-series-episodes .jq-media-card');
    assert.equal(await page.locator('.jq-series-status').isVisible(), false);
    assert.equal((await focusSnapshot(page)).className.includes('jq-series-season-button'), true);
    await assertPainted(page.locator(':focus'));
}));

test('a late episode response does not steal a newer rail selection', async () => withPage(async (page) => {
    await page.evaluate(() => {
        window.ApiClient.getEpisodes = () => new Promise((resolve) => { window.__resolveEpisodes = resolve; });
    });
    await openSeriesOne(page);
    await page.waitForFunction(() =>
        document.querySelector('.jq-series-status')?.textContent === 'Loading episodes…');

    await page.evaluate(() => document.querySelector('.jq-nav-search').focus());
    await assertPainted(page.locator('.jq-nav-search'));
    await page.evaluate(() => window.__resolveEpisodes({
        Items: [{ Id: 'late-episode', Name: 'Late episode', Type: 'Episode', SeasonId: 'season-1', ParentIndexNumber: 1, IndexNumber: 1 }],
        TotalRecordCount: 1,
    }));
    await page.waitForSelector('[data-item-id="late-episode"]');

    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('jq-nav-search')), true,
        'the completed request must preserve the newer rail focus');
    await assertPainted(page.locator('.jq-nav-search'));
}));
