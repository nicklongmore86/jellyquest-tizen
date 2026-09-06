// Root-level Back on Home (Samsung certification CO-US-05, "Terminating
// Applications": a short Return press on the app's root screen must show an
// app-created HTML confirmation, and only an affirmative answer may
// terminate).
//
// Why this was never caught before: dev/simulator.html loads the overlay with
// fixture stubs and NO jellyfin-web bundle, so the second Back consumer that
// exists on device is simply absent here -- and no spec pressed Back on Home
// at all. These specs press Back on Home, and assert that JellyQuest consumes
// the event rather than letting it bubble on to a second listener.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { startServer } from './support/server.mjs';

const server = await startServer();
const simulatorUrl = `${server.baseUrl}/dev/simulator.html`;
test.after(() => server.close());

async function openHomeAsAlice(page) {
    await page.goto(simulatorUrl);
    await page.waitForSelector('.jq-profile-card');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.jq-shell');
    await page.waitForSelector('.jq-media-card');
}

// The simulator has no remote, and Playwright cannot synthesise a Tizen key
// code through the real input pipeline, so the TV's own codes are dispatched
// as trusted-shaped synthetic events. Escape (27) is what the other specs use.
async function pressBackKeyCode(page, keyCode) {
    await page.evaluate((code) => {
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'keyCode', { get: () => code });
        document.body.dispatchEvent(event);
    }, keyCode);
}

// Counts real calls through the shipped tizen.js path
// (NativeShell.AppHost.exit -> tizen.application.getCurrentApplication().exit())
// down to dev/fixtures/tizen-stub.js, whose exit() only logs. getCurrentApplication()
// hands back a fresh object per call, so the factory is what has to be wrapped.
async function installExitSpy(page) {
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
}

test('Back on Home opens a JellyQuest-owned exit confirmation', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openHomeAsAlice(page);

        // Escape doubles as Back in the simulator (see app.js's BACK_KEY_CODES).
        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-exit-confirm', { state: 'visible' });

        // Still on Home behind the dialog -- Back must not navigate anywhere.
        assert.ok(await page.evaluate(() => Boolean(document.querySelector('.jq-home-screen'))));
        // Focus is inside the dialog, and starts on the non-destructive answer.
        assert.equal(await page.evaluate(() => document.activeElement.className.includes('jq-exit-no')), true);
    } finally {
        await browser.close();
    }
});

test('both Tizen Back key codes (10009 and 461) open the exit confirmation', async () => {
    for (const keyCode of [10009, 461]) {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
            await openHomeAsAlice(page);

            await pressBackKeyCode(page, keyCode);
            await page.waitForSelector('.jq-exit-confirm', { state: 'visible' });
        } finally {
            await browser.close();
        }
    }
});

test('Back dismisses the exit confirmation and restores focus where it was', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openHomeAsAlice(page);
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-item-id')), 'movie-1');

        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-exit-confirm', { state: 'visible' });

        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.querySelector('.jq-exit-backdrop').hidden);

        assert.ok(await page.evaluate(() => Boolean(document.querySelector('.jq-home-screen'))));
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-item-id')), 'movie-1');
    } finally {
        await browser.close();
    }
});

test('No dismisses the exit confirmation, restores focus, and does not exit', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openHomeAsAlice(page);
        await installExitSpy(page);

        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-exit-confirm', { state: 'visible' });

        await page.evaluate(() => document.querySelector('.jq-exit-no').click());
        await page.waitForFunction(() => document.querySelector('.jq-exit-backdrop').hidden);

        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-item-id')), 'movie-1');
        assert.equal(await page.evaluate(() => window.__tizenExitCalls), 0);
    } finally {
        await browser.close();
    }
});

test('Yes calls through NativeShell.AppHost.exit() to the Tizen application exit', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openHomeAsAlice(page);
        await installExitSpy(page);
        assert.equal(await page.evaluate(() => typeof window.NativeShell.AppHost.exit), 'function');

        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-exit-confirm', { state: 'visible' });

        await page.evaluate(() => document.querySelector('.jq-exit-yes').click());

        // The stub's exit() only logs, so this asserts that the shipped path was
        // invoked end to end. It does NOT demonstrate that the app terminates --
        // only a real TV can show that.
        await page.waitForFunction(() => window.__tizenExitCalls > 0);
    } finally {
        await browser.close();
    }
});

test('a Back that JellyQuest handles never reaches a window-level listener', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openHomeAsAlice(page);

        // Stands in for jellyfin-web's own keyboardnavigation listener, which
        // does not exist in the simulator (no jellyfin-web bundle is loaded).
        // It maps 461/10009 to Back and, unhandled, runs
        // appRouter.back() / appHost.exit() on the same press.
        await page.evaluate(() => {
            window.__backSeenByHost = 0;
            window.addEventListener('keydown', (event) => {
                if ([10009, 461, 27].indexOf(event.keyCode) !== -1) window.__backSeenByHost++;
            });
        });

        // 1. Screen-level Back (Search -> Home).
        await page.evaluate(() => document.querySelector('.jq-nav-search').click());
        await page.waitForSelector('.jq-search-input');
        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-home-row-heading');
        assert.equal(await page.evaluate(() => window.__backSeenByHost), 0,
            'a screen-level Back must be stopped before any second consumer sees it');

        // 2. Root-level Back (opens the exit confirmation).
        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-exit-confirm', { state: 'visible' });

        // 3. Modal Back (closes the exit confirmation).
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.querySelector('.jq-exit-backdrop').hidden);

        assert.equal(await page.evaluate(() => window.__backSeenByHost), 0);
    } finally {
        await browser.close();
    }
});

test('the exit confirmation still works after switching profiles, which rebuilds the root', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openHomeAsAlice(page);

        // Open and dismiss once so the dialog is built and cached.
        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-exit-confirm', { state: 'visible' });
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.querySelector('.jq-exit-backdrop').hidden);

        // The profile picker and the shell both clear #jellyquest-root's
        // contents, detaching anything the router parked there.
        await page.evaluate(() => document.querySelector('.jq-profile-switch').click());
        await page.waitForSelector('.jq-profile-card');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.jq-shell');
        await page.waitForSelector('.jq-media-card');

        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-exit-confirm', { state: 'visible' });
        assert.equal(await page.evaluate(() => document.querySelectorAll('.jq-exit-backdrop').length), 1,
            'exactly one exit dialog must be attached, not zero (detached) and not a duplicate per visit');
        assert.equal(await page.evaluate(() => document.activeElement.className.includes('jq-exit-no')), true);
    } finally {
        await browser.close();
    }
});

test('a Home render that completes while the exit confirmation is open does not steal focus', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openHomeAsAlice(page);

        // Hold Home's row fetches open so the render finishes AFTER Back is
        // pressed -- app.js installs the root Back handler before the screen
        // has rendered, which is exactly the window this covers.
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

        // Leave Home and come back so it re-renders against the held fetches.
        await page.evaluate(() => document.querySelector('.jq-nav-search').click());
        await page.waitForSelector('.jq-search-input');
        await page.evaluate(() => document.querySelector('.jq-nav-home').click());
        await page.waitForFunction(() => window.__held.length > 0);

        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-exit-confirm', { state: 'visible' });
        assert.equal(await page.evaluate(() => document.activeElement.className.includes('jq-exit-no')), true);

        await page.evaluate(() => window.__held.splice(0).forEach((release) => release()));
        await page.waitForSelector('.jq-media-card');

        // The dialog is still up and still owns focus: a card behind it must
        // not be focusable-by-surprise, or Enter opens Detail under the modal.
        assert.equal(await page.evaluate(() => document.querySelector('.jq-exit-backdrop').hidden), false);
        assert.equal(await page.evaluate(() => document.activeElement.className.includes('jq-exit-no')), true);

        // And once dismissed, focus lands on real content rather than nowhere.
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.querySelector('.jq-exit-backdrop').hidden);
        assert.equal(await page.evaluate(() => document.activeElement.classList.contains('jq-focusable')), true);
    } finally {
        await browser.close();
    }
});

// Contain mode (`--spatial-navigation-contain: contain` in focus.css) used to
// be asserted on Detail's Playback Options dialog. That dialog is no longer
// rendered (see TRACK_SELECTION_ENABLED in src/overlay/screens/detail.js), so
// the invariant moves here rather than being dropped: this is now the only
// .jq-modal a user can actually open.
test('the exit confirmation contains focus: no arrow key escapes it', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openHomeAsAlice(page);

        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-exit-confirm', { state: 'visible' });

        const inside = () => page.evaluate(() =>
            document.querySelector('.jq-exit-confirm').contains(document.activeElement));
        for (const key of ['ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowRight', 'ArrowDown']) {
            await page.keyboard.press(key);
            assert.equal(await inside(), true, `${key} must not move focus out of the dialog`);
        }
        // Right did reach the other answer -- containment, not paralysis.
        assert.equal(await page.evaluate(() => document.activeElement.className.includes('jq-exit-yes')), true);
    } finally {
        await browser.close();
    }
});

test('the confirmation answers are operable from the remote: Enter on No dismisses', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openHomeAsAlice(page);
        await installExitSpy(page);

        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-exit-confirm', { state: 'visible' });

        // No pointer exists on a TV; the existing specs' .click() calls do not
        // prove the buttons are reachable and activatable from the remote.
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('.jq-exit-backdrop').hidden);

        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-item-id')), 'movie-1');
        assert.equal(await page.evaluate(() => window.__tizenExitCalls), 0);
    } finally {
        await browser.close();
    }
});

test('the confirmation answers are operable from the remote: Right then Enter exits', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openHomeAsAlice(page);
        await installExitSpy(page);

        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-exit-confirm', { state: 'visible' });

        await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(() => document.activeElement.className.includes('jq-exit-yes')), true,
            'Right must move from No to Yes inside the dialog');

        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.__tizenExitCalls > 0);
    } finally {
        await browser.close();
    }
});

test('Back is left to jellyfin-web while video playback is active', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openHomeAsAlice(page);

        await page.keyboard.press('Enter'); // movie-1, autofocused
        await page.waitForSelector('.jq-detail-screen');
        // movie-1 has saved progress, so its first action is Resume, not Play.
        await page.evaluate(() => Array.from(document.querySelectorAll('.jq-detail-action'))
            .find((button) => /^(Play|Resume)$/.test(button.textContent)).click());
        await page.waitForFunction(() => window.playbackManager.isPlayingVideo());

        // Stands in for jellyfin-web's window-level keyboardNavigation
        // listener, which is what actually exits a playing video: it runs
        // inputManager.handleCommand('back') -> appRouter.back(), and the
        // video view's own 'viewbeforehide' handler then calls
        // playbackManager.stop(). The video controller's document-level
        // listener only hides the OSD, so JellyQuest must NOT swallow this
        // press -- doing so leaves the video playing with no way out.
        await page.evaluate(() => {
            window.__backSeenByHost = 0;
            window.addEventListener('keydown', (event) => {
                if ([10009, 461, 27].indexOf(event.keyCode) !== -1) window.__backSeenByHost++;
            });
        });

        await page.keyboard.press('Escape');

        assert.equal(await page.evaluate(() => window.__backSeenByHost), 1,
            'Back must reach jellyfin-web while a video is playing');
        // JellyQuest must also not run its own screen-level navigation for
        // that press: the host is exiting the video, not moving JellyQuest.
        assert.ok(await page.evaluate(() => Boolean(document.querySelector('.jq-detail-screen'))),
            'JellyQuest must not navigate away from Detail on that press');
        assert.equal(await page.evaluate(() => Boolean(document.querySelector('.jq-exit-backdrop'))), false,
            'and must not open its exit confirmation');
    } finally {
        await browser.close();
    }
});

test('once playback ends, Back belongs to JellyQuest again', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openHomeAsAlice(page);

        await page.keyboard.press('Enter');
        await page.waitForSelector('.jq-detail-screen');
        // movie-1 has saved progress, so its first action is Resume, not Play.
        await page.evaluate(() => Array.from(document.querySelectorAll('.jq-detail-action'))
            .find((button) => /^(Play|Resume)$/.test(button.textContent)).click());
        await page.waitForFunction(() => window.playbackManager.isPlayingVideo());
        await page.evaluate(() => window.playbackManager.__endPlayback());

        await page.keyboard.press('Escape');
        await page.waitForSelector('.jq-home-screen');
    } finally {
        await browser.close();
    }
});
