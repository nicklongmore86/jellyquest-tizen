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
- A 500 ms poll restores after five seconds of continuously false
  `isPlayingVideo()`. This covers lost events and silent pre-start failures when
  that accessor goes false. Initial silent failures never hide in the first
  place (`2300-2302`, `2347-2350`, swallowed rejection at `2378-2383`).
- A nextItem stop without a subsequent start restores after 15 seconds even if
  the accessor stays true. Polling alone is insufficient: `isPlayingVideo()`
  delegates to `currentSrc()` (`968-1007`); htmlVideoPlayer reads private
  `#currentSrc` (`plugin.js:331-332`), while `components/htmlMediaHelper.js:342-360`
  resets the media element and clears public `_currentSrc`. The manager retains
  the same player on a same-player queue transition (`3483-3490`).
- No playbackerror restore: terminal error triggers stop immediately afterward
  (`3429-3431`), while changing streams suppresses stop (`1769`, `3437-3439`).
  The auto-transcode retry branch returns before manager playbackerror (`3405-3426`).

Residual gaps, explicitly accepted as limitations of this heuristic:

- A real handoff taking over 15 seconds, or a stream replacement reporting false
  for over five seconds, can show JellyQuest during loading. A later start hides
  it again. These deadlines are policy choices, **not measured startup bounds**.
- A lost/suppressed terminal stop with a permanently true accessor and no
  preceding nextItem stop remains uncovered. The poll cannot distinguish that
  from a long paused/buffering video. This could still strand the overlay; this
  patch does **not** claim an absolute never-hidden guarantee under arbitrary
  missing signals. A throwing earlier upstream callback can produce this shape.
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
handoff. Explicit fault controls model lost signals/stale accessors; they do not
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
  `node --test "test/e2e/**/*.spec.mjs"`: 249 collected cases pass.

Fail-then-pass experiment: retained the tightened fixture and new tests, replaced
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

The two browser cases already passing against master are **non-regression
guards**: pre-start resolved/rejected failure plus audio stays visible; and a
throwing focus call cannot leave the root hidden or escape into upstream Events.
The latter is vacuously visible on master because master never hides at all; its
usefulness is protecting the new restore path. The bridge's damaged-import and
idempotence sub-assertions are guards too, not independently demonstrated red
tests on master.
