import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { startServer } from './support/server.mjs';
import { assertPainted } from './support/paint.mjs';

const server = await startServer();
test.after(() => server.close());

async function withPage(run) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(5000);
        await page.goto(`${server.baseUrl}/dev/simulator.html`);
        await page.waitForSelector('.jq-profile-card');
        await run(page);
    } finally {
        await browser.close();
    }
}

async function signIn(page) {
    await page.keyboard.press('Enter');
    await page.waitForSelector('.jq-home-row-heading');
}

const ids = (page, selector) => page.locator(selector).evaluateAll(cards => cards.map(card => card.dataset.itemId));

test('fixture models root views, recursive and parent scope, type filters, bounds and rejects unknown options', async () => {
    const context = vm.createContext({ window: {} });
    vm.runInContext(fs.readFileSync('dev/fixtures/api-client-stub.js', 'utf8'), context);
    const api = context.window.ApiClient;
    for (const query of [{}, { Filters: 'IsResumable' }, { SortBy: 'DateCreated', Limit: 8 }]) {
        const result = await api.getItems('user-alice', query);
        assert.equal(result.TotalRecordCount, 5);
        assert.ok(result.Items.every(item => item.IsFolder));
    }
    const recursive = await api.getItems('user-alice', { Recursive: true, IncludeItemTypes: 'Movie,Episode', Filters: 'IsResumable' });
    assert.deepEqual(Array.from(recursive.Items, item => item.Id), ['movie-1', 'movie-3', 'episode-516']);
    for (const [direction, expected] of [
        ['Descending', ['movie-1', 'episode-516', 'movie-3']],
        ['Ascending', ['movie-3', 'episode-516', 'movie-1']]
    ]) {
        const played = await api.getItems('user-alice', { Recursive: true, IncludeItemTypes: 'Movie,Episode', Filters: 'IsResumable', SortBy: 'DatePlayed', SortOrder: direction });
        assert.deepEqual(Array.from(played.Items, item => item.Id), expected);
    }
    const children = await api.getItems('user-alice', { ParentId: 'movies', IncludeItemTypes: 'Movie' });
    assert.equal(children.Items.length, 10);
    const descendants = await api.getItems('user-alice', { ParentId: 'shows', Recursive: true, IncludeItemTypes: 'Episode' });
    assert.equal(descendants.Items.length, 700);
    const limited = await api.getItems('user-alice', { Recursive: true, IncludeItemTypes: 'Movie,Series', SortBy: 'DateCreated', SortOrder: 'Descending', Limit: 50 });
    assert.equal(limited.Items.length, 50);
    assert.equal(limited.TotalRecordCount, 54);
    assert.equal(limited.Items[0].Id, 'movie-10');
    const all = (await api.getItems('user-alice', { Recursive: true })).Items;
    assert.ok(all.every(item => item.ServerId && item.ImageTags));
    for (const [type, total, primary] of [['Movie', 10, 10], ['Series', 44, 44], ['Season', 37, 33], ['Episode', 700, 515]]) {
        const items = all.filter(item => item.Type === type);
        assert.equal(items.length, total);
        assert.equal(items.filter(item => item.ImageTags.Primary).length, primary);
    }
    const episodes = all.filter(item => item.Type === 'Episode');
    assert.equal(episodes.filter(item => item.ParentBackdropImageTags.length).length, 699);
    assert.ok(episodes.every(item => item.SeriesId && item.SeriesName && item.SeasonId && item.ParentIndexNumber && item.IndexNumber && item.ParentBackdropItemId));
    const movies = all.filter(item => item.Type === 'Movie');
    assert.equal(movies.filter(item => item.BackdropImageTags.length).length, 9,
        'fixture mirrors near-universal movie backdrop coverage with one Primary-only terminal fallback');
    // The other direction of the same principle as the option guard below:
    // the fixture must not RETURN fields the real server does not. MEASURED
    // against Jellyfin 10.11.11, a list response carries none of these; the
    // single-item endpoint carries all of them with no Fields parameter.
    const detailOnly = ['Overview', 'LocalTrailerCount', 'MediaStreams', 'MediaSources', 'RemoteTrailers'];
    for (const item of all) {
        for (const field of detailOnly) {
            assert.ok(!(field in item), `getItems must not return ${field} (${item.Id})`);
        }
    }
    const fullMovie = await api.getItem('user-alice', 'movie-1');
    assert.ok(fullMovie.Overview);
    assert.equal(fullMovie.LocalTrailerCount, 1);
    assert.equal(fullMovie.MediaStreams.filter(stream => stream.Type === 'Audio').length, 2);
    assert.deepEqual(Array.from(fullMovie.MediaStreams, stream => stream.Index), [2, 5, 9, 12]);
    const remoteOnly = await api.getItem('user-alice', 'movie-2');
    assert.equal(remoteOnly.LocalTrailerCount, 0);
    assert.equal(remoteOnly.RemoteTrailers.length, 1);
    for (const id of ['series-paw-patrol', 'season-25', 'episode-355']) {
        const fullItem = await api.getItem('user-alice', id);
        assert.ok(fullItem.Overview, `${id} single-item fetch must be rich`);
        assert.equal(fullItem.LocalTrailerCount, 0);
    }
    const fullEpisode = await api.getItem('user-alice', 'episode-355');
    assert.deepEqual(Array.from(fullEpisode.MediaStreams, stream => stream.Index), [3, 8]);
    assert.equal(fullEpisode.MediaSources.length, 1);

    // StartIndex used to be in the rejection list below. The Library screen
    // now sends it, so the fixture models it -- and modelling it means
    // reproducing what the real server does with it, asserted here. The
    // rejection list keeps every option the app still never sends, plus the
    // StartIndex SHAPES it never sends: strictness moved, it did not loosen.
    const paged = [];
    for (let start = 0; start < 54; start += 20) {
        const page = await api.getItems('user-alice', { Recursive: true, IncludeItemTypes: 'Movie,Series', SortBy: 'DateCreated', SortOrder: 'Descending', StartIndex: start, Limit: 20 });
        assert.equal(page.TotalRecordCount, 54, 'TotalRecordCount must report the whole match count, not the page');
        paged.push(...page.Items.map(item => item.Id));
    }
    // Array.from, not .map: Items is built inside the vm context, so .map
    // returns an array on THAT realm's Array.prototype and deepStrictEqual
    // rejects it against a test-realm array however equal the contents are.
    const unpaged = Array.from((await api.getItems('user-alice', { Recursive: true, IncludeItemTypes: 'Movie,Series', SortBy: 'DateCreated', SortOrder: 'Descending' })).Items, item => item.Id);
    assert.equal(paged.length, 54);
    assert.deepEqual(paged, unpaged, 'paged reads must reassemble the unpaged order');
    assert.equal(new Set(paged).size, 54);
    assert.equal((await api.getItems('user-alice', { Recursive: true, IncludeItemTypes: 'Movie,Series', StartIndex: 54, Limit: 20 })).Items.length, 0,
        'a StartIndex at the end of the result returns an empty page');

    for (const query of [{ Fields: 'Overview' }, { Filters: 'IsFavorite' }, { SortBy: 'Name' }, { Recursive: 'true' }, { ParentId: 'unknown' }, { IncludeItemTypes: 'Audio' },
        { StartIndex: '1' }, { StartIndex: 1.5 }, { StartIndex: -1 }, { StartIndex: null }]) {
        assert.throws(() => api.getItems('user-alice', query), /Unmodeled/);
    }
});

test('fixture models empty and deep series with honest show-endpoint semantics', async () => {
    const context = vm.createContext({ window: {} });
    vm.runInContext(fs.readFileSync('dev/fixtures/api-client-stub.js', 'utf8'), context);
    const api = context.window.ApiClient;

    const nhlEpisodes = await api.getEpisodes('series-nhl', { UserId: 'user-alice' });
    assert.equal(nhlEpisodes.TotalRecordCount, 0);
    assert.equal(nhlEpisodes.Items.length, 0);
    const nhlSeasons = await api.getSeasons('series-nhl', { UserId: 'user-alice' });
    assert.equal(nhlSeasons.TotalRecordCount, 0);

    const pawSeasons = await api.getSeasons('series-paw-patrol', { UserId: 'user-alice' });
    assert.equal(pawSeasons.TotalRecordCount, 13);
    assert.deepEqual(Array.from(pawSeasons.Items, season => season.IndexNumber), Array.from({ length: 13 }, (_, index) => index + 1));
    assert.ok(pawSeasons.Items.every(season => season.ServerId && season.Type === 'Season' && !('Overview' in season)));
    const richSeason = await api.getSeasons('series-paw-patrol', { UserId: 'user-alice', Fields: 'Overview' });
    assert.ok(richSeason.Items.every(season => season.Overview));

    const naive = await api.getEpisodes('series-paw-patrol', { UserId: 'user-alice' });
    assert.equal(naive.TotalRecordCount, 475);
    assert.equal(naive.Items.filter(episode => episode.LocationType === 'Virtual').length, 129);
    assert.ok(naive.Items.every(episode => episode.ServerId && !('Overview' in episode) && !('MediaStreams' in episode)));
    const diskOnly = await api.getEpisodes('series-paw-patrol', {
        UserId: 'user-alice', IsMissing: false, IsVirtualUnaired: false
    });
    assert.equal(diskOnly.TotalRecordCount, 346);
    assert.equal(diskOnly.Items.length, 346);
    assert.equal(diskOnly.Items.filter(episode => !episode.ImageTags.Primary).length, 92);
    assert.equal((await api.getEpisodes('series-paw-patrol', { UserId: 'user-alice', IsVirtualUnaired: false })).TotalRecordCount, 446);
    assert.equal((await api.getEpisodes('series-paw-patrol', { UserId: 'user-alice', IsMissing: true, IsVirtualUnaired: false })).TotalRecordCount, 100);
    const firstSeason = await api.getEpisodes('series-paw-patrol', {
        UserId: 'user-alice', SeasonId: 'season-25', IsMissing: false, IsVirtualUnaired: false
    });
    assert.equal(firstSeason.TotalRecordCount, 27);
    assert.ok(firstSeason.Items.every(episode => episode.SeasonId === 'season-25'));

    // MEASURED server trap: this endpoint accepts these list-looking options
    // but ignores them. The played dates sit well after the unplayed first
    // item, so either filtering or sorting would fail these assertions.
    const ignored = await api.getEpisodes('series-paw-patrol', {
        UserId: 'user-alice', IsMissing: false, IsVirtualUnaired: false,
        Filters: 'IsResumable', SortBy: 'DatePlayed', SortOrder: 'Descending'
    });
    assert.equal(ignored.Items.length, 346);
    assert.equal(ignored.Items[0].Id, 'episode-355');
    assert.equal(ignored.Items[0].UserData.LastPlayedDate, undefined);
    assert.deepEqual([38, 56, 73].map(position => ignored.Items[position - 1].Id), ['episode-392', 'episode-410', 'episode-427']);
    assert.ok([38, 56, 73].every(position => ignored.Items[position - 1].UserData.LastPlayedDate));
    const otherValidEnums = await api.getEpisodes('series-paw-patrol', {
        UserId: 'user-alice', IsMissing: false, Filters: 'IsFavorite', SortBy: 'Name', Fields: 'Path'
    });
    assert.equal(otherValidEnums.Items[0].Id, 'episode-355');
    assert.equal(otherValidEnums.Items.length, 346);
    const limited = await api.getEpisodes('series-paw-patrol', {
        UserId: 'user-alice', IsMissing: false, IsVirtualUnaired: false,
        Filters: 'IsResumable', SortBy: 'DatePlayed', SortOrder: 'Descending', Limit: 1
    });
    assert.equal(limited.Items.length, 1);
    assert.equal(limited.Items[0].Id, 'episode-355');
    assert.equal(limited.TotalRecordCount, 346);

    const richEpisode = await api.getEpisodes('series-paw-patrol', {
        UserId: 'user-alice', IsMissing: false, Limit: 1, Fields: 'Overview,MediaStreams,MediaSources,LocalTrailerCount'
    });
    assert.ok(richEpisode.Items[0].Overview);
    assert.deepEqual(Array.from(richEpisode.Items[0].MediaStreams, stream => stream.Index), [3, 8]);
    assert.equal(richEpisode.Items[0].LocalTrailerCount, 0);
    for (const query of [{ Bogus: true }, { Limit: -1 }, { Filters: 'NotAFilter' }, { SortBy: 'NotASort' }]) {
        assert.throws(() => api.getEpisodes('series-paw-patrol', query), /Unmodeled/);
    }
    for (const call of [
        () => api.getEpisodes('series-nhl', { Fields: 'NotAField' }),
        () => api.getSeasons('series-nhl', { Fields: 'NotAField' }),
        () => api.getEpisodes('series-paw-patrol', { Limit: 0, Fields: 'NotAField' }),
        () => api.getEpisodes('series-paw-patrol', { SeasonId: 'season-999', Fields: 'NotAField' })
    ]) {
        assert.throws(call, /Unmodeled Fields value: NotAField/);
    }
    assert.throws(() => api.getEpisodes('missing-series'), /Unknown seriesId/);
});

test('Home and Library use independent media queries and Library reaches beyond eight up to its own bound', async () => withPage(async page => {
    await page.evaluate(() => {
        const original = window.ApiClient.getItems;
        window.__queries = [];
        window.ApiClient.getItems = function (user, options) {
            window.__queries.push(options);
            return original(user, options);
        };
    });
    await signIn(page);
    assert.deepEqual(await page.evaluate(() => window.__queries[0]), { Recursive: true, IncludeItemTypes: 'Movie,Episode', Filters: 'IsResumable', SortBy: 'DatePlayed', SortOrder: 'Descending' });
    assert.deepEqual(await ids(page, '.jq-home-row-section:first-child .jq-media-card'), ['movie-1', 'episode-516', 'movie-3']);
    const continueCards = await page.locator('.jq-home-row-section:first-child .jq-media-card').evaluateAll((cards) =>
        cards.map((card) => ({ id: card.dataset.itemId, height: card.getBoundingClientRect().height,
            shape: card.classList.contains('jq-media-card-episode') ? 'landscape' : 'poster' })));
    assert.deepEqual(continueCards, [
        { id: 'movie-1', height: 204, shape: 'landscape' },
        { id: 'episode-516', height: 204, shape: 'landscape' },
        { id: 'movie-3', height: 204, shape: 'landscape' },
    ], 'Continue Watching must be one level 16:9 resume row even when item types are mixed');
    const progress = await page.locator('.jq-home-row-section:first-child [data-item-id="movie-1"] .jq-media-card-progress').evaluate((bar) => {
        const card = bar.parentElement.getBoundingClientRect();
        const bounds = bar.getBoundingClientRect();
        return { inside: bounds.left >= card.left && bounds.right <= card.right && bounds.top >= card.top && bounds.bottom <= card.bottom,
            overflow: getComputedStyle(bar).overflow };
    });
    assert.deepEqual(progress, { inside: true, overflow: 'hidden' },
        'resume progress remains inside the landscape card and clips only its fill');
    assert.equal(await page.locator('.jq-home-row-section').nth(1).locator('.jq-media-card').count(), 8);
    assert.ok((await ids(page, '.jq-home-row-section:nth-child(2) .jq-media-card')).includes('series-1'));
    assert.equal(await page.locator('.jq-home-row-section:nth-child(2) .jq-media-card').evaluateAll((cards) =>
        cards.every((card) => card.getBoundingClientRect().height === 410)), true,
    'Recently Added remains a poster row');
    await page.keyboard.press('ArrowDown');
    const rowItems = await page.locator('.jq-see-all').locator('..').locator('.jq-focusable').count();
    for (let i = 1; i < rowItems; i++) await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator(':focus').getAttribute('class'), 'jq-card jq-focusable jq-see-all');
    await assertPainted(page.locator(':focus'));
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.jq-library-screen').count(), 1);
    await page.waitForSelector('.jq-library-grid .jq-media-card');
    assert.equal(await page.locator('.jq-library-grid .jq-media-card').count(), 48);
    assert.equal(await page.locator('.jq-library-grid .jq-media-card').evaluateAll((cards) =>
        cards.every((card) => card.getBoundingClientRect().height === 410)), true,
    'Movie/Series Library remains a poster grid');
    const libraryIds = await ids(page, '.jq-library-grid .jq-media-card');
    assert.ok(libraryIds.some(id => id.startsWith('movie-')), 'See All must include films');
    assert.ok(libraryIds.some(id => id.startsWith('series-')), 'See All remains a mixed grid');
    assert.ok(libraryIds.every(id => !id.startsWith('episode-')), 'See All excludes Episodes');
    assert.deepEqual(await page.evaluate(() => window.__queries), [
        { Recursive: true, IncludeItemTypes: 'Movie,Episode', Filters: 'IsResumable', SortBy: 'DatePlayed', SortOrder: 'Descending' },
        { Recursive: true, IncludeItemTypes: 'Movie,Series', SortBy: 'DateCreated', SortOrder: 'Descending', Limit: 8 },
        { Recursive: true, IncludeItemTypes: 'Movie,Series', SortBy: 'DateCreated', SortOrder: 'Descending', StartIndex: 0, Limit: 96 }
    ]);
}));

async function openShowsWithRemote(page) {
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('jq-nav-home')), true);
    await assertPainted(page.locator(':focus'));
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('jq-nav-shows')), true);
    await assertPainted(page.locator(':focus'));
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.jq-library-screen').count(), 1,
        'Enter on keyboard-focused Shows must synchronously open Library');
    await page.waitForSelector('.jq-library-grid .jq-media-card');
}

test('Shows rail entry requests and presents only Series in SortName order', async () => withPage(async page => {
    await signIn(page);
    await page.evaluate(() => {
        const original = window.ApiClient.getItems;
        window.__showsQueries = [];
        window.ApiClient.getItems = function (user, options) {
            window.__showsQueries.push(options);
            return original(user, options);
        };
    });

    assert.equal(await page.locator('.jq-nav-shows').count(), 1,
        'Shows must be a first-class entry in the persistent rail');
    await openShowsWithRemote(page);

    assert.equal(await page.locator('.jq-library-heading').textContent(), 'Shows');
    assert.deepEqual(await page.evaluate(() => window.__showsQueries), [
        { Recursive: true, IncludeItemTypes: 'Series', SortBy: 'SortName', SortOrder: 'Ascending', StartIndex: 0, Limit: 96 }
    ]);
    assert.equal(await page.locator('.jq-library-grid .jq-media-card').count(), 44,
        'the fixture collection fits under the shared 48-card mounted window');
    assert.deepEqual(await page.locator('.jq-library-grid .jq-media-card').evaluateAll((cards) =>
        cards.map((card) => card.querySelector('.jq-media-card-title').textContent)),
    [
        'NHL', 'Northern Stories 1', 'Northern Stories 10', 'Northern Stories 11',
        'Northern Stories 12', 'Northern Stories 13', 'Northern Stories 14', 'Northern Stories 15',
        'Northern Stories 16', 'Northern Stories 17', 'Northern Stories 18', 'Northern Stories 19',
        'Northern Stories 2', 'Northern Stories 20', 'Northern Stories 21', 'Northern Stories 22',
        'Northern Stories 23', 'Northern Stories 24', 'Northern Stories 25', 'Northern Stories 26',
        'Northern Stories 27', 'Northern Stories 28', 'Northern Stories 29', 'Northern Stories 3',
        'Northern Stories 30', 'Northern Stories 31', 'Northern Stories 32', 'Northern Stories 33',
        'Northern Stories 34', 'Northern Stories 35', 'Northern Stories 36', 'Northern Stories 37',
        'Northern Stories 38', 'Northern Stories 39', 'Northern Stories 4', 'Northern Stories 40',
        'Northern Stories 41', 'The Northern Stories 42', 'Northern Stories 5', 'Northern Stories 6',
        'Northern Stories 7', 'Northern Stories 8', 'Northern Stories 9',
        'PAW Patrol',
    ]);
    assert.equal(await page.locator('.jq-library-grid .jq-media-card').evaluateAll((cards) =>
        cards.every((card) => card.getBoundingClientRect().height === 410)), true,
    'Series must retain poster geometry rather than episode-still geometry');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.itemId), 'series-nhl');
    await assertPainted(page.locator(':focus'));
}));

test('Shows grid walks every row down and back up to painted Back', async () => withPage(async page => {
    await signIn(page);
    await page.locator('.jq-nav-shows').click();
    await page.waitForSelector('.jq-library-grid .jq-media-card');
    const traversal = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.jq-library-grid .jq-media-card'));
        const first = cards[0].getBoundingClientRect();
        const fifth = cards[4].getBoundingClientRect();
        const screen = document.querySelector('.jq-library-screen');
        return {
            ids: cards.map((card) => card.dataset.itemId),
            pitch: Math.round(fifth.top - first.top),
            range: screen.scrollHeight - screen.clientHeight,
        };
    });
    assert.ok(traversal.range > traversal.pitch * 5,
        `Shows must be deep enough to exercise reveal-on-Up: ${traversal.range}px range, ${traversal.pitch}px pitch`);
    const rows = Math.ceil(traversal.ids.length / 4);
    for (let row = 1; row < rows; row++) {
        await page.keyboard.press('ArrowDown');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.itemId), traversal.ids[row * 4]);
        await assertPainted(page.locator(':focus'));
    }
    for (let row = rows - 2; row >= 0; row--) {
        await page.keyboard.press('ArrowUp');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.itemId), traversal.ids[row * 4]);
        await assertPainted(page.locator(':focus'));
    }
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('jq-back-button')), true);
    await assertPainted(page.locator(':focus'));
}));

test('selecting a Shows card opens the existing Series browser', async () => withPage(async page => {
    await signIn(page);
    await page.locator('.jq-nav-shows').click();
    await page.waitForSelector('[data-item-id="series-1"]');
    await page.locator('[data-item-id="series-1"]').click();
    assert.equal(await page.locator('.jq-series-screen').count(), 1,
        'selecting a show must synchronously cross the existing Series route boundary');
    await page.waitForSelector('.jq-series-episodes .jq-media-card');
    assert.equal(await page.locator('.jq-series-title').textContent(), 'Northern Stories 1');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Season 1 ▾');
    await assertPainted(page.locator(':focus'));
}));

test('Search finds Series and Movies but excludes Episodes', async () => withPage(async page => {
    await signIn(page);
    await page.locator('.jq-nav-search').click();
    for (const [term, expected] of [['Northern Stories 1', 'series-1'], ['Blue Hour', 'movie-9']]) {
        await page.locator('.jq-search-input').fill(term);
        await page.waitForSelector(`.jq-search-results [data-item-id="${expected}"]`);
        assert.ok((await ids(page, '.jq-search-results .jq-media-card')).includes(expected));
    }
    const episodeOnly = await page.evaluate(async () => {
        const result = await window.ApiClient.getItems('user-alice', {
            Recursive: true, IncludeItemTypes: 'Movie,Series,Episode', SearchTerm: 'PAW Patrol 6x27'
        });
        return result.Items.map(item => ({ Id: item.Id, Type: item.Type }));
    });
    assert.deepEqual(episodeOnly, [{ Id: 'episode-516', Type: 'Episode' }],
        'negative search probe requires a real matching Episode in the fixture');
    await page.locator('.jq-search-input').fill('PAW Patrol 6x27');
    const message = page.locator('.jq-search-empty');
    await message.waitFor();
    assert.equal(await message.textContent(), 'No films or shows match. Episode search isn’t available yet.');
    await page.evaluate(() => { document.documentElement.style.fontSize = '27px'; });
    // Search uses px-sized text. Also exercise 69% larger message text as
    // a conservative fit check, without changing the shipped stylesheet.
    for (const fontSize of [20, 33.75]) {
        await message.evaluate((element, size) => { element.style.fontSize = size + 'px'; }, fontSize);
        await assertPainted(message);
        const fit = await message.evaluate(element => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const text = range.getBoundingClientRect();
            const box = element.getBoundingClientRect();
            const container = element.parentElement.getBoundingClientRect();
            return {
                rootFont: getComputedStyle(document.documentElement).fontSize,
                textFont: getComputedStyle(element).fontSize,
                fits: element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight &&
                    text.left >= box.left && text.right <= box.right && text.top >= box.top && text.bottom <= box.bottom &&
                    box.left >= container.left && box.right <= container.right && box.bottom <= container.bottom &&
                    text.left >= 0 && text.right <= window.innerWidth && text.top >= 0 && text.bottom <= window.innerHeight
            };
        });
        assert.equal(fit.rootFont, '27px');
        assert.equal(fit.textFont, fontSize + 'px');
        assert.equal(fit.fits, true, 'The entire empty-result message must fit its paragraph, container and viewport');
    }
    assert.equal(await page.locator('.jq-search-results .jq-media-card').count(), 0);
}));

test('Search caps its query at 24 remote-reachable results', async () => withPage(async page => {
    await signIn(page);
    await page.evaluate(() => {
        const original = window.ApiClient.getItems;
        window.__searchQueries = [];
        window.ApiClient.getItems = function (user, options) {
            window.__searchQueries.push(options);
            return original(user, options);
        };
    });
    await page.locator('.jq-nav-search').click();
    await page.locator('.jq-search-input').fill('Northern');
    await page.waitForSelector('.jq-search-results .jq-media-card');
    assert.deepEqual(await page.evaluate(() => window.__searchQueries), [
        { Recursive: true, IncludeItemTypes: 'Movie,Series', SearchTerm: 'Northern', Limit: 24 }
    ]);
    assert.equal(await page.locator('.jq-search-results .jq-media-card').count(), 24);
    assert.equal(await page.locator('.jq-search-results .jq-media-card').evaluateAll((cards) =>
        cards.every((card) => card.getBoundingClientRect().height === 410)), true,
    'Movie/Series Search remains a poster row');
}));

test('Search excludes episode crowding so a matching Movie is visible within the cap', async () => withPage(async page => {
    await signIn(page);
    const crowded = await page.evaluate(async () => {
        const options = { Recursive: true, IncludeItemTypes: 'Movie,Series,Episode', SearchTerm: 'Quiet Signal', Limit: 24 };
        const withEpisodes = await window.ApiClient.getItems('user-alice', options);
        const withoutEpisodes = await window.ApiClient.getItems('user-alice', { ...options, IncludeItemTypes: 'Movie,Series' });
        return { withEpisodes, withoutEpisodes };
    });
    assert.equal(crowded.withEpisodes.TotalRecordCount, 31);
    assert.equal(crowded.withEpisodes.Items.length, 24);
    assert.ok(crowded.withEpisodes.Items.every(item => item.Type === 'Episode'));
    assert.deepEqual(crowded.withoutEpisodes.Items.map(item => item.Id), ['movie-2']);
    await page.locator('.jq-nav-search').click();
    await page.locator('.jq-search-input').fill('Quiet Signal');
    await page.waitForSelector('.jq-search-results .jq-media-card');
    assert.deepEqual(await ids(page, '.jq-search-results .jq-media-card'), ['movie-2']);
}));

test('Search paints truncation in its existing message and clears it for a narrower search', async () => withPage(async page => {
    await signIn(page);
    await page.locator('.jq-nav-search').click();
    await page.locator('.jq-search-input').fill('Northern');
    await page.waitForSelector('.jq-search-results .jq-media-card');
    const message = page.locator('.jq-search-empty');
    assert.equal(await message.textContent(), 'Showing the first 24 of 42 matches — try a more specific title.');
    await assertPainted(message);
    assert.equal(await message.evaluate(element => element.classList.contains('jq-search-error')), false);
    await page.locator('.jq-search-input').fill('Blue Hour');
    await page.waitForSelector('.jq-search-results [data-item-id="movie-9"]');
    assert.equal(await message.evaluate(element => element.hidden), true);
}));

test('Search treats zero items with a nonzero total as empty rather than truncated', async () => withPage(async page => {
    await signIn(page);
    await page.evaluate(() => {
        window.ApiClient.getItems = () => Promise.resolve({ Items: [], TotalRecordCount: 99 });
    });
    await page.locator('.jq-nav-search').click();
    await page.locator('.jq-search-input').fill('missing');
    const message = page.locator('.jq-search-empty');
    await message.waitFor();
    assert.doesNotMatch(await message.textContent(), /Showing the first/);
    assert.equal(await message.textContent(), 'No films or shows match. Episode search isn’t available yet.');
    await assertPainted(message);
    assert.equal(await page.locator('.jq-search-results .jq-media-card').count(), 0);
}));

test('Search omits truncation when TotalRecordCount is absent or not greater than the returned count', async () => withPage(async page => {
    await signIn(page);
    await page.evaluate(() => {
        const original = window.ApiClient.getItems;
        window.__countMode = 'absent';
        window.__searchDone = 0;
        window.ApiClient.getItems = async function (user, options) {
            const result = await original(user, options);
            if (window.__countMode === 'absent') delete result.TotalRecordCount;
            else result.TotalRecordCount = result.Items.length - (window.__countMode === 'less' ? 1 : 0);
            window.__searchDone++;
            return result;
        };
    });
    await page.locator('.jq-nav-search').click();
    for (const [index, mode] of ['absent', 'equal', 'less'].entries()) {
        await page.evaluate(mode => { window.__countMode = mode; }, mode);
        await page.locator('.jq-search-input').fill('');
        await page.locator('.jq-search-input').fill('Northern');
        await page.waitForFunction(count => window.__searchDone === count, index + 1);
        assert.equal(await page.locator('.jq-search-results .jq-media-card').count(), 24);
        assert.equal(await page.locator('.jq-search-empty').evaluate(element => element.hidden), true);
    }
}));

test('Home row order and initial focus survive Recently Added resolving first', async () => withPage(async page => {
    await page.evaluate(() => {
        const original = window.ApiClient.getItems;
        window.__releaseRows = [];
        window.ApiClient.getItems = function (user, options) {
            return new Promise(resolve => window.__releaseRows.push(() => resolve(original(user, options))));
        };
    });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__releaseRows.length === 2);
    await page.evaluate(() => window.__releaseRows[1]());
    // Flush the promise/render turn before releasing the first request.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => window.__releaseRows[0]());
    await page.waitForFunction(() => document.querySelectorAll('.jq-home-row-heading').length === 2);
    assert.deepEqual(await page.locator('.jq-home-row-heading').allTextContents(), ['Continue Watching', 'Recently Added']);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.itemId), 'movie-1');
}));

// Series left this table when S4 replaced the inert seam: a Series is a real
// navigation target with its own screen now, not an unsupported item, so it
// gets the dedicated test below rather than a row here. The property being
// checked is the same one in both places.
for (const [type, isFolder, message] of [['CollectionFolder', true, 'This item is not available for playback.'], ['Audio', false, 'This item is not available for playback.'], ['Movie', true, 'This item is not available for playback.']]) {
    test(`${type} (IsFolder=${isFolder}) activation has visible explanation, Back, and no playback actions`, async () => withPage(async page => {
        await page.evaluate(({ type, isFolder }) => {
            window.__playCalls = 0;
            window.playbackManager.play = () => { window.__playCalls++; };
            window.ApiClient.getItems = () => Promise.resolve({ Items: [{ Id: 'unsupported', Type: type, IsFolder: isFolder, Name: 'Unsupported example', ServerId: 'dev-server-1' }] });
        }, { type, isFolder });
        await signIn(page);
        await page.keyboard.press('Enter');
        await page.waitForSelector('.jq-detail-screen');
        assert.equal(await page.locator('.jq-detail-error').textContent(), message);
        assert.equal(await page.locator('.jq-detail-error').isVisible(), true);
        await assertPainted(page.locator('.jq-detail-error'));
        await assertPainted(page.locator('.jq-back-button'));
        assert.equal(await page.locator('.jq-detail-action').count(), 0);
        assert.equal(await page.locator('.jq-back-button').evaluate(button => button === document.activeElement), true);
        await page.keyboard.press('Enter');
        await page.waitForSelector('.jq-home-row-heading');
        assert.equal(await page.evaluate(() => window.__playCalls), 0);
    }));
}

// The Series counterpart of the table above: same property -- a visible
// explanation, a painted Back, no playback action and no play() call -- on
// the screen a Series now routes to. This item's id is unknown to the show
// endpoints, and the stub rejects an unknown series id by THROWING
// SYNCHRONOUSLY, so this also pins that a synchronous client failure reaches
// the screen as a message rather than leaving it on 'Loading seasons…'.
test('Series activation has a visible explanation, Back, and no playback actions', async () => withPage(async page => {
    await page.evaluate(() => {
        window.__playCalls = 0;
        window.playbackManager.play = () => { window.__playCalls++; };
        window.ApiClient.getItems = () => Promise.resolve({ Items: [{ Id: 'unsupported', Type: 'Series', IsFolder: true, Name: 'Unsupported example', ServerId: 'dev-server-1' }] });
    });
    await signIn(page);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.jq-series-screen');
    await page.waitForFunction(() => document.querySelector('.jq-series-status')?.textContent
        === 'Couldn\u2019t load this show\u2019s seasons. Try again.');
    assert.equal(await page.locator('.jq-series-status').isVisible(), true);
    await assertPainted(page.locator('.jq-series-status'));
    await assertPainted(page.locator('.jq-back-button'));
    assert.equal(await page.locator('.jq-detail-action').count(), 0);
    assert.equal(await page.locator('.jq-back-button').evaluate(button => button === document.activeElement), true);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.jq-home-row-heading');
    assert.equal(await page.evaluate(() => window.__playCalls), 0);
}));

test('a resumable Episode enters the existing playback path with its server and saved position', async () => withPage(async page => {
    await signIn(page);
    await page.locator('[data-item-id="episode-516"]').click();
    await page.waitForSelector('.jq-detail-action');
    await page.evaluate(() => { window.playbackManager.play = options => { window.__played = options; }; });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__played), { ids: ['episode-516'], serverId: 'dev-server-1', startPositionTicks: 6000000000 });
}));

// A new entry must work from the remote and preserve the shared detail/back route.
test('Movies rail entry opens only Movies alphabetically and returns from Detail', async () => withPage(async page => {
    await signIn(page);
    assert.equal(await page.locator('.jq-nav-movies').count(), 1,
        'Movies must have a persistent rail entry');
    await page.evaluate(() => {
        const original = window.ApiClient.getItems;
        window.__movieQueries = [];
        window.ApiClient.getItems = function (user, options) {
            window.__movieQueries.push({ user, options });
            return original(user, options);
        };
    });
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator(':focus').textContent(), 'Home');
    for (const label of ['Shows', 'Movies']) {
        await page.keyboard.press('ArrowDown');
        assert.equal(await page.locator(':focus').textContent(), label);
        await assertPainted(page.locator(':focus'));
    }
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.jq-library-screen').count(), 1);
    await page.waitForSelector('.jq-library-grid .jq-media-card');
    assert.equal(await page.locator('.jq-library-heading').textContent(), 'Movies');
    assert.deepEqual(await page.evaluate(() => window.__movieQueries), [{
        user: 'user-alice',
        options: { Recursive: true, IncludeItemTypes: 'Movie', SortBy: 'SortName',
            SortOrder: 'Ascending', StartIndex: 0, Limit: 96 }
    }]);
    const movieIds = await ids(page, '.jq-library-grid .jq-media-card');
    assert.equal(movieIds.length, 10, 'all fixture Movies fit in the shared mounted window');
    assert.ok(movieIds.every(id => id.startsWith('movie-')), 'exclude Series and Episodes');
    const titles = await page.locator('.jq-media-card-title').allTextContents();
    // SortName puts the article-prefixed display title under L, not T.
    assert.deepEqual(titles, [
        'Blue Hour', 'Field Notes', 'Harbor Lights', 'The Long Way Round',
        'Low Tide', 'Open Water', 'Quiet Signal', 'Second Frost', 'Static Bloom',
        'The Long Winter',
    ], 'Movies must follow SortName order rather than display Name order');
    const selected = await page.locator(':focus').getAttribute('data-item-id');
    assert.equal(selected, movieIds[0]);
    await assertPainted(page.locator(':focus'));
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.jq-detail-screen').count(), 1);
    await page.waitForSelector('.jq-detail-title');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.jq-library-heading').textContent(), 'Movies');
    await page.waitForSelector('.jq-library-grid .jq-media-card');
    assert.deepEqual(await ids(page, '.jq-library-grid .jq-media-card'), movieIds);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.jq-home-screen').count(), 1);
}));
