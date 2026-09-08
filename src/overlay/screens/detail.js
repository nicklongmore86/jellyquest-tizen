// Detail/playback screen for individually playable Movie and Episode items.
// See DETAIL_ACTIONS.md for the broader intended behavior. Series have their
// own route seam in series.js; show browsing and Sports-specific behavior
// remain explicit follow-up work.
//
// There's no dedicated "Back" control here: per DETAIL_ACTIONS.md, Left
// from the first action returns to the persistent rail (shell.js), which
// is reachable from every screen -- that's the way back, same as it is
// from Home, Search, and Library.
//
// ---- Why this screen fetches the item again -----------------------------
//
// Everything that reaches renderDetail() arrived from an
// ApiClient.getItems() LIST query (Home, Library, Search), and a list
// response is NOT a full BaseItemDto. Measured against the household's
// Jellyfin 10.11.11 server, the app's own library query returns Name, Id,
// ServerId, Type, IsFolder, HasSubtitles, Container, PremiereDate,
// CriticRating, OfficialRating, CommunityRating, RunTimeTicks,
// ProductionYear, UserData, VideoType, ImageTags, BackdropImageTags,
// ImageBlurHashes, LocationType and MediaType -- and does NOT return
// Overview, LocalTrailerCount, MediaStreams or MediaSources. This screen
// used to read those three straight off the list item, so on the real
// television it has never shown a synopsis and never shown a Trailer
// button. Only dev/fixtures/api-client-stub.js made it look otherwise, by
// returning fields the server does not.
//
// Widening the LIST query with Fields= is the wrong fix: measured, adding
// Fields= to the 50-item library query takes the response from 61,669 to
// 324,398 bytes (+426%), and the cost is paid on every grid paint. A single
// GET /Users/{id}/Items/{itemId} with NO Fields parameter is 17,153 bytes
// and already carries Overview, MediaStreams, LocalTrailerCount and
// RemoteTrailers. So the full item is fetched here, once, on demand.
//
// The fetch happens AFTER a synchronous first paint, never before it. The
// household's TV is on a remote network; blocking the first paint on a
// network round trip would show a blank screen for as long as the server
// takes. Title, Resume/Play, Start Over and My List all come from fields
// the list item already has, so they paint immediately and the synopsis
// and Trailer button are PATCHED in when the response lands. The patch
// deliberately does not re-render and does not re-focus: focus was placed
// at first paint and the user may already have moved it.
(function () {
    'use strict';

    // The More menu is built (hasConfigurableTracks/appendMoreMenu below)
    // but NOT rendered, deliberately.
    //
    // Track selection has never actually been implemented: appendMoreMenu()
    // creates each audio/subtitle choice as a bare <button> with no event
    // listener of any kind, nothing stores a selection, and app.js's onPlay
    // sends only { ids, startPositionTicks, serverId }. The existing spec
    // asserted labels and focus containment, never an effect, which is why
    // that never showed up as a failure.
    //
    // It has also never been reachable on a television, because MediaStreams
    // is absent from list responses (see the header comment) and this screen
    // only ever saw list items. Enriching from getItem() is the first change
    // that COULD make the button appear -- and it would be a genuinely dead
    // control the first time the user ever sees it. So it stays off until a
    // follow-up wires selection through to playback. Do not flip this flag
    // without that work.
    var TRACK_SELECTION_ENABLED = false;

    // callbacks: { onPlay(item, startTicks) -> Promise, onPlayTrailer(item) -> Promise }
    // Both reject when the request could not be carried out. Neither
    // rejection may be dereferenced: jellyfin-web rejects with NO argument in
    // nine places in the pinned build, several of them reachable through
    // these two calls (see app.js's onPlayTrailer).
    function renderDetail(container, item, callbacks) {
        container.innerHTML = '';
        container.className = 'jq-detail-screen';

        var episodeText = item.Type === 'Episode'
            ? window.JellyQuestCards.textFor(item, 'browse')
            : null;
        var heading = document.createElement('h1');
        heading.className = 'jq-detail-title';
        heading.textContent = episodeText
            ? episodeText.title
            : item.Name + (item.ProductionYear ? ' (' + item.ProductionYear + ')' : '');
        container.appendChild(heading);

        if (episodeText && episodeText.meta) {
            var episodeContext = document.createElement('p');
            episodeContext.className = 'jq-detail-context';
            episodeContext.textContent = episodeText.meta;
            container.appendChild(episodeContext);
        }

        var actions = document.createElement('div');
        actions.className = 'jq-row jq-detail-actions';
        container.appendChild(actions);

        // JellyQuest has no player screen of its own -- playback is handed
        // whole to jellyfin-web -- so a play() that never starts leaves this
        // screen looking exactly as it did before the press. On a TV with no
        // console that is indistinguishable from a dead remote, so say so,
        // the same way the Trailer and My List actions below already do.
        var playError = document.createElement('p');
        playError.className = 'jq-detail-error';
        playError.hidden = true;
        container.appendChild(playError);

        function requestPlay(startPositionTicks) {
            playError.hidden = true;
            Promise.resolve(callbacks.onPlay(item, startPositionTicks)).catch(function (error) {
                playError.textContent = 'Could not start playback. Try again.';
                playError.hidden = false;
                console.error('[JellyQuest] Playback failed:', error);
            });
        }

        var resumable = item.UserData && item.UserData.PlaybackPositionTicks > 0;
        var playButton = document.createElement('button');
        playButton.className = 'jq-detail-action jq-focusable';
        playButton.setAttribute('data-jq-autofocus', '');
        playButton.textContent = resumable ? 'Resume' : 'Play';
        playButton.addEventListener('click', function () {
            requestPlay(resumable ? item.UserData.PlaybackPositionTicks : 0);
        });
        actions.appendChild(playButton);

        if (resumable) {
            var startOverButton = document.createElement('button');
            startOverButton.className = 'jq-detail-action jq-focusable';
            startOverButton.textContent = 'Start Over';
            startOverButton.addEventListener('click', function () { requestPlay(0); });
            actions.appendChild(startOverButton);
        }

        var favoriteButton = document.createElement('button');
        favoriteButton.className = 'jq-detail-action jq-focusable jq-my-list-action';
        var isFavorite = Boolean(item.UserData && item.UserData.IsFavorite);
        favoriteButton.textContent = isFavorite ? 'Remove from My List' : 'Add to My List';
        var favoriteError = document.createElement('p');
        favoriteError.className = 'jq-detail-error';
        favoriteError.hidden = true;
        container.appendChild(favoriteError);
        favoriteButton.addEventListener('click', function () {
            favoriteError.hidden = true;
            var userId = window.ApiClient.getCurrentUserId();
            var next = !isFavorite;
            window.ApiClient.updateFavoriteStatus(userId, item.Id, next).then(function () {
                isFavorite = next;
                favoriteButton.textContent = isFavorite ? 'Remove from My List' : 'Add to My List';
            }).catch(function (error) {
                favoriteError.textContent = 'Could not update My List. Try again.';
                favoriteError.hidden = false;
                console.error('[JellyQuest] My List update failed:', error);
            });
        });
        actions.appendChild(favoriteButton);

        // The TV has no console, so a failed enrichment has to say so on
        // screen -- and say what still works, because Play and My List do.
        var detailsError = document.createElement('p');
        detailsError.className = 'jq-detail-error jq-detail-enrich-error';
        detailsError.hidden = true;
        container.appendChild(detailsError);

        window.JellyQuestFocus.focusFirst(container);

        // ---- Enrichment ------------------------------------------------
        //
        // Staleness guard: JellyQuestShell.getContent() hands back the SAME
        // <main> node for every screen (shell.js:55,66), so a render counter
        // cannot tell a re-entrant showDetail() for the same item apart from
        // this one. What can is node identity: `heading` is a node THIS
        // render created and appended, and any later render clears the
        // container, which detaches it. Same idiom as app.js's Requests
        // loading check (`if (loading.parentNode !== container) return;`).
        function isCurrentRender() {
            return heading.parentNode === container;
        }

        function showDetailsUnavailable(error) {
            detailsError.textContent = 'Could not load details. Play and My List still work.';
            detailsError.hidden = false;
            console.error('[JellyQuest] Item details failed to load:', error);
        }

        function applyFullItem(full) {
            if (full.Overview) {
                var overview = document.createElement('p');
                overview.className = 'jq-detail-overview';
                overview.textContent = full.Overview;
                // Patch, don't rebuild: inserting in place keeps
                // document.activeElement, the action row's node identity and
                // any error paragraph an in-flight play() failure already
                // painted. Re-rendering would throw all three away.
                container.insertBefore(overview, actions);
            }

            // LOCAL trailers only -- deliberately NARROWER than upstream
            // jellyfin-web, which also offers a trailer for RemoteTrailers
            // alone (controllers/itemDetails/index.js:502 gates on
            // `LocalTrailerCount || RemoteTrailers?.length`), and narrower
            // than DETAIL_ACTIONS.md described before this change.
            //
            // Reason: jellyfin-web plays a RemoteTrailer IN-APP through a
            // YouTube IFrame embed -- playbackmanager.js:3891-3925 builds an
            // Id-less pseudo-item and dispatches on canPlayUrl, handled by
            // plugins/youtubePlayer/plugin.js:251-253, registered in
            // www/config.json. MEASURED: the packaged app is loaded from a
            // `file://` URL on both of the household's sets (README.md:52),
            // which gives it a null origin. INFERRED, and NOT settleable
            // without the television: the YouTube IFrame API handshake is
            // origin-governed and the plugin's own error table already
            // includes 101/150 YoutubeDenied, so a null origin is expected to
            // be refused. Second unresolved unknown, also INFERRED: the
            // youtube container sits at z-index 1000, far under
            // #jellyquest-root's 2147483000 (app.css), so even a working
            // embed would be expected to play behind the overlay.
            //
            // So a film with only RemoteTrailers gets NO Trailer button
            // rather than a button that probably does nothing visible. Do
            // not "fix" this back to the upstream gate on inference alone --
            // it needs a measurement on real hardware first.
            var hasTrailer = full.LocalTrailerCount > 0;
            if (hasTrailer) appendTrailerAction(full);

            // Deliberately not rendered -- see TRACK_SELECTION_ENABLED.
            if (TRACK_SELECTION_ENABLED && hasConfigurableTracks(full)) {
                var moreButton = document.createElement('button');
                moreButton.className = 'jq-detail-action jq-focusable';
                moreButton.textContent = 'More';
                actions.appendChild(moreButton);
                appendMoreMenu(container, full, moreButton);
            }
        }

        function appendTrailerAction(full) {
            var trailerStatus = document.createElement('p');
            trailerStatus.className = 'jq-detail-error';
            trailerStatus.hidden = true;
            container.appendChild(trailerStatus);

            var trailerButton = document.createElement('button');
            trailerButton.className = 'jq-detail-action jq-focusable';
            trailerButton.textContent = 'Trailer';
            trailerButton.addEventListener('click', function () {
                trailerStatus.hidden = true;
                // The FULL item is what goes to playback: playTrailers()
                // reads LocalTrailerCount and ServerId off it, and the list
                // item carries neither.
                // ONE message, and it deliberately does not name a cause.
                // This used to show "No trailer available." for a bare
                // rejection and a failure message otherwise, on the reading
                // that playbackmanager.js:3924 uniquely means "nothing to
                // play". MEASURED: it does not. The pinned build rejects with
                // no argument in nine places, and playInternal() alone
                // reaches two of them from inside this call
                // (PlaybackErrorPlaceHolder at playbackmanager.js:2348-2351,
                // NO_MEDIA_ERROR at 2301-2302). A confident cause we cannot
                // substantiate is worse on a TV than an honest one we can.
                Promise.resolve(callbacks.onPlayTrailer(full)).catch(function (error) {
                    trailerStatus.textContent = 'Could not play the trailer. Try again.';
                    trailerStatus.hidden = false;
                    // Logged, never read: the rejection value is routinely
                    // undefined.
                    console.error('[JellyQuest] Trailer playback failed:', error);
                });
            });
            // Keep the documented action order (Resume, Start Over, Trailer,
            // My List) by inserting rather than appending -- My List is
            // already on the row from the first paint.
            actions.insertBefore(trailerButton, favoriteButton);
        }

        var apiClient = window.ApiClient;
        if (!apiClient || typeof apiClient.getItem !== 'function') {
            showDetailsUnavailable(new Error('ApiClient.getItem is unavailable'));
            return;
        }
        var currentUserId = typeof apiClient.getCurrentUserId === 'function' ? apiClient.getCurrentUserId() : null;
        Promise.resolve(apiClient.getItem(currentUserId, item.Id)).then(function (full) {
            if (!isCurrentRender()) return; // navigated away, or re-entered for another item
            applyFullItem(full || {});
        }).catch(function (error) {
            if (!isCurrentRender()) return;
            showDetailsUnavailable(error);
        });
    }

    function hasConfigurableTracks(item) {
        var streams = item.MediaStreams || [];
        var audioCount = streams.filter(function (stream) { return stream.Type === 'Audio'; }).length;
        var subtitleCount = streams.filter(function (stream) { return stream.Type === 'Subtitle'; }).length;
        return audioCount > 1 || subtitleCount > 0;
    }

    function appendMoreMenu(container, item, moreButton) {
        var streams = item.MediaStreams || [];
        var audioTracks = streams.filter(function (stream) { return stream.Type === 'Audio'; });
        var subtitleTracks = streams.filter(function (stream) { return stream.Type === 'Subtitle'; });

        var backdrop = document.createElement('div');
        backdrop.className = 'jq-modal-backdrop';
        backdrop.hidden = true;

        var modal = document.createElement('div');
        modal.className = 'jq-modal jq-focusable jq-playback-options';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-label', 'Playback Options');
        backdrop.appendChild(modal);
        container.appendChild(backdrop);

        var heading = document.createElement('h2');
        heading.textContent = 'Playback Options';
        modal.appendChild(heading);

        if (audioTracks.length > 1) {
            modal.appendChild(optionGroup('Audio', audioTracks.map(function (track) { return track.DisplayTitle; })));
        }
        if (subtitleTracks.length > 0) {
            modal.appendChild(optionGroup('Subtitles', ['Off'].concat(subtitleTracks.map(function (track) { return track.DisplayTitle; }))));
        }

        var closeButton = document.createElement('button');
        closeButton.className = 'jq-modal-option jq-focusable';
        closeButton.textContent = 'Close';
        closeButton.addEventListener('click', close);
        modal.appendChild(closeButton);

        moreButton.addEventListener('click', function () {
            backdrop.hidden = false;
            window.JellyQuestFocus.openModal(modal, close);
        });

        function close() {
            backdrop.hidden = true;
            window.JellyQuestFocus.closeModal(modal, moreButton);
        }
    }

    function optionGroup(label, options) {
        var group = document.createElement('div');
        group.className = 'jq-playback-option-group';
        var groupLabel = document.createElement('h3');
        groupLabel.textContent = label;
        group.appendChild(groupLabel);
        options.forEach(function (text) {
            var option = document.createElement('button');
            option.className = 'jq-modal-option jq-focusable';
            option.textContent = text;
            group.appendChild(option);
        });
        return group;
    }

    window.JellyQuestDetailScreen = {
        render: renderDetail
    };
})();
