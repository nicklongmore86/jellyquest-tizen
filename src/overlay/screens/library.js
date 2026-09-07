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
        var focusAtRequest = document.activeElement;

        var userId = window.ApiClient.getCurrentUserId();
        // Bounded independently of Home. Pagination remains follow-up work.
        window.ApiClient.getItems(userId, {
            Recursive: true, IncludeItemTypes: 'Movie,Series',
            SortBy: 'DateCreated', SortOrder: 'Descending', Limit: 50
        }).then(function (result) {
            renderWindowedGrid(grid, result.Items, callbacks);
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

    function renderWindowedGrid(grid, items, callbacks) {
        var windowStart = 0;
        var windowEnd = 0;
        var rowPitch = 0;
        var retryBudgets = [];

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
        grid.addEventListener('focus', function (event) {
            var focused = event.target;
            var index = focused._jqLibraryIndex;
            if (typeof index !== 'number') return;
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
