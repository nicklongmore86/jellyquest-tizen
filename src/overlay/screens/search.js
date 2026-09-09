// Search screen: a text input (the platform's on-screen keyboard handles
// text entry on real Tizen hardware -- no custom input UI needed) plus a
// live-filtered results row.
(function () {
    'use strict';

    var DEBOUNCE_MS = 200;

    // callbacks: { onSelectItem(item) }
    function renderSearch(container, callbacks) {
        container.innerHTML = '';
        container.className = window.JellyQuestShell.contentClassName('jq-search-screen');

        var input = document.createElement('input');
        input.type = 'search';
        input.className = 'jq-search-input jq-focusable';
        input.placeholder = 'Search your library';
        input.setAttribute('data-jq-autofocus', '');
        container.appendChild(input);

        var resultsRow = document.createElement('div');
        resultsRow.className = 'jq-row jq-search-results';
        container.appendChild(resultsRow);

        var empty = document.createElement('p');
        empty.className = 'jq-search-empty';
        empty.textContent = 'No films or shows match. Episode search isn’t available yet.';
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
            resultsRow.innerHTML = '';
            empty.hidden = true;
            empty.textContent = 'No films or shows match. Episode search isn’t available yet.';
            empty.classList.remove('jq-search-error');
            if (!term.trim()) return;
            var userId = window.ApiClient.getCurrentUserId();
            window.ApiClient.getItems(userId, { Recursive: true, IncludeItemTypes: 'Movie,Series', SearchTerm: term, Limit: 24 }).then(function (result) {
                if (currentSearchId !== searchId || input.value !== term) return; // a newer search superseded this one
                empty.hidden = true;
                empty.textContent = 'No films or shows match. Episode search isn’t available yet.';
                empty.classList.remove('jq-search-error');
                if (!result.Items.length) {
                    empty.hidden = false;
                    return;
                }
                if (typeof result.TotalRecordCount === 'number' && result.TotalRecordCount > result.Items.length) {
                    empty.textContent = 'Showing the first ' + result.Items.length + ' of ' + result.TotalRecordCount + ' matches — try a more specific title.';
                    empty.hidden = false;
                }
                result.Items.forEach(function (item) {
                    resultsRow.appendChild(window.JellyQuestCards.createCard(item, {
                        onSelect: function () { callbacks.onSelectItem(item); },
                    }));
                });
            }).catch(function (error) {
                if (currentSearchId !== searchId || input.value !== term) return;
                empty.textContent = 'Search failed. Try again.';
                empty.classList.add('jq-search-error');
                empty.hidden = false;
                console.error('[JellyQuest] Library search failed:', error);
            });
        }

        window.JellyQuestFocus.focusFirst(container);
    }

    window.JellyQuestSearchScreen = {
        render: renderSearch
    };
})();
