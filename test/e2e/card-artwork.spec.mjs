import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer } from './support/server.mjs';
import { assertPainted } from './support/paint.mjs';

const server = await startServer();
test.after(() => server.close());
async function setup(run) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
        page.setDefaultTimeout(2000);
        await page.goto(server.baseUrl + '/dev/simulator.html', { timeout: 15000 });
        // Every test below stands on the fixture stub. Under the full parallel
        // suite the 2s default was observed to race this file's page load once
        // (`Cannot set properties of undefined (setting 'getImageUrl')`), so
        // wait for it explicitly rather than assuming `load` settled it.
        await page.waitForFunction(() => Boolean(window.ApiClient), null, { timeout: 15000 });
        await page.evaluate(() => { document.body.innerHTML = ''; });
        await page.addStyleTag({ url: server.baseUrl + '/src/overlay/cards.css' });
        await page.addScriptTag({ url: server.baseUrl + '/src/overlay/cards.js' });
        await page.evaluate(() => {
            window.imageCalls = [];
            window.ApiClient.getImageUrl = function (id, options) {
                window.imageCalls.push({ id, options });
                return '/dev/fixtures/artwork/poster-1.webp?' + new URLSearchParams(options);
            };
        });
        await run(page);
    } finally { await browser.close(); }
}

// Card SHAPE comes from Type alone; the image TYPE requested comes from what
// the item actually carries. Each row names the expected id, the exact option
// object handed to the real client, and the resulting rendered box.
const SELECTION_CASES = [
    { label: 'Movie own poster', item: { Type: 'Movie', ImageTags: { Primary: 'movie-tag' } },
        id: 'item', options: { type: 'Primary', tag: 'movie-tag', maxHeight: 330 }, height: 330, shape: 'poster' },
    { label: 'Series own poster', item: { Type: 'Series', ImageTags: { Primary: 'series-tag' } },
        id: 'item', options: { type: 'Primary', tag: 'series-tag', maxHeight: 330 }, height: 330, shape: 'poster' },
    // A Season is a poster like its Series. The merged code gave it the 124px
    // episode still box -- the live inconsistency this case pins.
    { label: 'Season own poster', item: { Type: 'Season', ImageTags: { Primary: 'season-tag' } },
        id: 'item', options: { type: 'Primary', tag: 'season-tag', maxHeight: 330 }, height: 330, shape: 'poster' },
    // Tier 3, which is LIVE on a real server: SOURCE-CONFIRMED against
    // Jellyfin 10.11.11, SeriesPrimaryImageTag is populated unconditionally
    // for any episode or season with a valid series
    // (Emby.Server.Implementations/Dto/DtoService.cs:1213-1225 for episodes,
    // :1265-1277 for seasons). Only the FIXTURE's coverage is synthetic: the
    // stub projects no SeriesPrimaryImageTag, so these two cases build their
    // own items rather than reading one out of the fixture. Do not read these
    // literals as evidence that the branch is unreachable in production.
    { label: 'Season falls back to the series poster', item: { Type: 'Season', SeriesId: 'show', SeriesPrimaryImageTag: 'show-tag' },
        id: 'show', options: { type: 'Primary', tag: 'show-tag', maxHeight: 330 }, height: 330, shape: 'poster' },
    { label: 'Episode own still', item: { Type: 'Episode', ImageTags: { Primary: 'still-tag' } },
        id: 'item', options: { type: 'Primary', tag: 'still-tag', maxHeight: 124 }, height: 124, shape: 'episode' },
    // The fix: a 16:9 parent backdrop instead of the series' 2:3 poster.
    { label: 'Episode parent backdrop', item: { Type: 'Episode', ParentBackdropItemId: 'show', ParentBackdropImageTags: ['backdrop-tag'] },
        id: 'show', options: { type: 'Backdrop', index: 0, tag: 'backdrop-tag', maxHeight: 124 }, height: 124, shape: 'episode' },
    // The parent backdrop outranks the series poster, but the poster is still
    // reached when no backdrop exists at all.
    { label: 'Episode series poster last resort', item: { Type: 'Episode', SeriesId: 'show', SeriesPrimaryImageTag: 'show-tag' },
        id: 'show', options: { type: 'Primary', tag: 'show-tag', maxHeight: 124 }, height: 124, shape: 'episode' },
    { label: 'Episode own still outranks a parent backdrop',
        item: { Type: 'Episode', ImageTags: { Primary: 'still-tag' }, ParentBackdropItemId: 'show', ParentBackdropImageTags: ['backdrop-tag'], SeriesId: 'show', SeriesPrimaryImageTag: 'show-tag' },
        id: 'item', options: { type: 'Primary', tag: 'still-tag', maxHeight: 124 }, height: 124, shape: 'episode' },
    { label: 'Episode parent backdrop outranks the series poster',
        item: { Type: 'Episode', ParentBackdropItemId: 'show', ParentBackdropImageTags: ['backdrop-tag'], SeriesId: 'show', SeriesPrimaryImageTag: 'show-tag' },
        id: 'show', options: { type: 'Backdrop', index: 0, tag: 'backdrop-tag', maxHeight: 124 }, height: 124, shape: 'episode' },
];

for (const { label, item, id, options, height, shape } of SELECTION_CASES) {
    test(`artwork URL and server resize: ${label}`, () => setup(async (page) => {
        await page.evaluate((item) => {
            document.body.appendChild(JellyQuestCards.createCard(Object.assign({ Id: 'item', Name: 'Title' }, item)));
        }, item);
        await page.waitForFunction(() => window.imageCalls.length === 1);
        const call = await page.evaluate(() => window.imageCalls[0]);
        assert.deepEqual(call, { id, options: { maxWidth: 220, quality: 80, format: 'webp', ...options } });
        await page.waitForFunction(() => document.querySelector('.jq-card img')?.naturalWidth > 0);
        assert.equal(await page.locator('.jq-card img').getAttribute('alt'), '');
        const imageBounds = await page.locator('.jq-card img').boundingBox();
        assert.equal(imageBounds.width, 220);
        assert.equal(imageBounds.height, height);
        const cardBounds = await page.locator('.jq-card').boundingBox();
        assert.equal(cardBounds.height, height + 80);
        assert.equal(await page.locator('.jq-card').evaluate((card) => card.className.split(' ').filter((name) => name.startsWith('jq-media-card-')).join()),
            `jq-media-card-${shape}`);
    }));
}

test('resume landscape is explicit and leaves ordinary movie cards as posters', () => setup(async (page) => {
    await page.evaluate(() => {
        const movie = {
            Id: 'movie', Name: 'Movie', Type: 'Movie', ImageTags: { Primary: 'primary-tag' },
            BackdropImageTags: ['backdrop-tag']
        };
        document.body.appendChild(JellyQuestCards.createCard(movie, { presentation: 'resume-landscape' }));
        document.body.appendChild(JellyQuestCards.createCard(movie));
    });
    await page.waitForFunction(() => window.imageCalls.length === 2);
    assert.deepEqual(await page.evaluate(() => window.imageCalls), [
        { id: 'movie', options: { type: 'Backdrop', tag: 'backdrop-tag', maxWidth: 220, maxHeight: 124, quality: 80, format: 'webp', index: 0 } },
        { id: 'movie', options: { type: 'Primary', tag: 'primary-tag', maxWidth: 220, maxHeight: 330, quality: 80, format: 'webp' } },
    ]);
    assert.deepEqual(await page.locator('.jq-card').evaluateAll((cards) => cards.map((card) => ({
        classes: card.className, height: card.getBoundingClientRect().height
    }))), [
        { classes: 'jq-card jq-focusable jq-media-card jq-media-card-episode', height: 204 },
        { classes: 'jq-card jq-focusable jq-media-card jq-media-card-poster', height: 410 },
    ]);
}));

test('resume movie artwork uses Backdrop then Thumb then Primary metadata fallbacks', () => setup(async (page) => {
    await page.evaluate(() => {
        // Keep every request-producing card inside the observer viewport even
        // if a regression makes them 410px posters; failures below must come
        // from the informative source-selection assertion, never a timeout.
        document.body.style.display = 'flex';
        [
            { Id: 'backdrop', BackdropImageTags: ['backdrop-tag'], ImageTags: { Thumb: 'thumb-tag', Primary: 'primary-tag' } },
            // BackdropImageTags is deliberately absent, matching a permissive
            // list DTO as well as exercising the guarded property access.
            { Id: 'thumb', ImageTags: { Thumb: 'thumb-tag', Primary: 'primary-tag' } },
            { Id: 'primary', BackdropImageTags: [], ImageTags: { Primary: 'primary-tag' } },
            { Id: 'none', BackdropImageTags: [], ImageTags: {} },
        ].forEach((item) => document.body.appendChild(JellyQuestCards.createCard(
            Object.assign({ Name: item.Id, Type: 'Movie' }, item),
            { presentation: 'resume-landscape' }
        )));
    });
    await page.waitForFunction(() => window.imageCalls.length === 3);
    assert.deepEqual(await page.evaluate(() => window.imageCalls.map((call) => ({
        id: call.id, type: call.options.type, index: call.options.index, maxHeight: call.options.maxHeight
    }))), [
        { id: 'backdrop', type: 'Backdrop', index: 0, maxHeight: 124 },
        { id: 'thumb', type: 'Thumb', index: undefined, maxHeight: 124 },
        { id: 'primary', type: 'Primary', index: undefined, maxHeight: 124 },
    ]);
    assert.equal(await page.locator('[data-item-id="none"] img').count(), 0,
        'a resume movie with no usable image remains text-only');
    assert.equal((await page.locator('[data-item-id="none"]').boundingBox()).height, 204);
}));

test('an episode with neither a still nor a parent backdrop stays honest text', () => setup(async (page) => {
    // The fixture's episode-700 shape: no ImageTags.Primary, an empty
    // ParentBackdropImageTags array, and no series poster tag.
    await page.evaluate(() => {
        document.body.appendChild(JellyQuestCards.createCard({
            Id: 'episode-700', Name: 'Last Signal', Type: 'Episode', SeriesName: 'Northern Stories 1',
            ParentIndexNumber: 47, IndexNumber: 4, ParentBackdropItemId: 'series-1', ParentBackdropImageTags: [],
        }));
    });
    await page.waitForTimeout(150);
    assert.deepEqual(await page.evaluate(() => window.imageCalls), []);
    assert.equal(await page.locator('.jq-card img').count(), 0);
    // It keeps the episode still SHAPE regardless -- shape follows Type, so a
    // row of episodes does not go ragged around the one with no artwork.
    assert.equal((await page.locator('.jq-card').boundingBox()).height, 204);
    assert.equal(await page.locator('.jq-media-card-title').textContent(), 'Northern Stories 1');
    assert.equal(await page.locator('.jq-media-card-meta').textContent(), 'S47 E4 \u00b7 Last Signal');
}));

// Decision 3. Only the 'browse' branch has an app caller today (Home's
// Continue Watching row queries 'Movie,Episode'); nothing passes 'series'
// until S4 builds the series screen, so that branch is exercised here only.
for (const [context, title, meta] of [
    [undefined, 'PAW Patrol', 'S3 E12 \u00b7 Pups Save the Bay'],
    ['browse', 'PAW Patrol', 'S3 E12 \u00b7 Pups Save the Bay'],
    ['series', 'Pups Save the Bay', 'S3 E12'],
]) {
    test(`episode card labelling is contextual: context=${context}`, () => setup(async (page) => {
        await page.evaluate((context) => {
            document.body.appendChild(JellyQuestCards.createCard({
                Id: 'episode-1', Name: 'Pups Save the Bay', Type: 'Episode', SeriesName: 'PAW Patrol',
                ParentIndexNumber: 3, IndexNumber: 12, ImageTags: { Primary: 'still-tag' },
            }, { context }));
        }, context);
        assert.equal(await page.locator('.jq-media-card-title').textContent(), title);
        assert.equal(await page.locator('.jq-media-card-meta').textContent(), meta);
    }));
}

test('an unnumbered episode drops the numbering rather than printing undefined', () => setup(async (page) => {
    // The fixture's virtual PAW Patrol placeholders carry IndexNumber but the
    // real server does not guarantee either number.
    await page.evaluate(() => {
        document.body.appendChild(JellyQuestCards.createCard({
            Id: 'special', Name: 'Behind the Scenes', Type: 'Episode', SeriesName: 'PAW Patrol',
            ImageTags: { Primary: 'still-tag' },
        }));
        document.body.appendChild(JellyQuestCards.createCard({
            Id: 'orphan', Name: 'Unattached', Type: 'Episode', ImageTags: { Primary: 'still-tag' },
        }, { context: 'series' }));
    });
    assert.deepEqual(await page.locator('.jq-media-card-title').allTextContents(), ['PAW Patrol', 'Unattached']);
    assert.deepEqual(await page.locator('.jq-media-card-meta').allTextContents(), ['Behind the Scenes']);
}));

test('missing tags and failed image retain readable text without broken icons', () => setup(async (page) => {
    await page.evaluate(() => {
        document.body.style.display = 'flex';
        document.body.appendChild(JellyQuestCards.createCard({ Id: 'missing', Name: 'No artwork', Type: 'Movie' }));
        window.ApiClient.getImageUrl = function () { return '/missing-artwork.webp'; };
        document.body.appendChild(JellyQuestCards.createCard({ Id: 'broken', Name: 'Failed artwork', ImageTags: { Primary: 'bad' } }));
        document.body.appendChild(JellyQuestCards.createCard({
            Id: 'resume-broken', Name: 'Failed resume backdrop', Type: 'Movie',
            BackdropImageTags: ['bad']
        }, { presentation: 'resume-landscape' }));
    });
    await page.waitForFunction(() => ['broken', 'resume-broken'].every((id) =>
        document.querySelector('[data-item-id="' + id + '"]').getAttribute('data-artwork-state') === 'error'));
    assert.equal(await page.locator('.jq-card img').count(), 0);
    assert.equal(await page.locator('.jq-card').allTextContents().then(x => x.join('|')),
        'No artwork|Failed artwork|Failed resume backdrop');
    assert.equal((await page.locator('[data-item-id="resume-broken"]').boundingBox()).height, 204);
    assert.deepEqual(await page.evaluate(() => window.imageCalls), []);
}));

test('300 cards request only intersecting artwork and release on scroll/removal', () => setup(async (page) => {
    await page.evaluate(() => {
        const row = document.createElement('div');
        row.id = 'art-row';
        row.style.cssText = 'display:flex;width:240px;height:430px;overflow:auto';
        document.body.appendChild(row);
        for (let i = 0; i < 300; i++) {
            const card = JellyQuestCards.createCard({ Id: String(i), Name: 'Movie ' + i, Type: 'Movie', ImageTags: { Primary: 'tag' } });
            card.style.marginRight = '20px';
            row.appendChild(card);
        }
    });
    await page.waitForFunction(() => window.imageCalls.length > 0);
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => window.imageCalls.map(x => x.id)), ['0']);
    await page.evaluate(() => { document.getElementById('art-row').scrollLeft = 2400; });
    await page.waitForFunction(() => window.imageCalls.some(x => x.id === '10'));
    assert.equal(await page.locator('[data-item-id="0"] img').count(), 0);
    assert.equal(await page.locator('.jq-card img').count(), 1);
    await page.evaluate(() => { window.removedRow = document.getElementById('art-row'); window.removedRow.remove(); });
    await page.waitForFunction(() => window.removedRow.querySelectorAll('img').length === 0);
}));

test('without IntersectionObserver artwork stays text-only', () => setup(async (page) => {
    await page.evaluate(() => { window.IntersectionObserver = undefined; });
    await page.addScriptTag({ url: server.baseUrl + '/src/overlay/cards.js' });
    await page.evaluate(() => document.body.appendChild(JellyQuestCards.createCard({ Id: 'x', Name: 'Offline', ImageTags: { Primary: 'tag' } })));
    assert.equal(await page.locator('.jq-card img').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.imageCalls), []);
}));

test('simulator serves landscape resume art while browse movies keep stable poster geometry', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await page.goto(server.baseUrl + '/dev/simulator.html');
        await page.waitForSelector('.jq-profile-card');
        await page.keyboard.press('Enter');
        const resumeMovie = page.locator('.jq-home-row-section').first().locator('[data-item-id="movie-1"] img');
        const resumeFallback = page.locator('.jq-home-row-section').first().locator('[data-item-id="movie-3"] img');
        const browseMovie = page.locator('.jq-home-row-section').last().locator('[data-item-id="movie-10"] img');
        await page.waitForFunction(() => [
            document.querySelector('.jq-home-row-section:first-child [data-item-id="movie-1"] img'),
            document.querySelector('.jq-home-row-section:first-child [data-item-id="movie-3"] img'),
            document.querySelector('.jq-home-row-section:last-child [data-item-id="movie-10"] img'),
        ].every((image) => image && image.naturalWidth === 220));
        assert.deepEqual(await resumeMovie.evaluate((image) => ({
            natural: [image.naturalWidth, image.naturalHeight], box: [image.offsetWidth, image.offsetHeight]
        })), { natural: [220, 124], box: [220, 124] }, 'resume Movies prefer their 16:9 Backdrop');
        assert.deepEqual(await resumeFallback.evaluate((image) => ({
            natural: [image.naturalWidth, image.naturalHeight], box: [image.offsetWidth, image.offsetHeight]
        })), { natural: [220, 330], box: [220, 124] }, 'the no-backdrop Movie reaches its Primary terminal fallback without stretching');
        assert.deepEqual(await browseMovie.evaluate((image) => ({
            natural: [image.naturalWidth, image.naturalHeight], box: [image.offsetWidth, image.offsetHeight],
            card: image.parentElement.getBoundingClientRect().height
        })), { natural: [220, 330], box: [220, 330], card: 410 },
        'Recently Added keeps Movie portrait posters outside the resume presentation');
        await page.screenshot({ path: '.cache/artwork-preview.png' });
    } finally { await browser.close(); }
});

for (const recovers of [true, false]) {
    test(`failed artwork retries only on re-entry with a bounded budget: recovery=${recovers}`, () => setup(async (page) => {
        let requests = 0;
        await page.route('**/retry-artwork.webp', async (route) => {
            requests++;
            if (recovers && requests > 1) {
                await route.fulfill({ path: 'dev/fixtures/artwork/poster-1.webp', contentType: 'image/webp' });
            } else {
                await route.fulfill({ status: 503, body: 'Temporary failure' });
            }
        });
        await page.evaluate(() => {
            window.ApiClient.getImageUrl = function () { return '/retry-artwork.webp'; };
            const card = JellyQuestCards.createCard({ Id: 'retry', Name: 'Retry', Type: 'Movie', ImageTags: { Primary: 'tag' } });
            card.style.position = 'absolute';
            card.style.left = '0px';
            document.body.appendChild(card);
        });
        await page.waitForFunction(() => document.querySelector('.jq-card').getAttribute('data-artwork-state') === 'error');
        await page.waitForTimeout(250);
        assert.equal(requests, 1, 'Failure must not initiate a timer or immediate retry loop');
        for (let visit = 0; visit < 5; visit++) {
            await page.locator('.jq-card').evaluate(card => { card.style.left = '900px'; });
            await page.waitForTimeout(100);
            await page.locator('.jq-card').evaluate(card => { card.style.left = '0px'; });
            await page.waitForTimeout(100);
            if (recovers) {
                await page.waitForFunction(() => document.querySelector('.jq-card img')?.naturalWidth === 220);
                assert.equal(await page.locator('.jq-card').getAttribute('data-artwork-state'), null);
            }
        }
        if (!recovers) {
            assert.equal(requests, 3, 'Initial attempt plus two re-entry retries, even after five visits');
            assert.equal(await page.locator('.jq-card img').count(), 0);
        }
    }));
}

test('long titles truncate to one line without changing artwork or fallback geometry', () => setup(async (page) => {
    const title = 'The Extremely Long Movie Title With Enough Words To Overflow Every Card In This Library';
    await page.evaluate((title) => {
        document.body.style.display = 'flex';
        for (const [id, name, imageTags] of [['short', 'Short', {}], ['fallback', title, {}], ['poster', title, { Primary: 'tag' }]]) {
            document.body.appendChild(JellyQuestCards.createCard({ Id: id, Name: name, Type: 'Movie', ImageTags: imageTags }));
        }
    }, title);
    const titles = await page.locator('.jq-media-card-title').evaluateAll(nodes => nodes.map(node => {
        const style = getComputedStyle(node);
        return { text: node.textContent, width: node.clientWidth, scrollWidth: node.scrollWidth,
            height: node.getBoundingClientRect().height, whiteSpace: style.whiteSpace,
            overflow: style.overflow, ellipsis: style.textOverflow, cardHeight: node.parentElement.getBoundingClientRect().height };
    }));
    for (const measured of titles.slice(1)) {
        assert.equal(measured.text, title, 'Full title remains in the DOM');
        assert.equal(measured.height, titles[0].height, 'Long title remains one line');
        assert.ok(measured.scrollWidth > measured.width, 'Fixture must actually overflow');
        assert.equal(measured.cardHeight, 410);
        assert.equal(measured.whiteSpace, 'nowrap');
        assert.equal(measured.overflow, 'hidden');
        assert.equal(measured.ellipsis, 'ellipsis');
    }
}));

test('fixture image URLs resolve for non-movie and malformed IDs', () => setup(async (page) => {
    await page.addScriptTag({ url: server.baseUrl + '/dev/fixtures/api-client-stub.js' });
    const urls = await page.evaluate(() => ['series-1', 'episode-2', 'movie-0', 'movie-nope', undefined].map(id => ApiClient.getImageUrl(id, { type: 'Primary' })));
    for (const url of urls) {
        assert.equal(url, '/dev/fixtures/artwork/poster-1.webp?type=Primary');
        const response = await page.request.get(server.baseUrl + url);
        assert.equal(response.status(), 200);
        assert.ok((await response.body()).length > 0);
    }
}));


test('positive intersection crossings without an exit do not consume an artwork retry', () => setup(async (page) => {
    await page.route('**/latch-artwork.webp', route => route.fulfill({ status: 503, body: 'Temporary failure' }));
    await page.evaluate(() => {
        // Deliver the exact edge-crossing sequence deterministically, without
        // relying on subpixel layout or browser callback coalescing. The real
        // observer/scroll path is exercised separately by the 300-card test.
        window.IntersectionObserver = function (callback) {
            this.observe = function (target) {
                window.deliverArtworkIntersection = ratio => callback([{ target, intersectionRatio: ratio }]);
            };
            this.unobserve = function () {};
        };
        window.ApiClient.getImageUrl = function (id, options) {
            window.imageCalls.push({ id, options });
            return '/latch-artwork.webp';
        };
        document.body.appendChild(JellyQuestCards.createCard({ Id: 'latch', Name: 'Latch', Type: 'Movie', ImageTags: { Primary: 'tag' } }));
        window.deliverArtworkIntersection(0.0005);
    });
    await page.waitForFunction(() => document.querySelector('.jq-card').getAttribute('data-artwork-state') === 'error');
    assert.equal(await page.evaluate(() => window.imageCalls.length), 1);
    await page.evaluate(() => window.deliverArtworkIntersection(0.01));
    assert.equal(await page.evaluate(() => window.imageCalls.length), 1,
        'Another positive threshold crossing without an exit must not request a retry');
    assert.equal(await page.locator('.jq-card img').count(), 0);
    assert.equal(await page.locator('.jq-card').getAttribute('data-artwork-state'), 'error');

    await page.evaluate(() => {
        window.deliverArtworkIntersection(0);
        window.deliverArtworkIntersection(0.01);
    });
    assert.equal(await page.evaluate(() => window.imageCalls.length), 2,
        'A true exit and re-entry must still permit the first retry');
    await page.waitForFunction(() => document.querySelector('.jq-card').getAttribute('data-artwork-state') === 'error');
}));

// The headline fix, measured as painted pixels rather than as a requested
// style. `object-fit: contain` means the element box is 220x124 whichever
// image lands in it, so the box alone cannot tell a filled still from a
// letterboxed poster -- the painted content is what a person sees.
function paintedGeometry(locator) {
    return locator.evaluate((image) => {
        const box = image.getBoundingClientRect();
        const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
        return {
            box: { width: box.width, height: box.height },
            natural: { width: image.naturalWidth, height: image.naturalHeight },
            painted: { width: image.naturalWidth * scale, height: image.naturalHeight * scale },
        };
    });
}

test('a parent backdrop fills the episode still slot the series poster letterboxed', async () => {
    const browser = await chromium.launch();
    try {
        // Run inside the real simulator, not the addStyleTag harness: this
        // page loads the built jellyquest.css from <body>, so a stylesheet
        // injected into <head> would lose on document order and a card could
        // be measured at the wrong size. Here the shipped rules are the ones
        // in effect, and #jellyquest-root exists for the paint assertion.
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(5000);
        await page.goto(server.baseUrl + '/dev/simulator.html');
        await page.waitForSelector('.jq-profile-card');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.jq-home-row .jq-media-card');
        await page.evaluate(() => {
            const row = document.querySelector('.jq-home-row');
            // Prepend, so both land inside the row's visible scrollport and
            // the shared IntersectionObserver actually fires for them.
            for (const item of [
                // Carries BOTH fallbacks, exactly as a real episode does: the
                // backdrop must win, and when it is removed this same card
                // regresses to the letterboxed poster rather than to no image
                // -- so the assertion below fails on painted geometry.
                { Id: 'fixed-episode', Name: 'Backdrop Fallback', Type: 'Episode', SeriesName: 'Northern Stories 1',
                    ParentIndexNumber: 4, IndexNumber: 2,
                    ParentBackdropItemId: 'series-1', ParentBackdropImageTags: ['backdrop-v1'],
                    SeriesId: 'series-1', SeriesPrimaryImageTag: 'preview-v1' },
                { Id: 'old-episode', Name: 'Poster Fallback', Type: 'Episode', SeriesName: 'Northern Stories 1',
                    ParentIndexNumber: 4, IndexNumber: 3,
                    SeriesId: 'series-1', SeriesPrimaryImageTag: 'preview-v1' },
                // In browse context the meta line carries the numbering AND
                // the episode's own name, which routinely overflows 188px.
                { Id: 'long-episode', Type: 'Episode', SeriesName: 'Northern Stories 1',
                    Name: 'The Extremely Long Episode Title With Enough Words To Overflow Every Card',
                    ParentIndexNumber: 4, IndexNumber: 4, ImageTags: { Primary: 'preview-v1' } },
            ].reverse()) {
                row.insertBefore(JellyQuestCards.createCard(item), row.firstChild);
            }
        });
        await page.waitForFunction(() => ['fixed-episode', 'old-episode']
            .every((id) => document.querySelector(`[data-item-id="${id}"] img`)?.naturalWidth > 0));

        const fixed = await paintedGeometry(page.locator('[data-item-id="fixed-episode"] img'));
        const old = await paintedGeometry(page.locator('[data-item-id="old-episode"] img'));
        // Both occupy the identical 220x124 slot...
        assert.deepEqual(fixed.box, { width: 220, height: 124 });
        assert.deepEqual(old.box, { width: 220, height: 124 });
        // ...but only the 16:9 backdrop paints into all of it.
        assert.deepEqual(fixed.natural, { width: 220, height: 124 }, 'parent backdrop must be served 16:9');
        assert.deepEqual(fixed.painted, { width: 220, height: 124 });
        assert.deepEqual(old.natural, { width: 220, height: 330 }, 'series poster must be served 2:3');
        // 124 * 220/330 = 82.67px of a 220px slot: the measured before-state.
        assert.ok(Math.abs(old.painted.width - 82.67) < 0.05,
            `series poster paints ${old.painted.width}px wide, not ~82.67px`);
        assert.ok(fixed.painted.width / old.painted.width > 2.6,
            'the backdrop must be substantially wider than the letterboxed poster');
        // Paint-check the CARD, not the <img>: the image carries
        // `pointer-events: none`, so the hit target at its centre is the card
        // button beneath it. Both cards must really be on screen, inside
        // #jellyquest-root, and unobscured by the overlay above them.
        await assertPainted(page.locator('[data-item-id="fixed-episode"]'));
        await assertPainted(page.locator('[data-item-id="old-episode"]'));

        // The contextual meta line must truncate, not wrap: the footer is a
        // fixed 80px under a fixed artwork box, so a second line would spill
        // out of the card and over whatever sits below it.
        const metaLines = await page.locator('.jq-home-row .jq-media-card-meta').evaluateAll((nodes) =>
            nodes.map((node) => {
                const style = getComputedStyle(node);
                return { text: node.textContent, width: node.clientWidth, scrollWidth: node.scrollWidth,
                    height: node.getBoundingClientRect().height, whiteSpace: style.whiteSpace,
                    overflow: style.overflow, ellipsis: style.textOverflow,
                    cardHeight: node.parentElement.getBoundingClientRect().height,
                    bottom: node.getBoundingClientRect().bottom,
                    cardBottom: node.parentElement.getBoundingClientRect().bottom };
            }));
        const long = metaLines.find((line) => line.text.startsWith('S4 E4'));
        const short = metaLines.find((line) => line.text === 'S4 E2 · Backdrop Fallback');
        assert.ok(long && short, 'both episode meta lines must be rendered');
        assert.ok(long.scrollWidth > long.width, 'fixture must actually overflow the meta line');
        assert.equal(long.height, short.height, 'the long meta line must stay one line');
        assert.equal(long.whiteSpace, 'nowrap');
        assert.equal(long.overflow, 'hidden');
        assert.equal(long.ellipsis, 'ellipsis');
        assert.equal(long.cardHeight, 204);
        assert.ok(long.bottom <= long.cardBottom, 'the meta line must stay inside the card');
    } finally { await browser.close(); }
});

test('every fixture episode gets a correctly shaped image or honest text', () => setup(async (page) => {
    const census = await page.evaluate(async () => {
        // Hand each card its own intersection trigger rather than firing
        // during createCard(), because the real observer only loads artwork
        // for a card that is attached to the document. Returning a falsy URL
        // classifies 700 cards without making 700 image requests.
        window.IntersectionObserver = function (callback) {
            this.observe = function (target) {
                target.deliverIntersection = function () { callback([{ target, intersectionRatio: 1 }]); };
            };
            this.unobserve = function () {};
        };
        window.ApiClient.getImageUrl = function (id, options) {
            window.imageCalls.push({ id, options });
            return '';
        };
        const { Items } = await window.ApiClient.getItems(null, { Recursive: true, IncludeItemTypes: 'Episode' });
        const tally = { total: Items.length, Primary: 0, Backdrop: 0, none: 0, wrongShape: 0, wrongBox: 0,
            seriesPosterTags: Items.filter((item) => item.SeriesPrimaryImageTag).length };
        for (const item of Items) {
            const before = window.imageCalls.length;
            const card = JellyQuestCards.createCard(item);
            document.body.appendChild(card);
            // Absent on a card with no artwork source at all: observeArtwork
            // never observes one, which is itself part of what is counted.
            if (card.deliverIntersection) card.deliverIntersection();
            if (!card.classList.contains('jq-media-card-episode')) tally.wrongShape++;
            const call = window.imageCalls[before];
            if (window.imageCalls.length === before) tally.none++;
            else {
                tally[call.options.type]++;
                if (call.options.maxWidth !== 220 || call.options.maxHeight !== 124) tally.wrongBox++;
            }
        }
        return tally;
    });
    // MEASURED against dev/fixtures/api-client-stub.js.
    assert.deepEqual(census, {
        total: 700,
        Primary: 515,   // own 16:9 still, unchanged by this PR
        Backdrop: 184,  // was: no request at all in the fixture; a squeezed
                        // series poster on the real server
        none: 1,        // episode-700: no still, no backdrop, no series poster
        wrongShape: 0,
        wrongBox: 0,
        // FIXTURE-FIDELITY GAP, not a statement about production. The stub
        // projects no SeriesPrimaryImageTag, so in the fixture the before-state
        // for those 185 was text-only. On the household's server it was a
        // letterboxed series poster: SOURCE-CONFIRMED against Jellyfin
        // 10.11.11, that tag is populated unconditionally for every episode
        // with a valid series (DtoService.cs:1213-1225), so tier 3 always had
        // something to serve. The squeeze itself is reproduced directly by the
        // painted geometry test above.
        seriesPosterTags: 0,
    });
}));
