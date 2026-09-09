import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { startServer } from './support/server.mjs';

const server = await startServer();
test.after(() => server.close());

async function setup(t) {
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.clock.install();
    await page.goto(`${server.baseUrl}/dev/simulator.html`);
    await page.waitForSelector('.jq-profile-card');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.jq-media-card');
    await page.evaluate(() => document.querySelector('.jq-media-card').click());
    await page.waitForSelector('.jq-detail-action');
    await page.evaluate(() => document.querySelector('.jq-detail-action').focus());
    // Freeze the running fake clock after async setup. Otherwise its first
    // runFor sample can include wall-clock drift, leaving six 1s samples
    // less than five seconds apart. Test the debounce, not that drift.
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 1000)));
    return page;
}

async function state(page) {
    return page.evaluate(() => {
        const root = document.getElementById('jellyquest-root');
        return {
            hidden: getComputedStyle(root).display === 'none',
            overlayFocus: root.contains(document.activeElement),
            painted: root.getClientRects().length > 0,
        };
    });
}

async function start(page) {
    await page.evaluate(() => window.playbackManager.__start('Video'));
}

// Only a geometry witness, NOT a simulated OSD or decoder: insertion/stacking
// transcribed from htmlVideoPlayer/plugin.js:1620-1663 and style.scss:1-13.
test('video start removes the opaque overlay from paint, hit tests and focus; stop restores the launch control', async (t) => {
    const page = await setup(t);
    await page.evaluate(() => {
        window.__launch = document.activeElement;
        const player = document.createElement('div');
        player.id = 'video-witness';
        player.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:1000;background:black';
        document.body.insertBefore(player, document.body.firstChild);
    });
    await start(page);
    assert.deepEqual(await state(page), { hidden: true, overlayFocus: false, painted: false });
    assert.equal(await page.evaluate(() => document.elementFromPoint(600, 400).id), 'video-witness');
    await page.evaluate(() => window.playbackManager.__endPlayback());
    assert.deepEqual(await state(page), { hidden: false, overlayFocus: true, painted: true });
    assert.equal(await page.evaluate(() => document.activeElement === window.__launch), true);
});

test('play resolving or rejecting before start never hides; audio start stays visible', async (t) => {
    const page = await setup(t);
    for (const outcome of ['silent-resolve', 'silent-reject']) {
        await page.evaluate(async (value) => {
            window.playbackManager.__nextOutcome(value);
            await window.playbackManager.play({ serverId: 'fixture', ids: ['movie-1'] }).catch(() => {});
        }, outcome);
        assert.equal((await state(page)).hidden, false);
    }
    await page.evaluate(() => window.playbackManager.__start('Audio'));
    assert.equal((await state(page)).hidden, false);
});

test('queue/intro/player-switch stop with nextItem stays hidden and silent next-start failure recovers', async (t) => {
    const page = await setup(t);
    await start(page);
    await page.evaluate(() => window.playbackManager.__stop({ Id: 'next', MediaType: 'Video' }));
    assert.equal((await state(page)).hidden, true);
    await page.clock.runFor(2000);
    await start(page);
    await page.clock.runFor(6000);
    assert.equal((await state(page)).hidden, true, 'successful handoff must not flash');
    await page.evaluate(() => window.playbackManager.__stop({ Id: 'next', MediaType: 'Video' }));
    await page.clock.runFor(16000);
    assert.equal((await state(page)).hidden, false, 'silent handoff failure must recover');
});

test('cancellation and terminal error restore; stream-change suppressed stop/error do not', async (t) => {
    const page = await setup(t);
    await start(page);
    await page.evaluate(() => {
        window.playbackManager.__changingStream(true);
        window.playbackManager.__error();
        window.playbackManager.__stop(null);
    });
    await page.clock.runFor(6000);
    assert.equal((await state(page)).hidden, true);
    await page.evaluate(() => {
        window.playbackManager.__changingStream(false);
        window.playbackManager.__error();
    });
    assert.equal((await state(page)).hidden, false);
    await start(page);
    await page.evaluate(() => window.playbackManager.__cancel());
    assert.equal((await state(page)).hidden, false);
});

test('lost stop recovers through polling and detached launch focus falls back visibly', async (t) => {
    const page = await setup(t);
    await start(page);
    await page.evaluate(() => {
        document.querySelector('.jq-detail-action').remove();
        window.playbackManager.__setPlayingVideo(false);
    });
    await page.clock.runFor(6000);
    assert.deepEqual(await state(page), { hidden: false, overlayFocus: true, painted: true });
});

test('restore unhides before a throwing focus call and does not throw into upstream Events', async (t) => {
    const page = await setup(t);
    await start(page);
    await page.evaluate(() => {
        window.__throwingFocusCalled = false;
        document.querySelector('.jq-detail-action').focus = function () {
            window.__throwingFocusCalled = true;
            throw new Error('focus fault');
        };
        window.playbackManager.__endPlayback();
    });
    assert.equal(await page.evaluate(() => window.__throwingFocusCalled), true,
        'restore must unhide before measuring the poisoned focus target');
    assert.equal((await state(page)).hidden, false);
});

test('boot subscription is once and hidden modal cannot consume Back', async (t) => {
    const page = await setup(t);
    const subscribed = await page.evaluate(() => {
        if (window.JellyQuestBindPlayback) {
            window.JellyQuestBindPlayback();
            window.JellyQuestBindPlayback();
        }
        const subscriptions = window.playbackManager.__subscriptions;
        return ['playbackstart', 'playbackstop', 'playbackcancelled'].map((name) => (subscriptions[name] || []).length);
    });
    assert.deepEqual(subscribed, [1, 1, 1]);
    await page.evaluate(() => {
        const modal = document.createElement('div');
        modal.innerHTML = '<button>Close</button>';
        document.getElementById('jellyquest-root').appendChild(modal);
        window.__modalClosed = false;
        window.JellyQuestFocus.openModal(modal, () => { window.__modalClosed = true; });
        window.__backReachedWindow = false;
        window.addEventListener('keydown', (event) => {
            if (event.keyCode === 27) window.__backReachedWindow = true;
        });
    });
    await start(page);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.__modalClosed), false);
    assert.equal(await page.evaluate(() => window.__backReachedWindow), true);
});


test('handoff deadline recovers even when upstream still reports the old video source', async (t) => {
    const page = await setup(t);
    await start(page);
    assert.equal((await state(page)).hidden, true);
    await page.evaluate(() => {
        window.playbackManager.__stop({ Id: 'feature', MediaType: 'Video' });
        window.playbackManager.__setPlayingVideo(true);
    });
    await page.clock.runFor(16000);
    assert.equal((await state(page)).hidden, false);
});

test('late upstream bundle subscribes at publication, before its first start', async (t) => {
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.route('**/fixtures/playback-manager-stub.js', (route) => route.fulfill({ body: '' }));
    await page.goto(`${server.baseUrl}/dev/simulator.html`);
    await page.waitForSelector('.jq-profile-card');
    await page.unroute('**/fixtures/playback-manager-stub.js');
    await page.addScriptTag({ url: `${server.baseUrl}/dev/fixtures/playback-manager-stub.js` });
    await start(page);
    assert.equal((await state(page)).hidden, true);
    await page.evaluate(() => window.playbackManager.__cancel());
    assert.equal((await state(page)).hidden, false);
});

test('Series can open its season modal during pending Play; Back then reaches the host and stop restores modal focus', async (t) => {
    const page = await setup(t);
    await page.evaluate(() => document.querySelector('.jq-nav-home').click());
    await page.waitForSelector('[data-item-id="series-1"]');
    await page.evaluate(() => {
        const getEpisodes = window.ApiClient.getEpisodes.bind(window.ApiClient);
        window.ApiClient.getEpisodes = (id, options) => getEpisodes(id, options).then((result) => ({
            ...result,
            Items: result.Items.map((item, index) => index ? item : {
                ...item, UserData: { PlaybackPositionTicks: 1200000000, Played: false },
            }),
        }));
        document.querySelector('[data-item-id="series-1"]').click();
    });
    await page.waitForSelector('.jq-series-actions .jq-detail-action');
    await page.evaluate(() => {
        const play = window.playbackManager.play;
        // Hold an asynchronous request open; no claim about network latency.
        window.playbackManager.play = (options) => new Promise((resolve) => {
            window.__releasePlay = () => resolve(play(options));
        });
        document.querySelector('.jq-series-actions .jq-detail-action').click();
        document.querySelector('.jq-series-season-button').click();
    });
    assert.equal(await page.locator('.jq-series-season-menu').isVisible(), true);
    await page.evaluate(() => window.__releasePlay());
    assert.equal((await state(page)).hidden, true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.jq-series-season-backdrop').evaluate((node) => node.hidden), false);
    await page.evaluate(() => window.playbackManager.__endPlayback());
    assert.equal(await page.locator('.jq-series-season-menu').isVisible(), true);
    assert.equal(await page.evaluate(() => document.querySelector('.jq-series-season-menu').contains(document.activeElement)), true);
});


test('video to audio removes the video player and restores through the five-second idle branch', async (t) => {
    const page = await setup(t);
    await start(page);
    await page.evaluate(() => window.playbackManager.__stop({ Id: 'song', MediaType: 'Audio' }));
    assert.equal(await page.evaluate(() => window.playbackManager.isPlayingVideo()), false,
        'a local audio nextItem must remove the video player');
    assert.equal((await state(page)).hidden, true, 'nextItem stop must not immediately flash the overlay');
    await page.evaluate(() => window.playbackManager.__start('Audio'));
    await page.clock.runFor(4000);
    assert.equal((await state(page)).hidden, true, 'idle debounce must still apply');
    await page.clock.runFor(2000);
    assert.deepEqual(await state(page), { hidden: false, overlayFocus: true, painted: true });
});
