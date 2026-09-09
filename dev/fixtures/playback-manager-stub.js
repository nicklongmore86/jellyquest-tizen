// A fake window.playbackManager modelling the PATCHED Jellyfin Web build --
// not a stock one. The pinned Jellyfin Web build does NOT expose this global:
// src/components/playback/playbackmanager.js only exports the singleton as a
// module export, and nothing assigns it to window. JellyQuest's build-time
// patch (scripts/patch-jellyfin-web.mjs) is what creates the global, so this
// stub stands in for that patch rather than for upstream behaviour. Records
// calls so tests can assert what was requested without actually playing video
// -- this project's Detail screen calls play() with the same shape the real
// playbackManager.play() expects.
(function () {
    'use strict';

    var calls = [];
    var playingVideo = false;
    var callbacks = {};
    var nextOutcome = null;
    var changingStream = false;
    // utils/events.ts:26-29,41-46: synchronous callbacks, event first,
    // snapshot iteration, no exception isolation.
    window.JellyQuestPlaybackEvents = function (type, callback) {
        (callbacks[type] || (callbacks[type] = [])).push(callback);
    };
    function emit(type, args) {
        (callbacks[type] || []).slice().forEach(function (callback) {
            callback.apply(window.playbackManager, [{ type: type }].concat(args || []));
        });
    }
    function start(mediaType) {
        playingVideo = mediaType === 'Video';
        // playbackmanager.js:3295 / 3326.
        emit('playbackstart', [{}, { NowPlayingItem: { MediaType: mediaType } }]);
    }
    function stop(nextItem) {
        // playbackmanager.js:3437-3439: stream replacement suppresses stop.
        if (changingStream) return;
        // Keep the old source during same-player queue handoff: manager
        // 3484-3490 retains that player; htmlMediaHelper.js:357-359 clears
        // _currentSrc, not plugin.js:331-332's private #currentSrc.
        emit('playbackstop', [{ nextItem: nextItem || null,
            nextMediaType: nextItem ? nextItem.MediaType : null }]);
        // Local video -> audio selects a different player: htmlVideoPlayer
        // plugin.js:1717-1718 accepts only Video; htmlAudioPlayer/plugin.js:
        // 400-401 accepts Audio. playbackmanager.js:3485-3489 removes the
        // old current player AFTER dispatch; 929-935,950 nulls it. Other
        // player-selection combinations remain unmodelled here.
        if (!nextItem || nextItem.MediaType === 'Audio') playingVideo = false;
    }

    window.playbackManager = {
        // Real: playbackmanager.js's self.play (playbackmanager.js:2086).
        // Its first act after normalizing options is to demand a source for
        // the queue -- `let { items } = options; if (!items) { if
        // (!options.serverId) { throw new Error('serverId required!'); } }`
        // (playbackmanager.js:2101-2105). Callers that pass only `ids` never
        // reach the player at all.
        //
        // That check is enforced here rather than assumed, because this stub
        // previously accepted ANY options object and resolved -- which let a
        // caller passing neither `items` nor `serverId` pass the whole e2e
        // suite while being dead on a real build. play() is declared `async`
        // upstream, so the throw surfaces to callers as a REJECTION; the
        // shapes match deliberately.
        //
        // Lifecycle below models the pinned manager's event arguments and
        // ordering, not codecs, OSD, timing, or upstream focus (unmodelled).
        play: function (options) {
            options = options || {};
            if (!options.items && !options.serverId) {
                return Promise.reject(new Error('serverId required!'));
            }
            calls.push(options);
            var outcome = nextOutcome;
            nextOutcome = null;
            // 2378-2383 swallows failure; 2300-2302 / 2347-2350 reject bare
            // with no lifecycle event. Explicit test controls, not guessed
            // mappings from media metadata to server/decoder failures.
            if (outcome === 'silent-resolve') return Promise.resolve();
            if (outcome === 'silent-reject') return Promise.reject();
            return Promise.resolve().then(function () { start('Video'); });
        },
        // Real: playbackmanager.js's self.playTrailers
        // (playbackmanager.js:3891-3925). Modelled here because Detail's
        // Trailer action now calls it instead of assembling a play() call
        // itself (app.js's onPlayTrailer).
        //
        // Two branches, and the difference between them is the whole reason
        // Detail's trailer gate is local-only:
        //
        //   LocalTrailerCount > 0 -- getLocalTrailers() returns real
        //   BaseItemDto trailer items, which go to play() as `items`.
        //
        //   the LOCAL LOOKUP CAME BACK EMPTY -- and this is the branch that
        //   matters, because it is NOT an else. Upstream's condition is
        //   `if (!items?.length)`, not `if (!item.LocalTrailerCount)`, so a
        //   stale LocalTrailerCount falls straight through to RemoteTrailers,
        //   which become Id-less pseudo-items carrying a Url and get
        //   dispatched by canPlayUrl to the YouTube IFrame plugin.
        //
        // This stub used to short-circuit on LocalTrailerCount and resolve
        // after play({ items: [] }) in BOTH cases, which made the two
        // outcomes indistinguishable and hid a real bug in app.js: JellyQuest
        // was handing over the full item, RemoteTrailers included, so an
        // empty local lookup silently reached the remote path. Same shape of
        // fixture-fidelity failure PR #20 and PR #22 fixed -- a stub more
        // permissive than the real thing. Transcribed from
        // playbackmanager.js:3898-3925 rather than paraphrased.
        //
        // With neither, it rejects with NO ARGUMENT (playbackmanager.js:3924)
        // -- reproduced exactly, so a caller that dereferences the rejection
        // value fails here rather than on the television.
        playTrailers: function (item) {
            var apiClient = window.ApiClient;
            var lookup = item.LocalTrailerCount
                ? apiClient.getLocalTrailers(apiClient.getCurrentUserId(), item.Id)
                : Promise.resolve(null);
            return lookup.then(function (items) {
                if (!items || !items.length) {
                    items = (item.RemoteTrailers || []).map(function (trailer) {
                        return {
                            Name: trailer.Name || (item.Name + ' Trailer'),
                            Url: trailer.Url,
                            MediaType: 'Video',
                            Type: 'Trailer',
                            ServerId: apiClient.serverId(),
                        };
                    });
                }
                if (items.length) return window.playbackManager.play({ items: items });
                return Promise.reject();
            });
        },
        // Real: playbackmanager.js's self.isPlayingVideo (via
        // isPlayingMediaType('Video')). app.js's Back handler asks this
        // before deciding whether to consume the key or leave it to
        // jellyfin-web, whose video view stops playback when it is
        // navigated away from.
        isPlayingVideo: function () {
            return playingVideo;
        },
        // Test-only inspection hooks -- not part of the real playbackManager
        // API, so screens must never call these themselves.
        __calls: calls,
        __endPlayback: function () { stop(null); },
        __start: start,
        __stop: stop,
        __cancel: function () {
            // 2386-2394: destroy/remove then cancel, no stop.
            playingVideo = false;
            emit('playbackcancelled');
        },
        __error: function () {
            // 3429-3431: error THEN onPlaybackStopped (including suppression).
            emit('playbackerror', ['test-error']);
            stop(null);
        },
        __changingStream: function (value) { changingStream = value; },
        __nextOutcome: function (value) { nextOutcome = value; },
        // Deliberate fault injection for missing signals / stale accessors;
        // NOT a claim that upstream always clears currentSrc on a failure.
        __setPlayingVideo: function (value) { playingVideo = value; },
        __subscriptions: callbacks,
    };
    if (window.JellyQuestBindPlayback) window.JellyQuestBindPlayback();
})();
