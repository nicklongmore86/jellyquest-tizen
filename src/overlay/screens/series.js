// Series browse screen: a season dropdown plus the selected season's episode
// list. Replaces the inert S3 seam (PR #31), which rendered a title, a Back
// button and "Series browsing is not available yet."
//
// A Series is not itself playable. Its Resume / Continue / Restart Episode
// actions resolve to concrete Episodes, while selecting an episode still
// routes to the Detail screen (household decision 5 -- instant play would
// save one press but lose Start Over, My List and any future track choice).
//
// ---- Why a dropdown rather than a row of season posters ----------------
//
// Household decision 6: the household's shows average under four seasons
// (34 series / 129 seasons on the measured server), so a poster row would
// spend a whole screen band, and an extra press, on a choice that is usually
// between two or three things.
//
// ---- Why every episode ordering here is CLIENT-SIDE --------------------
//
// MEASURED against the household's Jellyfin 10.11.11 server:
// GET /Shows/{id}/Episodes ACCEPTS AND SILENTLY IGNORES `Filters`,
// `SortBy` and `SortOrder`. Probed on a 73-episode series,
// Filters=IsResumable&SortBy=DatePlayed returned all 73 records, unfiltered
// and unsorted, with the played episodes still sitting at positions 38, 56
// and 73. So a request that asks the server to order or filter episodes
// LOOKS like it works and is wrong. This screen therefore sends neither
// option and sorts the response itself (orderEpisodes below).
//
// `Limit` IS honoured (TotalRecordCount stays pre-Limit), but this screen
// does not page: a partial page cannot select the most recent resumable
// episode or its successor correctly when ordering is ours to do, so the
// series is fetched whole and the MOUNTING is what gets bounded below.
//
// IsMissing:false and IsVirtualUnaired:false are always sent. MEASURED: PAW
// Patrol carries 129 VIRTUAL episode records on top of its 346 real ones, so
// a naive fetch returns 475.
(function () {
    'use strict';

    // ---- Why this windows, and why it does not reuse library.js's ------
    //
    // The vendored spatial-navigation polyfill sweeps every candidate on
    // every arrow press, so per-keypress cost scales with MOUNTED cards, not
    // fetched items. MEASURED for PR #24 under 20x CPU throttling on desktop
    // Chromium (an OPTIMISTIC lower bound for a 2019 M63 television, not a
    // measurement of one): 48 mounted cards = 48.0ms median / 91.3ms worst;
    // 200 cards = 75-124ms, already past a 100ms budget; 680 = 249-384ms.
    //
    // These are library.js's constants, deliberately, so the measured 48-card
    // figure above describes this screen too.
    //
    // library.js's renderWindowedGrid() is NOT reused, and the reason is not
    // that the numbers differ. It is inseparable from its PAGING -- fetchPage,
    // appendPage, the id dedup, the exhaustion heuristics, the prefetch
    // trigger and the "a landed page must re-run the forward window test"
    // fix -- none of which an episode list can have, because ordering the
    // response is this screen's job and a partial page cannot be ordered
    // correctly. It is also not exported; JellyQuestLibraryScreen publishes
    // render() alone, and pulling the window core out of the screen with the
    // repo's most delicate documented invariants, for a caller that needs
    // none of its paging, is a refactor this task did not ask for.
    //
    // WHAT THAT COSTS, stated plainly: the window arithmetic below now exists
    // in two files and has to be kept in step by hand. The INVARIANT comment
    // in library.js is the authority; the one in mountEpisodes() restates the
    // same arithmetic for the same constants.
    //
    // Season partitioning is what makes the mount bound generous in practice
    // -- this screen mounts one season, never a whole series -- but it is not
    // itself a bound. The measured 346/13 aggregate for PAW Patrol says
    // nothing about how episodes distribute across seasons (the fixture's own
    // per-season split is INFERRED, not probed), and a single-season show of
    // several hundred episodes is a shape nobody has ruled out. The window is
    // the guard for that case.
    var COLUMNS = 4;
    var WINDOW_SIZE = 48;
    var EDGE_ROWS = 2;

    // callbacks: {
    //   onBack(), onSelectItem(episode), onPlay(episode, startTicks) -> Promise,
    //   initialEpisodes, onEpisodesLoaded(orderedEpisodes),
    //   initialSeasonId  -- the season to open on, so returning from an
    //                       episode's Detail page comes back to the season
    //                       the viewer was actually in,
    //   onSeasonChange(seasonId) -- reports that back to app.js
    // }
    function renderSeries(container, item, callbacks) {
        container.innerHTML = '';
        container.className = 'jq-series-screen';

        var heading = document.createElement('h1');
        heading.className = 'jq-detail-title jq-series-title';
        heading.textContent = item && item.Name ? item.Name : 'Series';
        container.appendChild(heading);

        // Back stays immediately below the title, where the S3 seam put it:
        // besides making the exit prominent, it places a focusable control
        // alongside the persistent rail, so ArrowLeft has a visible rail
        // candidate from the top of the screen.
        var back = document.createElement('button');
        back.className = 'jq-back-button jq-focusable';
        back.textContent = '< Back';
        back.setAttribute('data-jq-autofocus', '');
        back.addEventListener('click', callbacks.onBack);
        container.appendChild(back);

        var actions = document.createElement('div');
        actions.className = 'jq-row jq-detail-actions jq-series-actions';
        container.appendChild(actions);

        var playError = document.createElement('p');
        playError.className = 'jq-detail-error jq-series-play-error';
        playError.hidden = true;
        container.appendChild(playError);

        var controls = document.createElement('div');
        controls.className = 'jq-series-controls';
        container.appendChild(controls);

        // The televisions have no console (PR #18 made ten silent failures
        // visible for exactly this reason), so every load, empty and failure
        // state on this screen is a paragraph on screen, not a log line.
        var status = document.createElement('p');
        status.className = 'jq-series-status';
        container.appendChild(status);

        var grid = document.createElement('div');
        grid.className = 'jq-grid jq-series-episodes';
        grid.style.gridTemplateColumns = 'repeat(' + COLUMNS + ', 220px)';
        container.appendChild(grid);

        var seasonButton = null;
        var seasons = [];
        var currentSeasonId = null;
        var allEpisodes = null;
        // Guards a late whole-series response against a retry.
        var episodeRequest = 0;
        // Replaced wholesale by each mountEpisodes(); the grid's own focus
        // listener is registered once, below, and dispatches into whatever
        // window is current, so changing season cannot leak listeners.
        var episodeWindow = null;
        // Assigned by buildSeasonControl(), which closes over the option
        // nodes; null until the season list has actually arrived.
        var markCurrentSeason = null;

        setStatus('Loading seasons…', false);

        // Focus is placed for this render BEFORE anything is awaited, so the
        // remote is live immediately and the anchor below means something.
        window.JellyQuestFocus.focusFirst(container);
        // FOCUS ANCHOR. Captured AFTER this render has finished placing focus
        // and STRICTLY BEFORE the first await -- the shape six shipped
        // focus-steal bugs (PRs #17/#24/#26/#27/#28) all had wrong. Capturing
        // it any earlier is provably wrong: that was tried in PR #27 and
        // regressed the retry path. focusFirst() compares it against
        // document.activeElement when the response lands, so a cursor the
        // viewer moved while the request was in flight is newer intent and
        // wins.
        var focusAtRequest = document.activeElement;

        // Node identity, not a render counter: JellyQuestShell.getContent()
        // hands back the SAME <main> for every screen, so only a node this
        // render created can tell "still mine" from "a later render replaced
        // me". Same idiom as detail.js.
        function isCurrentRender() {
            return heading.parentNode === container;
        }

        function setStatus(text, isError) {
            status.textContent = text;
            status.hidden = false;
            if (isError) status.className = 'jq-series-status jq-series-status-error';
            else status.className = 'jq-series-status';
        }

        function clearStatus() {
            status.hidden = true;
            status.textContent = '';
        }

        var apiClient = window.ApiClient;
        if (!apiClient || typeof apiClient.getSeasons !== 'function'
            || typeof apiClient.getEpisodes !== 'function') {
            // Nothing has been awaited, so focus is still where this render
            // put it and there is no anchor decision to make.
            setStatus('Shows are unavailable right now. Try again.', true);
            console.error('[JellyQuest] ApiClient show endpoints are unavailable.');
            return;
        }
        var userId = typeof apiClient.getCurrentUserId === 'function' ? apiClient.getCurrentUserId() : null;

        // Promise.resolve().then(call) rather than
        // Promise.resolve(call()): a SYNCHRONOUS throw out of the client --
        // an unknown series id is one, in dev/fixtures/api-client-stub.js and
        // plausibly in the real client's argument handling -- would otherwise
        // escape this chain entirely, leaving the screen on 'Loading seasons…'
        // forever with the failure only in a console the television does not
        // have. Inside the callback it becomes a rejection and reaches the
        // visible catch below. Same shape for the episode request.
        Promise.resolve().then(function () {
            return apiClient.getSeasons(item.Id, { UserId: userId });
        }).then(function (result) {
            if (!isCurrentRender()) return; // navigated away, or re-entered
            seasons = (result && result.Items) || [];
            if (!seasons.length) {
                // A real library state, not an edge case to skip: MEASURED,
                // the household's NHL series has zero seasons and zero
                // episodes. No episode request is made for it.
                setStatus('No episodes are available for this show yet.', false);
                window.JellyQuestFocus.focusFirst(container, focusAtRequest);
                return;
            }
            var selectedSeason = initialSeason(seasons);
            currentSeasonId = selectedSeason.Id;
            buildSeasonControl(seasons, selectedSeason);
            var cachedEpisodes = callbacks.initialEpisodes;
            var cacheMatches = Array.isArray(cachedEpisodes) && cachedEpisodes.every(function (episode) {
                return episode.SeriesId === item.Id;
            });
            if (cacheMatches) {
                allEpisodes = callbacks.initialEpisodes;
                var cachedToken = episodeRequest;
                prepareEpisodes(focusAtRequest, cachedToken).catch(function (error) {
                    showEpisodeFailure(error, focusAtRequest, cachedToken, 'Cached Series episodes failed:');
                });
            } else {
                loadEpisodes(focusAtRequest);
            }
        }).catch(function (error) {
            if (!isCurrentRender()) return;
            setStatus('Couldn’t load this show’s seasons. Try again.', true);
            window.JellyQuestFocus.focusFirst(container, focusAtRequest);
            console.error('[JellyQuest] Series seasons failed:', error);
        });

        function initialSeason(seasons) {
            var index;
            for (index = 0; index < seasons.length; index++) {
                if (seasons[index].Id === callbacks.initialSeasonId) return seasons[index];
            }
            return seasons[0];
        }

        function seasonLabel(season) {
            if (season.Name) return season.Name;
            if (typeof season.IndexNumber === 'number') return 'Season ' + season.IndexNumber;
            return 'Season';
        }

        function buildSeasonControl(seasons, selectedSeason) {
            seasonButton = document.createElement('button');
            seasonButton.className = 'jq-series-season-button jq-focusable';
            seasonButton.setAttribute('aria-haspopup', 'true');
            // Establish the retry control's label before episode loading. The
            // fetch failure path never reaches selectSeasonById().
            seasonButton.textContent = seasonLabel(selectedSeason) + ' ▾';
            controls.appendChild(seasonButton);
            // This remains the autofocus target when the show has no
            // playback action. renderActions() moves it to Resume/Continue
            // when one exists. There must only ever be one marker.
            back.removeAttribute('data-jq-autofocus');
            seasonButton.setAttribute('data-jq-autofocus', '');

            var backdrop = document.createElement('div');
            backdrop.className = 'jq-modal-backdrop jq-series-season-backdrop';
            backdrop.hidden = true;

            var menu = document.createElement('div');
            menu.className = 'jq-modal jq-series-season-menu';
            menu.setAttribute('role', 'dialog');
            menu.setAttribute('aria-label', 'Choose a season');
            backdrop.appendChild(menu);

            var menuHeading = document.createElement('h2');
            menuHeading.textContent = 'Seasons';
            menu.appendChild(menuHeading);

            var options = [];
            seasons.forEach(function (season) {
                var option = document.createElement('button');
                option.className = 'jq-modal-option jq-focusable jq-series-season-option';
                option.textContent = seasonLabel(season);
                option.addEventListener('click', function () {
                    closeMenu();
                    // closeModal() has restored focus to this still-painted
                    // selector before changing the mounted season.
                    selectSeason(season, document.activeElement);
                });
                menu.appendChild(option);
                options.push(option);
            });

            container.appendChild(backdrop);

            seasonButton.addEventListener('click', function () {
                backdrop.hidden = false;
                // openModal() marks the dialog contained, so arrow keys
                // cannot walk out of it, and registers closeMenu() as the
                // hardware Back handler -- Back closes the dropdown before it
                // leaves the screen, per DETAIL_ACTIONS.md's "Left or Back
                // returns one level before closing".
                window.JellyQuestFocus.openModal(menu, closeMenu);
                // openModal() focuses the menu's first option. Start on the
                // season the viewer is actually in instead, so Up/Down move
                // from where they are. Held by node identity rather than an
                // attribute selector on a server id.
                var index;
                for (index = 0; index < seasons.length; index++) {
                    if (seasons[index].Id === currentSeasonId) {
                        options[index].focus();
                        return;
                    }
                }
            });

            function closeMenu() {
                backdrop.hidden = true;
                window.JellyQuestFocus.closeModal(menu, seasonButton);
            }

            markCurrentSeason = function () {
                var index;
                for (index = 0; index < seasons.length; index++) {
                    if (seasons[index].Id === currentSeasonId) options[index].setAttribute('aria-current', 'true');
                    else options[index].removeAttribute('aria-current');
                }
            };
        }

        function selectSeason(season, focusAnchor) {
            currentSeasonId = season.Id;
            seasonButton.textContent = seasonLabel(season) + ' ▾';
            if (markCurrentSeason) markCurrentSeason();
            if (callbacks.onSeasonChange) callbacks.onSeasonChange(season.Id);

            unmountEpisodes();
            if (!allEpisodes) {
                loadEpisodes(focusAnchor);
                return;
            }
            mountCurrentSeason();
        }

        // One whole-series fetch serves BOTH playback selection and every
        // season switch. A bounded prefix cannot be correct: MEASURED, this
        // endpoint ignores Filters/SortBy/SortOrder, so the newest resumable
        // record may occur anywhere (positions 38, 56 and 73 in the probe).
        // Limit is therefore deliberately absent. IsMissing/IsVirtualUnaired
        // are always false so PAW Patrol's 129 virtual placeholders do not
        // join its 346 real episodes.
        function loadEpisodes(focusAnchor) {
            unmountEpisodes();
            setStatus('Loading episodes…', false);
            var token = ++episodeRequest;
            Promise.resolve().then(function () {
                return apiClient.getEpisodes(item.Id, {
                    UserId: userId,
                    IsMissing: false,
                    IsVirtualUnaired: false
                });
            }).then(function (result) {
                if (!isCurrentRender() || token !== episodeRequest) return;
                allEpisodes = orderEpisodes((result && result.Items) || []);
                if (callbacks.onEpisodesLoaded) callbacks.onEpisodesLoaded(allEpisodes);
                return prepareEpisodes(focusAnchor, token);
            }).catch(function (error) {
                showEpisodeFailure(error, focusAnchor, token, 'Series episodes failed:');
            });
        }

        function prepareEpisodes(focusAnchor, token) {
            return resolvePlaybackActions(allEpisodes).catch(function (error) {
                playError.textContent = 'Couldn’t load playback actions. Browse episodes below.';
                playError.hidden = false;
                console.error('[JellyQuest] Series playback actions failed:', error);
            }).then(function () {
                if (!isCurrentRender() || token !== episodeRequest || !allEpisodes) return;
                selectSeasonById(currentSeasonId);
                window.JellyQuestFocus.focusFirst(container, focusAnchor);
            });
        }

        function showEpisodeFailure(error, focusAnchor, token, logLabel) {
            if (!isCurrentRender() || token !== episodeRequest) return;
            allEpisodes = null;
            setStatus('Couldn’t load this show’s episodes. Try again.', true);
            window.JellyQuestFocus.focusFirst(container, focusAnchor);
            console.error('[JellyQuest] ' + logLabel, error);
        }

        function selectSeasonById(seasonId) {
            var season = null;
            var index;
            for (index = 0; index < seasons.length; index++) {
                if (seasons[index].Id === seasonId) {
                    season = seasons[index];
                    break;
                }
            }
            if (!season) season = seasons[0];
            currentSeasonId = season.Id;
            seasonButton.textContent = seasonLabel(season) + ' ▾';
            if (markCurrentSeason) markCurrentSeason();
            if (callbacks.onSeasonChange) callbacks.onSeasonChange(season.Id);
            mountCurrentSeason();
        }

        function mountCurrentSeason() {
            var episodes = allEpisodes.filter(function (episode) {
                return episode.SeasonId === currentSeasonId || episode.ParentId === currentSeasonId;
            });
            if (!episodes.length) setStatus('No episodes in this season yet.', false);
            else {
                clearStatus();
                mountEpisodes(episodes);
            }
        }

        function resolvePlaybackActions(episodes) {
            actions.innerHTML = '';
            playError.hidden = true;
            seasonButton.setAttribute('data-jq-autofocus', '');
            var resumable = mostRecentInProgress(episodes);
            if (resumable) {
                renderActions(resumable, episodeAfter(episodes, resumable));
                return Promise.resolve();
            }
            if (typeof apiClient.getNextUpEpisodes !== 'function') {
                return Promise.reject(new Error('ApiClient.getNextUpEpisodes is unavailable'));
            }
            return Promise.resolve().then(function () {
                return apiClient.getNextUpEpisodes({
                    SeriesId: item.Id,
                    UserId: userId,
                    Limit: 1,
                    EnableRewatching: false
                });
            }).then(function (result) {
                var nextUp = result && result.Items && result.Items[0];
                renderActions(null, nextUp || null);
            });
        }

        function renderActions(resumable, continueEpisode) {
            var primary = null;
            if (resumable) {
                primary = appendAction('Resume', resumable, resumable.UserData.PlaybackPositionTicks);
            } else if (continueEpisode) {
                primary = appendAction('Continue', continueEpisode, 0);
            }
            if (resumable && continueEpisode) appendAction('Continue', continueEpisode, 0);
            if (resumable) appendAction('Restart Episode', resumable, 0);
            if (primary) {
                seasonButton.removeAttribute('data-jq-autofocus');
                primary.setAttribute('data-jq-autofocus', '');
            }
        }

        function appendAction(label, episode, startTicks) {
            var button = document.createElement('button');
            button.className = 'jq-detail-action jq-focusable';
            button.textContent = label;
            button.addEventListener('click', function () {
                playError.hidden = true;
                Promise.resolve(callbacks.onPlay(episode, startTicks)).catch(function (error) {
                    playError.textContent = 'Could not start playback. Try again.';
                    playError.hidden = false;
                    console.error('[JellyQuest] Series playback failed:', error);
                });
            });
            actions.appendChild(button);
            return button;
        }

        function unmountEpisodes() {
            episodeWindow = null;
            grid.innerHTML = '';
            grid.style.paddingTop = '0px';
            grid.style.paddingBottom = '0px';
        }

        function mountEpisodes(items) {
            var windowStart = 0;
            var windowEnd = Math.min(items.length, WINDOW_SIZE);
            var rowPitch = 0;
            // Indexed by position in `items`, which never renumbers, so an
            // artwork retry budget stays with the episode it was opened for
            // when windowing recreates its card (see cards.js).
            var retryBudgets = [];
            var index;

            function createCard(cardIndex) {
                var episode = items[cardIndex];
                if (!retryBudgets[cardIndex]) retryBudgets[cardIndex] = { failures: 0 };
                // context:'series' is household decision 3 -- inside the
                // show's own page the show name is already at the top, so the
                // EPISODE's name leads and 'S3 E12' drops to the meta line.
                // cards.js has implemented this branch since PR #30 with no
                // production caller; this is that caller.
                var card = window.JellyQuestCards.createCard(episode, {
                    context: 'series',
                    artworkRetryBudget: retryBudgets[cardIndex],
                    onSelect: function () { callbacks.onSelectItem(episode); }
                });
                card._jqSeriesIndex = cardIndex;
                return card;
            }

            function measureRowPitch() {
                var cards = grid.querySelectorAll('.jq-media-card');
                if (cards.length > COLUMNS) {
                    return cards[COLUMNS].getBoundingClientRect().top
                        - cards[0].getBoundingClientRect().top;
                }
                if (!cards.length) return 0;
                var style = window.getComputedStyle(grid);
                var rowGap = parseFloat(style.gridRowGap || style.gridGap) || 0;
                return cards[0].getBoundingClientRect().height + rowGap;
            }

            // Unmounted rows are carried as padding, so the scroll range --
            // and therefore every reveal focus.js computes -- matches the
            // whole season rather than the mounted window.
            function updatePadding() {
                var totalRows = Math.ceil(items.length / COLUMNS);
                var firstRow = windowStart / COLUMNS;
                var lastRow = Math.ceil(windowEnd / COLUMNS);
                grid.style.paddingTop = firstRow * rowPitch + 'px';
                grid.style.paddingBottom = (totalRows - lastRow) * rowPitch + 'px';
            }

            function moveWindow(nextStart) {
                var maximumStart = Math.ceil(Math.max(0, items.length - WINDOW_SIZE) / COLUMNS) * COLUMNS;
                var nextEnd;
                var card;
                var cardIndex;
                nextStart = Math.max(0, Math.min(maximumStart, nextStart));
                nextEnd = Math.min(items.length, nextStart + WINDOW_SIZE);
                if (nextStart === windowStart && nextEnd === windowEnd) return;

                card = grid.firstElementChild;
                while (card) {
                    var next = card.nextElementSibling;
                    if (card._jqSeriesIndex < nextStart || card._jqSeriesIndex >= nextEnd) {
                        grid.removeChild(card);
                    }
                    card = next;
                }
                for (cardIndex = windowStart - 1; cardIndex >= nextStart; cardIndex--) {
                    grid.insertBefore(createCard(cardIndex), grid.firstElementChild);
                }
                for (cardIndex = Math.max(windowEnd, nextStart); cardIndex < nextEnd; cardIndex++) {
                    grid.appendChild(createCard(cardIndex));
                }
                windowStart = nextStart;
                windowEnd = nextEnd;
                updatePadding();
            }

            for (index = windowStart; index < windowEnd; index++) {
                grid.appendChild(createCard(index));
            }
            rowPitch = measureRowPitch();
            updatePadding();

            // INVARIANT: moveWindow() must keep the focused index inside
            // [nextStart, nextEnd), so the focused node stays attached across
            // the synchronous update. Re-check this if WINDOW_SIZE, COLUMNS,
            // EDGE_ROWS or the +/- COLUMNS step changes -- and re-check
            // library.js's copy of the same arithmetic with it.
            // With 48/4/2: a down move requires index >= windowEnd - 8 =
            // windowStart + 40 while nextStart is only windowStart + 4; an up
            // move requires index < windowStart + 8 while nextEnd is
            // (windowStart - 4) + 48 = windowStart + 44. Neither removal
            // range can contain the focused index. Guaranteed by that
            // arithmetic, not by a runtime assertion.
            //
            // Unlike library.js there is no paging caller: the series arrives
            // whole and this season partition never grows, so this is the
            // only mutator.
            episodeWindow = {
                onFocus: function (focused) {
                    var focusedIndex = focused._jqSeriesIndex;
                    if (typeof focusedIndex !== 'number') return;
                    if (focusedIndex >= windowEnd - EDGE_ROWS * COLUMNS && windowEnd < items.length) {
                        moveWindow(windowStart + COLUMNS);
                        return;
                    }
                    if (focusedIndex < windowStart + EDGE_ROWS * COLUMNS && windowStart > 0) {
                        moveWindow(windowStart - COLUMNS);
                    }
                }
            };
        }

        // Registered once, on a grid node that outlives every season, so a
        // season change replaces the window without touching listeners.
        grid.addEventListener('focus', function (event) {
            if (episodeWindow) episodeWindow.onFocus(event.target);
        }, true);
    }

    // Season first, then episode number, with anything the server did not
    // number kept last in the order it arrived. MEASURED: the server ignores
    // SortBy on this endpoint, so this is the only ordering there is.
    //
    // Decorated with the arrival index because Array#sort is NOT specified
    // stable in ES5 and V8's own sort only became stable in V8 7.0 /
    // Chromium M70 -- above BOTH target sets (M63 and M69). Comparing the
    // index as the final tiebreak makes the result stable regardless.
    function orderEpisodes(episodes) {
        var decorated = episodes.map(function (episode, index) {
            return { episode: episode, index: index };
        });
        decorated.sort(function (a, b) {
            return compareIndexNumber(a.episode.ParentIndexNumber, b.episode.ParentIndexNumber)
                || compareIndexNumber(a.episode.IndexNumber, b.episode.IndexNumber)
                || (a.index - b.index);
        });
        return decorated.map(function (entry) { return entry.episode; });
    }

    function mostRecentInProgress(episodes) {
        var selected = null;
        var selectedTime = -Infinity;
        episodes.forEach(function (episode) {
            var userData = episode.UserData || {};
            if (!(userData.PlaybackPositionTicks > 0)) return;
            var playedTime = Date.parse(userData.LastPlayedDate || '');
            if (isNaN(playedTime)) playedTime = -Infinity;
            if (!selected || playedTime > selectedTime) {
                selected = episode;
                selectedTime = playedTime;
            }
        });
        return selected;
    }

    function episodeAfter(episodes, episode) {
        var index = episodes.indexOf(episode);
        return index >= 0 && index + 1 < episodes.length ? episodes[index + 1] : null;
    }

    // Explicit branches rather than a sentinel: a numeric sentinel large
    // enough to sort last subtracts from itself to NaN, which sort() reads as
    // "equal" only by accident.
    function compareIndexNumber(a, b) {
        var aNumbered = typeof a === 'number';
        var bNumbered = typeof b === 'number';
        if (aNumbered && bNumbered) return a - b;
        if (aNumbered) return -1;
        if (bNumbered) return 1;
        return 0;
    }

    window.JellyQuestSeriesScreen = {
        render: renderSeries
    };
})();
