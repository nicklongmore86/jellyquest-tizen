// Library screen: a full grid for one category (reached via a Home
// row's "See All"). Uses .jq-grid -- safe here because the column count
// matches how many cards actually fill a row throughout (only the last,
// naturally partial row is short), unlike the profile picker's ragged
// grid template (see docs/rebuild-plan.md's Phase 2 caveat).
(function () {
    'use strict';

    var COLUMNS = 4;
    // Twelve complete rows keep the polyfill's O(n) candidate sweep at 48
    // cards. With 680 items in memory, real posters, the production polyfill,
    // and 20x CPU throttling, current desktop Chromium measured 48.0ms median
    // and 91.3ms worst over 100 ArrowDown presses. That desktop result is an
    // optimistic lower bound, not an M63 or television measurement.
    var WINDOW_SIZE = 48;
    var EDGE_ROWS = 2;

    // ---- Paging ---------------------------------------------------------
    //
    // Before this, the screen asked for Limit 50 with no StartIndex, so on the
    // household's measured server (680 Movies + 34 Series = 714 eligible
    // items) it reached 7% of the library and the rest was unreachable by any
    // key press. It now walks StartIndex/Limit pages as the cursor advances.
    //
    // PAGE_SIZE = 2 * WINDOW_SIZE. The keypress cost measured for PR #24
    // scales with MOUNTED cards, not fetched ones -- the 48.0ms/91.3ms figures
    // above were taken with all 680 items already in memory -- so a larger
    // page buys fewer round trips at no navigation cost. Two windows is the
    // smallest size that (a) fills the initial 48-card window outright, so the
    // screen is never short on arrival, and (b) leaves a whole spare window
    // behind it, so the first page never needs a prefetch to have already
    // landed. 714 items become 8 requests instead of 1 truncated one. It is
    // also a multiple of COLUMNS, so a page boundary always falls on a row
    // boundary and the only short row is still the last one -- the .jq-grid
    // precondition in this file's opening comment.
    //
    // PREFETCH_REMAINING = WINDOW_SIZE. The next page is requested once the
    // cursor comes within 48 items -- 12 ArrowDown presses -- of the end of
    // what is loaded. At the measured 91.3ms worst-case press that is ~1.1s of
    // headroom, and at the 48.0ms median ~0.58s. INFERRED, not measured: no
    // figure for this server's page latency over the TV's own network exists,
    // so this is a headroom budget, not a proof the page always wins the race.
    // If it loses, the cursor simply stops at the last loaded row until the
    // page lands; nothing breaks, and the trigger fires again.
    //
    // The pre-rebuild overlay used Limit 70 with a prefetch at 14 cards
    // remaining. That is prior art, not a spec: 14 is under four rows, which
    // is less than one window of lead.
    var PAGE_SIZE = 96;
    var PREFETCH_REMAINING = 48;
    // A failed page must not be re-requested at key-repeat rate. Every retry
    // is still user-initiated (the next focus move inside the trigger zone);
    // this only stops a held-down arrow from hammering a failing server.
    var RETRY_COOLDOWN_MS = 2000;

    // callbacks: { onSelectItem(item), onBack() }
    function renderLibrary(container, row, callbacks) {
        container.innerHTML = '';
        container.className = 'jq-library-screen';

        var backButton = document.createElement('button');
        backButton.className = 'jq-back-button jq-focusable';
        backButton.textContent = '< Back';
        backButton.addEventListener('click', callbacks.onBack);
        container.appendChild(backButton);

        var heading = document.createElement('h1');
        heading.className = 'jq-library-heading';
        heading.textContent = row.title;
        container.appendChild(heading);

        var grid = document.createElement('div');
        grid.className = 'jq-grid jq-library-grid';
        grid.style.gridTemplateColumns = 'repeat(' + COLUMNS + ', 220px)';
        container.appendChild(grid);

        // A page can fail while the grid is scrolled arbitrarily deep, so this
        // message cannot sit in the flow after the grid -- that is below
        // however many virtual rows of padding the window is holding, i.e.
        // permanently off screen. .jq-library-paging-status is fixed to the
        // viewport instead (see library.css). The TV has no console, so a
        // console-only failure is an invisible one (PR #18).
        var pagingStatus = document.createElement('p');
        pagingStatus.className = 'jq-library-paging-status';
        pagingStatus.textContent = 'More of your library couldn’t be loaded. Try again.';
        pagingStatus.hidden = true;
        container.appendChild(pagingStatus);

        var focusAtRequest = document.activeElement;

        var userId = window.ApiClient.getCurrentUserId();
        function fetchPage(startIndex) {
            return window.ApiClient.getItems(userId, {
                Recursive: true, IncludeItemTypes: 'Movie,Series',
                SortBy: 'DateCreated', SortOrder: 'Descending',
                StartIndex: startIndex, Limit: PAGE_SIZE
            });
        }

        fetchPage(0).then(function (result) {
            renderWindowedGrid(grid, result, fetchPage, pagingStatus, callbacks);
            window.JellyQuestFocus.focusFirst(container, focusAtRequest);
        }).catch(function (error) {
            var status = document.createElement('p');
            status.className = 'jq-library-status';
            status.textContent = 'Library is unavailable right now. Try again.';
            container.appendChild(status);
            window.JellyQuestFocus.focusFirst(container, focusAtRequest);
            console.error('[JellyQuest] Library failed:', error);
        });
    }

    function renderWindowedGrid(grid, firstPage, fetchPage, pagingStatus, callbacks) {
        var items = [];
        // Ids already appended, so a page that overlaps one already held
        // cannot mount the same item twice.
        //
        // This is a FLOOR, not a guarantee that paging is stable. It can only
        // drop a REPEATED item; it cannot recover a SKIPPED one. MEASURED on
        // the household's Jellyfin 10.11.11 server: two full sweeps of all 680
        // movies across 14 pages returned 680 collected / 680 distinct /
        // identical order, matching a single 2500-item reference fetch, with
        // the page boundaries deliberately cut through all eight exact
        // DateCreated collisions -- each of which returned both members
        // exactly once. That is an EMPIRICAL result on one server at one
        // moment, not a contract: SortBy=SortName,Id returns HTTP 200 on this
        // server and is SILENTLY IGNORED (Id ascending and descending both
        // return the original sequence), so there is no usable unique
        // tie-breaker to make the order contractual.
        var seenIds = {};
        // The number of items the server has RETURNED, which is the next
        // StartIndex. Deliberately not items.length: dedup can make those
        // differ, and paging by the deduplicated count would re-request the
        // overlap forever.
        var fetchedCount = 0;
        var totalRecordCount = null;
        var pendingPage = false;
        var exhausted = false;
        var lastFailureAt = 0;

        var windowStart = 0;
        var windowEnd = 0;
        var rowPitch = 0;
        // Indexed by position in `items`, which is append-only -- a page
        // never renumbers an item already held -- so a budget stays with the
        // item it was opened for across both windowing and paging.
        var retryBudgets = [];

        function appendPage(result) {
            var received = (result && result.Items) || [];
            var added = 0;
            var index;
            var item;
            for (index = 0; index < received.length; index++) {
                item = received[index];
                // 'id:' prefix so an item literally named __proto__ or
                // hasOwnProperty cannot collide with Object.prototype.
                if (!item || !item.Id || seenIds['id:' + item.Id]) continue;
                seenIds['id:' + item.Id] = true;
                items.push(item);
                added++;
            }
            fetchedCount += received.length;
            if (result && typeof result.TotalRecordCount === 'number') {
                totalRecordCount = result.TotalRecordCount;
            }
            // Stop on the server's own count when it gives one, on a short or
            // empty page, and on a page that contributed nothing new -- the
            // last is the only remaining way to make no progress, and looping
            // on it would re-request the same offset indefinitely.
            if (!received.length || added === 0
                || received.length < PAGE_SIZE
                || (totalRecordCount !== null && fetchedCount >= totalRecordCount)) {
                exhausted = true;
            }
        }

        function requestNextPage() {
            if (pendingPage || exhausted) return;
            if (lastFailureAt && Date.now() - lastFailureAt < RETRY_COOLDOWN_MS) return;
            pendingPage = true;
            fetchPage(fetchedCount).then(function (result) {
                pendingPage = false;
                lastFailureAt = 0;
                pagingStatus.hidden = true;
                appendPage(result);
                // Deliberately NO focus call anywhere on this path. A page
                // arrives asynchronously, potentially long after the user has
                // moved the cursor somewhere else entirely, and
                // asynchronous-completion-beats-newer-intent is this repo's
                // recurring cursor-loss bug. Appending is focus-neutral by
                // construction: moveWindow(windowStart) below removes nothing
                // (see the INVARIANT note), no appended card is marked
                // [data-jq-autofocus], and nothing calls .focus().
                updatePadding();
                moveWindow(windowStart);
            }).catch(function (error) {
                pendingPage = false;
                lastFailureAt = Date.now();
                pagingStatus.hidden = false;
                console.error('[JellyQuest] Library page failed:', error);
            });
        }

        function createCard(index) {
            var item = items[index];
            if (!retryBudgets[index]) retryBudgets[index] = { failures: 0 };
            var card = window.JellyQuestCards.createCard(item, {
                artworkRetryBudget: retryBudgets[index],
                onSelect: function () { callbacks.onSelectItem(item); },
            });
            card._jqLibraryIndex = index;
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
            var index;
            nextStart = Math.max(0, Math.min(maximumStart, nextStart));
            nextEnd = Math.min(items.length, nextStart + WINDOW_SIZE);
            if (nextStart === windowStart && nextEnd === windowEnd) return;

            card = grid.firstElementChild;
            while (card) {
                var next = card.nextElementSibling;
                if (card._jqLibraryIndex < nextStart || card._jqLibraryIndex >= nextEnd) {
                    grid.removeChild(card);
                }
                card = next;
            }
            for (index = windowStart - 1; index >= nextStart; index--) {
                grid.insertBefore(createCard(index), grid.firstElementChild);
            }
            for (index = Math.max(windowEnd, nextStart); index < nextEnd; index++) {
                grid.appendChild(createCard(index));
            }
            windowStart = nextStart;
            windowEnd = nextEnd;
            updatePadding();
        }

        appendPage(firstPage);
        windowEnd = Math.min(items.length, WINDOW_SIZE);
        for (var index = windowStart; index < windowEnd; index++) {
            var card = createCard(index);
            if (index === 0) card.setAttribute('data-jq-autofocus', '');
            grid.appendChild(card);
        }
        rowPitch = measureRowPitch();
        updatePadding();

        // INVARIANT: moveWindow() must keep the focused index inside
        // [nextStart, nextEnd), so its node stays attached throughout the
        // synchronous update. Re-check this if WINDOW_SIZE, COLUMNS,
        // EDGE_ROWS, either trigger threshold, or the +/- COLUMNS step changes.
        // With today's 48/4/2 values, a down move requires
        // index >= windowEnd - 8 = windowStart + 40, while nextStart is only
        // windowStart + 4. An up move requires index < windowStart + 8, while
        // nextEnd is (windowStart - 4) + 48 = windowStart + 44. Thus neither
        // edge-removal loop can include the focused index. This is guaranteed
        // by that arithmetic, not by a runtime assertion.
        //
        // Paging adds one more caller: requestNextPage() calls
        // moveWindow(windowStart). nextStart === windowStart there, so the
        // removal loop's lower bound is unchanged and its upper bound only
        // GROWS (items.length grew) -- it removes nothing at all, and the
        // window still mounts at most WINDOW_SIZE cards because nextEnd is
        // capped at nextStart + WINDOW_SIZE regardless of how many pages have
        // been fetched.
        grid.addEventListener('focus', function (event) {
            var focused = event.target;
            var index = focused._jqLibraryIndex;
            if (typeof index !== 'number') return;
            if (index >= items.length - PREFETCH_REMAINING) requestNextPage();
            if (index >= windowEnd - EDGE_ROWS * COLUMNS && windowEnd < items.length) {
                moveWindow(windowStart + COLUMNS);
            } else if (index < windowStart + EDGE_ROWS * COLUMNS && windowStart > 0) {
                moveWindow(windowStart - COLUMNS);
            }
        }, true);
    }

    window.JellyQuestLibraryScreen = {
        render: renderLibrary
    };
})();
