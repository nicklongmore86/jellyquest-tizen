// A fake window.ApiClient with representative Jellyfin data (profiles and
// library items), matching the method names and shapes real jellyfin-web
// code calls on the genuine ApiClient (jellyfin-apiclient-javascript).
// Screens built against this in the simulator should work unmodified
// against the real ApiClient once packaged.
(function () {
    'use strict';

    var TICKS_PER_SECOND = 10000000;

    // Every BaseItemDto a real Jellyfin server returns carries ServerId, and
    // jellyfin-web's playback path depends on it: playbackManager.play()
    // needs a serverId to resolve `ids` into items
    // (playbackmanager.js:2101-2111), and when `items` are passed directly it
    // reads the id straight off the first item
    // (translateItemsForPlayback, playbackmanager.js:1810). Fixture items
    // used to omit it, which is exactly what let a serverId-less play() call
    // look correct in the simulator.
    var SERVER_ID = 'dev-server-1';

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
            // BOTH a local trailer and a remote one, which real servers do.
            // This is the hazardous shape: upstream playTrailers() falls back
            // to RemoteTrailers whenever the LOCAL LOOKUP is empty, so a
            // stale LocalTrailerCount on an item like this is what would
            // launch the YouTube embed. It lives in the fixture rather than
            // in one test's setup so the hazard is permanently present.
            RemoteTrailers: [{ Url: 'https://www.youtube.com/watch?v=dev-long-winter', Name: 'The Long Winter - Official Trailer' }],
            // The only fixture item with multiple tracks -- exercises the
            // conditionally-shown More/Playback Options menu.
            MediaStreams: [
                { Type: 'Audio', DisplayTitle: 'English 5.1' },
                { Type: 'Audio', DisplayTitle: 'French Stereo' },
                { Type: 'Subtitle', DisplayTitle: 'English' },
                { Type: 'Subtitle', DisplayTitle: 'French' },
            ],
        },
        // The RemoteTrailers-only case. Real servers return this shape, and
        // upstream jellyfin-web would offer a Trailer button for it;
        // JellyQuest deliberately does not (see detail.js's trailer gate),
        // so the fixture has to contain one for that divergence to be
        // testable at all.
        {
            Id: 'movie-2', Name: 'Quiet Signal', ProductionYear: 2022, RunTimeTicks: 6300 * TICKS_PER_SECOND,
            Overview: 'A radio operator picks up a transmission that shouldn’t exist.', LocalTrailerCount: 0,
            RemoteTrailers: [{ Url: 'https://www.youtube.com/watch?v=dev-quiet-signal', Name: 'Quiet Signal - Official Trailer' }],
        },
        { Id: 'movie-3', Name: 'Low Tide', ProductionYear: 2020, RunTimeTicks: 5700 * TICKS_PER_SECOND, Overview: 'Two sisters return to the coastal town they swore they’d never see again.', LocalTrailerCount: 1 },
        { Id: 'movie-4', Name: 'Static Bloom', ProductionYear: 2024, RunTimeTicks: 6900 * TICKS_PER_SECOND, Overview: 'An artist’s final installation starts finishing itself.', LocalTrailerCount: 0 },
        { Id: 'movie-5', Name: 'Harbor Lights', ProductionYear: 2023, RunTimeTicks: 6600 * TICKS_PER_SECOND, Overview: 'A lighthouse keeper’s last winter on the job.', LocalTrailerCount: 0 },
        { Id: 'movie-6', Name: 'Field Notes', ProductionYear: 2021, RunTimeTicks: 5400 * TICKS_PER_SECOND, Overview: 'A biologist’s survey of a valley nobody else wants to study.', LocalTrailerCount: 0 },
        { Id: 'movie-7', Name: 'Second Frost', ProductionYear: 2019, RunTimeTicks: 6300 * TICKS_PER_SECOND, Overview: 'A late-season storm strands a family at the edge of town.', LocalTrailerCount: 0 },
        { Id: 'movie-8', Name: 'The Long Way Round', ProductionYear: 2018, RunTimeTicks: 7200 * TICKS_PER_SECOND, Overview: 'A road trip that keeps finding reasons not to end.', LocalTrailerCount: 1 },
        { Id: 'movie-9', Name: 'Blue Hour', ProductionYear: 2025, RunTimeTicks: 6000 * TICKS_PER_SECOND, Overview: 'Everything important happens in the twenty minutes after sunset.', LocalTrailerCount: 0 },
        { Id: 'movie-10', Name: 'Open Water', ProductionYear: 2017, RunTimeTicks: 5100 * TICKS_PER_SECOND, Overview: 'A rescue crew’s last call of the season.', LocalTrailerCount: 0 },
    ].map(function (movie) {
        return Object.assign({
            Type: 'Movie',
            ServerId: SERVER_ID,
            ImageTags: { Primary: 'preview-v1' },
            IsFolder: false,
            ParentId: 'movies',
            DateCreated: '2026-08-' + ('0' + movie.Id.split('-')[1]).slice(-2) + 'T00:00:00Z',
        }, movie);
    });

    // Root views reproduce the measured unscoped /Users/{id}/Items response.
    var FOLDERS = [
        { Id: 'collections', Name: 'Collections', Type: 'CollectionFolder', CollectionType: 'boxsets' },
        { Id: 'movies', Name: 'Movies', Type: 'CollectionFolder', CollectionType: 'movies' },
        { Id: 'shows', Name: 'Shows', Type: 'CollectionFolder', CollectionType: 'tvshows' },
        { Id: 'sports', Name: 'Sports', Type: 'CollectionFolder', CollectionType: 'tvshows' },
        { Id: 'playlists', Name: 'Playlists', Type: 'ManualPlaylistsFolder', CollectionType: 'playlists' },
    ].map(function (item) {
        return Object.assign({ IsFolder: true, ServerId: SERVER_ID, ImageTags: {} }, item);
    });

    var MEDIA = MOVIES.slice();
    // 54 Movie/Series entries exceed both Home's 8 and Library's 50 cap.
    // Generated dates keep movie-10 newest, with a Series beside it.
    var i;
    for (i = 1; i <= 44; i++) {
        MEDIA.push({ Id: 'series-' + i, Name: 'Northern Stories ' + i, Type: 'Series',
            IsFolder: true, ParentId: 'shows', ServerId: SERVER_ID,
            ImageTags: { Primary: 'preview-v1' },
            DateCreated: i === 1 ? '2026-08-09T12:00:00Z' : '2025-01-01T00:00:00Z' });
    }
    // 33/37 seasons have Primary (89.2% rounded).
    for (i = 1; i <= 37; i++) {
        MEDIA.push({ Id: 'season-' + i, Name: 'Season ' + i, Type: 'Season',
            IsFolder: true, ParentId: 'series-1', SeriesId: 'series-1', SeriesName: 'Northern Stories 1',
            IndexNumber: i, ServerId: SERVER_ID, ImageTags: i <= 33 ? { Primary: 'preview-v1' } : {} });
    }
    // 515/700 Primary (73.6%); 699/700 parent backdrops (99.86%).
    for (i = 1; i <= 700; i++) {
        MEDIA.push({ Id: 'episode-' + i, Name: (i <= 30 ? 'Quiet Signal Episode ' : 'Northern Journey ') + i, Type: 'Episode',
            IsFolder: false, ParentId: 'season-1', SeriesId: 'series-1', SeriesName: 'Northern Stories 1',
            ParentIndexNumber: 1, IndexNumber: i, ServerId: SERVER_ID,
            RunTimeTicks: 2700 * TICKS_PER_SECOND,
            ImageTags: i <= 515 ? { Primary: 'preview-v1' } : {},
            ParentBackdropItemId: 'series-1', ParentBackdropImageTags: i < 700 ? ['backdrop-v1'] : [] });
    }

    // Per-user UserData (playback progress, favorites) -- keyed by user id
    // then item id, matching how real per-profile state works.
    var USER_DATA = {
        'user-alice': {
            'episode-516': { LastPlayedDate: '2026-09-05T12:00:00Z', PlaybackPositionTicks: 600 * TICKS_PER_SECOND, Played: false, IsFavorite: false },
            'movie-1': { LastPlayedDate: '2026-09-06T12:00:00Z', PlaybackPositionTicks: 40 * 60 * TICKS_PER_SECOND, Played: false, IsFavorite: false },
            'movie-3': { LastPlayedDate: '2026-09-04T12:00:00Z', PlaybackPositionTicks: 300 * TICKS_PER_SECOND, Played: false, IsFavorite: false },
            'movie-5': { PlaybackPositionTicks: 0, Played: true, IsFavorite: true },
        },
        'user-bob': {},
        'user-charlie': {},
    };

    // ---- What a LIST response actually contains -------------------------
    //
    // Same principle as the getItems option guard below, in the other
    // direction: that stops the fixture ACCEPTING options the real server
    // rejects; this stops it RETURNING fields the real server does not
    // return.
    //
    // MEASURED against the household's Jellyfin 10.11.11 server, the app's
    // own library query returns exactly the fields below and NOT Overview,
    // LocalTrailerCount, MediaStreams or MediaSources. The fixture used to
    // hand all of those back on list results, which is precisely what let
    // the Detail screen read Overview/LocalTrailerCount/MediaStreams off a
    // list item and pass every test while showing none of them on the real
    // television.
    //
    // The rich objects above stay intact -- getItem() returns them whole, as
    // the real single-item endpoint does. Only the LIST projection is
    // narrowed.
    var LIST_FIELDS = [
        // The measured set, verbatim.
        'Name', 'Id', 'ServerId', 'Type', 'IsFolder', 'HasSubtitles', 'Container',
        'PremiereDate', 'CriticRating', 'OfficialRating', 'CommunityRating',
        'RunTimeTicks', 'ProductionYear', 'UserData', 'VideoType', 'ImageTags',
        'BackdropImageTags', 'ImageBlurHashes', 'LocationType', 'MediaType',
        // Relational fields the measured responses carry for the item types
        // that have them, asserted by test/e2e/library-queries.spec.mjs.
        'ParentId', 'DateCreated', 'SeriesId', 'SeriesName', 'ParentIndexNumber',
        'IndexNumber', 'ParentBackdropItemId', 'ParentBackdropImageTags',
        // Root views only: the measured unscoped /Users/{id}/Items response
        // returns CollectionType on each CollectionFolder. It is not part of
        // the library query's field set because no library item has one.
        'CollectionType',
    ];

    function projectListFields(item) {
        var projected = {};
        LIST_FIELDS.forEach(function (field) {
            if (Object.prototype.hasOwnProperty.call(item, field)) projected[field] = item[field];
        });
        return projected;
    }

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
            // Unknown/parent IDs reuse a real placeholder instead of a NaN path.
            var match = /^movie-([1-9][0-9]*)$/.exec(String(itemId || ''));
            var number = match ? Number(match[1]) : 1;
            var index = isFinite(number) ? (number - 1) % 3 + 1 : 1;
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
        // Real ApiClient's documented accessor for the connected server's id
        // (see .cache/jellyfin-web/src/apiclient.d.ts:270); jellyfin-web
        // itself falls back to it for an item with no ServerId of its own
        // (apps/stable/features/playback/utils/mediaSegmentManager.ts:91).
        serverId: function () {
            return SERVER_ID;
        },
        getItems: function (userId, options) {
            options = options || {};
            var modeled = ['Recursive', 'ParentId', 'IncludeItemTypes', 'Filters', 'SearchTerm', 'SortBy', 'SortOrder', 'StartIndex', 'Limit'];
            Object.keys(options).forEach(function (key) {
                if (modeled.indexOf(key) === -1) throw new Error('Unmodeled getItems option: ' + key);
            });
            if (options.Recursive !== undefined && typeof options.Recursive !== 'boolean') throw new Error('Unmodeled Recursive');
            if (options.Filters !== undefined && options.Filters !== 'IsResumable') throw new Error('Unmodeled Filters');
            if (options.SortBy !== undefined && options.SortBy !== 'DateCreated' && options.SortBy !== 'DatePlayed') throw new Error('Unmodeled SortBy');
            if (options.SortOrder !== undefined && options.SortOrder !== 'Ascending' && options.SortOrder !== 'Descending') throw new Error('Unmodeled SortOrder');
            if (options.SortOrder && !options.SortBy) throw new Error('SortOrder requires SortBy');
            if (options.Limit !== undefined && (typeof options.Limit !== 'number' || options.Limit < 0 || options.Limit % 1 !== 0)) throw new Error('Unmodeled Limit');
            // StartIndex is modeled because the Library screen pages with it.
            // It stays as strict as Limit: the app only ever sends a
            // non-negative integer, so a string, a float or a negative offset
            // is still an unmodeled option and still throws.
            if (options.StartIndex !== undefined && (typeof options.StartIndex !== 'number' || options.StartIndex < 0 || options.StartIndex % 1 !== 0)) throw new Error('Unmodeled StartIndex');
            if (options.SearchTerm !== undefined && typeof options.SearchTerm !== 'string') throw new Error('Unmodeled SearchTerm');
            var types = options.IncludeItemTypes === undefined ? null : options.IncludeItemTypes.split(',');
            if (types) types.forEach(function (type) {
                if (['Movie', 'Series', 'Season', 'Episode', 'CollectionFolder', 'ManualPlaylistsFolder'].indexOf(type) === -1) throw new Error('Unmodeled IncludeItemTypes: ' + type);
            });
            var all = FOLDERS.concat(MEDIA);
            if (options.ParentId !== undefined && !all.some(function (item) { return item.Id === options.ParentId && item.IsFolder; })) throw new Error('Unmodeled ParentId');
            var scoped = options.Recursive || options.ParentId;
            var candidates = scoped ? MEDIA : FOLDERS;
            // Reproduce measured search crowding: episodes can precede films.
            // Thirty Quiet Signal episodes bury the matching movie past 24.
            if (scoped && options.SearchTerm) {
                candidates = candidates.filter(function (item) { return item.Type === 'Episode'; })
                    .concat(candidates.filter(function (item) { return item.Type !== 'Episode'; }));
            }
            var items = candidates.filter(function (item) {
                if (types && types.indexOf(item.Type) === -1) return false;
                if (options.ParentId) {
                    var parentId = item.ParentId;
                    while (parentId && parentId !== options.ParentId && options.Recursive) {
                        var parent = all.filter(function (entry) { return entry.Id === parentId; })[0];
                        parentId = parent && parent.ParentId;
                    }
                    if (parentId !== options.ParentId) return false;
                }
                // The measured root response ignores IsResumable and returns views.
                return matchesFilters(item, userId, scoped ? options : { SearchTerm: options.SearchTerm });
            }).map(function (item) { return withUserData(item, userId); });
            var sorted = items.slice();
            if (options.SortBy) sorted.sort(function (a, b) {
                // DatePlayed is per-user history, not the library's creation date.
                var aDate = options.SortBy === 'DatePlayed' ? a.UserData.LastPlayedDate : a.DateCreated;
                var bDate = options.SortBy === 'DatePlayed' ? b.UserData.LastPlayedDate : b.DateCreated;
                var order = (aDate || '').localeCompare(bDate || '') || a.Id.localeCompare(b.Id);
                return options.SortOrder === 'Descending' ? -order : order;
            });
            var limit = options && options.Limit;
            // MEASURED against Jellyfin 10.11.11: an EXPLICIT StartIndex
            // offsets into the sorted result -- two full sweeps of all 680
            // movies across 14 pages returned 680 collected / 680 distinct /
            // identical order, matching a single 2500-item reference fetch.
            //
            // INFERRED, not measured: that TotalRecordCount reports the whole
            // match count rather than the returned page's length. It is how
            // jellyfin-web reads the field and what the Search screen's
            // truncation message already assumed before this change, but no
            // probe here established it.
            //
            // CONVENTIONAL, not measured: that an OMITTED StartIndex means
            // zero. The server's OpenAPI document marks startIndex optional
            // with no specified default, and an attempt to probe the live
            // server for it returned 401. The fixture defaults it to zero
            // because that is the near-universal convention for an offset
            // parameter -- and nothing in the app relies on it, because
            // library.js always sends a numeric StartIndex.
            var start = typeof options.StartIndex === 'number' ? options.StartIndex : 0;
            var page = typeof limit === 'number' ? sorted.slice(start, start + limit) : sorted.slice(start);
            return Promise.resolve({ Items: page.map(projectListFields), TotalRecordCount: sorted.length });
        },
        // The single-item endpoint, and the only place the full BaseItemDto
        // exists. MEASURED: GET /Users/{id}/Items/{itemId} with NO Fields
        // parameter is 17,153 bytes and already carries Overview,
        // MediaStreams, LocalTrailerCount and RemoteTrailers -- so no field
        // projection here, unlike getItems above.
        getItem: function (userId, itemId) {
            var item = FOLDERS.concat(MEDIA).filter(function (entry) { return entry.Id === itemId; })[0];
            return item ? Promise.resolve(withUserData(item, userId)) : Promise.reject(new Error('item not found'));
        },
        getLocalTrailers: function (userId, itemId) {
            var item = FOLDERS.concat(MEDIA).filter(function (entry) { return entry.Id === itemId; })[0];
            if (!item || !item.LocalTrailerCount) return Promise.resolve([]);
            return Promise.resolve([{ Id: itemId + '-trailer', Name: item.Name + ' - Trailer', Type: 'Trailer', ServerId: SERVER_ID }]);
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
