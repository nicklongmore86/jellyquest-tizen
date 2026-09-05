// A fake window.ApiClient with representative Jellyfin data (profiles and
// library items), matching the method names and shapes real jellyfin-web
// code calls on the genuine ApiClient (jellyfin-apiclient-javascript).
// Screens built against this in the simulator should work unmodified
// against the real ApiClient once packaged.
(function () {
    'use strict';

    var TICKS_PER_SECOND = 10000000;

    var USERS = [
        { Id: 'user-alice', Name: 'Alice' },
        { Id: 'user-bob', Name: 'Bob' },
        { Id: 'user-charlie', Name: 'Charlie' },
        { Id: 'user-dana', Name: 'Dana' },
    ];

    // A library big enough to exercise a real grid's partial last row
    // (see docs/rebuild-plan.md's Phase 2 .jq-grid caveat): 10 movies in
    // a 4-column grid is 2 full rows + 1 row of 2.
    var MOVIES = [
        {
            Id: 'movie-1', Name: 'The Long Winter', ProductionYear: 2024, RunTimeTicks: 2 * 3600 * TICKS_PER_SECOND,
            Overview: 'A supply run north turns into a fight to get home before the roads close for good.', LocalTrailerCount: 1,
            // The only fixture item with multiple tracks -- exercises the
            // conditionally-shown More/Playback Options menu.
            MediaStreams: [
                { Type: 'Audio', DisplayTitle: 'English 5.1' },
                { Type: 'Audio', DisplayTitle: 'French Stereo' },
                { Type: 'Subtitle', DisplayTitle: 'English' },
                { Type: 'Subtitle', DisplayTitle: 'French' },
            ],
        },
        { Id: 'movie-2', Name: 'Quiet Signal', ProductionYear: 2022, RunTimeTicks: 6300 * TICKS_PER_SECOND, Overview: 'A radio operator picks up a transmission that shouldn’t exist.', LocalTrailerCount: 0 },
        { Id: 'movie-3', Name: 'Low Tide', ProductionYear: 2020, RunTimeTicks: 5700 * TICKS_PER_SECOND, Overview: 'Two sisters return to the coastal town they swore they’d never see again.', LocalTrailerCount: 1 },
        { Id: 'movie-4', Name: 'Static Bloom', ProductionYear: 2024, RunTimeTicks: 6900 * TICKS_PER_SECOND, Overview: 'An artist’s final installation starts finishing itself.', LocalTrailerCount: 0 },
        { Id: 'movie-5', Name: 'Harbor Lights', ProductionYear: 2023, RunTimeTicks: 6600 * TICKS_PER_SECOND, Overview: 'A lighthouse keeper’s last winter on the job.', LocalTrailerCount: 0 },
        { Id: 'movie-6', Name: 'Field Notes', ProductionYear: 2021, RunTimeTicks: 5400 * TICKS_PER_SECOND, Overview: 'A biologist’s survey of a valley nobody else wants to study.', LocalTrailerCount: 0 },
        { Id: 'movie-7', Name: 'Second Frost', ProductionYear: 2019, RunTimeTicks: 6300 * TICKS_PER_SECOND, Overview: 'A late-season storm strands a family at the edge of town.', LocalTrailerCount: 0 },
        { Id: 'movie-8', Name: 'The Long Way Round', ProductionYear: 2018, RunTimeTicks: 7200 * TICKS_PER_SECOND, Overview: 'A road trip that keeps finding reasons not to end.', LocalTrailerCount: 1 },
        { Id: 'movie-9', Name: 'Blue Hour', ProductionYear: 2025, RunTimeTicks: 6000 * TICKS_PER_SECOND, Overview: 'Everything important happens in the twenty minutes after sunset.', LocalTrailerCount: 0 },
        { Id: 'movie-10', Name: 'Open Water', ProductionYear: 2017, RunTimeTicks: 5100 * TICKS_PER_SECOND, Overview: 'A rescue crew’s last call of the season.', LocalTrailerCount: 0 },
    ].map(function (movie) { return Object.assign({ Type: 'Movie', ImageTags: movie.Id === 'movie-10' ? {} : { Primary: 'preview-v1' } }, movie); });

    // Per-user UserData (playback progress, favorites) -- keyed by user id
    // then item id, matching how real per-profile state works.
    var USER_DATA = {
        'user-alice': {
            'movie-1': { PlaybackPositionTicks: 40 * 60 * TICKS_PER_SECOND, Played: false, IsFavorite: false },
            'movie-5': { PlaybackPositionTicks: 0, Played: true, IsFavorite: true },
        },
        'user-bob': {},
        'user-charlie': {},
    };

    function withUserData(item, userId) {
        var data = (USER_DATA[userId] && USER_DATA[userId][item.Id]) || { PlaybackPositionTicks: 0, Played: false, IsFavorite: false };
        return Object.assign({}, item, { UserData: data });
    }

    var currentUserId = null;

    function matchesFilters(item, userId, options) {
        options = options || {};
        if (options.SearchTerm) {
            var term = options.SearchTerm.toLowerCase();
            if (item.Name.toLowerCase().indexOf(term) === -1) return false;
        }
        if (options.Filters === 'IsResumable') {
            var data = (USER_DATA[userId] && USER_DATA[userId][item.Id]) || {};
            if (!data.PlaybackPositionTicks) return false;
        }
        return true;
    }

    var apiClient = {
        getImageUrl: function (itemId, options) {
            var index = (parseInt(itemId.replace('movie-', ''), 10) - 1) % 3 + 1;
            var query = Object.keys(options).map(function (key) {
                return encodeURIComponent(key) + '=' + encodeURIComponent(options[key]);
            }).join('&');
            return '/dev/fixtures/artwork/poster-' + index + '.webp?' + query;
        },
        getPublicUsers: function () {
            return Promise.resolve(USERS.slice());
        },
        // Mirrors the real passwordless flow this project relies on: a
        // blank password against a household member's account.
        authenticateUserByName: function (username, password) {
            var user = USERS.filter(function (candidate) { return candidate.Name === username; })[0];
            if (!user || password !== '') {
                return Promise.reject(new Error('authentication failed'));
            }
            currentUserId = user.Id;
            return Promise.resolve({ User: user, AccessToken: 'dev-token-' + user.Id });
        },
        getCurrentUserId: function () {
            return currentUserId;
        },
        getItems: function (userId, options) {
            var items = MOVIES.filter(function (item) { return matchesFilters(item, userId, options); })
                .map(function (item) { return withUserData(item, userId); });
            var sorted = (options && options.SortBy === 'DateCreated') ? items.slice().reverse() : items;
            var limit = options && options.Limit;
            var page = typeof limit === 'number' ? sorted.slice(0, limit) : sorted;
            return Promise.resolve({ Items: page, TotalRecordCount: sorted.length });
        },
        getItem: function (userId, itemId) {
            var item = MOVIES.filter(function (entry) { return entry.Id === itemId; })[0];
            return item ? Promise.resolve(withUserData(item, userId)) : Promise.reject(new Error('item not found'));
        },
        getLocalTrailers: function (userId, itemId) {
            var item = MOVIES.filter(function (entry) { return entry.Id === itemId; })[0];
            if (!item || !item.LocalTrailerCount) return Promise.resolve([]);
            return Promise.resolve([{ Id: itemId + '-trailer', Name: item.Name + ' - Trailer' }]);
        },
        updateFavoriteStatus: function (userId, itemId, isFavorite) {
            USER_DATA[userId] = USER_DATA[userId] || {};
            USER_DATA[userId][itemId] = Object.assign({ PlaybackPositionTicks: 0, Played: false }, USER_DATA[userId][itemId], { IsFavorite: isFavorite });
            return Promise.resolve();
        },
    };

    // Real jellyfin-web doesn't define window.ApiClient the instant
    // jellyquest.js runs (see docs/rebuild-plan.md's Phase 5 boot-race
    // finding) -- window.__jqTestDelayApiClientMs lets
    // test/e2e/boot-race.spec.mjs reproduce that instead of always
    // defining it synchronously like every other test relies on.
    if (window.__jqTestDelayApiClientMs) {
        window.setTimeout(function () { window.ApiClient = apiClient; }, window.__jqTestDelayApiClientMs);
    } else {
        window.ApiClient = apiClient;
    }
})();
