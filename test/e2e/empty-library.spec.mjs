// Home with an EMPTY Jellyfin library -- no items at all, which is the state
// a fresh or still-unpopulated server is actually in. Every other spec drives
// Home against populated fixtures, so none of the focus behaviour the exit
// confirmation depends on (focusFirst finding something, focus being restored
// to a saved card) had ever been exercised with nothing to focus.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { startServer } from './support/server.mjs';

const server = await startServer();
const simulatorUrl = `${server.baseUrl}/dev/simulator.html`;
test.after(() => server.close());

// Empties the library at the source, before any page script runs, so the very
// first Home render is the empty one -- rather than populating Home and then
// blanking it, which is not the state the user boots into. The fixture itself
// is left alone; this only intercepts what it returns.
async function emptyLibrary(page) {
    await page.addInitScript(() => {
        let apiClient;
        Object.defineProperty(window, 'ApiClient', {
            configurable: true,
            get: () => apiClient,
            set: (value) => {
                apiClient = value;
                const getItems = value.getItems.bind(value);
                value.getItems = (userId, options) =>
                    getItems(userId, options).then((result) => ({ ...result, Items: [] }));
                // Home's Next Up row does not go through getItems, so an
                // empty library has to empty /Shows/NextUp as well. Alice's
                // row happens to be empty already (her only candidate is
                // resumable, and the row suppresses those), so this is
                // belt-and-braces today -- but "the library is empty" must
                // not depend on which profile or which fixture data.
                const getNextUpEpisodes = value.getNextUpEpisodes.bind(value);
                value.getNextUpEpisodes = (options) =>
                    getNextUpEpisodes(options).then((result) => ({ ...result, Items: [], TotalRecordCount: 0 }));
            },
        });
    });
}

async function signInToEmptyHome(page) {
    await emptyLibrary(page);
    await page.goto(simulatorUrl);
    await page.waitForSelector('.jq-profile-card');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.jq-shell');
    await page.waitForSelector('.jq-home-empty');
}

// "Somewhere sensible" on a TV means an element that is in the document, is
// actually RENDERED, and carries the focus ring. All three matter: <body>
// gives no cursor at all, and an element that is still attached but inside a
// hidden subtree gives no cursor either while looking fine to a naive
// activeElement check -- focus parked on the dismissed dialog's own button is
// exactly that case, and an earlier version of this helper passed it.
function focusState(page) {
    return page.evaluate(() => {
        const active = document.activeElement;
        return {
            tag: active ? active.tagName : 'NONE',
            className: active ? active.className : '',
            focusable: Boolean(active && active.classList && active.classList.contains('jq-focusable')),
            connected: Boolean(active && active !== document.body && document.body.contains(active)),
            rendered: Boolean(active && active.getClientRects && active.getClientRects().length > 0),
        };
    });
}

// Scope of the `rendered` check, recorded so it is not over-trusted:
// getClientRects() is empty for anything in a `display: none` subtree, which
// is what the dismissed dialog's backdrop uses and is sufficient for the two
// defects these tests cover. It does NOT catch an element hidden by ancestor
// `opacity: 0`, one clipped entirely out of view, or one moved offscreen by a
// transform -- all of those still report boxes and would pass. Catching those
// needs computed visibility, ancestor opacity, viewport intersection and
// possibly elementFromPoint() sampling; that is deliberately not built here
// because the focus targets involved are fixed, always-visible rail buttons.
function assertVisiblyFocused(state, context) {
    assert.ok(state.connected, `${context}: focus was lost to ${state.tag} -- no focus ring, no cursor on the TV`);
    assert.ok(state.rendered,
        `${context}: focus is on ${state.tag}.${state.className}, which is attached but not rendered -- still no visible cursor`);
    assert.ok(state.focusable,
        `${context}: focus landed on ${state.tag}.${state.className}, which carries no focus ring`);
}

test('an empty library renders the Home placeholder with no cards and no page error', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await signInToEmptyHome(page);

        assert.equal(await page.evaluate(() => document.querySelector('.jq-home-empty').textContent),
            'Nothing here yet.');
        assert.equal(await page.evaluate(() => document.querySelectorAll('.jq-media-card').length), 0);
        assert.equal(await page.evaluate(() => document.querySelectorAll('.jq-shell-content .jq-focusable').length), 0,
            'the empty Home really has nothing focusable in it -- that is the point of these tests');
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
    }
});

test('the rail stays mounted and navigable when the library is empty', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInToEmptyHome(page);

        assert.equal(await page.evaluate(() => document.querySelectorAll('.jq-rail .jq-focusable').length), 4);

        // Booting into an empty Home must not strand the user: the rail was
        // focused before Home rendered, and the empty render must not undo it.
        assertVisiblyFocused(await focusState(page), 'after booting into an empty Home');

        // And the remote can still walk the rail to Search/Requests.
        await page.keyboard.press('ArrowDown');
        assert.equal(await page.evaluate(() => document.activeElement.className.includes('jq-nav-home')), true);
        await page.keyboard.press('ArrowDown');
        assert.equal(await page.evaluate(() => document.activeElement.className.includes('jq-nav-search')), true);
    } finally {
        await browser.close();
    }
});

test('returning to an empty Home from Search leaves focus on something visible', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInToEmptyHome(page);

        // Focus lives inside the content area, which Home is about to replace.
        await page.evaluate(() => document.querySelector('.jq-nav-search').click());
        await page.waitForSelector('.jq-search-input');
        await page.evaluate(() => document.querySelector('.jq-search-input').focus());

        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-home-empty');

        assertVisiblyFocused(await focusState(page), 'after Back from Search to an empty Home');
    } finally {
        await browser.close();
    }
});

test('Back on an empty Home still opens the exit confirmation', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInToEmptyHome(page);

        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-exit-confirm', { state: 'visible' });
        assert.equal(await page.evaluate(() => document.activeElement.className.includes('jq-exit-no')), true);
    } finally {
        await browser.close();
    }
});

test('dismissing the exit confirmation on an empty Home leaves focus on something visible', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInToEmptyHome(page);

        // Reproduce the state where there is no saved card to restore to:
        // focus was inside the content Home replaced, so it is already gone
        // by the time the dialog opens.
        await page.evaluate(() => document.querySelector('.jq-nav-search').click());
        await page.waitForSelector('.jq-search-input');
        await page.evaluate(() => document.querySelector('.jq-search-input').focus());
        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-home-empty');

        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-exit-confirm', { state: 'visible' });
        await page.evaluate(() => document.querySelector('.jq-exit-no').click());
        await page.waitForFunction(() => document.querySelector('.jq-exit-backdrop').hidden);

        // Without a fallback this lands on the dialog's own No button, which
        // is still attached but inside the now-hidden backdrop: attached and
        // .jq-focusable, yet completely invisible.
        assertVisiblyFocused(await focusState(page), 'after dismissing the prompt on an empty Home');
    } finally {
        await browser.close();
    }
});

test('a late empty render does not pull focus off a rail item the user has already selected', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInToEmptyHome(page);
        assert.equal(await page.evaluate(() => document.activeElement.className.includes('jq-profile-switch')), true);

        // Hold Home's (empty) responses so its render lands after the user
        // has had time to do something else -- the realistic shape of a slow
        // server, and the same asynchronous-completion-beats-newer-intent
        // problem as a late render stealing focus from an open modal.
        await page.evaluate(() => {
            const getItems = window.ApiClient.getItems.bind(window.ApiClient);
            window.__held = [];
            window.ApiClient.getItems = function () {
                const args = arguments;
                return new Promise((resolve) => {
                    window.__held.push(() => resolve(getItems.apply(null, args)));
                });
            };
        });
        await page.evaluate(() => document.querySelector('.jq-nav-home').click());
        await page.waitForFunction(() => window.__held.length > 0);

        // Meanwhile the user walks the rail down to Search.
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        assert.equal(await page.evaluate(() => document.activeElement.className.includes('jq-nav-search')), true);

        await page.evaluate(() => window.__held.splice(0).forEach((release) => release()));
        await page.waitForSelector('.jq-home-empty');

        // The fallback exists for focus that is nowhere. Search is somewhere:
        // moving off it would make the next Enter open profile selection, an
        // action the user never asked for.
        assert.equal(await page.evaluate(() => document.activeElement.className.includes('jq-nav-search')), true,
            'a late render must not override a selection the user has already made');
    } finally {
        await browser.close();
    }
});

test('the fallback still runs when the saved focus target disappears while the prompt is open', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInToEmptyHome(page);
        assert.equal(await page.evaluate(() => document.activeElement.className.includes('jq-profile-switch')), true);

        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-exit-confirm', { state: 'visible' });

        // The other dismissal test now has a live saved target to restore to,
        // so closeModal() handles it and the fallback is never reached. Take
        // the saved target away while the dialog is up -- standing in for the
        // content underneath being replaced by an async refresh -- so that
        // dismissal has to fall back on its own.
        await page.evaluate(() => {
            const saved = document.querySelector('.jq-profile-switch');
            saved.parentNode.removeChild(saved);
        });

        await page.evaluate(() => document.querySelector('.jq-exit-no').click());
        await page.waitForFunction(() => document.querySelector('.jq-exit-backdrop').hidden);

        assertVisiblyFocused(await focusState(page), 'after dismissing with the saved target gone');
        assert.equal(await page.evaluate(() => document.activeElement.closest('.jq-rail') !== null), true,
            'the fallback should land on the rail, which is what always survives');
    } finally {
        await browser.close();
    }
});

test('Yes still reaches the exit path from an empty Home', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await signInToEmptyHome(page);
        await page.evaluate(() => {
            window.__tizenExitCalls = 0;
            const getCurrentApplication = window.tizen.application.getCurrentApplication;
            window.tizen.application.getCurrentApplication = function () {
                const application = getCurrentApplication.apply(this, arguments);
                const exit = application.exit;
                application.exit = function () {
                    window.__tizenExitCalls++;
                    return exit.apply(this, arguments);
                };
                return application;
            };
        });

        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-exit-confirm', { state: 'visible' });
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.__tizenExitCalls > 0);
    } finally {
        await browser.close();
    }
});
