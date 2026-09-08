// Home screen: Continue Watching + Next Up + Recently Added rows. Real
// screen content replacing the Phase 2 placeholder ("Home -- Phase 3").
(function () {
    'use strict';

    // callbacks: { onSelectItem(item), onSeeAll(row) } where row is
    // { title } for the Library screen, which owns its query.
    function renderHome(container, callbacks) {
        container.innerHTML = '';
        container.className = 'jq-home-screen';

        var focusAtRequest = document.activeElement;
        var userId = window.ApiClient.getCurrentUserId();
        var rows = [
            {
                title: 'Continue Watching',
                fetch: function () { return window.ApiClient.getItems(userId, { Recursive: true, IncludeItemTypes: 'Movie,Episode', Filters: 'IsResumable', SortBy: 'DatePlayed', SortOrder: 'Descending' }); },
                seeAll: false,
            },
            // Next Up sits between them, matching Jellyfin's own default home
            // layout -- Resume, then NextUp, then LatestMedia
            // (.cache/jellyfin-web/src/types/homeSectionType.ts:18-27, which
            // mirrors the SERVER's DisplayPreferences defaults). It reads the
            // same way on a television: "carry on with what you paused",
            // then "start the next episode of a show you are partway
            // through", then "look at what is new".
            //
            // This is the LIBRARY-WIDE /Shows/NextUp call -- no SeriesId --
            // and it is NOT the Series screen's Continue. MEASURED against
            // the household's Jellyfin 10.11.11: Series Continue plays the
            // episode AFTER the in-progress one, while library-wide Next Up
            // returns the IN-PROGRESS EPISODE ITSELF (Pixel Move came back at
            // PlayedPercentage 66.2). So these cards route to Episode Detail
            // like every other episode card here, and Detail's own
            // Resume/Play/Start Over do the right thing per item. There is
            // deliberately no second selection algorithm in this screen.
            //
            // Sent, and MEASURED as HONOURED: UserId, Limit, EnableRewatching,
            // EnableResumable.
            //
            // EnableResumable: false is what keeps this row from repeating
            // Continue Watching. MEASURED, an in-progress episode is returned
            // by this endpoint ITSELF, and the overlap was large, not
            // cosmetic: 7 of the 15 baseline items on the largest profile
            // (47%) and 2 of 3 on the restricted one (67%) were already
            // Continue Watching cards. MEASURED, false removes EXACTLY those
            // ids, keeps the rest in baseline order, substitutes nothing, and
            // leaves both profiles non-empty (15 -> 8 and 3 -> 1).
            //
            // That it is HONOURED rather than accepted-and-ignored was
            // established from the FALSE delta, not from true matching the
            // baseline -- an ignored option matches the baseline too:
            //   15 items / 26,195 bytes / sha b0898ecf -> 8 / 13,939 / 7038da41
            //    3 items /  5,433 bytes / sha b18b27a7 -> 1 /  1,830 / 170d3e99
            // TotalRecordCount tracks it. It also does not mask
            // EnableRewatching: the same ids go with rewatching off or on.
            // Upstream sends the same thing (.cache/jellyfin-web/src/
            // components/homesections/sections/nextUp.ts:32).
            //
            // REJECTED ALTERNATIVE -- deduplicating against Continue
            // Watching's ids here in the client. MEASURED, it yields the same
            // survivors, so it buys nothing; it offers no extra cards to
            // replace what it drops; it would couple this row to another
            // row's results and to whichever resolves first; and it filters
            // AFTER Limit, so a page of eight could arrive mostly duplicated
            // and render two cards. The server does the same job before the
            // limit is applied.
            //
            // Deliberately NOT sent:
            //   SortBy/SortOrder     MEASURED accepted and SILENTLY IGNORED
            //                        here; the ignored variants came back
            //                        byte-identical. Asking the server to
            //                        sort would look like it worked. The
            //                        server's order is descending most recent
            //                        activity anywhere in the SERIES -- not
            //                        the returned episode's own date -- and
            //                        the client cannot request another, so
            //                        this row does not re-sort either.
            //   IsMissing/           also MEASURED accepted and ignored on
            //   IsVirtualUnaired     THIS endpoint, and zero virtual records
            //                        appear in its response. Sending them
            //                        would imply a guarantee that does not
            //                        exist. (They are required on
            //                        /Shows/{id}/Episodes -- see series.js --
            //                        which is a different endpoint.)
            //   DisableFirstEpisode  MEASURED to have no observable effect.
            //
            // Limit: 8 matches Recently Added below rather than upstream's 15
            // (nextUp.ts:24). MEASURED cost on the household's largest
            // profile: 15 items / 26,195 bytes unbounded against 8 items /
            // 14,143 bytes at Limit 8. The row is a horizontally scrolled
            // rail, so eight cards is already more than one screen, and the
            // measured worst case hides at most seven items. ACCEPTED
            // LIMITATION: there is no "See All" to reach those seven --
            // the Library screen is a getItems screen and cannot express
            // /Shows/NextUp, and building a Next Up library is out of this
            // task's scope.
            {
                title: 'Next Up',
                fetch: function () {
                    // Same guard shape as series.js's Continue action: an
                    // older ApiClient without this method must degrade to the
                    // row's own unavailable message, not throw out of the map
                    // below and take the other two rows with it.
                    if (typeof window.ApiClient.getNextUpEpisodes !== 'function') {
                        return Promise.reject(new Error('ApiClient.getNextUpEpisodes is unavailable'));
                    }
                    return window.ApiClient.getNextUpEpisodes({
                        UserId: userId, Limit: 8, EnableResumable: false, EnableRewatching: false
                    });
                },
                seeAll: false,
            },
            {
                title: 'Recently Added',
                fetch: function () { return window.ApiClient.getItems(userId, { Recursive: true, IncludeItemTypes: 'Movie,Series', SortBy: 'DateCreated', SortOrder: 'Descending', Limit: 8 }); },
                seeAll: true,
            },
        ];

        var firstCard = null;
        var pending = rows.map(function (row) {
            return row.fetch().then(function (result) {
                if (!result.Items.length) return null;
                return renderRow(row, result.Items, callbacks);
            }).catch(function (error) {
                var status = document.createElement('p');
                status.className = 'jq-home-empty';
                status.textContent = row.title + ' is unavailable right now.';
                console.error('[JellyQuest] Home row failed:', error);
                return status;
            });
        });

        // Promise.all preserves input order even when the network does not.
        Promise.all(pending).then(function (sections) {
            sections.forEach(function (section) {
                if (!section) return;
                container.appendChild(section);
                if (!firstCard) firstCard = section.querySelector('.jq-focusable');
            });
            if (!container.children.length) {
                var empty = document.createElement('p');
                empty.className = 'jq-home-empty';
                empty.textContent = 'Nothing here yet.';
                container.appendChild(empty);
            }
            if (firstCard) firstCard.setAttribute('data-jq-autofocus', '');
            window.JellyQuestFocus.focusFirst(container, focusAtRequest);
        });
    }

    function renderRow(row, items, callbacks) {
        var section = document.createElement('section');
        section.className = 'jq-home-row-section';

        var heading = document.createElement('h2');
        heading.className = 'jq-home-row-heading';
        heading.textContent = row.title;
        section.appendChild(heading);

        var rowEl = document.createElement('div');
        rowEl.className = 'jq-row jq-home-row';
        items.forEach(function (item) {
            rowEl.appendChild(window.JellyQuestCards.createCard(item, {
                onSelect: function () { callbacks.onSelectItem(item); },
            }));
        });
        if (row.seeAll) {
            var seeAll = document.createElement('button');
            seeAll.className = 'jq-card jq-focusable jq-see-all';
            seeAll.textContent = 'See All';
            seeAll.addEventListener('click', function () { callbacks.onSeeAll({ title: row.title }); });
            rowEl.appendChild(seeAll);
        }
        section.appendChild(rowEl);
        return section;
    }

    window.JellyQuestHomeScreen = {
        render: renderHome
    };
})();
