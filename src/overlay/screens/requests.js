// Requests screen: search Jellyseerr (through JellyPass's request bridge,
// see requests-bridge.js) and either request a title Jellyseerr doesn't
// have yet, or claim access to one that's already available in the
// library. Movie-only for this pass, matching Detail's scope (see
// docs/rebuild-plan.md, Phase 3) -- TV/season-aware requesting is
// explicit follow-up work, not silently missing.
//
// Household visibility is intentionally simple: any household member can
// request or claim independently, and a title someone else in the same
// household already requested just shows as "Requested" -- nobody's name
// is attached, and nothing here restricts a *different* household from
// independently requesting or claiming the same title (JellyPass tracks
// claims per Jellyfin user, not per household). See docs/rebuild-plan.md's
// Phase 4 notes.
(function () {
    'use strict';

    var DEBOUNCE_MS = 300;
    // Jellyseerr's MediaInfo.status enum (unknown/pending/processing/
    // partially_available/available) -- only the "has this been asked
    // for" and "is this watchable" buckets matter here, not each stage.
    var STATUS_REQUESTED = [2, 3];
    var STATUS_AVAILABLE = [4, 5];

    // config: { bridgeUrl, userId, userName, configurationFailed,
    // focusAtRequest, onRetryConfiguration }
    function renderRequests(container, config) {
        container.innerHTML = '';
        container.className = 'jq-requests-screen';

        var status = document.createElement('p');
        status.className = 'jq-requests-status';
        container.appendChild(status);
        window.JellyQuestFocus.focusFirst(container, config.focusAtRequest);

        if (config.configurationFailed) {
            status.textContent = 'Could not load Requests configuration. Try again.';
            var retry = document.createElement('button');
            retry.className = 'jq-requests-retry jq-focusable';
            retry.textContent = 'Retry';
            retry.addEventListener('click', config.onRetryConfiguration);
            container.appendChild(retry);
            window.JellyQuestFocus.focusFirst(container, config.focusAtRequest);
            return;
        }

        if (!config.bridgeUrl) {
            status.textContent = 'Requests are not configured for this server.';
            return;
        }

        var bridge = window.JellyQuestRequestsBridge;
        status.textContent = 'Checking Requests for this profile…';

        // What focusFirst()'s guard (focus.js) compares against when
        // renderSearch's focus call lands, two bridge round trips from now,
        // was captured by app.js before configuration loading began.
        //
        // The comparison is element IDENTITY, not causation: if a DIFFERENT
        // visible element holds focus by then, this render's autofocus is
        // suppressed. That stands in for "the user moved on", and only
        // stands in -- focus that leaves the captured element and returns to
        // it is indistinguishable from focus that never moved, and an
        // application-driven move (a modal opening, a navigation elsewhere)
        // reads exactly like a remote key press. Those are limitations of
        // the shared guard, not of this value, and they are worth what they
        // cost here; nothing in this file can strengthen them. Keeping the
        // outer value also means a rail move during configuration loading is
        // not erased when this downstream render begins.
        var focusAtRequest = config.focusAtRequest;

        bridge.checkEligibility(config.bridgeUrl, config.userId, config.userName).then(function (eligible) {
            if (!eligible) {
                status.textContent = 'Requests are not available for this profile.';
                return;
            }
            return bridge.openSession(config.bridgeUrl, config.userId, config.userName).then(function () {
                renderSearch(container, status, focusAtRequest);
            });
        }).catch(function (error) {
            status.textContent = 'Requests are unavailable right now.';
            console.error('[JellyQuest] Requests bridge error:', error);
        });
    }

    function renderSearch(container, status, focusAtRequest) {
        status.hidden = true;

        var input = document.createElement('input');
        input.type = 'search';
        input.className = 'jq-search-input jq-requests-input jq-focusable';
        input.placeholder = 'Search movies to request';
        input.setAttribute('data-jq-autofocus', '');
        container.appendChild(input);

        var results = document.createElement('div');
        results.className = 'jq-row jq-requests-results';
        container.appendChild(results);

        var empty = document.createElement('p');
        empty.className = 'jq-requests-empty';
        empty.textContent = 'No matches.';
        empty.hidden = true;
        container.appendChild(empty);

        var timer = null;
        var searchId = 0;
        input.addEventListener('input', function () {
            searchId += 1;
            window.clearTimeout(timer);
            timer = window.setTimeout(function () { runSearch(input.value); }, DEBOUNCE_MS);
        });

        function runSearch(term) {
            var currentSearchId = searchId;
            results.innerHTML = '';
            empty.hidden = true;
            status.hidden = true;
            if (!term.trim()) return;
            window.JellyQuestRequestsBridge.call('/api/v1/search?query=' + encodeURIComponent(term)).then(function (data) {
                if (currentSearchId !== searchId || input.value !== term) return; // a newer search superseded this one
                status.hidden = true;
                empty.hidden = true;
                var movies = (data.results || []).filter(function (item) { return item.mediaType === 'movie'; });
                if (!movies.length) {
                    empty.hidden = false;
                    return;
                }
                movies.forEach(function (movie) { results.appendChild(createRequestCard(movie)); });
            }).catch(function (error) {
                if (currentSearchId !== searchId || input.value !== term) return;
                status.textContent = 'Search failed. Try again.';
                status.hidden = false;
                console.error('[JellyQuest] Requests search failed:', error);
            });
        }

        window.JellyQuestFocus.focusFirst(container, focusAtRequest);
    }

    function createRequestCard(movie) {
        var card = document.createElement('div');
        card.className = 'jq-card jq-request-card';
        card.setAttribute('data-tmdb-id', String(movie.id));

        var title = document.createElement('span');
        title.className = 'jq-request-card-title';
        title.textContent = movie.title;
        card.appendChild(title);

        if (movie.releaseDate) {
            var year = document.createElement('small');
            year.className = 'jq-request-card-meta';
            year.textContent = movie.releaseDate.slice(0, 4);
            card.appendChild(year);
        }

        renderAction(card, movie);
        return card;
    }

    function movieState(movie) {
        var status = movie.mediaInfo && movie.mediaInfo.status;
        if (status && STATUS_AVAILABLE.indexOf(status) !== -1) return 'available';
        if (status && STATUS_REQUESTED.indexOf(status) !== -1) return 'requested';
        return 'none';
    }

    function renderAction(card, movie) {
        var existing = card.querySelector('.jq-request-card-action');
        if (existing) existing.remove();

        var state = movieState(movie);
        if (state === 'requested') {
            appendLabel(card, 'Requested');
            return;
        }
        if (state === 'none') {
            appendButton(card, 'Request', function (button) {
                button.disabled = true;
                window.JellyQuestRequestsBridge.call('/api/v1/request', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mediaType: 'movie', mediaId: movie.id })
                }).then(function () {
                    movie.mediaInfo = movie.mediaInfo || {};
                    movie.mediaInfo.status = 2;
                    renderAction(card, movie);
                }).catch(function (error) {
                    button.disabled = false;
                    showActionError(card, 'Request failed. Try again.');
                    console.error('[JellyQuest] Request failed:', error);
                });
            });
            return;
        }

        // Available -- resolve this profile's own claim before offering
        // to claim it again. Cached on the item once claimed so
        // re-rendering after a click doesn't need another round trip.
        if (movie.__claimed) {
            appendLabel(card, 'In My Library');
            return;
        }
        var checking = appendLabel(card, 'Checking…');
        window.JellyQuestRequestsBridge.call('/jellyquest/access?mediaType=movie&tmdbId=' + movie.id).then(function (access) {
            checking.remove();
            if (access.claimed) {
                movie.__claimed = true;
                appendLabel(card, 'In My Library');
                return;
            }
            appendButton(card, 'Add to My Library', function (button) {
                button.disabled = true;
                window.JellyQuestRequestsBridge.call('/jellyquest/access', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mediaType: 'movie', tmdbId: movie.id })
                }).then(function () {
                    movie.__claimed = true;
                    renderAction(card, movie);
                }).catch(function (error) {
                    button.disabled = false;
                    showActionError(card, 'Could not add to My Library. Try again.');
                    console.error('[JellyQuest] Claim failed:', error);
                });
            });
        }).catch(function (error) {
            checking.textContent = 'Unavailable';
            console.error('[JellyQuest] Access check failed:', error);
        });
    }

    function showActionError(card, text) {
        var error = document.createElement('p');
        error.className = 'jq-request-card-error';
        error.textContent = text;
        card.appendChild(error);
    }

    function appendLabel(card, text) {
        var label = document.createElement('span');
        label.className = 'jq-request-card-action jq-request-card-label';
        label.textContent = text;
        card.appendChild(label);
        return label;
    }

    function appendButton(card, text, onClick) {
        var button = document.createElement('button');
        button.className = 'jq-request-card-action jq-focusable';
        button.textContent = text;
        button.addEventListener('click', function () {
            var error = card.querySelector('.jq-request-card-error');
            if (error) error.remove();
            onClick(button);
        });
        card.appendChild(button);
        return button;
    }

    window.JellyQuestRequestsScreen = {
        render: renderRequests
    };
})();
