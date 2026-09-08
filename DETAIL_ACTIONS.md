# JellyQuest detail actions

JellyQuest keeps Jellyfin as the playback authority. The TV UI exposes these actions only when the current item supports them:

| Action | Movies and recorded sports | Shows |
| --- | --- | --- |
| Resume | Plays the item at `UserData.PlaybackPositionTicks` when progress exists. | Resumes the most recently played in-progress episode at its saved position. |
| Continue | Not applicable. | Plays the episode immediately after the in-progress episode, or Jellyfin's Next Up episode when nothing is in progress. |
| Start Over / Restart Episode | Plays the same item at tick `0`. | Plays the in-progress episode at tick `0`. |
| Trailer | Uses Jellyfin's native trailer player. | Same behavior. |
| Highlights | Plays a separate matching special-feature item. | Not shown unless a matching feature happens to exist. |
| My List | Toggles the current Jellyfin user's Favorite state. | Same behavior. |
| More | Opens Audio, Subtitle, and conditional Version choices for this item. | Uses track identity from the primary episode and maps it to the actual Resume, Restart, or Continue episode. |

## Trailers

Jellyfin's detail controller exposes Trailer when the item has `LocalTrailerCount` **or** one or more `RemoteTrailers`, and the active player advertises `PlayTrailers` (`controllers/itemDetails/index.js:502`). Local trailers are requested with `getLocalTrailers`; remote entries are passed to Jellyfin's playback manager as URL-backed trailer items.

**JellyQuest deliberately diverges: the gate is `LocalTrailerCount > 0` only.** A film with only `RemoteTrailers` gets no Trailer action at all.

Why: jellyfin-web plays a remote trailer *in-app* through a YouTube IFrame embed — `playbackmanager.js:3891-3925` builds an Id-less pseudo-item and dispatches on `canPlayUrl`, handled by `plugins/youtubePlayer/plugin.js:251-253`, registered in `www/config.json`. MEASURED: the packaged app is loaded from a `file://` URL on both of the household's sets (see the README's "Target hardware" section), which gives it a null origin. INFERRED, and **not settleable without the television**: the YouTube IFrame API handshake is origin-governed and the plugin's own error table already includes 101/150 `YoutubeDenied`, so a null origin is expected to be refused. A second unresolved unknown, also INFERRED: the youtube container sits at `z-index: 1000`, far below `#jellyquest-root`'s `2147483000`, so even a working embed would be expected to play behind the overlay.

A button that probably does nothing visible is worse on a TV than no button, so the narrower gate stands until someone can measure the embed on real hardware. Do not widen it back to the upstream condition on inference alone.

Trailer activation goes through `playbackManager.playTrailers(item)`, guarded by `typeof` — on an item with `RemoteTrailers` **removed**.

That stripping is load-bearing, and an earlier version of this document was wrong to imply the gate alone was enough. MEASURED in the pinned build (`playbackmanager.js:3903-3916`), `playTrailers()` falls back to remote trailers whenever the **local lookup returns empty**, not when `LocalTrailerCount` is zero:

```js
if (item.LocalTrailerCount) { items = await apiClient.getLocalTrailers(...); }
if (!items?.length) { items = (item.RemoteTrailers || []).map(...); }
```

So a film with a stale `LocalTrailerCount`, or whose local trailer has been removed, would silently launch the YouTube embed despite the gate. Handing over an item with no `RemoteTrailers` removes the fallback's only source of remote URLs, so the guarantee comes from the input rather than from a branch nobody can re-verify on the hardware.

`playTrailers()` rejects with **no** argument (`playbackmanager.js:3924`), so nothing may dereference the rejection value — and a bare rejection must not be read as "no trailer available" either. The pinned build has nine bare `Promise.reject()` sites, two of them reachable from inside this call (`PlaybackErrorPlaceHolder` at `2348-2351`, `NO_MEDIA_ERROR` at `2301-2302`), so nothing distinguishes "there was no trailer" from "playing it failed". JellyQuest shows one message that names no cause.

The full item (not the list item) is what reaches `playTrailers()`: `LocalTrailerCount` and `ServerId` are read off it, and list responses carry neither `LocalTrailerCount` nor a trailer count of any kind.

## Sports highlights

Jellyfin does not define a sports-highlight media type or generate a condensed game. Its media-segment API recognizes only Intro, Outro, Recap, Preview, Commercial, and Unknown segments. Chapters can jump into the full recording, but they do not define a bounded highlight reel.

JellyQuest therefore treats highlights as real media. It requests the event's Jellyfin special features and shows Highlights only when a playable feature name contains `Highlight`, `Highlights`, `Condensed Game`, or `Game Recap`. Selecting it plays that feature from the beginning. If no matching feature is indexed, the action remains hidden.

## More menu

**Not shipped yet: the More button is not rendered.** The dialog is built in `src/overlay/screens/detail.js` but is gated off behind `TRACK_SELECTION_ENABLED = false`, because track selection has never been wired to playback — the option buttons carry no listeners, nothing stores a selection, and the play request sends only `{ ids, startPositionTicks, serverId }`. It was previously unreachable on a television anyway (`MediaStreams` is absent from list responses), so nobody has ever seen it. Rendering it now would put a genuinely dead control in front of the user for the first time. A follow-up implements selection and turns the flag on. The rest of this section describes the intended behavior once it is.

JellyQuest replaces Jellyfin's general item-management overflow with focused playback options. Audio appears only when more than one track is available. Subtitles appears when at least one subtitle exists and always includes Off. Version appears only for items with multiple media sources. When none of those choices is configurable, More is hidden.

Movies and recorded sports update Jellyfin's native hidden track selectors, so Resume and Start Over continue through Jellyfin's normal playback path. Series do not have streams of their own. JellyQuest therefore resolves the primary episode, stores choices by track identity rather than stream number, and maps those choices to the specific episode behind Resume, Restart Episode, or Continue. If an episode lacks the selected track, Jellyfin's default for that episode is used.

Queue controls, media information, downloads, deletion, and metadata administration are intentionally excluded from the household TV surface.

## Simulator detail navigation

The movie, show, and sports detail previews use an explicit focus graph:

- The persistent rail is Profile, Home, Shows, Search, Requests; Up and Down walk adjacent entries in that order.
- Profile moves down into the left rail. Home moves down to the primary playback action, and Requests moves down to More.
- Left and Right remain within the action row. Left from the primary action enters the rail; Right stops at More.
- Up from the first half of the action row reaches Home. Up from the second half reaches Requests.
- Down distributes action buttons across the lower collection, episode, or chapter row. On show details, Down from More reaches the Season selector, then the last episode.
- Lower cards move horizontally within their visual row. Up returns to the aligned action, Down advances only when another card row exists, and Down stops on the final row.
- Every vertical transition remembers its origin: returning in the opposite direction restores the exact previous control.
- Playback-option dialogs contain focus. Up and Down move one option, Right stays put, and Left or Back returns one level before closing and restoring More.
