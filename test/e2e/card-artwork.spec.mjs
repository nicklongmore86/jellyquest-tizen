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
