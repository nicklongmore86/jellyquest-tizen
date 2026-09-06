import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServer } from './support/server.mjs';
import { assertSiblingSpacing, assertWrappedSpacing } from './support/spacing.mjs';

const server = await startServer();
test.after(() => server.close());

// Reach screens through the same profile, navigation, search and More actions
// used by the existing specs. No production hooks or synthetic card elements.
async function openScreen(page, screen) {
    await page.goto(`${server.baseUrl}/dev/simulator.html`);
    await page.waitForSelector('.jq-profile-card');
    if (screen === 'profiles') return;
    await page.keyboard.press('Enter'); // Alice
    await page.waitForSelector('.jq-media-card');
    if (screen === 'home') return;
    if (screen === 'exit') {
        // Escape doubles as Back in the simulator (see app.js's BACK_KEY_CODES).
        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-exit-confirm');
        return;
    }
    if (screen === 'library') {
        await page.locator('.jq-see-all').click();
        await page.waitForSelector('.jq-library-grid .jq-media-card');
        return;
    }
    if (screen === 'detail' || screen === 'playback') {
        await page.locator('[data-item-id="movie-1"]').click();
        await page.waitForSelector('.jq-detail-action');
        if (screen === 'playback') {
            await page.locator('.jq-detail-action').filter({ hasText: /^More$/ }).click();
            await page.waitForSelector('.jq-playback-options');
        }
        return;
    }
    await page.locator(`.jq-nav-${screen}`).click();
    const input = page.locator(`.jq-${screen}-input`);
    await input.fill('a'); // Multiple existing matches in both simulator fixtures.
    await page.waitForSelector(screen === 'search'
        ? '.jq-search-results .jq-media-card' : '.jq-request-card');
}

for (const [selector, screen, axis, containers = 1] of [
    ['.jq-rail', 'home', 'y'],
    ['.jq-profiles-row', 'profiles', 'x'],
    ['.jq-home-row', 'home', 'x', 2],
    ['.jq-search-results', 'search', 'x'],
    ['.jq-detail-actions', 'detail', 'x'],
    ['.jq-playback-options', 'playback', 'y'],
    ['.jq-playback-option-group', 'playback', 'y', 2],
    ['.jq-exit-actions', 'exit', 'x'],
    ['.jq-request-card', 'requests', 'y', 3],
    ['.jq-requests-results', 'requests', 'wrapped'],
]) {
    test(`margin spacing without flex gap: ${selector}`, async () => {
        const browser = await chromium.launch();
        try {
            // At 1020px the real Requests cards form a two-card line plus one
            // wrapped card, exercising both axes and container compensation.
            const page = await browser.newPage({
                viewport: { width: axis === 'wrapped' ? 1020 : 1920, height: 1080 },
            });
            await openScreen(page, screen);
            if (axis === 'wrapped') await assertWrappedSpacing(page, selector);
            else await assertSiblingSpacing(page, selector, axis, containers);
        } finally {
            await browser.close();
        }
    });
}

// In modern Chromium, gap and grid-gap are aliases: injecting gap: 0 also
// disables the legacy spelling. Do not pretend that simulates M63. Instead,
// guard the source spelling explicitly and measure the unmodified grid.
test('library grid retains legacy grid-gap and positive spacing on both axes', async () => {
    const css = await readFile(new URL('../../src/overlay/screens/library.css', import.meta.url), 'utf8');
    assertLegacyGridSpacing(css);

    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openScreen(page, 'library');
        assert.equal(await page.locator('.jq-library-grid').count(), 1);
        const rects = await page.locator('.jq-library-grid > *').evaluateAll((children) => children.map((child) => {
            const { left, right, top, bottom, width, height } = child.getBoundingClientRect();
            return { left, right, top, bottom, width, height };
        }));
        assert.equal(rects.length, 50, 'Library fixture fills its own bound, including a partial last row');
        for (const [i, rect] of rects.entries()) {
            assert.ok(rect.width > 0 && rect.height > 0, 'Library cards must have visible geometry');
            if (i % 4 !== 0) {
                assert.ok(Math.abs(rect.top - rects[i - 1].top) < 1, 'Four cards must share each line');
                const separation = rect.left - rects[i - 1].right;
                assert.ok(separation > 0, `Library x separation ${separation}px must be positive`);
            }
            if (i >= 4) {
                assert.ok(Math.abs(rect.left - rects[i - 4].left) < 1, 'Library columns must align');
                const separation = rect.top - rects[i - 4].bottom;
                assert.ok(separation > 0, `Library y separation ${separation}px must be positive`);
            }
        }
    } finally {
        await browser.close();
    }
});

function assertLegacyGridSpacing(css) {
    const rules = Array.from(css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.jq-library-grid\s*\{([^}]+)\}/g));
    assert.ok(rules.length > 0, 'Library spacing rule must exist');
    const declarations = rules.map((rule) => rule[1]).join(';');
    assert.match(declarations, /(?:^|;)\s*grid-(?:row-|column-)?gap\s*:/, 'Library must retain M63-compatible legacy grid gap declarations');
    assert.doesNotMatch(declarations, /(?:^|;)\s*(?:gap|row-gap|column-gap)\s*:/,
        'Library spacing must not depend on modern gap spellings');
}

test('library spelling guard accepts legacy longhands and rejects incompatible rules', () => {
    const rule = (declarations) => `.jq-library-grid { ${declarations} }`;
    assert.doesNotThrow(() => assertLegacyGridSpacing(rule('grid-gap: 20px;')));
    assert.doesNotThrow(() => assertLegacyGridSpacing(rule('grid-row-gap: 20px; grid-column-gap: 20px;')));
    assert.throws(() => assertLegacyGridSpacing(rule('gap: 20px;')),
        /Library must retain M63-compatible/);
    assert.throws(() => assertLegacyGridSpacing(rule('-webkit-grid-gap: 20px;')),
        /Library must retain M63-compatible/);
    assert.throws(() => assertLegacyGridSpacing('.jq-library-grid, .other { grid-gap: 20px; }'),
        /Library spacing rule must exist/);
    // Legacy declarations must not trigger the modern-property rejection, but
    // a separate modern declaration must still be rejected alongside them.
    for (const property of ['gap', 'row-gap', 'column-gap']) {
        assert.throws(() => assertLegacyGridSpacing(rule(`grid-gap: 20px; ${property}: 20px;`)),
            /Library spacing must not depend on modern gap spellings/);
    }
});
