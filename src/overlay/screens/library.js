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
    //
    // If it loses, the cursor stops at the last loaded row until the page
    // lands, AND THEN HAS TO BE UNSTUCK. An earlier revision of this comment
    // claimed the cursor simply resumes; that was false and shipped a bug. A
    // full window's upper bound does not grow when items are appended
    // (nextEnd is capped at nextStart + WINDOW_SIZE), so the arriving page
    // mounted no new row, ArrowDown had no candidate, no focus event fired,
    // and downward traversal was stuck until the user happened to press Left
    // or Right. requestNextPage() therefore re-runs the forward window test
    // itself once a page lands -- see extendWindowForward().
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

    // ---- What the paging guards do and do not bound ---------------------
    //
    // READ THIS BEFORE TREATING ANY OF IT AS A GUARANTEE. An earlier revision
    // of this comment called the ceiling below "a hard guard against unbounded
    // requests". It is not one, and cannot be: a server delivering new items
    // steadily is indistinguishable from a large real library, so any absolute
    // request cap would truncate a legitimate library to close a hypothetical
    // one. What follows is what is actually bounded, stated exactly.
    //
    // BOUNDED:
    //   * A response that cannot advance the offset at all -- an empty page.
    //     Stopped immediately; nothing else can make progress from there.
    //   * A server repeating pages: MAX_BARREN_PAGES consecutive responses
    //     that add no new item.
    //   * A server making negligible progress: the ratio ceiling below binds
    //     when the average yield falls under PAGE_SIZE / MAX_REQUEST_RATIO,
    //     i.e. 24 new items per response. MEASURED: a server alternating
    //     1- and 20-item pages stops after 17 responses.
    //   * A TotalRecordCount that keeps moving the goalposts. The count is
    //     LATCHED from the first response that supplies one (see appendPage),
    //     so a total that grows on every response cannot indefinitely defer
    //     the short-page stop. MEASURED: a server alternating 24- and 25-item
    //     pages with a continually growing total ran to 163 responses without
    //     the latch and stops after 22 with it.
    //
    // NOT BOUNDED, deliberately:
    //   * A server that keeps returning full pages of new items. That is what
    //     a large library looks like, and bounding it would truncate one.
    //     MEASURED: a 5,000-item server returning full pages reaches all 5,000
    //     in 53 responses, which no guard here interferes with.
    //   * A server whose FIRST response already claims a huge
    //     TotalRecordCount and then yields at least 24 new items per response
    //     indefinitely. The latch bounds the count to that first claim, not to
    //     any absolute figure. Requests remain strictly user-paced -- one in
    //     flight, only ever issued from a focus move inside the trigger zone,
    //     roughly one per four to six rows scrolled -- so this costs traffic
    //     proportional to how far the viewer actually scrolls, not a runaway
    //     loop. INFERRED: the real server returns full pages, so this shape
    //     has never been observed.
    //
    // KNOWN TRUNCATION RISK, accepted: the ratio ceiling would cut short a
    // server whose own page cap is below 24 items while its library is much
    // larger. INFERRED, never observed -- the measured server honours Limit.
    // It is recorded here rather than guarded against, because every guard
    // that would close it also truncates some legitimate library.

    // Consecutive responses that contribute no new item. A page whose items
    // are all already held has still advanced the raw offset, so continuing
    // cannot loop on one offset -- but a server repeating pages forever would
    // never finish. Three consecutive is 288 item slots of zero progress. In a
    // stable ordering, boundary overlap repeats items only across ADJACENT
    // pages, so three is far beyond it; under an unstable ordering that is not
    // guaranteed. INFERRED: a conservative choice, not a measured threshold --
    // no measurement of a misbehaving server exists.
    var MAX_BARREN_PAGES = 3;
    // A floor under the request ceiling below. 16 responses is 1536 item
    // slots, more than twice the measured 714-item library, so the floor
    // cannot bind on any library resembling the measured one.
    var MINIMUM_PAGE_REQUESTS = 16;
    // How many times the ideal number of requests a server may take before
    // paging gives up. Computed from what has actually been fetched rather
    // than being a flat constant, because a flat constant would truncate a
    // library legitimately larger than it. MEASURED arithmetic: this binds
    // exactly when the average yield drops below PAGE_SIZE / MAX_REQUEST_RATIO
    // = 24 new items per response, and never binds above it at any library
    // size. It bounds INEFFICIENCY, not library size -- and, as set out above,
    // it therefore does not bound request count in absolute terms.
    var MAX_REQUEST_RATIO = 4;

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
        var pageResponses = 0;
        var barrenPages = 0;

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
            pageResponses++;
            barrenPages = added === 0 ? barrenPages + 1 : 0;
            // LATCHED, not refreshed. A count that grows on every response
            // otherwise moves the goalposts forever: fetchedCount can never
            // catch it, so the short-page stop never fires and paging runs as
            // long as the viewer keeps scrolling. Taking the first count the
            // server supplies bounds that by its own opening claim. It also
            // gives the screen a coherent meaning -- it pages the library as
            // it was when the screen opened -- rather than chasing a target
            // that moves underneath the cursor.
            if (totalRecordCount === null && result && typeof result.TotalRecordCount === 'number') {
                totalRecordCount = result.TotalRecordCount;
            }

            // ---- When to stop asking ------------------------------------
            //
            // TotalRecordCount is a hint. INFERRED, not measured: that it
            // reports the whole match count rather than the returned page's
            // length -- that is how jellyfin-web reads the field and what the
            // Search screen already assumed, but no probe here established it,
            // and an earlier revision of this comment wrongly called it
            // MEASURED. A response can contradict it in either direction, and
            // an earlier revision stopped on ANY duplicate-only or short page,
            // which silently presented a partial library as the whole one: a
            // single repeated page truncated 300 items to 96.
            //
            // Only an EMPTY page genuinely blocks progress, because only an
            // empty page fails to advance the raw offset; every non-empty
            // response moves StartIndex on, so asking again is a NEW offset,
            // not the same one. (An earlier comment here claimed otherwise.
            // It was wrong: fetchedCount advances by the RAW response length.)
            var shortPage = received.length < PAGE_SIZE;
            var reachedClaimedTotal = totalRecordCount !== null && fetchedCount >= totalRecordCount;
            if (!received.length) {
                // No offset progress is possible; asking again would repeat
                // this exact request forever.
                exhausted = true;
            } else if (shortPage && (reachedClaimedTotal || totalRecordCount === null)) {
                // The ordinary end: a short final page, agreed on by the
                // server's own count -- or, when it gave no count, the short
                // page is the only end-signal there is.
                exhausted = true;
            } else if (barrenPages >= MAX_BARREN_PAGES) {
                exhausted = true;
            } else if (pageResponses > Math.max(MINIMUM_PAGE_REQUESTS,
                Math.ceil(fetchedCount / PAGE_SIZE) * MAX_REQUEST_RATIO)) {
                exhausted = true;
            }
            // Everything else keeps going: a full page while the count says
            // more remain, a short page while it says more remain, a
            // duplicate-only page, and a page that overruns an understated
            // count. Dedup keeps a repeat from being mounted twice; it cannot
            // recover an item the server SKIPPED, and nothing here pretends
            // otherwise -- a skipped range stays missing and the reachable
            // count simply ends up below TotalRecordCount.
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
                // construction. extendWindowForward() below does mutate the
                // grid -- moveWindow() removes the cards that fall below the
                // new nextStart before appending the trailing ones, so this is
                // not an append-only operation, and an earlier revision of
                // this comment wrongly said it was. What makes it focus-safe
                // is the INVARIANT note's arithmetic: the focused index is
                // provably outside BOTH removal ranges, so the focused node is
                // never one of the cards removed. No appended card is marked
                // [data-jq-autofocus], and nothing on this path calls
                // .focus().
                updatePadding();
                if (extendWindowForward(focusedIndex())) {
                    // Mounting the row is not enough to make it reachable. The
                    // polyfill will not move to a candidate it cannot see, and
                    // the cursor was sitting on what was, until this page
                    // landed, the last row -- so the screen is scrolled to its
                    // old end and the new row is just past the bottom edge.
                    // Nothing re-runs the scroll reveal, because no focus
                    // event fired. Ask for it explicitly. This moves scroll
                    // offsets only; it does not move the cursor.
                    window.JellyQuestFocus.reveal(document.activeElement);
                }
            }).catch(function (error) {
                pendingPage = false;
                lastFailureAt = Date.now();
                pagingStatus.hidden = false;
                console.error('[JellyQuest] Library page failed:', error);
            });
        }

        // The index of the card the cursor is on, or null if the cursor is
        // not on a card of THIS grid -- on the rail, on "< Back", or on a
        // screen that has since replaced this one.
        function focusedIndex() {
            var active = document.activeElement;
            if (!active || !grid.contains(active)) return null;
            return typeof active._jqLibraryIndex === 'number' ? active._jqLibraryIndex : null;
        }

        // The forward half of the window trigger, shared by the focus listener
        // and by a page landing. Extracted rather than duplicated so the two
        // callers cannot drift apart -- the INVARIANT below is stated in terms
        // of exactly this arithmetic.
        function extendWindowForward(index) {
            if (index === null) return false;
            if (index >= windowEnd - EDGE_ROWS * COLUMNS && windowEnd < items.length) {
                moveWindow(windowStart + COLUMNS);
                return true;
            }
            return false;
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
        // extendWindowForward(focusedIndex()) when a page lands. That is the
        // SAME test and the SAME +COLUMNS step as the down branch below, so
        // the arithmetic above covers it unchanged -- the focused index is
        // >= windowStart + 40 when it fires, nextStart is windowStart + 4, and
        // nextEnd is windowStart + 52, so the focused card is in neither
        // removal range. One step is enough to unstick downward traversal: the
        // row below the focused card is at most index + COLUMNS <=
        // windowStart + 51, which is inside the new [nextStart, nextEnd).
        //
        // Note that it is NOT an append-only operation: moveWindow() removes
        // the COLUMNS cards that fall below the new nextStart before appending
        // the trailing ones. That is safe for the reason above -- the focused
        // index is provably outside that removal range -- not because nothing
        // is removed.
        //
        // It cannot raise the mounted-card bound either: nextEnd is capped at
        // nextStart + WINDOW_SIZE regardless of how many pages were fetched.
        //
        // Only the FORWARD branch runs on a page landing. An append adds items
        // at the END, so it can never make an item behind the cursor newly
        // available, and running the backward branch would mutate the DOM for
        // no reason the user asked for.
        grid.addEventListener('focus', function (event) {
            var focused = event.target;
            var index = focused._jqLibraryIndex;
            if (typeof index !== 'number') return;
            if (index >= items.length - PREFETCH_REMAINING) requestNextPage();
            if (extendWindowForward(index)) return;
            if (index < windowStart + EDGE_ROWS * COLUMNS && windowStart > 0) {
                moveWindow(windowStart - COLUMNS);
            }
        }, true);
    }

    window.JellyQuestLibraryScreen = {
        render: renderLibrary
    };
})();
