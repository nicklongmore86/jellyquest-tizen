import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer } from './support/server.mjs';

const server = await startServer();
test.after(() => server.close());
async function setup(run) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
        page.setDefaultTimeout(2000);
        await page.goto(server.baseUrl + '/dev/simulator.html');
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

for (const [type, extra, id, height] of [
    ['Movie', { ImageTags: { Primary: 'movie-tag' } }, 'item', 330],
    ['Series', { ImageTags: { Primary: 'series-tag' } }, 'item', 330],
    ['Episode', { ImageTags: { Primary: 'still-tag' } }, 'item', 124],
    ['Episode', { SeriesId: 'parent', SeriesPrimaryImageTag: 'parent-tag' }, 'parent', 124],
]) {
    test(`artwork URL and server resize: ${type} ${id}`, () => setup(async (page) => {
        await page.evaluate(({ type, extra }) => {
            document.body.appendChild(JellyQuestCards.createCard(Object.assign({ Id: 'item', Name: 'Title', Type: type }, extra)));
        }, { type, extra });
        await page.waitForFunction(() => window.imageCalls.length === 1);
        const call = await page.evaluate(() => window.imageCalls[0]);
        assert.deepEqual(call, { id, options: { type: 'Primary', tag: extra.ImageTags?.Primary || extra.SeriesPrimaryImageTag, maxWidth: 220, maxHeight: height, quality: 80, format: 'webp' } });
        await page.waitForFunction(() => document.querySelector('.jq-card img')?.naturalWidth > 0);
        assert.equal(await page.locator('.jq-card img').getAttribute('alt'), '');
        const imageBounds = await page.locator('.jq-card img').boundingBox();
        assert.equal(imageBounds.width, 220);
        assert.equal(imageBounds.height, height);
        const cardBounds = await page.locator('.jq-card').boundingBox();
        assert.equal(cardBounds.height, height + 80);
    }));
}

test('missing tags and failed image retain readable text without broken icons', () => setup(async (page) => {
    await page.evaluate(() => {
        document.body.appendChild(JellyQuestCards.createCard({ Id: 'missing', Name: 'No artwork', Type: 'Movie' }));
        window.ApiClient.getImageUrl = function () { return '/missing-artwork.webp'; };
        document.body.appendChild(JellyQuestCards.createCard({ Id: 'broken', Name: 'Failed artwork', ImageTags: { Primary: 'bad' } }));
    });
    await page.waitForFunction(() => document.querySelector('[data-item-id="broken"]').getAttribute('data-artwork-state') === 'error');
    assert.equal(await page.locator('.jq-card img').count(), 0);
    assert.equal(await page.locator('.jq-card').allTextContents().then(x => x.join('|')), 'No artwork|Failed artwork');
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

test('simulator serves real local posters with stable poster geometry', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await page.goto(server.baseUrl + '/dev/simulator.html');
        await page.waitForSelector('.jq-profile-card');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => {
            const images = Array.from(document.querySelectorAll('.jq-media-card img'));
            return images.length > 0 && images.every(img => img.naturalWidth === 220 && img.naturalHeight === 330);
        });
        const image = page.locator('.jq-media-card img').first();
        const bounds = await image.boundingBox();
        assert.equal(bounds.width, 220);
        assert.equal(bounds.height, 330);
        assert.equal(await page.locator('[data-item-id="movie-10"] img').count(), 0);
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
