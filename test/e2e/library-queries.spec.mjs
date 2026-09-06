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
    assert.deepEqual(Array.from(recursive.Items, item => item.Id), ['movie-1', 'episode-516']);
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
    for (const query of [{ StartIndex: 1 }, { Fields: 'Overview' }, { Filters: 'IsFavorite' }, { SortBy: 'Name' }, { Recursive: 'true' }, { ParentId: 'unknown' }, { IncludeItemTypes: 'Audio' }]) {
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
    assert.deepEqual(await ids(page, '.jq-home-row-section:first-child .jq-media-card'), ['movie-1', 'episode-516']);
    assert.equal(await page.locator('.jq-home-row-section').nth(1).locator('.jq-media-card').count(), 8);
    assert.ok((await ids(page, '.jq-home-row-section:nth-child(2) .jq-media-card')).includes('series-1'));
    await page.locator('.jq-see-all').click();
    await page.waitForSelector('.jq-library-grid .jq-media-card');
    assert.equal(await page.locator('.jq-library-grid .jq-media-card').count(), 50);
    assert.deepEqual(await page.evaluate(() => window.__queries), [
        { Recursive: true, IncludeItemTypes: 'Movie,Episode', Filters: 'IsResumable' },
        { Recursive: true, IncludeItemTypes: 'Movie,Series', SortBy: 'DateCreated', SortOrder: 'Descending', Limit: 8 },
        { Recursive: true, IncludeItemTypes: 'Movie,Series', SortBy: 'DateCreated', SortOrder: 'Descending', Limit: 50 }
    ]);
}));

test('Search finds nested Episodes and Series as well as Movies', async () => withPage(async page => {
    await signIn(page);
    await page.locator('.jq-nav-search').click();
    for (const [term, expected] of [['Northern Journey 516', 'episode-516'], ['Northern Stories 1', 'series-1'], ['Blue Hour', 'movie-9']]) {
        await page.locator('.jq-search-input').fill(term);
        await page.waitForSelector(`.jq-search-results [data-item-id="${expected}"]`);
        assert.ok((await ids(page, '.jq-search-results .jq-media-card')).includes(expected));
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
