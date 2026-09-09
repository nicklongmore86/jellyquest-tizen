// Top-level nav shell -- the persistent rail (Profile/Home/Shows/Movies/Search/Requests)
// stays mounted across every screen; app.js swaps what's in the content
// area beneath/beside it (Home, Search, Library, Detail). This matches
// DETAIL_ACTIONS.md's focus graph, which has the rail reachable by Up
// from the detail page's own action row, not hidden while viewing detail.
//
// shell.js only owns the rail chrome and the content container; it has
// no idea what's inside the content area at any given moment -- that's
// app.js's job (see showHome/showSearch/showLibrary/showDetail there).
(function () {
    'use strict';

    var contentEl = null;

    // The structural classes the shell's content <main> must always carry.
    // .jq-shell-content is what gives it `flex: 1 1 auto` (shell.css), i.e.
    // the whole width left of the rail; without it the content box
    // shrink-wraps its own contents and every screen hugs the left edge
    // after the 268px rail.
    //
    // Every screen renderer assigns container.className outright, which is
    // how this class was silently lost on all six of them from the first
    // revision each was written -- MEASURED at 1920x1080 before the fix:
    // Search and Requests 696px wide, Library and Series 1036px, Detail
    // 733px, against a 1652px content area. Home was full width only by
    // accident, its long horizontal rows being intrinsically wide enough to
    // mask the loss. Renderers therefore ask for their class through
    // contentClassName() rather than spelling the structural half out again,
    // so a new screen cannot drop it by writing the obvious thing.
    //
    // NOT for the profile picker: profiles.js replaces the top-level root
    // after the shell has been removed (app.js showProfiles), so its
    // container never is this <main> and it centres itself instead
    // (profiles.css).
    var CONTENT_CLASS = 'jq-content jq-shell-content';

    function contentClassName(screenClass) {
        return CONTENT_CLASS + ' ' + screenClass;
    }

    // callbacks: { onSwitchProfile(), onHome(), onShows(), onMovies(), onSearch(), onRequests() }
    function renderShell(container, callbacks) {
        container.innerHTML = '';
        container.className = 'jq-shell';

        var rail = document.createElement('nav');
        rail.className = 'jq-rail';
        rail.setAttribute('aria-label', 'Primary');

        var profileButton = document.createElement('button');
        profileButton.className = 'jq-rail-item jq-focusable jq-profile-switch';
        profileButton.setAttribute('data-jq-autofocus', '');
        var user = window.JellyQuestSession.getCurrentProfile();
        profileButton.textContent = user ? user.Name : 'Profile';
        profileButton.addEventListener('click', function () {
            window.JellyQuestSession.clearProfile();
            callbacks.onSwitchProfile();
        });
        rail.appendChild(profileButton);

        var homeButton = document.createElement('button');
        homeButton.className = 'jq-rail-item jq-focusable jq-nav-home';
        homeButton.textContent = 'Home';
        homeButton.addEventListener('click', callbacks.onHome);
        rail.appendChild(homeButton);

        var showsButton = document.createElement('button');
        showsButton.className = 'jq-rail-item jq-focusable jq-nav-shows';
        showsButton.textContent = 'Shows';
        showsButton.addEventListener('click', callbacks.onShows);
        rail.appendChild(showsButton);

        var moviesButton = document.createElement('button');
        moviesButton.className = 'jq-rail-item jq-focusable jq-nav-movies';
        moviesButton.textContent = 'Movies';
        moviesButton.addEventListener('click', callbacks.onMovies);
        rail.appendChild(moviesButton);

        var searchButton = document.createElement('button');
        searchButton.className = 'jq-rail-item jq-focusable jq-nav-search';
        searchButton.textContent = 'Search';
        searchButton.addEventListener('click', callbacks.onSearch);
        rail.appendChild(searchButton);

        var requestsButton = document.createElement('button');
        requestsButton.className = 'jq-rail-item jq-focusable jq-nav-requests';
        requestsButton.textContent = 'Requests';
        requestsButton.addEventListener('click', callbacks.onRequests);
        rail.appendChild(requestsButton);

        container.appendChild(rail);

        contentEl = document.createElement('main');
        contentEl.className = CONTENT_CLASS;
        container.appendChild(contentEl);

        // The rail outlives every content screen, so it is the one thing
        // that can always take focus when a screen has nothing focusable of
        // its own (an empty library's Home, for one) -- see focusFirst().
        window.JellyQuestFocus.setFallbackContainer(rail);
        window.JellyQuestFocus.focusFirst(rail);
    }

    function getContent() {
        return contentEl;
    }

    window.JellyQuestShell = {
        render: renderShell,
        getContent: getContent,
        contentClassName: contentClassName
    };
})();
