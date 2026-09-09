// The shell's content pane must fill the width left of the rail on every
// screen, and the Library/Series grids must actually put cards across it.
//
// WHY BOTH, and why RENDERED geometry rather than source. This screen has had
// two independent defects at once, and either one alone can make a test that
// checks only the other pass against a broken build:
//
//   1. Every content renderer assigns container.className outright, which
//      dropped the .jq-shell-content the shell had put there -- and with it
//      the `flex: 1 1 auto` that gives the pane the width left of the rail.
//      MEASURED at 1920x1080 before the fix: Search and Requests 696px wide,
//      Library and Series 1036px, Detail 733px, against a 1652px content area.
//      Home was full width only by accident -- its long horizontal rows are
//      intrinsically wide enough to mask the loss.
//   2. The grids were an explicit four 220px tracks. MEASURED with defect 1
//      fixed and this one still present: the Library screen reached x=1920 and
//      the computed template was still `220px 220px 220px 220px`, with every
//      card still ending at x=1256. A test that only checked the container's
//      right edge would have passed against that.
//
// So each screen asserts its pane extent AND, where there is a grid, the
// computed track list and the rendered right edge of the widest card row.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { startServer } from './support/server.mjs';

const server = await startServer();
const simulatorUrl = `${server.baseUrl}/dev/simulator.html`;
test.after(() => server.close());

const VIEWPORT = { width: 1920, height: 1080 };
// shell.css: a 220px rail with 24px of padding each side.
const RAIL = 220 + 24 + 24;
// Every screen's own padding (see each screens/*.css).
const SCREEN_PADDING = 48;
// src/overlay/screens/library.js and screens/series.js.
const COLUMNS = 6;
const CARD_WIDTH = 220;
// screens/library.css's legacy `grid-gap`.
const GRID_GAP = 20;
// screens/detail.css keeps this deliberately, so the synopsis column does not
// run the full width of a 1920px screen.
const DETAIL_MAX_WIDTH = 1200;

const TRACKS = Array(COLUMNS).fill(CARD_WIDTH + 'px').join(' ');
const GRID_WIDTH = COLUMNS * CARD_WIDTH + (COLUMNS - 1) * GRID_GAP;

async function signIn(page) {
    await page.goto(simulatorUrl);
    await page.waitForSelector('.jq-profile-card');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.jq-shell');
    await page.waitForSelector('.jq-media-card');
}

function paneExtent(page, selector) {
    return page.evaluate((selector) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error('screen not rendered: ' + selector);
        const rect = element.getBoundingClientRect();
        return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
    }, selector);
}

// The right edge of the widest row of cards actually laid out inside `grid`,
// plus the computed track list. Rows are grouped by their measured `top`, so
// this reports where cards END, not where their container does.
function gridGeometry(page, selector) {
    return page.evaluate((selector) => {
        const grid = document.querySelector(selector);
        if (!grid) throw new Error('grid not rendered: ' + selector);
        const cards = Array.from(grid.querySelectorAll('.jq-media-card'));
        const rows = [];
        for (const card of cards) {
            const rect = card.getBoundingClientRect();
            const row = rows.find((row) => Math.abs(row.top - rect.top) < 1);
            if (row) {
                row.count++;
                row.right = Math.max(row.right, rect.right);
            } else {
                rows.push({ top: rect.top, right: rect.right, left: rect.left, count: 1 });
            }
        }
        return {
            template: getComputedStyle(grid).gridTemplateColumns,
            cardCount: cards.length,
            firstCard: cards.length
                ? { width: Math.round(cards[0].getBoundingClientRect().width) }
                : null,
            widestRow: rows.length
                ? rows.reduce((widest, row) => (row.right > widest.right ? row : widest))
                : null,
            fullRowLength: rows.length ? Math.max(...rows.map((row) => row.count)) : 0,
            rows: rows.length,
        };
    }, selector);
}

// The extent the pane MUST reach: the whole width right of the rail.
const EXPECTED_PANE = { left: RAIL, right: VIEWPORT.width, width: VIEWPORT.width - RAIL };

async function withPage(run) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: VIEWPORT });
        page.setDefaultTimeout(8000);
        await run(page);
    } finally {
        await browser.close();
    }
}

// ---- The pane, screen by screen ----------------------------------------
//
// Home is included even though it measured full width before the fix: it was
// full width by ACCIDENT, and a screen that is correct for the wrong reason is
// exactly the one that regresses silently.
for (const [label, selector, open] of [
    ['Home', '.jq-home-screen', async (page) => {
        await page.locator('.jq-nav-home').click();
        await page.waitForSelector('.jq-home-screen .jq-media-card');
    }],
    ['Search', '.jq-search-screen', async (page) => {
        await page.locator('.jq-nav-search').click();
        await page.waitForSelector('.jq-search-input');
    }],
    ['Requests', '.jq-requests-screen', async (page) => {
        await page.locator('.jq-nav-requests').click();
        await page.waitForSelector('.jq-requests-screen');
        // The settled state, not the loading paragraph: app.js renders one
        // className and requests.js replaces it with another, and BOTH lost
        // the shell class. Waiting for the input asserts the second one.
        await page.waitForSelector('.jq-requests-input');
    }],
    ['Library', '.jq-library-screen', async (page) => {
        await page.locator('.jq-nav-shows').click();
        await page.waitForSelector('.jq-library-grid .jq-media-card');
    }],
    ['Series', '.jq-series-screen', async (page) => {
        await page.locator('.jq-nav-shows').click();
        await page.waitForSelector('[data-item-id="series-1"]');
        await page.locator('[data-item-id="series-1"]').click();
        await page.waitForSelector('.jq-series-episodes .jq-media-card');
    }],
]) {
    test(`${label} fills the content pane left of the rail`, async () => withPage(async (page) => {
        await signIn(page);
        await open(page);
        assert.deepEqual(await paneExtent(page, selector), EXPECTED_PANE,
            `${label}: the content pane must span the rail's right edge to the screen edge`);
        assert.equal(
            await page.locator(selector).evaluate((element) => element.classList.contains('jq-shell-content')),
            true,
            `${label}: the renderer must not overwrite the shell's structural class`);
    }));
}

test('Detail fills the pane up to its deliberate max-width', async () => withPage(async (page) => {
    await signIn(page);
    await page.locator('.jq-nav-home').click();
    await page.waitForSelector('.jq-home-screen .jq-media-card');
    await page.locator('.jq-home-row .jq-media-card').first().click();
    await page.waitForSelector('.jq-detail-screen .jq-detail-action');

    // Detail is the one screen that must NOT reach x=1920: detail.css caps the
    // synopsis column at 1200px on purpose. What the fix has to change here is
    // that the pane is no longer sized by its CONTENT -- it measured 733px,
    // i.e. whatever the text happened to need -- but by that cap.
    const pane = await paneExtent(page, '.jq-detail-screen');
    assert.deepEqual(pane, { left: RAIL, right: RAIL + DETAIL_MAX_WIDTH, width: DETAIL_MAX_WIDTH },
        'Detail must be exactly its max-width, not its content width');
    assert.ok(DETAIL_MAX_WIDTH < VIEWPORT.width - RAIL,
        'the cap is only meaningful while it is narrower than the pane');
    assert.equal(
        await page.locator('.jq-detail-screen').evaluate((element) => getComputedStyle(element).maxWidth),
        DETAIL_MAX_WIDTH + 'px', 'the max-width must survive the restored shell class');
}));

// ---- The two app.js paths ----------------------------------------------
//
// These are the sites the screen renderers do not own: showDetail()'s
// unsupported-item guard and showRequests()'s loading state. Both assigned
// className outright and both lost the shell class, and neither is reachable
// through the settled-screen cases above -- the Requests case waits for the
// input, which only exists once requests.js has re-rendered, and the Detail
// case selects a playable item. Reverting just these two assignments to bare
// classes left every other case in this file green.

test('an unsupported item fills the pane rather than its own text', async () => withPage(async (page) => {
    await page.goto(simulatorUrl);
    await page.waitForSelector('.jq-profile-card');
    await page.evaluate(() => {
        window.ApiClient.getItems = () => Promise.resolve({
            Items: [{ Id: 'unsupported', Type: 'Audio', IsFolder: false,
                Name: 'Unsupported example', ServerId: 'dev-server-1' }],
        });
    });
    await page.keyboard.press('Enter');
    await page.waitForSelector('.jq-media-card');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.jq-detail-error');

    // This screen is a heading, one line of error text and a Back button, so
    // shrink-wrapping is at its most visible here: it measured its own text.
    assert.equal(await page.locator('.jq-detail-screen').evaluate((element) =>
        element.classList.contains('jq-shell-content')), true,
    'the unsupported-item fallback must not overwrite the shell class');
    assert.deepEqual(await paneExtent(page, '.jq-detail-screen'),
        { left: RAIL, right: RAIL + DETAIL_MAX_WIDTH, width: DETAIL_MAX_WIDTH },
        'the unsupported-item fallback must be its max-width, not its content width');
}));

test('the Requests loading state fills the pane before its configuration lands', async () => withPage(async (page) => {
    // app.js fetches the build configuration once at boot, fire-and-forget,
    // so holding it from before the first navigation is the only way to see
    // showRequests()'s loading render at all.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route('**/jellyquest-build.json', async (route) => {
        await held;
        await route.continue();
    });
    await page.goto(simulatorUrl);
    await page.waitForSelector('.jq-profile-card');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.jq-media-card');
    await page.locator('.jq-nav-requests').click();
    await page.getByText('Loading Requests configuration…', { exact: true }).waitFor();

    // PRECONDITION: this must be the LOADING render, not the settled one that
    // the Requests case above already covers.
    assert.equal(await page.locator('.jq-requests-input').count(), 0,
        'the settled Requests screen must not have replaced this render yet');
    assert.equal(await page.locator('.jq-requests-screen').evaluate((element) =>
        element.classList.contains('jq-shell-content')), true,
    'the Requests loading render must not overwrite the shell class');
    assert.deepEqual(await paneExtent(page, '.jq-requests-screen'), EXPECTED_PANE,
        'the Requests loading render must span the pane');

    release();
    await page.waitForSelector('.jq-requests-input');
    assert.deepEqual(await paneExtent(page, '.jq-requests-screen'), EXPECTED_PANE,
        'and so must the settled render that replaces it');
}));

test('the profile picker is untouched and still spans the whole screen', async () => withPage(async (page) => {
    await page.goto(simulatorUrl);
    await page.waitForSelector('.jq-profile-card');
    // Profiles replaces the top-level root after the shell is removed, so it
    // never receives the shell's content class and centres itself instead. It
    // measured 0/1920/1920 before this change and must still.
    assert.deepEqual(await paneExtent(page, '.jq-profiles-screen'),
        { left: 0, right: VIEWPORT.width, width: VIEWPORT.width });
    assert.equal(
        await page.locator('.jq-profiles-screen').evaluate((element) =>
            element.classList.contains('jq-shell-content')),
        false, 'the profile picker must not be given the shell content class');
}));

// ---- The grids ----------------------------------------------------------
for (const [label, screenSelector, gridSelector, open] of [
    ['Library', '.jq-library-screen', '.jq-library-grid', async (page) => {
        await page.locator('.jq-nav-shows').click();
        await page.waitForSelector('.jq-library-grid .jq-media-card');
    }],
    ['Series', '.jq-series-screen', '.jq-series-episodes', async (page) => {
        await page.locator('.jq-nav-shows').click();
        await page.waitForSelector('[data-item-id="series-1"]');
        await page.locator('[data-item-id="series-1"]').click();
        await page.waitForSelector('.jq-series-episodes .jq-media-card');
    }],
]) {
    test(`${label} lays ${COLUMNS} cards across the pane, measured on the cards`, async () => withPage(async (page) => {
        await signIn(page);
        await open(page);

        const geometry = await gridGeometry(page, gridSelector);
        // PRECONDITION. A grid with fewer cards than one row cannot show a
        // short row from a full one, so the row assertions below would pass
        // vacuously against any track count.
        assert.ok(geometry.cardCount > COLUMNS,
            `${label}: the fixture must render more than one row, got ${geometry.cardCount}`);
        assert.ok(geometry.rows > 1, `${label}: the fixture must render more than one row`);

        // The template, because the container can be full width while the
        // tracks are not...
        assert.equal(geometry.template, TRACKS,
            `${label}: the computed grid must be ${COLUMNS} ${CARD_WIDTH}px tracks`);
        // ...and the cards, because a template can be right while the cards
        // are laid out somewhere else entirely.
        assert.equal(geometry.fullRowLength, COLUMNS,
            `${label}: a full row must actually contain ${COLUMNS} cards`);
        assert.equal(geometry.firstCard.width, CARD_WIDTH,
            `${label}: cards must render at ${CARD_WIDTH}px`);

        const pane = await paneExtent(page, screenSelector);
        const expectedRight = pane.left + SCREEN_PADDING + GRID_WIDTH;
        assert.equal(Math.round(geometry.widestRow.right), expectedRight,
            `${label}: the widest card row must end at ${expectedRight}px, not short of it`);
        // The whole point of the report: cards used to stop at x=1256.
        assert.ok(geometry.widestRow.right > 1256,
            `${label}: cards ending at ${geometry.widestRow.right}px is the four-column layout`);
        // ...and six tracks must still FIT. Seven would need
        // 7 * 220 + 6 * 20 = 1660px against 1556px of usable width.
        const usable = pane.width - 2 * SCREEN_PADDING;
        assert.ok(GRID_WIDTH <= usable,
            `${label}: ${COLUMNS} tracks need ${GRID_WIDTH}px and only ${usable}px is usable`);
        assert.ok((COLUMNS + 1) * CARD_WIDTH + COLUMNS * GRID_GAP > usable,
            `${label}: ${COLUMNS + 1} tracks must not also fit, or the grid is under-filled`);
        assert.equal(await page.evaluate((selector) =>
            document.querySelector(selector).scrollWidth <= document.querySelector(selector).clientWidth,
        screenSelector), true, `${label}: the grid must not overflow the pane horizontally`);
    }));
}
