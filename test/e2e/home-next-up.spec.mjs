// Home's "Next Up" row, driven by the LIBRARY-WIDE /Shows/NextUp endpoint
// (ApiClient.getNextUpEpisodes with no SeriesId).
//
// Two halves, deliberately separated:
//   * FIXTURE CONTRACT -- runs the stub in a bare vm context, no browser, and
//     pins the transport semantics MEASURED against the household's Jellyfin
//     10.11.11 (Limit/StartIndex honoured, TotalRecordCount pre-limit,
//     SortBy/SortOrder/IsMissing/IsVirtualUnaired accepted-and-ignored).
//   * SCREEN BEHAVIOUR -- runs the real simulator and asserts what the viewer
//     gets, including where focus lands and that it is PAINTED.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { assertPainted } from './support/paint.mjs';
import { startServer } from './support/server.mjs';

const server = await startServer();
const simulatorUrl = `${server.baseUrl}/dev/simulator.html`;
test.after(() => server.close());

function loadStub() {
    const context = vm.createContext({ window: {} });
    vm.runInContext(fs.readFileSync('dev/fixtures/api-client-stub.js', 'utf8'), context);
    return context.window.ApiClient;
}

async function withPage(run, before) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.setDefaultTimeout(5000);
        await page.goto(simulatorUrl);
        await page.waitForSelector('.jq-profile-card');
        if (before) await before(page);
        await run(page);
    } finally {
        await browser.close();
    }
}

async function signIn(page, profileId) {
    await page.evaluate((id) => document.querySelector(`[data-profile-id="${id}"]`).click(), profileId);
    await page.waitForSelector('.jq-home-row-heading');
}

const headings = (page) => page.locator('.jq-home-row-heading').allTextContents();

function rowIds(page, title) {
    return page.evaluate((rowTitle) => {
        const heading = Array.from(document.querySelectorAll('.jq-home-row-heading'))
            .find((node) => node.textContent === rowTitle);
        if (!heading) return null;
        return Array.from(heading.parentElement.querySelectorAll('.jq-media-card'))
            .map((card) => card.getAttribute('data-item-id'));
    }, title);
}

// ---- Fixture contract -------------------------------------------------

test('the fixture models a library-wide Next Up call and keeps the per-series one working', async () => {
    const api = loadStub();

    // Per-series (PR #33) is untouched: same canned answer, same rejection of
    // a non-string SeriesId.
    const perSeries = await api.getNextUpEpisodes({ SeriesId: 'series-1', UserId: 'user-bob', Limit: 1, EnableRewatching: false });
    assert.deepEqual(Array.from(perSeries.Items, (item) => item.Id), ['episode-1']);
    await assert.rejects(async () => api.getNextUpEpisodes({ SeriesId: 5, UserId: 'user-bob' }),
        /Unmodeled SeriesId/);

    // Library-wide: profile-specific canned results, and every profile's list
    // agrees with the per-series table for the same (user, series) pair.
    const alice = await api.getNextUpEpisodes({ UserId: 'user-alice', EnableRewatching: false });
    assert.deepEqual(Array.from(alice.Items, (item) => item.Id), ['episode-516']);
    assert.equal(alice.TotalRecordCount, 1);
    const dana = await api.getNextUpEpisodes({ UserId: 'user-dana', EnableRewatching: false });
    assert.deepEqual(Array.from(dana.Items, (item) => item.Id), ['episode-111', 'episode-523']);
    assert.equal(dana.TotalRecordCount, 2);
    assert.ok(dana.Items.every((item) => item.Type === 'Episode'));
    for (const [userId, seriesId, expected] of [
        ['user-alice', 'series-paw-patrol', 'episode-516'],
        ['user-dana', 'series-1', 'episode-111'],
        ['user-dana', 'series-paw-patrol', 'episode-523'],
    ]) {
        const scoped = await api.getNextUpEpisodes({ SeriesId: seriesId, UserId: userId, Limit: 1 });
        assert.deepEqual(Array.from(scoped.Items, (item) => item.Id), [expected],
            `the per-series and library-wide tables must not disagree about ${userId}/${seriesId}`);
    }

    // A profile with no playback history gets nothing, and never another
    // profile's items. MEASURED: the endpoint is user-scoped.
    for (const userId of ['user-bob', 'user-charlie']) {
        const other = await api.getNextUpEpisodes({ UserId: userId, EnableRewatching: false });
        assert.deepEqual(Array.from(other.Items), [], `${userId} must not inherit another profile's Next Up`);
        assert.equal(other.TotalRecordCount, 0);
    }
});

test('the library-wide fixture call must name a user', async () => {
    const api = loadStub();
    await assert.rejects(async () => api.getNextUpEpisodes({ EnableRewatching: false }), /Unmodeled UserId/);
    await assert.rejects(async () => api.getNextUpEpisodes({ Limit: 8 }), /Unmodeled UserId/);
});

test('the library-wide fixture honours Limit and StartIndex and reports the true pre-limit total', async () => {
    const api = loadStub();
    const limited = await api.getNextUpEpisodes({ UserId: 'user-dana', Limit: 1 });
    assert.deepEqual(Array.from(limited.Items, (item) => item.Id), ['episode-111']);
    assert.equal(limited.TotalRecordCount, 2, 'TotalRecordCount must survive Limit and report the pre-limit count');

    const offset = await api.getNextUpEpisodes({ UserId: 'user-dana', StartIndex: 1, Limit: 1 });
    assert.deepEqual(Array.from(offset.Items, (item) => item.Id), ['episode-523']);
    assert.equal(offset.TotalRecordCount, 2);

    const past = await api.getNextUpEpisodes({ UserId: 'user-dana', StartIndex: 9 });
    assert.deepEqual(Array.from(past.Items), []);
    assert.equal(past.TotalRecordCount, 2);

    for (const bad of [{ Limit: -1 }, { Limit: 1.5 }, { Limit: '8' }, { StartIndex: -1 }, { StartIndex: '0' }]) {
        await assert.rejects(async () => api.getNextUpEpisodes(Object.assign({ UserId: 'user-dana' }, bad)),
            /Unmodeled (Limit|StartIndex)/);
    }
});

test('the library-wide fixture accepts SortBy, SortOrder, IsMissing and IsVirtualUnaired and IGNORES them', async () => {
    const api = loadStub();
    const baseline = await api.getNextUpEpisodes({ UserId: 'user-dana' });
    const body = JSON.stringify(baseline);
    for (const ignored of [
        { SortBy: 'DatePlayed', SortOrder: 'Descending' },
        { SortBy: 'DatePlayed', SortOrder: 'Ascending' },
        { SortBy: 'SortName', SortOrder: 'Ascending' },
        { IsMissing: false },
        { IsVirtualUnaired: false },
        { IsMissing: true, IsVirtualUnaired: true },
    ]) {
        const result = await api.getNextUpEpisodes(Object.assign({ UserId: 'user-dana' }, ignored));
        assert.equal(JSON.stringify(result), body,
            `${JSON.stringify(ignored)} must return the byte-identical baseline body`);
    }
    // Values outside the server's enums are still rejected -- accepted-and-
    // ignored is not the same as unvalidated.
    await assert.rejects(async () => api.getNextUpEpisodes({ UserId: 'user-dana', SortBy: 'NotASort' }), /Unmodeled SortBy/);
    await assert.rejects(async () => api.getNextUpEpisodes({ UserId: 'user-dana', SortOrder: 'Sideways' }), /Unmodeled SortOrder/);
    await assert.rejects(async () => api.getNextUpEpisodes({ UserId: 'user-dana', IsMissing: 'false' }), /Unmodeled IsMissing/);
});

test('the library-wide fixture order is stable server policy, not the returned episodes own play dates', async () => {
    const api = loadStub();
    const first = await api.getNextUpEpisodes({ UserId: 'user-dana' });
    const second = await api.getNextUpEpisodes({ UserId: 'user-dana' });
    assert.equal(JSON.stringify(first), JSON.stringify(second), 'two identical requests must return an identical body');

    // MEASURED divergence, reproduced: the leading item has NEVER been played
    // (its series has the most recent activity), while the item behind it
    // carries a real LastPlayedDate. Any client-side re-sort by the returned
    // episode's own date inverts this.
    const [lead, trailer] = first.Items;
    assert.equal(lead.Id, 'episode-111');
    assert.equal(lead.UserData.LastPlayedDate, undefined, 'the lead item must have no play date of its own');
    assert.ok(trailer.UserData.LastPlayedDate, 'the trailing item must carry one');
});

test('the library-wide fixture projects Fields onto the measured list shape', async () => {
    const api = loadStub();
    const plain = await api.getNextUpEpisodes({ UserId: 'user-dana' });
    for (const item of plain.Items) {
        assert.ok(!('Overview' in item), 'a list response must not carry Overview');
        assert.ok(item.SeriesId && item.SeriesName && item.SeasonId
            && item.ParentIndexNumber && item.IndexNumber && item.ServerId && item.ImageTags,
        'the measured Next Up item shape must be present');
    }
    const projected = await api.getNextUpEpisodes({ UserId: 'user-dana', Fields: 'Overview' });
    assert.ok(projected.Items.every((item) => item.Overview), 'a requested Field must be projected');
    await assert.rejects(async () => api.getNextUpEpisodes({ UserId: 'user-dana', Fields: 'NotAField' }),
        /Unmodeled Fields value/);
    // At least one Next Up item must lack its own still, or the artwork
    // fallback tier is untested on this path.
    assert.equal(plain.Items.filter((item) => !item.ImageTags.Primary).length, 1);
});

test('EnableRewatching changes the library-wide selection substantially', async () => {
    const api = loadStub();
    const off = await api.getNextUpEpisodes({ UserId: 'user-dana', EnableRewatching: false });
    const on = await api.getNextUpEpisodes({ UserId: 'user-dana', EnableRewatching: true });
    assert.ok(on.Items.length > off.Items.length, 'rewatching must return more items');
    assert.equal(on.TotalRecordCount, on.Items.length);
    assert.ok(on.Items.some((item) => item.UserData.Played), 'rewatching must include played records');
    const perSeries = {};
    on.Items.forEach((item) => { perSeries[item.SeriesId] = (perSeries[item.SeriesId] || 0) + 1; });
    assert.ok(Object.keys(perSeries).some((seriesId) => perSeries[seriesId] > 1),
        'rewatching must be able to return MULTIPLE entries from one series');
    assert.ok(off.Items.every((item) => !item.UserData.Played));
    await assert.rejects(async () => api.getNextUpEpisodes({ UserId: 'user-dana', EnableRewatching: 'false' }),
        /Unmodeled EnableRewatching/);
});

// ---- Screen behaviour -------------------------------------------------

test('Home renders Next Up between Continue Watching and Recently Added', async () => withPage(async (page) => {
    await signIn(page, 'user-alice');
    assert.deepEqual(await headings(page), ['Continue Watching', 'Next Up', 'Recently Added']);
    assert.deepEqual(await rowIds(page, 'Next Up'), ['episode-516']);
    // ACCEPTED, and MEASURED, not a bug: an in-progress episode is returned by
    // this endpoint ITSELF, so it can appear in Continue Watching AND Next Up
    // at once. Upstream's own home section suppresses that with
    // EnableResumable: false, a switch outside the measured truth table, so
    // this row does not send it and the overlap stands.
    assert.ok((await rowIds(page, 'Continue Watching')).includes('episode-516'));
    // The row carries no "See All": the Library screen queries getItems, which
    // cannot express /Shows/NextUp.
    assert.equal(await page.evaluate(() =>
        Array.from(document.querySelectorAll('.jq-home-row-heading'))
            .find((node) => node.textContent === 'Next Up')
            .parentElement.querySelectorAll('.jq-see-all').length), 0);
}));

test('Home asks for Next Up user-scoped, bounded, and without the ignored options', async () => withPage(async (page) => {
    await page.evaluate(() => {
        window.__nextUpCalls = [];
        const real = window.ApiClient.getNextUpEpisodes.bind(window.ApiClient);
        window.ApiClient.getNextUpEpisodes = function (options) {
            window.__nextUpCalls.push({ ...options });
            return real(options);
        };
    });
    await signIn(page, 'user-alice');
    assert.deepEqual(await page.evaluate(() => window.__nextUpCalls), [
        { UserId: 'user-alice', Limit: 8, EnableRewatching: false },
    ]);
}));

test('a Next Up card routes to Episode Detail, exactly as Continue Watching does', async () => withPage(async (page) => {
    await signIn(page, 'user-dana');
    // Scoped to the Next Up row: the point is that THIS row's card routes to
    // Episode Detail, not that some card with the same id elsewhere does.
    await page.evaluate(() => {
        const heading = Array.from(document.querySelectorAll('.jq-home-row-heading'))
            .find((node) => node.textContent === 'Next Up');
        heading.parentElement.querySelector('[data-item-id="episode-111"]').click();
    });
    await page.waitForSelector('.jq-detail-screen');
    const title = await page.locator('.jq-detail-title').textContent();
    assert.match(title, /Northern Stories 1/);
    assert.match(title, /S8 E6 · Northern Journey 111/);
}));

test('a Next Up episode with no still of its own falls back to the parent backdrop', async () => withPage(async (page) => {
    await signIn(page, 'user-dana');
    // Dana's in-progress episode is in Continue Watching too (the measured
    // overlap), so every assertion here is scoped to the Next Up section.
    const nextUp = page.locator('.jq-home-row-section').nth(1);
    assert.equal(await nextUp.locator('.jq-home-row-heading').textContent(), 'Next Up');
    // The screen renders the server's order verbatim. Dana's leading item has
    // never been played and the one behind it carries a real play date, so a
    // client-side re-sort by the returned item's own date inverts this pair.
    assert.deepEqual(await rowIds(page, 'Next Up'), ['episode-111', 'episode-523']);
    const card = nextUp.locator('[data-item-id="episode-523"]');
    await card.locator('img').evaluate((img) => img.complete && img.naturalWidth > 0
        ? null : new Promise((resolve) => { img.onload = resolve; }));
    const image = await card.locator('img').evaluate((img) =>
        ({ src: img.getAttribute('src'), width: img.naturalWidth, height: img.naturalHeight }));
    assert.match(image.src, /type=Backdrop/);
    assert.deepEqual({ width: image.width, height: image.height }, { width: 220, height: 124 },
        'the fallback must fill the 16:9 still slot, not letterbox a 2:3 poster');
    await assertPainted(card);
}));

test('a profile with nothing in progress gets no Next Up row at all, and no other profile\'s items', async () => withPage(async (page) => {
    await signIn(page, 'user-bob');
    // Bob has no playback history at all, so Continue Watching is empty too.
    assert.deepEqual(await headings(page), ['Recently Added'],
        'an empty Next Up must render nothing -- no row, no stray heading');
    assert.equal(await rowIds(page, 'Next Up'), null);
    const onScreen = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.jq-media-card')).map((card) => card.getAttribute('data-item-id')));
    for (const leaked of ['episode-111', 'episode-523']) {
        assert.equal(onScreen.includes(leaked), false, `${leaked} belongs to another profile and must not appear`);
    }
}));

test('a failing Next Up degrades to a visible message and leaves the other rows alone', async () => withPage(async (page) => {
    await page.evaluate(() => {
        window.ApiClient.getNextUpEpisodes = () => Promise.reject(new Error('next up is down'));
    });
    await signIn(page, 'user-alice');
    assert.deepEqual(await headings(page), ['Continue Watching', 'Recently Added']);
    const message = page.locator('.jq-home-empty');
    assert.equal(await message.textContent(), 'Next Up is unavailable right now.');
    await assertPainted(message);
    assert.deepEqual(await rowIds(page, 'Continue Watching'), ['movie-1', 'episode-516', 'movie-3']);
    assert.ok((await rowIds(page, 'Recently Added')).length > 0);
}));

test('row order is fixed by the screen, not by which fetch resolves first', async () => {
    // Both directions: Next Up last to answer, and Next Up first to answer
    // while both getItems rows are still outstanding.
    for (const slow of ['next-up', 'get-items']) {
        await withPage(async (page) => {
            await page.evaluate(() => document.querySelector('[data-profile-id="user-alice"]').click());
            await page.waitForSelector('.jq-shell');
            await page.waitForFunction(() => window.__release.length > 0);
            await page.evaluate(() => window.__release.splice(0).forEach((release) => release()));
            await page.waitForSelector('.jq-media-card');
            assert.deepEqual(await headings(page), ['Continue Watching', 'Next Up', 'Recently Added'],
                `row order must not depend on resolve order (slow: ${slow})`);
        }, async (page) => {
            await page.evaluate((slowRow) => {
                window.__release = [];
                const defer = (fn, receiver) => function () {
                    const args = arguments;
                    return new Promise((resolve) => {
                        window.__release.push(() => resolve(fn.apply(receiver, args)));
                    });
                };
                if (slowRow === 'next-up') {
                    window.ApiClient.getNextUpEpisodes = defer(window.ApiClient.getNextUpEpisodes, window.ApiClient);
                } else {
                    window.ApiClient.getItems = defer(window.ApiClient.getItems, window.ApiClient);
                }
            }, slow);
        });
    }
});

test('the new row does not move first-card autofocus, and Down from it reaches Next Up', async () => withPage(async (page) => {
    await signIn(page, 'user-alice');
    await page.waitForSelector('.jq-media-card');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-item-id')), 'movie-1');
    await assertPainted(page.locator(':focus'));

    await page.keyboard.press('ArrowDown');
    assert.deepEqual(await page.evaluate(() => {
        const heading = Array.from(document.querySelectorAll('.jq-home-row-heading'))
            .find((node) => node.textContent === 'Next Up');
        return {
            id: document.activeElement.getAttribute('data-item-id'),
            inNextUp: heading.parentElement.contains(document.activeElement),
        };
    }), { id: 'episode-516', inNextUp: true });
    await assertPainted(page.locator(':focus'));

    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-item-id')), 'movie-1');
}));

test('a profile whose Next Up is empty still autofocuses a painted first card', async () => withPage(async (page) => {
    await signIn(page, 'user-bob');
    await page.waitForSelector('.jq-media-card');
    assert.equal(await page.evaluate(() =>
        document.activeElement.classList.contains('jq-media-card')), true);
    await assertPainted(page.locator(':focus'));
}));
