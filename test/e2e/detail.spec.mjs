// Detail/playback screen (see docs/rebuild-plan.md, Phase 3 and
// DETAIL_ACTIONS.md). Covers the movie actions this pass implements:
// Resume/Play, Start Over, Trailer and My List, plus the on-demand fetch
// of the FULL item that the synopsis and the Trailer button depend on.
//
// The fetch is the point of most of what follows. Everything that reaches
// Detail came from a getItems() LIST query, and a list response carries no
// Overview, no LocalTrailerCount and no MediaStreams (measured against the
// household's Jellyfin 10.11.11 server; dev/fixtures/api-client-stub.js now
// models that). So these specs deliberately separate the FIRST PAINT, built
// synchronously from the list item, from the ENRICHMENT that patches it --
// and hold the getItem() response open to assert the first paint on its own,
// rather than racing it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { startServer } from './support/server.mjs';
import { assertPainted } from './support/paint.mjs';

const server = await startServer();
const simulatorUrl = `${server.baseUrl}/dev/simulator.html`;
test.after(() => server.close());

// Holds every ApiClient.getItem() call open until the spec releases it, so
// the pre-enrichment paint is observable instead of a race. Installed after
// sign-in and before the card click, because only Detail calls getItem().
async function holdEnrichment(page) {
    await page.evaluate(() => {
        const getItem = window.ApiClient.getItem.bind(window.ApiClient);
        window.__realGetItem = getItem; // unwrapped, for specs that need to look at the full item
        window.__heldItems = [];
        window.ApiClient.getItem = function (userId, itemId) {
            return new Promise((resolve, reject) => {
                window.__heldItems.push({
                    itemId,
                    release: () => getItem(userId, itemId).then(resolve, reject),
                    fail: () => reject(new Error('detail fetch failed')),
                });
            });
        };
    });
}

const releaseEnrichment = (page) => page.evaluate(() => window.__heldItems.splice(0).forEach((held) => held.release()));
const failEnrichment = (page) => page.evaluate(() => window.__heldItems.splice(0).forEach((held) => held.fail()));

const actionLabels = (page) => page.evaluate(
    () => Array.from(document.querySelectorAll('.jq-detail-action')).map((button) => button.textContent));

async function signIn(page) {
    await page.goto(simulatorUrl);
    await page.waitForSelector('.jq-profile-card');
    await page.keyboard.press('Enter'); // Alice
    await page.waitForSelector('.jq-media-card');
}

// movie-2 is not on Home (it is neither in progress nor recently added), so
// specs that need it go through the Library grid, which holds all 50.
async function openLibrary(page) {
    await page.evaluate(() => document.querySelector('.jq-see-all').click());
    await page.waitForSelector('.jq-library-grid .jq-media-card');
}

async function openItem(page, itemId) {
    await page.evaluate((id) => document.querySelector(`[data-item-id="${id}"]`).click(), itemId);
    await page.waitForSelector('.jq-detail-screen');
}

async function openDetail(page, itemId, beforeOpen) {
    await signIn(page);
    if (beforeOpen) await beforeOpen(page);
    await openItem(page, itemId);
}

// Every spec below that walks the action row waits for enrichment to settle
// first, and then names its target with getByRole rather than counting
// ArrowRight presses -- the row's length changes mid-life now, so a fixed
// walk would encode the pre-enrichment length and break for a reason that
// has nothing to do with what the spec is about.
const button = (page, name) => page.getByRole('button', { name, exact: true });

test('the synopsis and the Trailer button are absent from the list item and appear only after the full item loads', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openDetail(page, 'movie-1', holdEnrichment);

        // First paint: everything the list DTO can support, and nothing else.
        assert.deepEqual(await actionLabels(page), ['Resume', 'Start Over', 'Add to My List']);
        assert.equal(await page.locator('.jq-detail-overview').count(), 0);
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Resume');
        // ... and exactly one fetch for it, not one per action.
        assert.deepEqual(await page.evaluate(() => window.__heldItems.map((held) => held.itemId)), ['movie-1']);

        await releaseEnrichment(page);
        await button(page, 'Trailer').waitFor();

        assert.deepEqual(await actionLabels(page), ['Resume', 'Start Over', 'Trailer', 'Add to My List']);
        const overview = page.locator('.jq-detail-overview');
        assert.match(await overview.textContent(), /supply run north/);
        await assertPainted(overview);
    } finally {
        await browser.close();
    }
});

// This used to be "an item with no progress, no trailer, and no extra tracks
// shows just Play and My List", pointed at movie-9 -- which passed for the
// wrong reason: movie-9 has no Overview/LocalTrailerCount in the fixture at
// all, so it would go on passing against a Detail screen whose fetch was
// completely broken. It is re-pointed at movie-2, which DOES have both on
// getItem(), so the absence before enrichment and the presence after are
// each a real assertion -- and movie-2 is the RemoteTrailers-only film, so
// the same spec pins JellyQuest's deliberately local-only trailer gate.
test('a RemoteTrailers-only film gains its synopsis but never a Trailer button', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openDetail(page, 'movie-2', async (target) => {
            await openLibrary(target);
            await holdEnrichment(target);
        });

        assert.deepEqual(await actionLabels(page), ['Play', 'Add to My List']);
        assert.equal(await page.locator('.jq-detail-overview').count(), 0);

        // The full item really does carry what upstream jellyfin-web would
        // gate on -- so no Trailer button below is a decision, not missing data.
        const full = await page.evaluate(() => window.__realGetItem('user-alice', 'movie-2'));
        assert.equal(full.LocalTrailerCount, 0);
        assert.equal(full.RemoteTrailers.length, 1);

        await releaseEnrichment(page);
        await page.waitForSelector('.jq-detail-overview');

        assert.match(await page.locator('.jq-detail-overview').textContent(), /transmission/);
        // Upstream jellyfin-web WOULD offer a Trailer here
        // (LocalTrailerCount || RemoteTrailers?.length). JellyQuest does not
        // -- see the gate comment in src/overlay/screens/detail.js.
        assert.deepEqual(await actionLabels(page), ['Play', 'Add to My List']);
        assert.equal(await button(page, 'Trailer').count(), 0);
    } finally {
        await browser.close();
    }
});

test('the More button is not rendered, even for an item with multiple audio and subtitle tracks', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openDetail(page, 'movie-1'); // the only fixture item with multiple tracks
        await button(page, 'Trailer').waitFor(); // enrichment settled

        // MediaStreams reached the screen -- this is not "the data was
        // missing", it is "the control is deliberately withheld".
        assert.ok(await page.evaluate(async () => {
            const full = await window.ApiClient.getItem(window.ApiClient.getCurrentUserId(), 'movie-1');
            return full.MediaStreams.filter((stream) => stream.Type === 'Audio').length > 1;
        }));
        assert.equal(await button(page, 'More').count(), 0);
        assert.equal(await page.locator('.jq-playback-options').count(), 0);
    } finally {
        await browser.close();
    }
});

test('enrichment leaves focus exactly where the user put it', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openDetail(page, 'movie-1', holdEnrichment);

        // Move off the autofocused action while the fetch is still in flight.
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Start Over');

        await releaseEnrichment(page);
        await button(page, 'Trailer').waitFor();

        // The patch must not re-focus. focus.js's activeModal/hasVisibleFocus
        // guards would probably absorb a stray focusFirst() -- they are a
        // safety net, not the design, so assert the design.
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Start Over');
        // And the row is patched, not rebuilt: Right still reaches the new
        // button rather than dead-ending on a replaced node.
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Trailer');
    } finally {
        await browser.close();
    }
});

test('a late response for a superseded render is discarded, even when it is the same item', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        const consoleErrors = [];
        page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
        await openDetail(page, 'movie-1', holdEnrichment);

        // Re-enter Detail for the SAME item. The shell hands every screen the
        // same <main> node (shell.js:55,66), so nothing about the container
        // distinguishes these two renders -- only a node this render created.
        await page.evaluate(() => document.querySelector('.jq-nav-home').click());
        await page.waitForSelector('.jq-media-card');
        await openItem(page, 'movie-1');

        assert.equal(await page.evaluate(() => window.__heldItems.length), 2);
        await releaseEnrichment(page);
        await button(page, 'Trailer').waitFor();

        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50))); // let the stale handler run too

        // The abandoned render's response must not paint a second synopsis or
        // a second Trailer button into the live screen.
        assert.equal(await page.locator('.jq-detail-overview').count(), 1);
        assert.deepEqual(await actionLabels(page), ['Resume', 'Start Over', 'Trailer', 'Add to My List']);

        // And it must be DISCARDED, not applied-and-then-caught. Without the
        // guard the stale handler still runs: its insertBefore() targets a
        // node the second render detached, throws, and lands in the failure
        // path -- which on a slower day paints "Could not load details" over
        // a screen that loaded perfectly well. Nothing about the container
        // distinguishes the two renders, so this is what the node-identity
        // check buys.
        assert.deepEqual(consoleErrors, [], 'a superseded response must not reach the DOM or the failure path');
        assert.equal(await page.locator('.jq-detail-enrich-error').evaluate((element) => element.hidden), true);
    } finally {
        await browser.close();
    }
});

test('a detail fetch that fails says so on screen, and says what still works', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openDetail(page, 'movie-1', holdEnrichment);
        await failEnrichment(page);

        const message = page.getByText('Could not load details. Play and My List still work.', { exact: true });
        await message.waitFor({ state: 'visible', timeout: 2000 });
        await assertPainted(message);

        // The claim in that message has to be true: both actions still work.
        assert.deepEqual(await actionLabels(page), ['Resume', 'Start Over', 'Add to My List']);
        await button(page, 'Resume').click();
        await page.waitForFunction(() => window.playbackManager.__calls.length > 0);
        await button(page, 'Add to My List').click();
        await page.waitForFunction(() => Boolean(document.querySelector('.jq-my-list-action'))
            && document.querySelector('.jq-my-list-action').textContent === 'Remove from My List');
    } finally {
        await browser.close();
    }
});

// The action row and any error text must stay on screen no matter how long
// the synopsis is. Overview has never rendered before this change, so this
// was latent; the typography audit measured the action row starting at
// y=1273 with a 4,000-character overview at TV metrics.
test('a 4,000-character synopsis at TV metrics keeps the action row and error text on screen', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openDetail(page, 'movie-1', async (target) => {
            await target.evaluate(() => {
                const getItem = window.ApiClient.getItem.bind(window.ApiClient);
                window.ApiClient.getItem = (userId, itemId) => getItem(userId, itemId).then((item) => ({
                    ...item,
                    Overview: 'Northern supply lines close early this year. '.repeat(100).slice(0, 4000),
                }));
            });
        });
        await page.waitForSelector('.jq-detail-overview');
        assert.equal(await page.locator('.jq-detail-overview').evaluate((element) => element.textContent.length), 4000);

        // The TVs run a 27px root font (the simulator's is 16px), so device
        // text is ~69% larger. The shipped stylesheet sizes this text in px,
        // so scale the paragraph explicitly too -- the same conservative fit
        // check test/e2e/library-queries.spec.mjs already uses for Search.
        await page.evaluate(() => {
            document.documentElement.style.fontSize = '27px';
            document.querySelector('.jq-detail-overview').style.fontSize = (18 * 27 / 16) + 'px';
        });

        // Paint an error too: it sits below the action row, so it is the
        // lowest thing on the screen and the first to fall off the bottom.
        await page.evaluate(() => {
            window.playbackManager.play = () => Promise.reject(new Error('nope'));
            // Dispatched rather than clicked through Playwright: an
            // unbounded overview puts Resume below the fold, and Playwright
            // would then spend the whole test timeout waiting for a button
            // to become actionable instead of reporting where it actually
            // is. Measuring the geometry is the point of this spec.
            Array.from(document.querySelectorAll('.jq-detail-action'))
                .find((element) => /^(Play|Resume)$/.test(element.textContent)).click();
        });
        const error = page.getByText('Could not start playback. Try again.', { exact: true });
        await error.waitFor({ state: 'visible', timeout: 2000 });

        const bottoms = await page.evaluate(() => {
            const visible = Array.from(document.querySelectorAll('.jq-detail-error')).filter((element) => !element.hidden);
            return {
                actions: document.querySelector('.jq-detail-actions').getBoundingClientRect().bottom,
                errors: visible.map((element) => element.getBoundingClientRect().bottom),
                errorCount: visible.length,
            };
        });
        assert.ok(bottoms.errorCount > 0, 'the playback error must be one of the measured elements');
        assert.ok(bottoms.actions <= 1080, `action row bottom ${bottoms.actions}px must stay within the 1080px viewport`);
        for (const bottom of bottoms.errors) {
            assert.ok(bottom <= 1080, `error text bottom ${bottom}px must stay within the 1080px viewport`);
        }
        // Still reachable by remote, not merely inside the box.
        await assertPainted(error);
        await assertPainted(button(page, 'Resume'));
    } finally {
        await browser.close();
    }
});

test('Play/Resume/Start Over call playbackManager.play with the right start position', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openDetail(page, 'movie-1');
        await button(page, 'Trailer').waitFor(); // enrichment settled: the row is final

        await page.keyboard.press('Enter'); // Resume -- still focused, enrichment does not move it
        await page.waitForFunction(() => window.playbackManager.__calls.length > 0);
        const resumeCall = await page.evaluate(() => window.playbackManager.__calls.slice(-1)[0]);
        assert.equal(resumeCall.ids[0], 'movie-1');
        assert.ok(resumeCall.startPositionTicks > 0, 'Resume must start from the saved position');

        await button(page, 'Start Over').click();
        await page.waitForFunction(() => window.playbackManager.__calls.length > 1);
        const startOverCall = await page.evaluate(() => window.playbackManager.__calls.slice(-1)[0]);
        assert.equal(startOverCall.startPositionTicks, 0);
    } finally {
        await browser.close();
    }
});

// The real player refuses `ids` with no server to resolve them against --
// `if (!items) { if (!options.serverId) throw new Error('serverId required!') }`
// at .cache/jellyfin-web/src/components/playback/playbackmanager.js:2101 --
// and dev/fixtures/playback-manager-stub.js now rejects the same way. These
// assertions state the requirement directly rather than leaving it implied by
// the stub, so a caller that drops serverId fails here with a readable reason.
test('every play request names the server the ids belong to', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openDetail(page, 'movie-1');

        await button(page, 'Resume').click();
        await page.waitForFunction(() => window.playbackManager.__calls.length > 0);
        const call = await page.evaluate(() => window.playbackManager.__calls.slice(-1)[0]);
        // The item's own ServerId, as jellyfin-web's playmenu.js:41-51 sends.
        assert.equal(call.serverId, 'dev-server-1');

        // And the fallback for an item that carries no ServerId of its own:
        // ApiClient.serverId(), the accessor jellyfin-web reaches for in the
        // same situation (mediaSegmentManager.ts:91). Detail plays the LIST
        // item it was handed, so stripping the list response is what matters.
        await page.evaluate(() => {
            const getItems = window.ApiClient.getItems;
            window.ApiClient.getItems = (userId, options) => getItems(userId, options).then((result) => ({
                ...result,
                Items: result.Items.map((item) => {
                    const stripped = { ...item };
                    delete stripped.ServerId;
                    return stripped;
                }),
            }));
            window.playbackManager.__calls.length = 0;
            document.querySelector('.jq-nav-home').click();
        });
        await page.waitForSelector('.jq-media-card');
        await openItem(page, 'movie-1');
        await button(page, 'Resume').click();
        await page.waitForFunction(() => window.playbackManager.__calls.length > 0);
        assert.equal(
            await page.evaluate(() => window.playbackManager.__calls.slice(-1)[0].serverId),
            'dev-server-1'
        );
    } finally {
        await browser.close();
    }
});

test('a play request the player refuses is visible on screen', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openDetail(page, 'movie-1');
        await button(page, 'Trailer').waitFor();

        await page.evaluate(() => {
            window.playbackManager.play = () => Promise.reject(new Error('serverId required!'));
        });
        await page.keyboard.press('Enter'); // Resume

        const message = page.getByText('Could not start playback. Try again.', { exact: true });
        await message.waitFor({ state: 'visible', timeout: 2000 });
        // Playwright visibility alone would still pass with this message
        // painted underneath the opaque #jellyquest-root, or under any other
        // layer above it -- which is how two earlier assertions in this repo
        // came to be checking something nobody could actually see. The shared
        // paint check (PR #18, test/e2e/support/paint.mjs) tests the real
        // stacking context instead.
        await assertPainted(message);

        // A retry that succeeds must clear it rather than leave a stale error.
        await page.evaluate(() => {
            window.playbackManager.play = () => Promise.resolve();
        });
        await page.keyboard.press('Enter');
        await message.waitFor({ state: 'hidden', timeout: 2000 });
    } finally {
        await browser.close();
    }
});

test('Trailer plays the local trailer item, not the movie itself', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openDetail(page, 'movie-1');
        await button(page, 'Trailer').waitFor();

        // Reachable from the remote, not just clickable: Right twice from the
        // autofocused Resume, whatever the row's final length turns out to be.
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Trailer');
        await page.keyboard.press('Enter');

        await page.waitForFunction(() => window.playbackManager.__calls.length > 0);
        // playTrailers() hands play() the resolved trailer ITEMS
        // (playbackmanager.js:3891-3925), not ids -- see app.js's
        // onPlayTrailer and dev/fixtures/playback-manager-stub.js.
        const call = await page.evaluate(() => window.playbackManager.__calls.slice(-1)[0]);
        assert.equal(call.items[0].Id, 'movie-1-trailer');
    } finally {
        await browser.close();
    }
});

// playTrailers() has two distinct rejections and Detail must tell them apart:
// playbackmanager.js:3924 rejects with NO ARGUMENT when there was nothing to
// play, while a real failure rejects with an error. A handler that
// dereferences the rejection value throws instead of painting either.
test('the two trailer rejections show different messages, and the empty one is survivable', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        const pageErrors = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await openDetail(page, 'movie-1');
        await button(page, 'Trailer').waitFor();

        await page.evaluate(() => { window.playbackManager.playTrailers = () => Promise.reject(); });
        await button(page, 'Trailer').click();
        const empty = page.getByText('No trailer available.', { exact: true });
        await empty.waitFor({ state: 'visible', timeout: 2000 });
        await assertPainted(empty);

        await page.evaluate(() => { window.playbackManager.playTrailers = () => Promise.reject(new Error('Offline')); });
        await button(page, 'Trailer').click();
        const failed = page.getByText('Could not load trailer. Try again.', { exact: true });
        await failed.waitFor({ state: 'visible', timeout: 2000 });
        await assertPainted(failed);

        assert.deepEqual(pageErrors, [], 'reading a bare rejection would throw inside the click handler');
    } finally {
        await browser.close();
    }
});

test('My List toggles the favorite label and persists through ApiClient', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openDetail(page, 'movie-9');
        await page.waitForSelector('.jq-detail-overview'); // enrichment settled

        await page.keyboard.press('ArrowRight'); // Play -> Add to My List (no trailer on movie-9)
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Add to My List');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.activeElement.textContent === 'Remove from My List');

        const favorite = await page.evaluate(() => window.ApiClient.getItem(window.ApiClient.getCurrentUserId(), 'movie-9'));
        assert.equal(favorite.UserData.IsFavorite, true);
    } finally {
        await browser.close();
    }
});

test('Left from the first action returns to the persistent rail', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openDetail(page, 'movie-1');
        await button(page, 'Trailer').waitFor();

        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Resume');
        await page.keyboard.press('ArrowLeft');
        assert.equal(
            await page.evaluate(() => document.activeElement.classList.contains('jq-rail-item')),
            true
        );
    } finally {
        await browser.close();
    }
});
