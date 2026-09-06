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
                        window.JellyQuestLibraryScreen.render(container, { title: 'Movies', fetch: reject }, { onBack() {} });
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
                const empty = page.getByText('No matches.', { exact: true });
                await empty.waitFor({ state: 'visible' });
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

for (const outcome of ['rejected', 'empty']) {
    test(`Trailer lookup ${outcome} shows a distinct message`, async () => {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
            await openRequestsAs(page, 'Alice');
            await page.evaluate(() => document.querySelector('.jq-nav-home').click());
            await page.waitForSelector('.jq-card');
            await page.evaluate((outcome) => {
                window.ApiClient.getLocalTrailers = () => outcome === 'rejected'
                    ? Promise.reject(new Error('Offline')) : Promise.resolve([]);
            }, outcome);
            await page.locator('.jq-card').first().click();
            await page.getByRole('button', { name: 'Trailer', exact: true }).click();
            const message = page.getByText(outcome === 'rejected' ? 'Could not load trailer. Try again.' : 'No trailer available.', { exact: true });
            await message.waitFor({ state: 'visible', timeout: 2000 });
            await assertPainted(message);
            await page.evaluate(() => {
                window.ApiClient.getLocalTrailers = () => Promise.resolve([{ Id: 'trailer-retry' }]);
            });
            await page.getByRole('button', { name: 'Trailer', exact: true }).click();
            await page.waitForFunction(() => window.playbackManager.__calls.some((call) => call.ids[0] === 'trailer-retry'));
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
