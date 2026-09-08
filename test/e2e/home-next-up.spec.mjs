// Home's "Next Up" row, driven by the LIBRARY-WIDE /Shows/NextUp endpoint
// (ApiClient.getNextUpEpisodes with no SeriesId).
//
// Two halves, deliberately separated:
//   * FIXTURE CONTRACT -- runs the stub in a bare vm context, no browser, and
//     pins the transport semantics MEASURED against the household's Jellyfin
//     10.11.11 (Limit/StartIndex/EnableResumable honoured, TotalRecordCount
//     pre-limit and tracking suppression, SortBy/SortOrder/IsMissing/
//     IsVirtualUnaired accepted-and-ignored).
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

// Where the cursor is: the Home row that owns it, or the shell chrome it
// escaped to. Named rather than id-based so a trace reads like the traversal.
function cursor(page) {
    return page.evaluate(() => {
        const active = document.activeElement;
        if (!active || active === document.body) return { row: 'NOWHERE', id: null };
        const section = active.closest ? active.closest('.jq-home-row-section') : null;
        return {
            row: section
                ? section.querySelector('.jq-home-row-heading').textContent
                : (active.className || '').indexOf('jq-rail-item') !== -1 ? 'RAIL' : 'OFF-SCREEN',
            id: active.getAttribute('data-item-id'),
        };
    });
}

function homeGeometry(page) {
    return page.evaluate(() => {
        const screen = document.querySelector('.jq-home-screen');
        return {
            scrollRange: screen.scrollHeight - screen.clientHeight,
            scrollTop: screen.scrollTop,
            rows: Array.from(document.querySelectorAll('.jq-home-row-section'), (section) => ({
                title: section.querySelector('.jq-home-row-heading').textContent,
                cardHeight: Math.round(section.querySelector('.jq-media-card').getBoundingClientRect().height),
            })),
        };
    });
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
    assert.deepEqual(Array.from(dana.Items, (item) => item.Id), ['episode-114', 'episode-523']);
    assert.equal(dana.TotalRecordCount, 2);
    assert.ok(dana.Items.every((item) => item.Type === 'Episode'));
    for (const [userId, seriesId, expected] of [
        ['user-alice', 'series-paw-patrol', 'episode-516'],
        ['user-dana', 'series-1', 'episode-114'],
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
    assert.deepEqual(Array.from(limited.Items, (item) => item.Id), ['episode-114']);
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
    assert.equal(lead.Id, 'episode-114');
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
    // A Next Up item that SURVIVES EnableResumable: false must lack its own
    // still, or the artwork fallback tier is untested on the path the app
    // actually takes.
    const rendered = await api.getNextUpEpisodes({ UserId: 'user-dana', EnableResumable: false });
    assert.ok(rendered.Items.length > 0);
    assert.ok(Array.from(rendered.Items).every((item) => !item.ImageTags.Primary));
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

test('EnableResumable is HONOURED: false removes exactly the resumable items', async () => {
    const api = loadStub();
    // MEASURED, and the reason `true` is checked first: on this endpoint a
    // matching baseline proves nothing on its own -- an accepted-and-ignored
    // option matches the baseline too. What establishes that this one is
    // honoured is the FALSE delta below (Nick 15 -> 8, Kids 3 -> 1).
    const baseline = await api.getNextUpEpisodes({ UserId: 'user-dana' });
    const kept = await api.getNextUpEpisodes({ UserId: 'user-dana', EnableResumable: true });
    assert.equal(JSON.stringify(kept), JSON.stringify(baseline), 'true must return the baseline body');

    const suppressed = await api.getNextUpEpisodes({ UserId: 'user-dana', EnableResumable: false });
    assert.deepEqual(Array.from(baseline.Items, (item) => item.Id), ['episode-114', 'episode-523']);
    assert.deepEqual(Array.from(suppressed.Items, (item) => item.Id), ['episode-114'],
        'exactly the item with saved progress is removed, and the rest keep baseline order');
    // TotalRecordCount tracks the suppression -- MEASURED 15 -> 8 and 3 -> 1.
    assert.equal(baseline.TotalRecordCount, 2);
    assert.equal(suppressed.TotalRecordCount, 1);
    // Nothing is substituted for the removed card.
    for (const item of suppressed.Items) {
        assert.ok(baseline.Items.some((original) => original.Id === item.Id),
            `${item.Id} is not in the baseline: suppression must not invent a replacement`);
    }
    // The removed item is exactly the one with playback progress, which is
    // also what puts it on the Continue Watching row.
    const removed = Array.from(baseline.Items).filter((item) =>
        !suppressed.Items.some((survivor) => survivor.Id === item.Id));
    assert.deepEqual(Array.from(removed, (item) => item.Id), ['episode-523']);
    assert.ok(removed.every((item) => item.UserData.PlaybackPositionTicks > 0));
    assert.ok(Array.from(suppressed.Items).every((item) => !item.UserData.PlaybackPositionTicks));

    // A profile whose only candidate is resumable is left with nothing. This
    // is a real, reachable state, not a fixture accident.
    const alice = await api.getNextUpEpisodes({ UserId: 'user-alice', EnableResumable: false });
    assert.deepEqual(Array.from(alice.Items), []);
    assert.equal(alice.TotalRecordCount, 0);

    await assert.rejects(async () => api.getNextUpEpisodes({ UserId: 'user-dana', EnableResumable: 'false' }),
        /Unmodeled EnableResumable/);
});

test('EnableResumable and EnableRewatching do not mask each other', async () => {
    const api = loadStub();
    const both = await api.getNextUpEpisodes({ UserId: 'user-dana', EnableRewatching: true, EnableResumable: false });
    const rewatchOnly = await api.getNextUpEpisodes({ UserId: 'user-dana', EnableRewatching: true });
    // MEASURED: resumable suppression removes the same ids with rewatching off
    // or on (15 -> 8 and 19 -> 12).
    assert.deepEqual(Array.from(rewatchOnly.Items, (item) => item.Id), ['episode-114', 'episode-113', 'episode-523']);
    assert.deepEqual(Array.from(both.Items, (item) => item.Id), ['episode-114', 'episode-113']);
    assert.equal(both.TotalRecordCount, 2);
});

// ---- Screen behaviour -------------------------------------------------
//
// Dana is the profile whose Next Up row survives EnableResumable: false; see
// the fixture. Alice's only candidate is her in-progress episode-516, so her
// row is the measurably-reachable EMPTY case.

test('Home renders Next Up between Continue Watching and Recently Added', async () => withPage(async (page) => {
    await signIn(page, 'user-dana');
    assert.deepEqual(await headings(page), ['Continue Watching', 'Next Up', 'Recently Added']);
    assert.deepEqual(await rowIds(page, 'Next Up'), ['episode-114']);
    // The row carries no "See All": the Library screen queries getItems, which
    // cannot express /Shows/NextUp.
    assert.equal(await page.evaluate(() =>
        Array.from(document.querySelectorAll('.jq-home-row-heading'))
            .find((node) => node.textContent === 'Next Up')
            .parentElement.querySelectorAll('.jq-see-all').length), 0);
}));

test('a resumable episode already on Continue Watching does not come back in Next Up', async () => withPage(async (page) => {
    // MEASURED: without EnableResumable: false this endpoint returns the
    // in-progress episode ITSELF, and 47% of the largest profile's row (7 of
    // 15) and 67% of the restricted profile's (2 of 3) were duplicates of
    // Continue Watching cards.
    await signIn(page, 'user-dana');
    assert.deepEqual(await rowIds(page, 'Continue Watching'), ['movie-6', 'episode-523']);
    assert.deepEqual(await rowIds(page, 'Next Up'), ['episode-114'],
        'the resumable episode must be suppressed, and nothing substituted for it');
    const continueWatching = await rowIds(page, 'Continue Watching');
    const nextUp = await rowIds(page, 'Next Up');
    assert.deepEqual(nextUp.filter((id) => continueWatching.indexOf(id) !== -1), [],
        'the two rows must share no card');
    // And the suppressed episode is genuinely a Next Up candidate -- it is in
    // the baseline the fixture would return without the parameter, so this
    // asserts suppression rather than an absence that was never there.
    const baseline = await page.evaluate(() =>
        window.ApiClient.getNextUpEpisodes({ UserId: 'user-dana' })
            .then((result) => result.Items.map((item) => item.Id)));
    assert.deepEqual(baseline, ['episode-114', 'episode-523']);
}));

test('a profile whose only Next Up candidate is resumable renders no row at all', async () => withPage(async (page) => {
    await signIn(page, 'user-alice');
    assert.deepEqual(await headings(page), ['Continue Watching', 'Recently Added'],
        'an empty Next Up must render nothing -- no row, no stray heading');
    assert.equal(await rowIds(page, 'Next Up'), null);
    assert.equal(await page.locator('.jq-home-empty').count(), 0,
        'an empty row is not an error and must not print a message');
    // episode-516 is on Continue Watching and nowhere else on the screen.
    const onScreen = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.jq-media-card'), (card) => card.getAttribute('data-item-id')));
    assert.equal(onScreen.filter((id) => id === 'episode-516').length, 1);
}));

test('Home asks for Next Up user-scoped, bounded, resumable-suppressed, and without the ignored options', async () => withPage(async (page) => {
    // Records the options BEFORE calling through, and waits on the RECORD
    // rather than on a rendered row. A wrong query makes the strict fixture
    // throw, which aborts Home's render -- so a test that synchronised on a
    // heading would report that as a timeout and never reach this assertion.
    await page.evaluate(() => {
        window.__nextUpCalls = [];
        const real = window.ApiClient.getNextUpEpisodes.bind(window.ApiClient);
        window.ApiClient.getNextUpEpisodes = function (options) {
            window.__nextUpCalls.push({ ...options });
            return real(options);
        };
    });
    await page.evaluate(() => document.querySelector('[data-profile-id="user-dana"]').click());
    await page.waitForSelector('.jq-shell');
    // Flush the turn Home issues its fetches in, then read once. Not a wait:
    // "the row was never requested at all" must fail as an assertion too.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.deepEqual(await page.evaluate(() => window.__nextUpCalls), [
        { UserId: 'user-dana', Limit: 8, EnableResumable: false, EnableRewatching: false },
    ]);
}));

test('a Next Up card routes to Episode Detail, exactly as Continue Watching does', async () => withPage(async (page) => {
    await signIn(page, 'user-dana');
    await page.evaluate(() => {
        const heading = Array.from(document.querySelectorAll('.jq-home-row-heading'))
            .find((node) => node.textContent === 'Next Up');
        heading.parentElement.querySelector('[data-item-id="episode-114"]').click();
    });
    await page.waitForSelector('.jq-detail-screen');
    const title = await page.locator('.jq-detail-title').textContent();
    assert.match(title, /Northern Stories 1/);
    assert.match(title, /S8 E9 · Northern Journey 114/);
}));

test('a Next Up episode with no still of its own falls back to the parent backdrop', async () => withPage(async (page) => {
    await signIn(page, 'user-dana');
    // Synchronise on the render, then ASSERT the row and its card with
    // non-waiting DOM reads, so an absent row fails by assertion here rather
    // than by timing out on an image that was never going to appear.
    assert.deepEqual(await headings(page), ['Continue Watching', 'Next Up', 'Recently Added']);
    assert.deepEqual(await rowIds(page, 'Next Up'), ['episode-114']);
    const nextUp = page.locator('.jq-home-row-section').nth(1);
    const card = nextUp.locator('[data-item-id="episode-114"]');
    // Only the decode is genuinely asynchronous, and only this wait remains.
    await card.locator('img').evaluate((img) => img.complete && img.naturalWidth > 0
        ? null : new Promise((resolve) => { img.onload = resolve; }));
    const image = await card.locator('img').evaluate((img) =>
        ({ src: img.getAttribute('src'), width: img.naturalWidth, height: img.naturalHeight }));
    assert.match(image.src, /type=Backdrop/);
    assert.deepEqual({ width: image.width, height: image.height }, { width: 220, height: 124 },
        'the fallback must fill the 16:9 still slot, not letterbox a 2:3 poster');
    await assertPainted(card);
}));

test('the row renders the server order verbatim and does not re-sort it', async () => withPage(async (page) => {
    // The suppressed fixture row is one card, so the ordering guarantee is
    // driven here from a two-item response in the MEASURED shape: the leading
    // item has never been played (its SERIES has the most recent activity)
    // while the one behind it carries a real play date. A client-side re-sort
    // by the returned item's own date inverts the pair.
    await page.evaluate(() => {
        window.ApiClient.getNextUpEpisodes = () => Promise.resolve({
            TotalRecordCount: 2,
            Items: [
                { Id: 'lead-episode', Name: 'Never Played', Type: 'Episode', ServerId: 'dev-server-1',
                    SeriesId: 'series-1', SeriesName: 'Northern Stories 1', SeasonId: 'season-8',
                    ParentIndexNumber: 8, IndexNumber: 9, ImageTags: { Primary: 'preview-v1' },
                    UserData: { PlaybackPositionTicks: 0, Played: false } },
                { Id: 'trailing-episode', Name: 'Played Earlier', Type: 'Episode', ServerId: 'dev-server-1',
                    SeriesId: 'series-paw-patrol', SeriesName: 'PAW Patrol', SeasonId: 'season-30',
                    ParentIndexNumber: 7, IndexNumber: 7, ImageTags: { Primary: 'preview-v1' },
                    UserData: { PlaybackPositionTicks: 0, Played: true, LastPlayedDate: '2026-09-05T12:00:00Z' } },
            ],
        });
    });
    await signIn(page, 'user-dana');
    assert.deepEqual(await rowIds(page, 'Next Up'), ['lead-episode', 'trailing-episode']);
}));

test('a profile with nothing in progress gets no Next Up row at all, and no other profile\'s items', async () => withPage(async (page) => {
    await signIn(page, 'user-bob');
    // Bob has no playback history at all, so Continue Watching is empty too.
    assert.deepEqual(await headings(page), ['Recently Added'],
        'an empty Next Up must render nothing -- no row, no stray heading');
    assert.equal(await rowIds(page, 'Next Up'), null);
    const onScreen = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.jq-media-card')).map((card) => card.getAttribute('data-item-id')));
    for (const leaked of ['episode-114', 'episode-523', 'episode-516']) {
        assert.equal(onScreen.includes(leaked), false, `${leaked} belongs to another profile and must not appear`);
    }
}));

test('a failing Next Up degrades to a visible message and leaves the other rows alone', async () => withPage(async (page) => {
    await page.evaluate(() => {
        window.ApiClient.getNextUpEpisodes = () => Promise.reject(new Error('next up is down'));
    });
    await signIn(page, 'user-dana');
    // signIn waits for a heading, and Promise.all gates all three rows, so by
    // the time ANY heading exists this render is finished -- including the
    // failed row's message. Everything below is therefore a non-waiting read:
    // a missing message must fail as an assertion, not as a five-second
    // textContent() timeout.
    assert.deepEqual(await headings(page), ['Continue Watching', 'Recently Added']);
    assert.deepEqual(
        await page.evaluate(() => Array.from(document.querySelectorAll('.jq-home-empty'), (p) => p.textContent)),
        ['Next Up is unavailable right now.']);
    await assertPainted(page.locator('.jq-home-empty'));
    assert.deepEqual(await rowIds(page, 'Continue Watching'), ['movie-6', 'episode-523']);
    assert.ok((await rowIds(page, 'Recently Added')).length > 0);
}));

test('row order is fixed by the screen, not by which fetch resolves first', async () => {
    // Both directions: Next Up last to answer, and Next Up first to answer
    // while both getItems rows are still outstanding.
    for (const slow of ['next-up', 'get-items']) {
        await withPage(async (page) => {
            await page.evaluate(() => document.querySelector('[data-profile-id="user-dana"]').click());
            await page.waitForSelector('.jq-shell');
            // Flush the turn Home's fetches are issued in, then ASSERT that
            // the deferral actually happened. Waiting for it instead would
            // report "the row was never requested" as a timeout.
            await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
            const deferred = await page.evaluate(() => window.__release.length);
            assert.ok(deferred > 0,
                `the ${slow} request must have been made and held: ${deferred} deferred`);
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
    await signIn(page, 'user-dana');
    await page.waitForSelector('.jq-media-card');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-item-id')), 'movie-6',
        'autofocus stays on the first Continue Watching card');
    await assertPainted(page.locator(':focus'));

    await page.keyboard.press('ArrowDown');
    assert.deepEqual(await page.evaluate(() => {
        const heading = Array.from(document.querySelectorAll('.jq-home-row-heading'))
            .find((node) => node.textContent === 'Next Up');
        return {
            id: document.activeElement.getAttribute('data-item-id'),
            inNextUp: heading.parentElement.contains(document.activeElement),
        };
    }), { id: 'episode-114', inNextUp: true });
    await assertPainted(page.locator(':focus'));

    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-item-id')), 'movie-6');
}));

test('a profile whose Next Up is empty still autofocuses a painted first card', async () => withPage(async (page) => {
    await signIn(page, 'user-alice');
    await page.waitForSelector('.jq-media-card');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-item-id')), 'movie-1');
    await assertPainted(page.locator(':focus'));
}));

test('walking DOWN all three rows and back UP returns to Continue Watching', async () => withPage(async (page) => {
    // The third up-traversal defect this codebase has had (see PR #21 and
    // PR #25). Each one was invisible until a test used a geometry where
    // stranding was structurally possible, so the preconditions that make it
    // possible are asserted here rather than assumed -- a future fixture that
    // flattens Home would fail this test instead of passing it vacuously.
    await signIn(page, 'user-dana');
    await page.waitForSelector('.jq-media-card');

    const geometry = await homeGeometry(page);
    assert.deepEqual(geometry.rows.map((row) => row.title),
        ['Continue Watching', 'Next Up', 'Recently Added'], 'this profile must have three rows');
    assert.ok(geometry.scrollRange > 0,
        `Home must genuinely overflow, or nothing can strand: range ${geometry.scrollRange}px`);
    assert.equal(geometry.scrollTop, 0, 'a freshly rendered Home starts at the top');
    const heights = geometry.rows.map((row) => row.cardHeight);
    assert.ok(heights[1] < heights[0],
        `the Next Up row must be SHORTER than the row above it -- ${heights.join('/')}px -- `
        + 'because a reveal sized for the shorter row is what fails to uncover the taller one');

    const trace = [await cursor(page)];
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp']) {
        await page.keyboard.press(key);
        trace.push(await cursor(page));
    }
    assert.deepEqual(trace.map((step) => step.row), [
        'Continue Watching', 'Next Up', 'Recently Added', 'Next Up', 'Continue Watching',
    ], 'the walk down must retrace exactly, and never leave the screen for the rail');

    // The descent has to have actually scrolled, or the return trip never
    // faced the condition that strands it.
    assert.ok(trace[2].row === 'Recently Added');
    assert.equal(trace[4].id, trace[0].id, 'the round trip must end on the card it started from');
    assert.equal((await homeGeometry(page)).scrollTop, 0,
        'returning to the first row must scroll Home back to the top');
    await assertPainted(page.locator(':focus'));
}));

test('the descent scrolls Home, and the return trip un-scrolls it', async () => withPage(async (page) => {
    // Separated from the traversal above so a failure says WHICH half broke.
    await signIn(page, 'user-dana');
    await page.waitForSelector('.jq-media-card');
    const scrollTop = () => page.evaluate(() => document.querySelector('.jq-home-screen').scrollTop);

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const atBottom = await scrollTop();
    assert.ok(atBottom > 0, `reaching the last row must scroll Home: scrollTop ${atBottom}px`);

    await page.keyboard.press('ArrowUp');
    const midway = await scrollTop();
    assert.ok(midway < atBottom,
        `returning up must give scroll back so the row above is uncovered: ${midway}px vs ${atBottom}px`);
    // The card in the row ABOVE the cursor must be fully on screen, because
    // the polyfill's hitTest() rejects a candidate whose top is negative
    // before it considers how much of it is visible.
    const above = await page.evaluate(() => {
        const sections = document.querySelectorAll('.jq-home-row-section');
        return Math.round(sections[0].querySelector('.jq-media-card').getBoundingClientRect().top);
    });
    assert.ok(above >= 0,
        `the row above must not sit at a negative offset, or it stops being a candidate: top ${above}px`);
}));
