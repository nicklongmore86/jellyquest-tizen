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
    assert.ok(episodes.every(item => item.SeriesId && item.SeriesName && item.ParentIndexNumber && item.IndexNumber && item.ParentBackdropItemId));
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
    const remoteOnly = await api.getItem('user-alice', 'movie-2');
    assert.equal(remoteOnly.LocalTrailerCount, 0);
    assert.equal(remoteOnly.RemoteTrailers.length, 1);

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
    assert.equal(await page.locator('.jq-home-row-section').nth(1).locator('.jq-media-card').count(), 8);
    assert.ok((await ids(page, '.jq-home-row-section:nth-child(2) .jq-media-card')).includes('series-1'));
    await page.locator('.jq-see-all').click();
    await page.waitForSelector('.jq-library-grid .jq-media-card');
    assert.equal(await page.locator('.jq-library-grid .jq-media-card').count(), 48);
    assert.deepEqual(await page.evaluate(() => window.__queries), [
        { Recursive: true, IncludeItemTypes: 'Movie,Episode', Filters: 'IsResumable', SortBy: 'DatePlayed', SortOrder: 'Descending' },
        { Recursive: true, IncludeItemTypes: 'Movie,Series', SortBy: 'DateCreated', SortOrder: 'Descending', Limit: 8 },
        { Recursive: true, IncludeItemTypes: 'Movie,Series', SortBy: 'DateCreated', SortOrder: 'Descending', StartIndex: 0, Limit: 96 }
    ]);
}));

test('Search finds Series and Movies but excludes Episodes', async () => withPage(async page => {
    await signIn(page);
    await page.locator('.jq-nav-search').click();
    for (const [term, expected] of [['Northern Stories 1', 'series-1'], ['Blue Hour', 'movie-9']]) {
        await page.locator('.jq-search-input').fill(term);
        await page.waitForSelector(`.jq-search-results [data-item-id="${expected}"]`);
        assert.ok((await ids(page, '.jq-search-results .jq-media-card')).includes(expected));
    }
    await page.locator('.jq-search-input').fill('Northern Journey 516');
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
    assert.equal(await message.textContent(), 'Showing the first 24 of 44 matches — try a more specific title.');
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

for (const [type, isFolder, message] of [['Series', true, 'Series browsing is not available yet.'], ['CollectionFolder', true, 'This item is not available for playback.'], ['Audio', false, 'This item is not available for playback.'], ['Movie', true, 'This item is not available for playback.']]) {
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

test('a resumable Episode enters the existing playback path with its server and saved position', async () => withPage(async page => {
    await signIn(page);
    await page.locator('[data-item-id="episode-516"]').click();
    await page.waitForSelector('.jq-detail-action');
    await page.evaluate(() => { window.playbackManager.play = options => { window.__played = options; }; });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__played), { ids: ['episode-516'], serverId: 'dev-server-1', startPositionTicks: 6000000000 });
}));
