# Playback overlay handoff (1.0.5 source)

Investigation and implementation use master `e897658` and pinned jellyfin-web
`35c0793ece3adbd247eab290ae1effab851f3d37`. Upstream paths below are relative to
`.cache/jellyfin-web/src/`; line numbers refer to that pinned checkout. No TV or
sdb was used. “Measured” below means local source or browser measurement, not
hardware measurement.

## Verified cause

`plugins/htmlVideoPlayer/plugin.js:1620-1663` creates a fullscreen div and inserts
it before body's first child; `style.scss:11-13` sets its onTop z-index to 1000.
The existing built `www/htmlVideoPlayer-style-scss.6919e19d581252e83cdd.css` has
that same rule. `components/playback/playbackmanager.js:647` defaults fullscreen
to true. JellyQuest appends its later sibling root at boot; `src/overlay/app.css:24-48`
gives it an opaque #14161a background and z-index 2147483000. Repository root
references contain no existing hide/transparent/remove mechanism. This reproduces
the layering reasoning; a new browser test also measures hit-testing against a
fullscreen earlier sibling at z-index 1000.

## Choice and recovery contract

`src/overlay/app.js:368-470` subscribes once during script boot. The patched
singleton publishes a narrow Events.on bridge and immediately calls the boot
handshake if the overlay loaded first. If upstream loaded first, overlay boot
calls the same handshake. Neither direction waits for a Play request. The patch
checks the singleton and Events import, rejects a partially changed bridge, and
is idempotent. It was also applied twice to temporary copies of the real pinned
three upstream files, without changing the shared cache.

The shipped load order is a positive, load-bearing property:
`gulpfile.babel.js:129-132` injects deferred jellyquest.js before the apploader.
Thus JellyQuestBindPlayback exists when the singleton evaluates and the bridge
subscribes immediately, ahead of later module-level subscribers. Changing script
injection order would silently lose this ordering protection; the two-way
handshake guarantees subscription in either order, **not** priority in both.

There is an important exception to the review's claim that our listener is FIRST:
`playbackmanager.js:3726-3727` binds constructor subscribers before the exported
`new PlaybackManager()` finishes (`4290`), hence before the bridge runs.
`components/playback/skipsegment.ts:192-202` defines onPlaybackStop and constructs
SkipSegment; its base class registers that manager handler in
`apps/stable/features/playback/utils/playbackSubscriber.ts:46-52,83-93`.
Consequently SkipSegment's manager playbackstop callback is ahead of ours even
in the normal injection order. `utils/events.ts:41-46` has no listener isolation,
and manager stop dispatch (`playbackmanager.js:3480`) precedes player removal
(`3485-3489`). A throw in an earlier listener can both skip our restore and prevent
_currentPlayer clearing. Load order protects against later module listeners, but
cannot honestly make that failure unreachable. No constructor/bridge change is
made in this documentation/test follow-up.

Only a video `playbackstart` hides the root, using `display: none`. This removes
all descendants from paint, hit tests and focus eligibility. `visibility: hidden`
would avoid subtree layout on restore, but a future visible descendant could
paint over video; display:none cannot have that failure. Restore does incur
subtree layout, including the geometry reads used to find a usable focus target.
M63 restore latency is **unmeasured**, not claimed to fit a frame budget. Existing
Series windowing bounds that screen, but other screens may have larger trees.
No CSS, grid, version, focus.js, library.js or series.js changes are included.

Focus is recorded on actual overlay focus placement, synchronously after the
browser has placed it and before yielding to any async work. This preserves the
last user selection even if upstream moves focus before playbackstart. On
restore, unhiding is the first statement inside try, before any focus work.
An attached, enabled launch control with a layout box is preferred; otherwise a
visible enabled control in the current root is used. Callback exceptions are
contained because `utils/events.ts:41-46` does not isolate listeners.

The union of signals is:

- Terminal stop restores immediately; cancellation restores without waiting for
  stop (`playbackmanager.js:2386-2394`, `3437-3481`).
- Stop with nextItem retains the video surface. Queue/cinema intro transitions
  and second play/player switching use this shape (`261-275`, `3450-3481`,
  `3520-3541`). A subsequent video start clears the handoff deadline.
- The permanent, unconditional poll runs every 1000 ms. Its five-second idle
  branch covers removal of the current video player: removeCurrentPlayer calls
  setCurrentPlayerInternal(null) (`929-935`), which assigns _currentPlayer (`950`).
  Reachable cases include player swap (video->audio nextItem), cancellation
  (`2386-2394`), and a lost/suppressed terminal notification when removal completes.
  Cancellation normally restores immediately through its event; polling is the
  backstop if that notification is lost. Audio playback remains non-video after
  its own start. Initial silent failures never hide in the first place
  (`2300-2302`, `2347-2350`, swallowed rejection at `2378-2383`).
- A nextItem stop without a subsequent start restores after 15 seconds even if
  the accessor stays true. Polling alone is insufficient: `isPlayingVideo()`
  delegates to `currentSrc()` (`968-1007`); htmlVideoPlayer reads private
  `#currentSrc` (`plugin.js:331-332`), while `components/htmlMediaHelper.js:342-360`
  resets the media element and clears public `_currentSrc`. The manager retains
  the same player on a same-player queue transition (`3483-3490`). #currentSrc
  is assigned at plugin.js:431/473/549 and never cleared; htmlMediaHelper.js:358
  clears the unread _currentSrc. Thus the 15-second deadline is the ONLY recovery
  for same-player video->video handoff without a new start.
- No playbackerror restore: terminal error triggers stop immediately afterward
  (`3429-3431`), while changing streams suppresses stop (`1769`, `3437-3439`).
  The auto-transcode retry branch returns before manager playbackerror (`3405-3426`).

The ordinary recovery shapes are disjoint: same-player video->video retains a
true accessor and uses the 15-second deadline; removal/non-video replacement
reports false and uses the five-second idle branch. They do not race: one
permanent callback checks them sequentially, and restore disables further checks.
A nextItem timestamp can also be armed during an audio swap, but its idle recovery
normally completes first and clears it. The timer remains permanent to avoid a
hide-without-started-timer or clear-without-restore strand class; only cadence
changed from 500 to 1000 ms, halving wakeups without changing either deadline.

A normal htmlVideoPlayer stream replacement is **not** an idle recovery case.
changeStreamToUrl sets isChangingStream (`1769`); createStreamInfo retains the
current item's Video type (`1744`), and setSrcIntoPlayer replaces streamInfo
(`1784-1789`) while #currentSrc retains the old URL. isPlayingVideo therefore
stays true throughout replacement and the five-second debounce cannot fire.
The existing app.js timer comment's generic “stream-change gaps” wording should
not be read as a reachable false accessor for this pinned local player; source
changes in this follow-up are restricted to the interval constant.

Two additional compatibility caveats:

- getPlayerState returns a self-managing player's own state (`2159-2161`) rather
  than assembling local state. For a non-local/cast player that omits
  NowPlayingItem.MediaType, the Video gate silently does nothing. JellyQuest has
  no cast UI; this remote shape is not modelled in the fixture.
- onPlaybackChanging clears getPlayerData(activePlayer).streamInfo (`3526`)
  before manager playbackstop (`3534`). getPlayerData returns the player itself
  (`2134-2150`); with a retained current source, isPlayingMediaType dereferences
  null streamInfo.mediaType (`987-988`) and throws TypeError. app.js:635-637
  deliberately logs and returns false, the safe recovery direction. During a
  stalled switch this can console.error at the 1000 ms poll cadence until the
  idle clock expires (or a new valid state arrives). This caught-error false is
  distinct from the normal accessor's false-on-player-removal shape above.

Residual gaps, explicitly accepted as limitations of this heuristic:

- A same-player video handoff without a new start for 15 seconds restores
  JellyQuest; a removed video player remaining absent/non-video for five seconds
  also restores it. A later video start hides it again. These deadlines are
  policy choices, **not measured startup bounds**. They do not interrupt a
  normal htmlVideoPlayer stream replacement.
- A lost/suppressed terminal stop with a permanently true accessor and no
  preceding nextItem stop remains uncovered. The poll cannot distinguish that
  from a long paused/buffering video. This could still strand the overlay; this
  patch does **not** claim an absolute never-hidden guarantee under arbitrary
  missing signals. The constructor-bound SkipSegment exception above means a
  throwing earlier callback can produce this shape even in normal script order.
- Frozen/throttled JS delays all timer recovery. No timeout can repair a dead
  event loop. Playback beginning before either script's boot handshake is not
  replayed; normal JellyQuest launches occur after boot.
- A throwing focus implementation leaves the root visible but may leave focus
  on body. The fault-injection test verifies visibility/exception containment,
  not successful focus when the platform focus API itself throws.

## Back and transport controls

**Measured source:** `scripts/keyboardNavigation.js:171,216-230` dispatches Back
through inputManager. `scripts/inputManager.js:80-90` dispatches a cancelable
command and returns when canceled. Video `controllers/playback/video/index.js:468-474`
hides the OSD and prevents the command if the OSD is visible and no dialog is
open. The next Back reaches `inputManager.js:112-114` and `appRouter.back()`.
Video state enables stop-on-back (`index.js:514-522,1607-1612`); viewbeforehide
calls playbackManager.stop (`1595-1604`). The OSD starts visible on viewshow
(`1672-1681`) and also has a hide timer (`274-303,377-386`).

The load-bearing return guarantee is the **/video history push**, not just the
Back handler: components/router/appRouter.js:469-471 calls show('video'), which
normalizes the route and history.push-es it (`84-99`). routerHistory.ts:45-46
navigates without replace; the pinned @remix-run/router/dist/router.js:377 calls
window.history.pushState. /video is not in START_PAGE_PATHS
(['/home', '/login', '/selectserver'], appRouter.js:16), so canGoBack('/video')
(`124-132`) reaches window.history.length > 1, guaranteed by that push. Therefore
the second Back returns from playback to JellyQuest rather than quitting.
If an upstream bump instead presents video as a dialogHelper overlay without
pushing /video, the underlying route can remain a start page: once its dialog
is dismissed, canGoBack returns false and inputManager's exit branch can quit
instead of return. No local simulator test would catch that router regression.

**Inferred TV experience:** with controls visible and no dialog, two presses:
first leaves the film playing with controls hidden; second exits playback and
restores JellyQuest and its focus. If controls have auto-hidden, one press exits.
Upstream dialogs/menus may need their own dismissal first. This is not a measured
Tizen key count, and the simulator deliberately does not invent a fake router/OSD.

**Modal ordering hazard:** Detail's Play/Resume/Start Over are plain actions
(`src/overlay/screens/detail.js:114-138`); More is disabled (`234-240`), so its
options modal cannot normally launch or overlap playback. Series actions also
launch outside a modal (`series.js:458-470`), and season selection closes its menu
before changing season (`283-288`). However Play is asynchronous and controls
remain usable before start: Series can open its season menu while Play is pending
(`296-310`). A browser test measures this with the real Series screen and a held
Play request. Deferring Back before closeOnBack while playback is hidden fixes
that reachable race. On stop, the still-open modal and its selected option return.

**Transport controls:** upstream OSD remains available; showMainOsdControls
focuses the pause button when current focus is invalid (`index.js:331-355`).
Directional commands call focusManager.moveUp/Down/Left/Right
(`scripts/inputManager.js:93-105`); TV keyboard handling reveals controls and
supports seek/pause (`index.js:1243-1265`). Thus D-pad transport navigation on M63
is **inferred**, not measured. Actual Tizen key delivery, TV layout selection,
upstream focus timing, interaction between upstream navigation and our globally
installed spatial polyfill, decoder/compositor behaviour and restore latency
all require physical hardware. The simulator loads no upstream bundle; it can
certify these tests while any of those TV behaviours remains broken.

## Fixture and verification

The lifecycle fixture uses synchronous Events-style dispatch and real argument
positions, including start, terminal/nextItem stop, cancellation, error then stop,
and stream-change suppression. It retains the old playing state on same-player
handoff, but a local video->audio nextItem removes the video player after stop
dispatch. Player selection filters canPlayMediaType (playbackmanager.js:2978-2994);
htmlVideoPlayer accepts only Video (plugin.js:1717-1718), htmlAudioPlayer accepts
only Audio (plugin.js:400-401), and the different-player branch removes the old
player (playbackmanager.js:3485-3489). The new browser case asserts false directly
after that stop, starts audio, and verifies idle restoration with usable focus
before the 15-second handoff deadline. Explicit fault controls model lost signals/stale accessors; they do not
claim guessed decoder outcomes. It does not model network/codec timing, remote
player delegation, the full playbackstop state payload, OSD/router/focus, or all
invalid-options cases. The geometry witness is a test-only div, not a fake player.

Three pre-existing Detail tests timed out after fixture tightening because they
clicked hidden controls: enrichment-failure Play then My List; Resume then Start
Over; item-server request then navigation to test server fallback. Each now ends
playback before the next overlay interaction; every original assertion remains.
Those timeouts are fixture-fidelity discoveries, **not** fail-then-pass assertion
evidence for the new fix.

Final gates (all exit 0):

- `npx eslint .` — repository-wide lint, including ES5 parsing of
  `src/overlay/app.js` and `dev/fixtures/playback-manager-stub.js`. No separate
  typecheck script/config exists in this JavaScript repository.
- `npm test` — `test/configuration.test.mjs`: 18 collected cases pass, including
  committed bundle drift and bridge idempotence/import-drift checks.
- `npm run test:e2e` — builds the overlay and runs
  `node --test "test/e2e/**/*.spec.mjs"`: 250 collected cases pass.

Original PR fail-then-pass experiment (before cross-review strengthening): retained the tightened fixture and new tests, replaced
`src/overlay/app.js` with `git show master:src/overlay/app.js`, regenerated the
bundle, and ran `node --test test/e2e/playback-overlay.spec.mjs`. Result: 10
collected cases, 8 assertion failures, 2 passes. Example actual result on master:
`{ hidden: false, overlayFocus: true, painted: true }`; expected after video start:
`{ hidden: true, overlayFocus: false, painted: false }` (`ERR_ASSERTION`, not a
timeout). Restored the fix and regenerated: all 10 pass, also included in the
249-case full run. The real Series modal test also fails on an explicit hidden
state assertion against master.

Separately replaced the patcher with master's version and ran `npm test`: 17
passes, one assertion failure, because the new bridge test could not find
`Events.on(playbackManager, type, callback)`. Restoring the patcher gives 18 passes.

The two original browser cases already passing against master remain labelled
**non-regression guards**: pre-start resolved/rejected failure plus audio stays visible; and a
throwing focus call cannot leave the root hidden or escape into upstream Events.
The original latter test was vacuously visible on master because master never
hides at all. Cross-review strengthened it to assert that the poisoned focus
function really executes; the historical two-pass baseline is not a claim that
this strengthened assertion passes master. The bridge's damaged-import and
idempotence sub-assertions are guards too, not independently demonstrated red
tests on master.


Cross-review mutation proof: temporarily moved root.style.display = '' from the
first to the last statement of restore's try, regenerated the bundle, and ran:

```sh
node --test --test-name-pattern='restore unhides before a throwing focus call' test/e2e/playback-overlay.spec.mjs
```

The mutant exits 1 with one collected case, one ERR_ASSERTION:
“restore must unhide before measuring the poisoned focus target”, false !== true.
The throwing focus stub sets a flag before throwing, so zero client rects can no
longer silently bypass the property. Restored the original production function,
regenerated, and reran the exact command: exit 0, one case passes. No mutant is
committed. This is mutation evidence for the non-regression guard, not a new
claim about the historical master comparison.

The interval change exposed one cadence-sensitive existing case (lost stop plus
detached focus) and the new audio case: the running Playwright clock's first
sample included setup wall time, yielding 4.956s between first and sixth samples
in a 6s advance. setup now pauses the fake clock after asynchronous boot. Both
cases use the same 5s debounce and 6s advance; no production deadline was changed
to make a test pass. All 11 playback-overlay cases pass at 1000 ms.

Real-upstream patch test assessment: CI's .github/workflows/jellyquest-check.yml installs this
repository and runs npm test but never fetches the pinned upstream checkout.
The synthetic configuration fixture tests patch transformations/drift guards,
not that the current .jellyfin-web-ref still matches actual upstream source.
A cache-dependent test would skip precisely where verification matters. No
skipping test was added. This remains an explicit CI coverage gap; maintaining
real-source CI coverage needs an unconditional pinned checkout or checked-in
upstream inputs with a mechanism to keep them tied to the ref. A warning on a
skip is too easy to overlook in otherwise-green output. The real build has a
separate protection: scripts/build.sh:1,13-15 uses set -e and invokes the patcher
on the checked-out ref before compilation. Anchor drift fails that build loudly;
it does not silently succeed when this build path is used. Ordinary npm test
alone does not provide that evidence, nor detect behavioural drift that retains
all anchors. Manual application to real pinned temporary copies remains local
evidence, not a CI guarantee.

Minor selector suggestion declined: app.js's [tabindex="0"] would miss a future
positive tabindex, whereas focus.js accepts any tabindex except -1. No overlay
source currently sets tabindex; current focusable controls are covered by the
button/link alternatives. Leave the reviewed production selector unchanged in
this follow-up; revisit it if such controls are introduced.

Audio fixture proof: with only its new Audio-removal condition temporarily
reverted, `node --test --test-name-pattern='video to audio removes'
test/e2e/playback-overlay.spec.mjs` exits 1 on “a local audio nextItem must remove
the video player”, true !== false. This is an accessor assertion before any clock
advance, not a timeout. Restoring the cited fixture condition passes the case.
