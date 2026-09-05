// Detail/playback screen for Movie items -- see DETAIL_ACTIONS.md for
// the full intended behavior across movies/shows/sports. This first pass
// covers movies only (Resume/Play, Trailer, My List, and a conditional
// More menu for track selection); Series/Sports-specific behavior
// (seasons, episodes, highlights, chapters) is explicit follow-up work,
// not silently missing -- see docs/rebuild-plan.md's Phase 3 status.
//
// There's no dedicated "Back" control here: per DETAIL_ACTIONS.md, Left
// from the first action returns to the persistent rail (shell.js), which
// is reachable from every screen -- that's the way back, same as it is
// from Home, Search, and Library.
(function () {
    'use strict';

    // callbacks: { onPlay(item, startTicks) -> Promise, onPlayTrailer(item) -> Promise<boolean> }
    // onPlay rejects when playback could not be started at all.
    // Trailer lookup resolves false when no trailer exists, and rejects on failure.
    function renderDetail(container, item, callbacks) {
        container.innerHTML = '';
        container.className = 'jq-detail-screen';

        var heading = document.createElement('h1');
        heading.className = 'jq-detail-title';
        heading.textContent = item.Name + (item.ProductionYear ? ' (' + item.ProductionYear + ')' : '');
        container.appendChild(heading);

        if (item.Overview) {
            var overview = document.createElement('p');
            overview.className = 'jq-detail-overview';
            overview.textContent = item.Overview;
            container.appendChild(overview);
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

        if (item.LocalTrailerCount) {
            var trailerStatus = document.createElement('p');
            trailerStatus.className = 'jq-detail-error';
            trailerStatus.hidden = true;
            container.appendChild(trailerStatus);
            var trailerButton = document.createElement('button');
            trailerButton.className = 'jq-detail-action jq-focusable';
            trailerButton.textContent = 'Trailer';
            trailerButton.addEventListener('click', function () {
                trailerStatus.hidden = true;
                callbacks.onPlayTrailer(item).then(function (played) {
                    if (played) return;
                    trailerStatus.textContent = 'No trailer available.';
                    trailerStatus.hidden = false;
                }).catch(function (error) {
                    trailerStatus.textContent = 'Could not load trailer. Try again.';
                    trailerStatus.hidden = false;
                    console.error('[JellyQuest] Trailer lookup failed:', error);
                });
            });
            actions.appendChild(trailerButton);
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

        var configurable = hasConfigurableTracks(item);
        if (configurable) {
            var moreButton = document.createElement('button');
            moreButton.className = 'jq-detail-action jq-focusable';
            moreButton.textContent = 'More';
            actions.appendChild(moreButton);
            appendMoreMenu(container, item, moreButton);
        }

        window.JellyQuestFocus.focusFirst(container);
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
