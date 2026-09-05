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
        play: function (options) {
            options = options || {};
            if (!options.items && !options.serverId) {
                return Promise.reject(new Error('serverId required!'));
            }
            calls.push(options);
            playingVideo = true;
            return Promise.resolve();
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
        __endPlayback: function () { playingVideo = false; },
    };
})();
