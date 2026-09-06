// Library screen: a full grid for one category (reached via a Home
// row's "See All"). Uses .jq-grid -- safe here because the column count
// matches how many cards actually fill a row throughout (only the last,
// naturally partial row is short), unlike the profile picker's ragged
// grid template (see docs/rebuild-plan.md's Phase 2 caveat).
(function () {
    'use strict';

    var COLUMNS = 4;

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

        var userId = window.ApiClient.getCurrentUserId();
        // Bounded independently of Home. Pagination remains follow-up work.
        window.ApiClient.getItems(userId, {
            Recursive: true, IncludeItemTypes: 'Movie,Series',
            SortBy: 'DateCreated', SortOrder: 'Descending', Limit: 50
        }).then(function (result) {
            result.Items.forEach(function (item, index) {
                var card = window.JellyQuestCards.createCard(item, {
                    onSelect: function () { callbacks.onSelectItem(item); },
                });
                // Focus the first card, not Back (which is reached via Up
                // from the top row instead) -- focusFirst()'s DOM-order
                // fallback would otherwise land on Back since it comes
                // first in the markup.
                if (index === 0) card.setAttribute('data-jq-autofocus', '');
                grid.appendChild(card);
            });
            window.JellyQuestFocus.focusFirst(container);
        }).catch(function (error) {
            var status = document.createElement('p');
            status.className = 'jq-library-status';
            status.textContent = 'Library is unavailable right now. Try again.';
            container.appendChild(status);
            window.JellyQuestFocus.focusFirst(container);
            console.error('[JellyQuest] Library failed:', error);
        });
    }

    window.JellyQuestLibraryScreen = {
        render: renderLibrary
    };
})();
