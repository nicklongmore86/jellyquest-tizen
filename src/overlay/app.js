// Bootstraps JellyQuest and owns the (small, hand-rolled) router between
// screens: creates #jellyquest-root (no host markup required -- gulp's
// injection provides no container div), then switches between the
// profile picker and the shell, and -- within the shell -- between
// Home/Search/Library/Detail/Requests. The shell's rail (shell.js) stays
// mounted across all of those; only its content area swaps.
//
// Also owns the remote's hardware Back button: every screen but Home
// registers a "go back to where I came from" handler here, so Back
// behaves the way every other TV app's does, distinct from (and in
// addition to) Left-into-the-rail spatial navigation. Home -- the top of
// the navigation stack -- answers Back with the exit confirmation below.
(function () {
    'use strict';

    // 10009 is Tizen's documented hardware Back. jellyfin-web's own
    // keyboardnavigation maps BOTH 461 and 10009 to Back, so some sets are
    // expected to emit 461 instead; which one this hardware sends is
    // UNVERIFIED (it needs a TV), and listening for both costs nothing --
    // if it emits 461, JellyQuest's listener would otherwise never fire on
    // any screen. 27/Escape is for desktop/simulator testing.
    var BACK_KEY_CODES = [10009, 461, 27];
    var currentBackHandler = null;
    var buildConfig = null;
    var configurationPromise = null;

    // jellyquest-build.json is written by scripts/configure-jellyquest.mjs
    // next to index.html at packaging time (fetched here the same way the
    // old app's loadConfiguration() did); Requests is the only thing that
    // needs it; every other screen works with no configuration at all.
    function loadConfiguration() {
        if (configurationPromise) return configurationPromise;
        configurationPromise = fetch('jellyquest-build.json', { cache: 'no-store' }).then(function (response) {
            if (!response.ok) throw new Error('configuration returned ' + response.status);
            return response.json();
        }).then(function (config) {
            buildConfig = config || {};
        }).catch(function (error) {
            // Loads only run without cached configuration today. If refresh is
            // added, preserve the last good configuration on a failed refresh.
            buildConfig = null;
            console.error('[JellyQuest] Requests configuration unavailable:', error);
        }).then(function () {
            configurationPromise = null;
        });
        return configurationPromise;
    }

    function showProfiles(root) {
        currentBackHandler = null;
        window.JellyQuestRequestsBridge.close();
        window.JellyQuestProfilesScreen.render(root, function () {
            showShell(root);
        });
    }

    function showShell(root) {
        window.JellyQuestShell.render(root, {
            onSwitchProfile: function () { showProfiles(root); },
            onHome: showHome,
            onSearch: showSearch,
            onRequests: showRequests,
        });
        showHome();
    }

    function showHome() {
        currentBackHandler = confirmExit; // top of the navigation stack: Back offers to quit
        window.JellyQuestRequestsBridge.close();
        window.JellyQuestHomeScreen.render(window.JellyQuestShell.getContent(), {
            onSelectItem: function (item) { showDetail(item, showHome); },
            onSeeAll: function (row) { showLibrary(row, showHome); },
        });
    }

    function showSearch() {
        currentBackHandler = showHome;
        window.JellyQuestRequestsBridge.close();
        window.JellyQuestSearchScreen.render(window.JellyQuestShell.getContent(), {
            onSelectItem: function (item) { showDetail(item, showSearch); },
        });
    }

    function showLibrary(row, returnTo) {
        currentBackHandler = returnTo;
        window.JellyQuestRequestsBridge.close();
        window.JellyQuestLibraryScreen.render(window.JellyQuestShell.getContent(), row, {
            onSelectItem: function (item) { showDetail(item, function () { showLibrary(row, returnTo); }); },
            onBack: returnTo,
        });
    }

    // ---- Playback ------------------------------------------------------
    //
    // playbackManager.play() cannot turn `ids` into playable items on its
    // own. With no `items` in the options it demands a server to query and
    // refuses outright otherwise -- `if (!items) { if (!options.serverId) {
    // throw new Error('serverId required!'); } }`, in
    // .cache/jellyfin-web/src/components/playback/playbackmanager.js:2101.
    // `ids` + `serverId` is the shape jellyfin-web's own Play/Resume buttons
    // pass (components/playmenu.js:41-51).
    //
    // Passing `items: [item]` instead is deliberately NOT what happens here.
    // Every item JellyQuest holds arrived from an ApiClient.getItems() list
    // query (Home, Library, Search) and is therefore partial -- no
    // MediaSources, no Chapters/Trickplay. `items` hands that partial object
    // straight to the player: for ordinary video, translateItemsForPlayback
    // returns the array unchanged (playbackmanager.js:1805). `ids` +
    // `serverId` makes the player re-fetch the FULL item through
    // apiClient.getItem() first (getItemsForPlayback,
    // playbackmanager.js:132). It would not even dodge the server question:
    // the `items` path reads firstItem.ServerId anyway
    // (playbackmanager.js:1810).
    function serverIdFor(item) {
        // Every BaseItemDto a real server returns carries ServerId. Falling
        // back to the connected client's own id for one that does not is
        // jellyfin-web's own pattern -- see
        // components/remotecontrol/remotecontrol.js:667. serverId() is the
        // documented ApiClient accessor (src/apiclient.d.ts:270).
        if (item && item.ServerId) return item.ServerId;
        var apiClient = window.ApiClient;
        if (apiClient && typeof apiClient.serverId === 'function') return apiClient.serverId();
        // Null rather than a guess: play() rejects with 'serverId required!'
        // and Detail shows that failure, which beats silently doing nothing.
        return null;
    }

    // Always hands back a promise -- including when playbackManager is
    // missing altogether -- so Detail has exactly one rejection path to
    // render an error from.
    function requestPlayback(item, options) {
        try {
            options.serverId = serverIdFor(item);
            return Promise.resolve(window.playbackManager.play(options));
        } catch (error) {
            return Promise.reject(error);
        }
    }

    function showDetail(item, returnTo) {
        currentBackHandler = returnTo;
        window.JellyQuestRequestsBridge.close();
        window.JellyQuestDetailScreen.render(window.JellyQuestShell.getContent(), item, {
            onPlay: function (playItem, startPositionTicks) {
                return requestPlayback(playItem, { ids: [playItem.Id], startPositionTicks: startPositionTicks });
            },
            onPlayTrailer: function (playItem) {
                var userId = window.ApiClient.getCurrentUserId();
                return window.ApiClient.getLocalTrailers(userId, playItem.Id).then(function (trailers) {
                    if (!trailers.length) return false;
                    // The trailer is its own item, so its own ServerId is the
                    // right one to send.
                    return requestPlayback(trailers[0], { ids: [trailers[0].Id] }).then(function () {
                        return true;
                    });
                });
            },
        });
    }

    function showRequests() {
        currentBackHandler = showHome;
        var container = window.JellyQuestShell.getContent();
        var user = window.JellyQuestSession.getCurrentProfile();
        container.innerHTML = '';
        container.className = 'jq-requests-screen';
        var loading = document.createElement('p');
        loading.className = 'jq-requests-status';
        loading.textContent = 'Loading Requests configuration…';
        container.appendChild(loading);
        var ready = buildConfig ? Promise.resolve() : loadConfiguration();
        ready.then(function () {
            if (loading.parentNode !== container) return; // navigated away while loading
            window.JellyQuestRequestsScreen.render(container, {
                bridgeUrl: buildConfig && buildConfig.requestsBridgeUrl,
                configurationFailed: !buildConfig,
                onRetryConfiguration: showRequests,
                userId: user.Id,
                userName: user.Name
            });
        }).catch(function (error) {
            console.error('[JellyQuest] Requests render failed:', error);
            container.innerHTML = '';
            loading.textContent = 'Requests are unavailable right now.';
            loading.hidden = false;
            container.appendChild(loading);
        });
    }

    // ---- Root-level Back: the exit confirmation -------------------------
    //
    // Samsung's certification policy (CO-US-05, "Terminating Applications")
    // requires that a short Return press on the app's root screen shows an
    // app-created HTML confirmation, and that only an affirmative answer
    // terminates the app. Home is that root screen.
    //
    // Leaving Back unhandled here does NOT get that behaviour for free.
    // jellyfin-web does show its own Samsung-style confirmation when its
    // router cannot go back, but #jellyquest-root sits at z-index
    // 2147483000 with an opaque background (see app.css) while
    // jellyfin-web's .dialogContainer is z-index 999999, so that dialog
    // renders behind the overlay and is invisible. What the user sees is
    // only its side effect: opening the dialog blurs the outside
    // activeElement (removing the .jq-focusable:focus outline that IS the
    // cursor) and closing it restores focus to the same element -- the
    // reported "cursor disappears, then comes back to the same spot".
    //
    // So JellyQuest owns the prompt, built on the same modal primitives
    // every other JellyQuest dialog uses (focus.js's openModal/closeModal/
    // closeOnBack and the .jq-modal conventions).
    var exitConfirm = null;

    function buildExitConfirm(root) {
        var backdrop = document.createElement('div');
        backdrop.className = 'jq-modal-backdrop jq-exit-backdrop';
        backdrop.hidden = true;

        var modal = document.createElement('div');
        modal.className = 'jq-modal jq-exit-confirm';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-label', 'Exit JellyQuest');
        backdrop.appendChild(modal);

        var heading = document.createElement('h2');
        heading.className = 'jq-exit-title';
        heading.textContent = 'Exit JellyQuest?';
        modal.appendChild(heading);

        var message = document.createElement('p');
        message.className = 'jq-exit-message';
        message.textContent = 'Closing the app will stop anything that is playing.';
        modal.appendChild(message);

        var actions = document.createElement('div');
        actions.className = 'jq-exit-actions';
        modal.appendChild(actions);

        // "No" is autofocused deliberately: Back is a frequently-pressed key
        // and the press that opens this dialog is often followed by a reflex
        // Enter, which must not be able to quit the app by accident.
        var no = document.createElement('button');
        no.className = 'jq-modal-option jq-focusable jq-exit-no';
        no.textContent = 'No';
        no.setAttribute('data-jq-autofocus', '');
        no.addEventListener('click', dismissExit);
        actions.appendChild(no);

        var yes = document.createElement('button');
        yes.className = 'jq-modal-option jq-focusable jq-exit-yes';
        yes.textContent = 'Yes, exit';
        yes.addEventListener('click', function () {
            dismissExit();
            exitApp();
        });
        actions.appendChild(yes);

        root.appendChild(backdrop);
        return { backdrop: backdrop, modal: modal, restoreTarget: null };
    }

    // Built lazily on the first root-level Back and reused after that:
    // showHome() runs on every navigation back to Home, and the dialog
    // lives on #jellyquest-root rather than inside the shell's content
    // area, which each screen clears when it renders.
    //
    // Reuse is not unconditional, though. #jellyquest-root's own contents
    // are cleared wholesale by both shell.js's renderShell() and
    // profiles.js's renderProfiles() (`container.innerHTML = ''`), so a
    // profile switch detaches this dialog while the cached reference
    // survives. Opening a detached dialog shows nothing while still
    // consuming the Back key -- strictly worse than having no handler at
    // all, and dead until reload. Re-parenting is preferred over rebuilding
    // because it is one comparison instead of a fresh DOM subtree and set
    // of listeners on every Back press, and the same check covers both
    // cases: the node was detached, or the root element itself was
    // replaced.
    function confirmExit() {
        var root = document.getElementById('jellyquest-root');
        if (!root) return;
        if (!exitConfirm) {
            exitConfirm = buildExitConfirm(root);
        } else if (exitConfirm.backdrop.parentNode !== root) {
            root.appendChild(exitConfirm.backdrop);
        }
        exitConfirm.restoreTarget = document.activeElement;
        exitConfirm.backdrop.hidden = false;
        window.JellyQuestFocus.openModal(exitConfirm.modal, dismissExit);
    }

    function dismissExit() {
        if (!exitConfirm) return;
        var restore = exitConfirm.restoreTarget;
        exitConfirm.restoreTarget = null;
        exitConfirm.backdrop.hidden = true;
        if (restore && restore !== document.body && document.body.contains(restore)) {
            window.JellyQuestFocus.closeModal(exitConfirm.modal, restore);
            return;
        }
        // Nothing focusable to go back to -- either the element that had
        // focus is gone (a re-render while the dialog was open), or nothing
        // was focused at all and activeElement was <body>, which focus()
        // cannot meaningfully restore. Fall back to whatever the current
        // screen focuses first rather than leaving the TV with no cursor.
        window.JellyQuestFocus.closeModal(exitConfirm.modal, null);
        window.JellyQuestFocus.focusFirst(window.JellyQuestShell.getContent());
    }

    // NativeShell.AppHost.exit() is tizen.js's shim over
    // tizen.application.getCurrentApplication().exit(). It is genuinely
    // absent in any embedding that does not load tizen.js, and in the
    // simulator dev/fixtures/tizen-stub.js supplies an exit() that only
    // logs -- so guard rather than assume, and never let a missing or
    // throwing host API take the UI down with it.
    function exitApp() {
        var appHost = window.NativeShell && window.NativeShell.AppHost;
        if (!appHost || typeof appHost.exit !== 'function') {
            console.warn('[JellyQuest] No AppHost.exit() available -- cannot terminate.');
            return;
        }
        try {
            appHost.exit();
        } catch (err) {
            console.error('[JellyQuest] AppHost.exit() failed:', err);
        }
    }

    // Consuming Back means consuming it for everyone. jellyfin-web installs
    // its own Back handling (keyboardNavigation -> inputManager
    // .handleCommand('back') -> appRouter.back() or appHost.exit()), and
    // that listener does bail out on an already-prevented event -- its first
    // line is `if (e.defaultPrevented) return;`.
    //
    // preventDefault() alone still is not enough to rely on, because it only
    // marks the event prevented if the event is CANCELABLE, and whether
    // these key presses are cancelable on this hardware is UNVERIFIED --
    // neither confirmed nor refuted; it needs a TV. stopPropagation() does
    // not depend on that at all: jellyfin-web's listener is on `window` in
    // the bubble phase and this one is on `document`, so the press stops
    // before it ever gets there. Both calls, deliberately.
    // True only while jellyfin-web is actually playing video -- not merely
    // "Detail is the current screen". playbackManager is jellyfin-web's own
    // global (the same one Detail's Play button already calls through, see
    // showDetail above) and isPlayingVideo() is its public accessor.
    //
    // Guarded rather than called directly: JellyQuest also runs in the
    // simulator, and this must never throw inside a keydown handler -- if
    // the API is not there, the answer is "no video is playing", which
    // leaves every existing Back behaviour exactly as it was.
    function isVideoPlaying() {
        var manager = window.playbackManager;
        if (!manager || typeof manager.isPlayingVideo !== 'function') return false;
        try {
            return !!manager.isPlayingVideo();
        } catch (err) {
            console.error('[JellyQuest] playbackManager.isPlayingVideo() failed:', err);
            return false;
        }
    }

    function consumeBack(event) {
        event.preventDefault();
        event.stopPropagation();
    }

    document.addEventListener('keydown', function (event) {
        if (BACK_KEY_CODES.indexOf(event.keyCode) === -1) return;
        // An open modal (e.g. Detail's Playback Options) owns Back first,
        // closing itself rather than navigating the whole screen away --
        // see DETAIL_ACTIONS.md's "Left or Back returns one level before
        // closing" rule.
        if (window.JellyQuestFocus.closeOnBack()) {
            consumeBack(event);
            return;
        }
        // While a video is playing, Back belongs to jellyfin-web. JellyQuest
        // has no player screen of its own -- playback is delegated whole to
        // playbackManager and Detail stays the current JellyQuest screen --
        // and it is jellyfin-web that owns getting the user out of the
        // video. Crucially that exit is NAVIGATION-driven and runs from the
        // WINDOW-level listener: keyboardNavigation ->
        // inputManager.handleCommand('back') -> appRouter.back(), which
        // hides the video view, whose own 'viewbeforehide' handler
        // (onViewHideStopPlayback) calls playbackManager.stop().
        //
        // The video controller's own document-level keydown handler does
        // NOT stop playback; its Escape/Back case only calls hideOsd(). So
        // consuming the press here -- stopPropagation() in particular, which
        // is what keeps the window listener from ever running -- would leave
        // the video playing with no way out. Deferring costs nothing: with
        // no video playing this branch never fires.
        if (isVideoPlaying()) return;
        if (!currentBackHandler) return;
        consumeBack(event);
        currentBackHandler();
    });

    var API_CLIENT_POLL_MS = 50;
    var API_CLIENT_MAX_ATTEMPTS = 300; // ~15s

    // jellyquest.js is injected (deferred) before jellyfin-web's own
    // bundle in the built index.html, and deferred scripts run in
    // document order -- so window.ApiClient is NOT guaranteed to exist
    // the instant this file runs; jellyfin-web's own bundle hasn't
    // necessarily executed yet at all. Confirmed on real hardware
    // (Phase 5): this crashed every time in the field (session.js's
    // listProfiles() calling ApiClient.getPublicUsers() on undefined),
    // but never in the simulator, where the fixture scripts set
    // window.ApiClient synchronously before jellyquest.js's own <script>
    // tag even runs -- the simulator never actually exercised real
    // script load-order timing.
    function waitForApiClient(callback, attempt) {
        attempt = attempt || 0;
        if (window.ApiClient && typeof window.ApiClient.getPublicUsers === 'function') {
            callback();
            return;
        }
        if (attempt >= API_CLIENT_MAX_ATTEMPTS) {
            console.error('[JellyQuest] Jellyfin Web never initialized ApiClient -- giving up.');
            var root = document.getElementById('jellyquest-root');
            if (root) root.textContent = 'Unable to start -- Jellyfin did not finish loading.';
            return;
        }
        window.setTimeout(function () { waitForApiClient(callback, attempt + 1); }, API_CLIENT_POLL_MS);
    }

    window.JellyQuestFocus.ready(function () {
        loadConfiguration(); // fire-and-forget: Requests waits on it lazily, nothing else needs it

        var root = document.getElementById('jellyquest-root');
        if (!root) {
            root = document.createElement('div');
            root.id = 'jellyquest-root';
            document.body.appendChild(root);
        }

        waitForApiClient(function () {
            if (window.JellyQuestSession.getCurrentProfile()) {
                showShell(root);
            } else {
                showProfiles(root);
            }
        });
    });
})();
