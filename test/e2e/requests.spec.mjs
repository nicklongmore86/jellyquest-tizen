// Requests screen (see docs/rebuild-plan.md, Phase 4): search, request,
// and claim, driven against dev/fixtures/requests-bridge.html standing in
// for JellyPass's real bridge.html.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { startServer } from './support/server.mjs';
import { assertPainted } from './support/paint.mjs';

const server = await startServer();
const simulatorUrl = `${server.baseUrl}/dev/simulator.html`;
test.after(() => server.close());

async function openRequestsAs(page, profileName) {
    await page.goto(simulatorUrl);
    await page.waitForSelector('.jq-profile-card');
    await page.evaluate((name) => {
        Array.from(document.querySelectorAll('.jq-profile-card')).find((card) => card.textContent === name).click();
    }, profileName);
    await page.waitForSelector('.jq-shell');
    await page.evaluate(() => document.querySelector('.jq-nav-requests').click());
}

async function searchFor(page, term) {
    await page.waitForSelector('.jq-requests-input');
    await page.evaluate((value) => {
        const input = document.querySelector('.jq-requests-input');
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }, term);
    await page.waitForSelector('.jq-request-card');
}

test('an eligible profile can search and gets one card per movie result', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openRequestsAs(page, 'Alice');
        await searchFor(page, 'a'); // matches Nebula Drift, Salt Flats, Harbor Lights

        const titles = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.jq-request-card-title')).map((el) => el.textContent)
        );
        assert.deepEqual(titles.sort(), ['Harbor Lights', 'Nebula Drift', 'Salt Flats']);
    } finally {
        await browser.close();
    }
});

test('a profile without a Jellyseerr account sees a message instead of a search box', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openRequestsAs(page, 'Charlie'); // fixture: not in eligibleUserIds

        await page.waitForFunction(() =>
            document.querySelector('.jq-requests-status') && !document.querySelector('.jq-requests-status').hidden
            && document.querySelector('.jq-requests-status').textContent === 'Requests are not available for this profile.'
        );
        assert.equal(await page.evaluate(() => document.querySelectorAll('.jq-requests-input').length), 0);
    } finally {
        await browser.close();
    }
});

test('a title with no request shows Request; requesting it flips the card to Requested', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openRequestsAs(page, 'Alice');
        await searchFor(page, 'Nebula Drift');

        assert.equal(await page.evaluate(() => document.querySelector('.jq-request-card-action').textContent), 'Request');
        await page.evaluate(() => document.querySelector('.jq-request-card-action').click());
        await page.waitForFunction(() => document.querySelector('.jq-request-card-action').textContent === 'Requested');

        // Requested is a plain status, not an action -- no button left to click.
        assert.equal(await page.evaluate(() => document.querySelector('.jq-request-card-action').tagName), 'SPAN');
    } finally {
        await browser.close();
    }
});

test('an already-requested title shows Requested with no action, regardless of who requested it', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openRequestsAs(page, 'Bob');
        await searchFor(page, 'Salt Flats'); // fixture: mediaInfo.status 2 (pending) from the start

        assert.equal(await page.evaluate(() => document.querySelector('.jq-request-card-action').textContent), 'Requested');
    } finally {
        await browser.close();
    }
});

test('an available title offers Add to My Library, and claiming it flips to In My Library', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openRequestsAs(page, 'Alice');
        await searchFor(page, 'Harbor Lights'); // fixture: status 5 (available), not yet claimed by Alice

        await page.waitForFunction(() => document.querySelector('.jq-request-card-action').textContent === 'Add to My Library');
        await page.evaluate(() => document.querySelector('.jq-request-card-action').click());
        await page.waitForFunction(() => document.querySelector('.jq-request-card-action').textContent === 'In My Library');
    } finally {
        await browser.close();
    }
});

test('the hardware Back button returns from Requests to Home', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openRequestsAs(page, 'Alice');
        await page.waitForSelector('.jq-requests-input');

        await page.keyboard.press('Escape'); // Escape doubles as Back in the simulator
        await page.waitForSelector('.jq-home-row-heading');
    } finally {
        await browser.close();
    }
});

for (const recovery of ['failure', 'empty', 'success']) {
    test(`a rejected Requests search is visible and recovers to ${recovery}`, async () => {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
            await openRequestsAs(page, 'Alice');
            await page.waitForSelector('.jq-requests-input');
            await page.evaluate(() => {
                const call = window.JellyQuestRequestsBridge.call;
                window.JellyQuestRequestsBridge.call = function (path, options) {
                    if (path.includes('query=fail')) return Promise.reject(new Error('Proxy unavailable'));
                    return call(path, options);
                };
            });
            await page.locator('.jq-requests-input').fill('fail');
            await page.waitForFunction(() => {
                const status = document.querySelector('.jq-requests-status');
                return !status.hidden && status.textContent === 'Search failed. Try again.';
            }, null, { timeout: 2000 });
            assert.equal(await page.locator('.jq-requests-status').isVisible(), true);
            assert.equal(await page.locator('.jq-requests-empty').isVisible(), false);
            assert.equal(await page.locator('.jq-request-card').count(), 0);
            if (recovery === 'failure') return;
            await page.locator('.jq-requests-input').fill(recovery === 'empty' ? 'zzzz-no-movie' : 'Nebula Drift');
            await page.waitForSelector(recovery === 'empty' ? '.jq-requests-empty' : '.jq-request-card');
            assert.equal(await page.locator('.jq-requests-status').isVisible(), false);
            if (recovery === 'empty') {
                assert.equal(await page.locator('.jq-requests-empty').textContent(), 'No matches.');
                assert.equal(await page.locator('.jq-request-card').count(), 0);
            } else {
                assert.equal(await page.locator('.jq-request-card-title').textContent(), 'Nebula Drift');
                assert.equal(await page.locator('.jq-requests-empty').isVisible(), false);
            }
        } finally {
            await browser.close();
        }
    });
}

for (const scenario of ['library search', 'library', 'home', 'profiles', 'favorite', 'request', 'claim']) {
    test(`a failed ${scenario} operation shows a message`, async () => {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
            await openRequestsAs(page, 'Alice');
            await page.waitForSelector('.jq-requests-input');
            if (scenario === 'request' || scenario === 'claim') {
                await searchFor(page, scenario === 'request' ? 'Nebula Drift' : 'Harbor Lights');
                await page.waitForFunction(() => document.querySelector('.jq-request-card-action').tagName === 'BUTTON');
                await page.evaluate(() => {
                    window.JellyQuestRequestsBridge.call = () => Promise.reject(new Error('Offline'));
                    document.querySelector('.jq-request-card-action').click();
                });
            } else {
                await page.evaluate((scenario) => {
                    const container = window.JellyQuestShell.getContent();
                    const reject = () => Promise.reject(new Error('Offline'));
                    if (scenario === 'library search') {
                        window.ApiClient.getItems = reject;
                        window.JellyQuestSearchScreen.render(container, {});
                        const input = container.querySelector('input');
                        input.value = 'movie';
                        input.dispatchEvent(new Event('input'));
                    } else if (scenario === 'library') {
                        window.ApiClient.getItems = reject;
                        window.JellyQuestLibraryScreen.render(container, { title: 'Movies' }, { onBack() {} });
                    } else if (scenario === 'home') {
                        const getItems = window.ApiClient.getItems;
                        window.ApiClient.getItems = (userId, options) => options.Filters === 'IsResumable'
                            ? reject() : getItems.call(window.ApiClient, userId, options);
                        window.JellyQuestHomeScreen.render(container, {});
                    } else if (scenario === 'profiles') {
                        window.JellyQuestSession.listProfiles = reject;
                        window.JellyQuestProfilesScreen.render(container, () => {});
                    } else {
                        window.ApiClient.updateFavoriteStatus = reject;
                        window.JellyQuestDetailScreen.render(container, { Id: 'movie', Name: 'Movie' }, {});
                        container.querySelector('.jq-my-list-action').click();
                    }
                }, scenario);
            }
            const messages = {
                'library search': 'Search failed. Try again.',
                library: 'Library is unavailable right now. Try again.',
                home: 'Continue Watching is unavailable right now.',
                profiles: 'Profiles are unavailable right now. Try again.',
                favorite: 'Could not update My List. Try again.',
                request: 'Request failed. Try again.',
                claim: 'Could not add to My Library. Try again.',
            };
            const message = page.getByText(messages[scenario], { exact: true });
            await message.waitFor({ state: 'visible', timeout: 2000 });
            await assertPainted(message);
            const colors = { 'library search': 'rgb(255, 107, 107)', favorite: 'rgb(255, 107, 107)', library: 'rgb(154, 160, 168)', request: 'rgb(255, 107, 107)', claim: 'rgb(255, 107, 107)' };
            if (colors[scenario]) assert.equal(await message.evaluate((el) => getComputedStyle(el).color), colors[scenario]);
            if (scenario === 'request' || scenario === 'claim') {
                const button = page.locator('button.jq-request-card-action');
                assert.equal(await button.textContent(), scenario === 'request' ? 'Request' : 'Add to My Library');
                assert.equal(await button.isEnabled(), true);
                await page.evaluate(() => {
                    window.JellyQuestRequestsBridge.call = () => Promise.resolve({});
                });
                await button.click();
                await page.getByText(scenario === 'request' ? 'Requested' : 'In My Library', { exact: true }).waitFor();
                assert.equal(await message.count(), 0);
            }
            if (scenario === 'library search') {
                await page.evaluate(() => {
                    window.ApiClient.getItems = () => Promise.resolve({ Items: [] });
                });
                await page.locator('.jq-search-input').fill('no matches');
                const empty = page.getByText('No films or shows match. Episode search isn’t available yet.', { exact: true });
                await empty.waitFor({ state: 'visible' });
                await assertPainted(empty);
                assert.equal(await empty.evaluate((el) => getComputedStyle(el).color), 'rgb(154, 160, 168)');
            }
            if (scenario === 'home') {
                assert.ok(await page.locator('.jq-home-row .jq-media-card').count() > 0);
                await assertPainted(page.getByText('Recently Added', { exact: true }));
            }
        } finally {
            await browser.close();
        }
    });
}

for (const screen of ['Requests', 'library']) {
    test(`${screen} ignores a late rejection after same-term success`, async () => {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
            await openRequestsAs(page, 'Alice');
            await page.waitForSelector('.jq-requests-input');
            await page.evaluate((screen) => {
                window.pendingSearches = [];
                const deferred = () => new Promise((resolve, reject) => window.pendingSearches.push({ resolve, reject }));
                if (screen === 'Requests') window.JellyQuestRequestsBridge.call = deferred;
                else {
                    window.ApiClient.getItems = deferred;
                    window.JellyQuestSearchScreen.render(window.JellyQuestShell.getContent(), {});
                }
            }, screen);
            const input = page.locator('.jq-search-input');
            await input.fill('Nebula');
            await page.waitForFunction(() => window.pendingSearches.length === 1);
            await input.fill('Nebulax');
            await input.fill('Nebula');
            await page.waitForFunction(() => window.pendingSearches.length === 2);
            await page.evaluate((screen) => {
                window.pendingSearches[1].resolve(screen === 'Requests'
                    ? { results: [{ id: 1, title: 'Nebula', mediaType: 'movie' }] }
                    : { Items: [{ Id: '1', Name: 'Nebula', Type: 'Movie' }] });
            }, screen);
            await page.waitForSelector('.jq-card');
            await page.evaluate(async () => {
                window.pendingSearches[0].reject(new Error('Late timeout'));
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
            assert.equal(await page.locator('.jq-card').count(), 1);
            assert.equal(await page.getByText('Search failed. Try again.', { exact: true }).isVisible(), false);
        } finally {
            await browser.close();
        }
    });
}

// These two used to assert DIFFERENT messages for the two rejection shapes.
// They do not any more: a bare `Promise.reject()` is not a unique signal for
// "no trailer" in the pinned build (nine such sites; see app.js's
// onPlayTrailer), so both now reach one message that names no cause. Both
// shapes are still exercised, because what still has to hold is that neither
// is dereferenced and both recover.
for (const outcome of ['rejected', 'empty']) {
    test(`Trailer ${outcome} shows a message that names no cause, and recovers`, async () => {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
            await openRequestsAs(page, 'Alice');
            await page.evaluate(() => document.querySelector('.jq-nav-home').click());
            await page.waitForSelector('.jq-card');
            // Trailer activation now goes through playbackManager.playTrailers()
            // rather than ApiClient.getLocalTrailers() + play() (see app.js's
            // onPlayTrailer). Both of its rejection shapes are exercised here
            // -- a real error, and the bare `Promise.reject()` of
            // playbackmanager.js:3924 -- and both must reach the same
            // message, because nothing in the pinned upstream tells them
            // apart.
            await page.evaluate((outcome) => {
                window.__realPlayTrailers = window.playbackManager.playTrailers;
                window.playbackManager.playTrailers = () => outcome === 'rejected'
                    ? Promise.reject(new Error('Offline')) : Promise.reject();
            }, outcome);
            await page.locator('.jq-card').first().click();
            const trailer = page.getByRole('button', { name: 'Trailer', exact: true });
            await trailer.waitFor(); // Detail fetches the full item before it can offer this
            await trailer.click();
            const message = page.getByText('Could not play the trailer. Try again.', { exact: true });
            await message.waitFor({ state: 'visible', timeout: 2000 });
            await assertPainted(message);
            await page.evaluate(() => {
                window.playbackManager.playTrailers = window.__realPlayTrailers;
                window.ApiClient.getLocalTrailers = () => Promise.resolve([{ Id: 'trailer-retry', Type: 'Trailer', ServerId: 'dev-server-1' }]);
            });
            await trailer.click();
            await page.waitForFunction(() => window.playbackManager.__calls.some((call) => call.items && call.items[0].Id === 'trailer-retry'));
            assert.equal(await message.isVisible(), false);
        } finally {
            await browser.close();
        }
    });
}

test('paint checks reject the old occluded fixture and accept real screen content', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openRequestsAs(page, 'Alice');
        await page.waitForSelector('.jq-requests-input');
        await page.evaluate(() => {
            const container = document.createElement('div');
            container.id = 'failure-test';
            document.body.appendChild(container);
            window.ApiClient.updateFavoriteStatus = () => Promise.reject(new Error('Offline'));
            window.JellyQuestDetailScreen.render(container, { Id: 'movie', Name: 'Movie' }, {});
            container.querySelector('.jq-my-list-action').click();
        });
        const message = page.getByText('Could not update My List. Try again.', { exact: true });
        await message.waitFor({ state: 'visible' }); // The OLD assertion passes despite occlusion.
        assert.equal(await message.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            return document.getElementById('jellyquest-root').contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        }), true, 'opaque root is painted above the old fixture');
        await assert.rejects(() => assertPainted(message), /not inside #jellyquest-root/);
        await page.evaluate(() => {
            const content = window.JellyQuestShell.getContent();
            content.innerHTML = '';
            content.appendChild(document.getElementById('failure-test'));
        });
        await assertPainted(message);
        await message.evaluate((el) => { el.style.transform = 'translateX(3000px)'; });
        await assert.rejects(() => assertPainted(message), /outside the viewport or has no hit target/);
        await message.evaluate((el) => { el.style.transform = ''; });
        await page.evaluate(() => {
            const cover = document.createElement('div');
            cover.id = 'test-cover';
            cover.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:#14161a;z-index:2147483001';
            document.getElementById('jellyquest-root').appendChild(cover);
        });
        assert.equal(await message.isVisible(), true);
        await assert.rejects(() => assertPainted(message), /obscured by another painted element/);
    } finally {
        await browser.close();
    }
});

for (const failure of ['HTTP 500', 'network', 'missing bridge URL']) {
    test(`Requests configuration distinguishes ${failure} and supports retry`, async () => {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
            await page.route('**/jellyquest-build.json', (route) => {
                if (failure === 'network') return route.abort();
                return route.fulfill({ status: failure === 'HTTP 500' ? 500 : 200, contentType: 'application/json', body: '{}' });
            });
            await openRequestsAs(page, 'Alice');
            const message = page.getByText(failure === 'missing bridge URL'
                ? 'Requests are not configured for this server.'
                : 'Could not load Requests configuration. Try again.', { exact: true });
            await message.waitFor({ state: 'visible', timeout: 2000 });
            await assertPainted(message);
            if (failure === 'missing bridge URL') {
                assert.equal(await page.getByRole('button', { name: 'Retry', exact: true }).count(), 0);
            } else {
                await page.unroute('**/jellyquest-build.json');
                await page.getByRole('button', { name: 'Retry', exact: true }).click();
                await page.waitForSelector('.jq-requests-input');
                assert.equal(await message.count(), 0);
            }
        } finally {
            await browser.close();
        }
    });
}

test('Requests surfaces a synchronous renderer throw after configuration loads', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await page.goto(simulatorUrl);
        await page.waitForSelector('.jq-profile-card');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.jq-shell');
        await page.evaluate(() => {
            window.JellyQuestRequestsScreen.render = (container) => {
                container.innerHTML = ''; // Also exercise throws after the loading status is removed.
                throw new Error('Forced Requests render failure');
            };
        });
        const loggedError = page.waitForEvent('console', {
            predicate: (message) => message.type() === 'error' && message.text().includes('Requests render failed'),
            timeout: 2000,
        });
        await page.locator('.jq-nav-requests').click();
        const message = page.getByText('Requests are unavailable right now.', { exact: true });
        await Promise.all([
            message.waitFor({ state: 'visible', timeout: 2000 }),
            loggedError,
        ]);
        await assertPainted(message);
    } finally {
        await browser.close();
    }
});

// ---- Late-completion focus steals (the fifth of this class) -------------
//
// Requests waits on the bridge -- checkEligibility() then openSession(),
// two network round trips -- while the rail stays mounted and focusable.
// The fixture bridge is already asynchronous (an iframe load and a
// postMessage round trip), so the ordering these tests need is reachable
// in principle without help; what it is not is CONTROLLABLE. Releasing the
// bridge call explicitly is what makes "a key press lands while the
// session is open" deterministic rather than a race against however long
// the fixture iframe happens to take. The cursor is then moved with REAL
// arrow keys, because a programmatic .focus() would not exercise the
// polyfill's own path.
async function openShellAs(page, profileName) {
    await page.goto(simulatorUrl);
    await page.waitForSelector('.jq-profile-card');
    await page.evaluate((name) => {
        Array.from(document.querySelectorAll('.jq-profile-card')).find((card) => card.textContent === name).click();
    }, profileName);
    await page.waitForSelector('.jq-shell');
    await page.waitForSelector('.jq-media-card'); // let Home settle, so nothing else moves focus later
}

// Holds the initial configuration response open until release(). This is the
// gap under test: an immediate route response cannot interleave a remote key
// press between showRequests() and its configuration continuation.
async function deferConfiguration(page, response) {
    let markStarted;
    let releaseRequest;
    let markFinished;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const held = new Promise((resolve) => { releaseRequest = resolve; });
    const finished = new Promise((resolve) => { markFinished = resolve; });
    await page.route('**/jellyquest-build.json', async (route) => {
        markStarted();
        await held;
        await route.fulfill({
            status: response.status,
            contentType: 'application/json',
            body: response.body,
        });
        markFinished();
    });
    return {
        waitForRequest: () => started,
        release: async () => {
            releaseRequest();
            await finished;
        },
    };
}

// Holds the named bridge method open until releaseBridge(). `outcome`
// 'reject' fails it instead, for the error path.
async function deferBridge(page, method, outcome) {
    await page.evaluate(([method, outcome]) => {
        const real = window.JellyQuestRequestsBridge[method];
        window.__pendingBridge = [];
        window.JellyQuestRequestsBridge[method] = function () {
            const receiver = this;
            const args = arguments;
            return new Promise((resolve, reject) => {
                window.__pendingBridge.push(() => {
                    if (outcome === 'reject') return reject(new Error('Requests bridge offline'));
                    real.apply(receiver, args).then(resolve, reject);
                });
            });
        };
    }, [method, outcome]);
}

// A real mouse click on the rail item, which focuses it the way pressing
// Enter on it does -- so the captured "focus at render start" is a rendered,
// visible rail button, the case that could wrongly suppress the guard.
async function enterRequestsAndHold(page) {
    await page.locator('.jq-nav-requests').click();
    await page.waitForFunction(() => window.__pendingBridge && window.__pendingBridge.length === 1);
    assert.equal(await activeClass(page), 'jq-nav-requests',
        'entering Requests must leave focus on the rail item that was activated');
}

async function releaseBridge(page) {
    await page.evaluate(() => window.__pendingBridge.splice(0).forEach((release) => release()));
}

function activeClass(page) {
    return page.evaluate(() => {
        const active = document.activeElement;
        const names = ['jq-nav-home', 'jq-nav-shows', 'jq-nav-search', 'jq-nav-requests', 'jq-profile-switch', 'jq-requests-input', 'jq-requests-retry'];
        return names.find((name) => active.classList.contains(name)) || active.className || active.tagName;
    });
}

// ---- Configuration-wait focus steals (the sixth of this class) ---------

for (const outcome of ['success', 'HTTP 500']) {
    test(`a delayed Requests configuration ${outcome} preserves a newer Home selection`, async () => {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
            const configuration = await deferConfiguration(page, {
                status: outcome === 'success' ? 200 : 500,
                body: outcome === 'success'
                    ? JSON.stringify({ requestsBridgeUrl: `${server.baseUrl}/dev/fixtures/requests-bridge.html` })
                    : '{}',
            });
            await openShellAs(page, 'Alice');
            await configuration.waitForRequest();
            await page.locator('.jq-nav-requests').click();
            await page.getByText('Loading Requests configuration…', { exact: true }).waitFor();

            await page.keyboard.press('ArrowUp'); // Requests -> Search
            await page.keyboard.press('ArrowUp'); // Search   -> Movies
            await page.keyboard.press('ArrowUp'); // Movies   -> Shows
            await page.keyboard.press('ArrowUp'); // Shows    -> Home
            assert.equal(await activeClass(page), 'jq-nav-home');
            await configuration.release();

            if (outcome === 'success') await page.waitForSelector('.jq-requests-input');
            else await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
            assert.equal(await activeClass(page), 'jq-nav-home',
                `a late configuration ${outcome} must not override the newer Home selection`);
            await assertPainted(page.locator(':focus'));
        } finally {
            await browser.close();
        }
    });
}

for (const scenario of [
    'configuration succeeds',
    'HTTP 500 then Retry succeeds',
    'HTTP 500 then Retry bridge fails',
    'eligibility is denied',
    'Requests are not configured',
]) {
    test(`a delayed Requests ${scenario} keeps ordinary focus placement`, async () => {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
            const failsInitially = scenario.startsWith('HTTP 500');
            const configuration = await deferConfiguration(page, {
                status: failsInitially ? 500 : 200,
                body: scenario === 'Requests are not configured'
                    ? '{}'
                    : JSON.stringify({ requestsBridgeUrl: `${server.baseUrl}/dev/fixtures/requests-bridge.html` }),
            });
            await openShellAs(page, scenario === 'eligibility is denied' ? 'Charlie' : 'Alice');
            await configuration.waitForRequest();
            await page.locator('.jq-nav-requests').click();
            assert.equal(await activeClass(page), 'jq-nav-requests');
            await configuration.release();

            if (failsInitially) {
                const retry = page.getByRole('button', { name: 'Retry', exact: true });
                await retry.waitFor();
                assert.equal(await activeClass(page), 'jq-requests-retry',
                    'a configuration failure must autofocus Retry when the user has not moved');
                await page.unroute('**/jellyquest-build.json');
                if (scenario === 'HTTP 500 then Retry bridge fails') {
                    await page.evaluate(() => {
                        window.JellyQuestRequestsBridge.openSession = () => Promise.reject(new Error('Requests bridge offline'));
                    });
                }
                await page.keyboard.press('Enter');
            }

            if (scenario === 'configuration succeeds' || scenario === 'HTTP 500 then Retry succeeds') {
                await page.waitForSelector('.jq-requests-input');
                assert.equal(await activeClass(page), 'jq-requests-input',
                    'an ordinary successful render must autofocus the Requests search input');
            } else if (scenario === 'HTTP 500 then Retry bridge fails') {
                await page.getByText('Requests are unavailable right now.', { exact: true }).waitFor();
                assert.equal(await activeClass(page), 'jq-profile-switch',
                    'a Retry bridge failure must leave visible focus on the rail fallback');
            } else if (scenario === 'eligibility is denied') {
                await page.getByText('Requests are not available for this profile.', { exact: true }).waitFor();
                assert.equal(await activeClass(page), 'jq-nav-requests');
            } else {
                await page.getByText('Requests are not configured for this server.', { exact: true }).waitFor();
                assert.equal(await activeClass(page), 'jq-nav-requests');
            }
            await assertPainted(page.locator(':focus'));
        } finally {
            await browser.close();
        }
    });
}

test('a delayed Requests session preserves a newer rendered rail selection', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openShellAs(page, 'Alice');
        await deferBridge(page, 'openSession');
        await enterRequestsAndHold(page);

        await page.keyboard.press('ArrowUp'); // Requests -> Search
        await page.keyboard.press('ArrowUp'); // Search   -> Movies
        await page.keyboard.press('ArrowUp'); // Movies   -> Shows
        await page.keyboard.press('ArrowUp'); // Shows    -> Home
        assert.equal(await activeClass(page), 'jq-nav-home',
            'the delayed-session precondition must leave a real selection on Home');
        await assertPainted(page.locator(':focus'));

        await releaseBridge(page);
        await page.waitForSelector('.jq-requests-input');

        assert.equal(await activeClass(page), 'jq-nav-home',
            'a late Requests session must not override the newer Home selection');
        await assertPainted(page.locator(':focus'));
    } finally {
        await browser.close();
    }
});

// NON-REGRESSION GUARD -- green before this change and after it. Its job is
// the other half of the guard: focusFirst()'s expectedFocus check must not
// suppress ORDINARY autofocus. shell.js focuses the rail before any screen
// renders, so the element captured at render start is itself a visible,
// rendered rail button; only the identity clause
// (document.activeElement !== expectedFocus) keeps hasVisibleFocus() from
// swallowing the normal case. Delete that clause and this test fails.
test('a delayed Requests session still autofocuses its search input without newer user input', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await openShellAs(page, 'Alice');
        await deferBridge(page, 'openSession');
        await enterRequestsAndHold(page);

        await releaseBridge(page);
        await page.waitForSelector('.jq-requests-input');

        assert.equal(await activeClass(page), 'jq-requests-input',
            'Requests must keep its ordinary search-input autofocus when focus has not moved');
        await assertPainted(page.locator(':focus'));
    } finally {
        await browser.close();
    }
});

// NON-REGRESSION GUARDs -- the two paths that end the render WITHOUT
// reaching renderSearch(). Neither calls focusFirst() after its await
// today; these pin that, since a "show a message and also focus something"
// change to either would reintroduce the same steal.
for (const path of ['an ineligible profile', 'a session error']) {
    test(`a delayed Requests render that ends in ${path} leaves a newer rail selection alone`, async () => {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
            const ineligible = path === 'an ineligible profile';
            await openShellAs(page, ineligible ? 'Charlie' : 'Alice'); // Charlie: not in eligibleUserIds
            await deferBridge(page, ineligible ? 'checkEligibility' : 'openSession', ineligible ? null : 'reject');
            await enterRequestsAndHold(page);

            await page.keyboard.press('ArrowUp'); // Requests -> Search
            assert.equal(await activeClass(page), 'jq-nav-search');

            await releaseBridge(page);
            const message = page.getByText(ineligible
                ? 'Requests are not available for this profile.'
                : 'Requests are unavailable right now.', { exact: true });
            await message.waitFor({ state: 'visible', timeout: 2000 });
            await assertPainted(message);

            assert.equal(await activeClass(page), 'jq-nav-search',
                'a late Requests failure must not override the newer Search selection');
            await assertPainted(page.locator(':focus'));
        } finally {
            await browser.close();
        }
    });
}

// ---- Retry: the same guard must not swallow ORDINARY autofocus ---------
//
// Pressing Retry re-enters app.js's showRequests(), which clears the
// content container -- detaching the Retry button that had focus, so
// document.activeElement is <body> when renderRequests() begins. The
// synchronous focusFirst() near the top of that render then finds nothing
// focusable in the screen yet and falls back to the rail. That is the
// APPLICATION placing focus during this render, not the user moving it,
// and it must not read as newer intent when the bridge comes back -- which
// is why the expectation is captured after that settles rather than at
// function entry. These three pin all three outcomes of a Retry press.
async function enterRequestsWithArrows(page) {
    await page.keyboard.press('ArrowLeft'); // out of the Home grid, into the rail
    for (let step = 0; step < 4; step += 1) {
        if (await page.evaluate(() => document.activeElement.classList.contains('jq-nav-requests'))) break;
        await page.keyboard.press('ArrowDown');
    }
    assert.equal(await activeClass(page), 'jq-nav-requests');
    await page.keyboard.press('Enter');
}

for (const outcome of ['succeeds', 'fails its configuration again', 'fails its bridge session']) {
    test(`Retry that ${outcome} leaves focus somewhere the user can see it`, async () => {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
            let configurationFails = true;
            await page.route('**/jellyquest-build.json', (route) => (configurationFails
                ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
                : route.continue()));
            await openShellAs(page, 'Alice');
            await enterRequestsWithArrows(page);

            const retry = page.getByRole('button', { name: 'Retry', exact: true });
            await retry.waitFor({ state: 'visible', timeout: 2000 });
            assert.equal(await activeClass(page), 'jq-requests-retry',
                'the configuration-failure render must put the cursor on its only action');
            await assertPainted(retry);

            if (outcome !== 'fails its configuration again') configurationFails = false;
            if (outcome === 'fails its bridge session') {
                await page.evaluate(() => {
                    window.JellyQuestRequestsBridge.openSession = () => Promise.reject(new Error('Requests bridge offline'));
                });
            }
            await page.keyboard.press('Enter'); // press Retry, with NO further user input after it

            if (outcome === 'succeeds') {
                await page.waitForSelector('.jq-requests-input');
                // The regression this file exists to prevent: nothing the
                // user did competes with this render, so the search box has
                // to take focus exactly as it does on a first visit.
                assert.equal(await activeClass(page), 'jq-requests-input',
                    'a successful Retry must autofocus the search input, not leave the cursor on the rail');
            } else if (outcome === 'fails its configuration again') {
                await page.waitForFunction(() => document.activeElement.classList.contains('jq-requests-retry'));
                // Retry is re-rendered and is again the screen's only
                // action, so it is again where the cursor belongs -- a user
                // holding Enter through a flaky config load keeps retrying.
                assert.equal(await activeClass(page), 'jq-requests-retry');
            } else {
                const message = page.getByText('Requests are unavailable right now.', { exact: true });
                await message.waitFor({ state: 'visible', timeout: 2000 });
                await assertPainted(message);
                // This render has NOTHING focusable: the message is a <p>
                // and the failure path deliberately offers no Retry. So the
                // rail fallback in focusFirst() is the right answer and the
                // one this pins -- the alternative is focus on <body>, i.e.
                // no cursor at all, which on a TV reads as a dead app.
                assert.equal(await activeClass(page), 'jq-profile-switch',
                    'a Retry whose bridge fails must still leave a visible cursor on the rail');
            }
            await assertPainted(page.locator(':focus'));
        } finally {
            await browser.close();
        }
    });
}
