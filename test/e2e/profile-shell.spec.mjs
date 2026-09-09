// Drives the real profile picker + shell (see docs/rebuild-plan.md,
// Phase 2) against the simulator. Supersedes the Phase 1 spike
// (focus.spec.mjs, now removed) now that a real screen exercises the
// same navigation conventions -- .jq-row here plays the role
// jq-row/jq-rail did in that spike.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { startServer } from './support/server.mjs';
import { assertPainted } from './support/paint.mjs';
import { assertSiblingSpacing } from './support/spacing.mjs';

const server = await startServer();
const simulatorUrl = `${server.baseUrl}/dev/simulator.html`;
test.after(() => server.close());

test('profile picker is the landing screen: no login form, autofocus on the first profile', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await page.goto(simulatorUrl);
        await page.waitForSelector('.jq-profile-card');

        const names = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.jq-profile-card')).map((card) => card.textContent)
        );
        assert.deepEqual(names, ['Alice', 'Bob', 'Charlie', 'Dana']);
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Alice');

        // No manual-login/Quick Connect/admin surfaces anywhere on this screen.
        assert.equal(await page.evaluate(() => document.querySelectorAll('input, form').length), 0);
    } finally {
        await browser.close();
    }
});

test('arrow keys move across the profile row', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await page.goto(simulatorUrl);
        await page.waitForSelector('.jq-profile-card');

        // Exercise all four household profiles with ordinary browser spacing.
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Bob');
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Charlie');
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Dana');
        await page.keyboard.press('ArrowLeft');
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Charlie');
        await page.keyboard.press('ArrowLeft');
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Bob');
    } finally {
        await browser.close();
    }
});

// Old TV Chromium silently drops flex gap. Keep the real polyfill active
// and remove gap at runtime so modern Chromium reproduces that layout.
for (const [key, expected] of [
    ['ArrowRight', [0, 1, 2, 3]],
    ['ArrowLeft', [3, 2, 1, 0]]
]) {
    test(`profile cards remain consecutive without flex gap: ${key}`, async () => {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
            await page.goto(simulatorUrl);
            await page.waitForSelector('.jq-profile-card');
            await assertSiblingSpacing(page, '.jq-profiles-row', 'x');
            await page.locator('.jq-profile-card').nth(expected[0]).focus();
            const focusedIndex = () => page.evaluate(() =>
                Array.from(document.querySelectorAll('.jq-profile-card')).indexOf(document.activeElement)
            );
            const visited = [await focusedIndex()];
            for (let step = 0; step < 3; step++) {
                await page.keyboard.press(key);
                visited.push(await focusedIndex());
            }
            assert.deepEqual(visited, expected);
        } finally {
            await browser.close();
        }
    });
}

test('selecting a profile switches instantly: no page navigation, no login step', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        let navigated = false;
        page.on('framenavigated', () => { navigated = true; });

        await page.goto(simulatorUrl);
        await page.waitForSelector('.jq-profile-card');
        navigated = false; // ignore the initial goto's own navigation

        await page.keyboard.press('Enter');
        await page.waitForSelector('.jq-shell');

        assert.equal(navigated, false, 'switching profile must not navigate the page');
        assert.deepEqual(
            await page.evaluate(() => window.JellyQuestSession.getCurrentProfile()),
            { Id: 'user-alice', Name: 'Alice' }
        );
        // Focus lands on Home's content (see home.spec.mjs), not the
        // rail -- landing on browsable content rather than sitting on
        // the nav is the point. The rail is still there, showing who's
        // active, a Left and an Up away.
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowUp');
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Alice');
        assert.deepEqual(
            await page.evaluate(() => Array.from(document.querySelectorAll('.jq-rail-item')).map((el) => el.textContent)),
            ['Alice', 'Home', 'Shows', 'Movies', 'Search', 'Requests']
        );
    } finally {
        await browser.close();
    }
});

test('the profile button returns to the picker and a different profile can be selected -- repeatable, no re-auth screen', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await page.goto(simulatorUrl);
        await page.waitForSelector('.jq-profile-card');

        // Alice -> shell (lands on Home content) -> Left+Up into the rail's profile button -> back to picker.
        await page.keyboard.press('Enter');
        await page.waitForSelector('.jq-shell');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowUp');
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Alice');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.jq-profile-card');
        assert.equal(await page.evaluate(() => window.JellyQuestSession.getCurrentProfile()), null);

        // Pick Bob this time.
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Bob');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.jq-shell');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowUp');

        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Bob');
        assert.equal(
            await page.evaluate(() => window.JellyQuestSession.getCurrentProfile().Name),
            'Bob'
        );
    } finally {
        await browser.close();
    }
});

test('the rail itself: down/up move through its items, right leaves it for Home content', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await page.goto(simulatorUrl);
        await page.waitForSelector('.jq-profile-card');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.jq-shell');
        await page.keyboard.press('ArrowLeft'); // from Home's autofocused card into the rail

        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Home');
        const geometry = await page.evaluate(() => {
            const rail = document.querySelector('.jq-rail');
            const items = Array.from(rail.querySelectorAll('.jq-rail-item'));
            return {
                railHeight: rail.clientHeight,
                scrollRange: rail.scrollHeight - rail.clientHeight,
                itemHeights: items.map((item) => Math.round(item.getBoundingClientRect().height)),
                itemTops: items.map((item) => Math.round(item.getBoundingClientRect().top)),
            };
        });
        assert.equal(geometry.railHeight, 1080, 'the test must exercise the household viewport height');
        // Review measured overflow-y: visible: excess content clips rather than
        // creating a scrollport. Zero scroll range is only a content-fit proxy;
        // it first fails at 16 items and cannot detect entries 7 through 15.
        assert.equal(geometry.scrollRange, 0, 'six rail items must fit without overflowing');
        // These exact measured enumerations are the load-bearing growth guard:
        // a seventh item fails immediately. Do not replace them with a length
        // check on the assumption that zero scroll range still protects layout.
        assert.deepEqual(geometry.itemHeights, [46, 46, 46, 46, 46, 46]);
        assert.deepEqual(geometry.itemTops, [48, 118, 188, 258, 328, 398],
            'the sixth item must preserve the measured 24px sibling spacing');
        await assertPainted(page.locator(':focus'));
        await page.keyboard.press('ArrowUp');
        assert.equal(await page.locator(':focus').textContent(), 'Alice');
        for (const expected of ['Home', 'Shows', 'Movies', 'Search', 'Requests']) {
            await page.keyboard.press('ArrowDown');
            assert.equal(await page.locator(':focus').textContent(), expected);
            await assertPainted(page.locator(':focus'));
        }
        for (const expected of ['Search', 'Movies', 'Shows', 'Home', 'Alice']) {
            await page.keyboard.press('ArrowUp');
            assert.equal(await page.locator(':focus').textContent(), expected);
            await assertPainted(page.locator(':focus'));
        }

        // Right from the rail re-enters Home's content.
        await page.keyboard.press('ArrowRight');
        assert.ok(await page.evaluate(() => document.activeElement.classList.contains('jq-media-card')));
    } finally {
        await browser.close();
    }
});

// Synthetic stress geometry only: production must retain zero rail scroll range.
// Alternating tall/short neighbours exposes the pre-#34 uniform reveal margin.
for (const firstDirection of ['ArrowDown', 'ArrowUp']) {
    test(`the full heterogeneous rail traverses both ways starting ${firstDirection}`, async () => {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
            await page.goto(simulatorUrl);
            await page.waitForSelector('.jq-profile-card');
            await page.keyboard.press('Enter');
            await page.waitForSelector('.jq-media-card');
            await page.addStyleTag({ content: `
                #jellyquest-root .jq-rail { box-sizing: border-box; height: 600px; overflow: hidden; padding-top: 24px; padding-bottom: 24px; }
                #jellyquest-root .jq-rail-item { box-sizing: border-box; flex-shrink: 0; height: 46px; }
                #jellyquest-root .jq-rail-item:nth-child(even) { height: 260px; }
            ` });
            const geometry = await page.locator('.jq-rail').evaluate(rail => {
                const items = Array.from(rail.children);
                return {
                    height: rail.clientHeight,
                    range: rail.scrollHeight - rail.clientHeight,
                    heights: items.map(el => el.getBoundingClientRect().height),
                    tops: items.map(el => el.getBoundingClientRect().top),
                    labels: items.map(el => el.textContent),
                };
            });
            assert.equal(geometry.height, 600);
            assert.deepEqual(geometry.heights, [46, 260, 46, 260, 46, 260]);
            assert.deepEqual(geometry.tops, [24, 94, 378, 448, 732, 802]);
            assert.ok(geometry.range > 260 + 24,
                `must scroll beyond a tall neighbour pitch, measured ${geometry.range}px`);
            const directions = firstDirection === 'ArrowDown'
                ? ['ArrowDown', 'ArrowUp'] : ['ArrowUp', 'ArrowDown'];
            // Set only the initial condition; every traversal step uses the remote.
            await page.locator('.jq-rail-item').nth(firstDirection === 'ArrowDown' ? 0 : geometry.labels.length - 1).focus();
            for (const direction of directions) {
                const labels = direction === 'ArrowDown' ? geometry.labels : [...geometry.labels].reverse();
                assert.equal(await page.locator(':focus').textContent(), labels[0]);
                if (direction === 'ArrowUp') {
                    assert.ok(await page.locator('.jq-rail').evaluate(rail => rail.scrollTop) > 284,
                        'Up must start beyond a tall neighbour pitch of real scrolling');
                }
                for (const label of labels.slice(1)) {
                    await page.keyboard.press(direction);
                    assert.equal(await page.locator(':focus').textContent(), label, `${direction} must reach ${label}`);
                    await assertPainted(page.locator(':focus'));
                }
                if (direction === 'ArrowUp') {
                    assert.equal(await page.locator('.jq-rail').evaluate(rail => rail.scrollTop), 0);
                }
            }

        } finally {
            await browser.close();
        }
    });

}
