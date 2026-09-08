# Card artwork decisions and evidence

## Client and HTTP contract

Research used `.jellyfin-web-ref` = `35c0793ece3adbd247eab290ae1effab851f3d37`.
The cache was absent from this worktree, so the existing pinned checkout was
copied into this worktree's ignored `.cache/jellyfin-web`; its HEAD matches.

- Pinned `src/lib/jellyfin-apiclient/ServerConnections.js:4,60-68,85-88`
  imports/constructs `ApiClient` and assigns it to `window.ApiClient`.
- Pinned `package.json:111` and `package-lock.json:14105-14109` resolve
  `jellyfin-apiclient@1.11.0`. Research unpacked that exact npm tarball into
  `.cache/apiclient/package`. Its distributed source map contains the actual
  `src/apiClient.js` (extracted as `.cache/apiclient/apiClient.js`).
- That **real client source**, `src/apiClient.js:2479-2518`, defines
  `getImageUrl(itemId, options)`: type/index become path components, quality
  defaults to 90 for Primary, and remaining options become query parameters.
  It mutates the options object, so the overlay passes a fresh object each time.
  `maxWidth`/`maxHeight` preserve aspect ratio inside the requested bounds;
  `width`, `height`, `fillWidth`, `fillHeight`, `quality`, and `index` are also
  documented there. `tag` and `format` pass through the generic serializer at
  `src/apiClient.js:56-66,246-270` (not an allowlist).
- The pinned host's normalization at `ServerConnections.js:15-19,51-53`
  only fills a missing quality; it does not remove format or resize bounds.
- Parent fallback follows pinned
  `src/components/cardbuilder/cardBuilder.js:327-331`: `SeriesId` plus
  `SeriesPrimaryImageTag`. Own `ImageTags.Primary` wins, including episodes.
  Missing parent metadata yields text; no metadata-fetch fan-out is introduced.

Example actual client output (server address includes any configured base path):

```text
https://server.example/jellyfin/Items/movie-id/Images/Primary?tag=image-tag&maxWidth=220&maxHeight=330&quality=80&format=webp
```

The browser issues an image GET to that client-built URL. No handcrafted server
URL, original-image request, native lazy attribute, or API token construction is
used by the overlay. Episode bounds are 220×124 (16:9 rounded to whole pixels).

## Decoder and endpoint research

| Format/API | M63 and M69 evidence | Decision |
| --- | --- | --- |
| WebP | [Can I Use](https://caniuse.com/webp): full Chrome support from 32. [Google WebP FAQ](https://developers.google.com/speed/webp/faq) documents Chrome decoding. [Samsung Web Engine Specifications](https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html), Multimedia table, lists WebP. | Explicit `format=webp`, quality 80. |
| AVIF | [Can I Use](https://caniuse.com/avif): Chrome 85+, absent on 63/69. | Never negotiate it through a modern desktop's Accept header. |
| Progressive JPEG | Chromium's actual [M63 JPEG decoder](https://github.com/chromium/chromium/blob/63.0.3239.132/third_party/WebKit/Source/platform/image-decoders/jpeg/JPEGImageDecoder.cpp#L537) and [M69 decoder](https://github.com/chromium/chromium/blob/69.0.3497.100/third_party/blink/renderer/platform/image-decoders/jpeg/jpeg_image_decoder.cc#L560) explicitly implement progressive decoding. | Supported by the browser engines; not selected. |
| PNG | Actual [M63 PNG decoder](https://github.com/chromium/chromium/blob/63.0.3239.132/third_party/WebKit/Source/platform/image-decoders/png/PNGImageDecoder.cpp#L104) and [M69 PNG decoder](https://github.com/chromium/chromium/blob/69.0.3497.100/third_party/blink/renderer/platform/image-decoders/png/png_image_decoder.cc) implement PNG decoding. | Supported by the browser engines; not selected. |
| IntersectionObserver | [Can I Use](https://caniuse.com/intersectionobserver): partial 51–57, full from 58. Samsung's Performance table explicitly marks Tizen 5.0 and 5.5 supported. | One shared observer, zero root margin, positive intersection ratio; clipped ancestors count. |
| `loading=lazy` | [Can I Use](https://caniuse.com/loading-lazy-attr): disabled by default in 75–76, enabled from 77. Thus “Chrome 76” is not a safe unqualified support floor. | Not used. |

[Jellyfin v10.10.7 ImageController.cs:1890-1958](https://github.com/jellyfin/jellyfin/blob/v10.10.7/Jellyfin.Api/Controllers/ImageController.cs#L1890)
passes resize bounds and quality into processing. `GetOutputFormats` honors an
explicit format; without one it derives supported formats from Accept, including
WebP when advertised plus JPEG/PNG. There is no single universal default MIME.
The [image processor](https://github.com/jellyfin/jellyfin/blob/master/src/Jellyfin.Drawing/ImageProcessor.cs)
prefers mutually supported WebP, otherwise PNG for transparency and other formats
as supported; it can return originals when encoding fails. This is server-source
research, not verification of the owner's installed server version or encoder.

## Geometry, lifecycle, and memory

Movie/Series buttons remain 220px wide, with a 220×330 (2:3) poster and an 80px
text/progress footer: 410px total. Episodes use a 220×124 still and the same
footer: 204px total. `object-fit: contain` preserves unusual artwork and avoids
cropping a parent-series poster in an episode's landscape slot. Fixed geometry
exists before decode, including missing/failed artwork, so loading never moves
focus targets. Titles remain real text; decorative images have empty alt text.
Errors remove the image entirely and retain the grey background/title/year.

The width is unchanged to preserve the four 220px library columns. No screen CSS
or focus logic changes. Existing sibling margins and legacy grid-gap remain
untouched; no flex gap or inset is introduced. The existing 42-case spacing suite
is **unchanged**, including mutation controls that reject broken margins and
measure positive separation. New tests additionally pin actual 220×330 image
geometry rather than changing old assertions to bless a new layout.

Only intersecting cards get img/src. Leaving view removes img/src; re-entry can
reuse the browser HTTP cache. A MutationObserver unobserves removed cards when
screens replace their DOM, and removes their images. No array retains hundreds
of previously visited image elements. Without IntersectionObserver, cards safely
stay text-only rather than eagerly fetching the library.

At 1920×1080, Home can show about seven cards across and two poster rows including
partial cards: 14 × 220 × 330 × 4 RGBA bytes = 4,065,600 bytes = **3.88 MiB**.
A conservative 20-poster screen allowance is 5,808,000 bytes = **5.54 MiB**.
Twenty episode stills are 20 × 220 × 124 × 4 = 2,182,400 bytes = **2.08 MiB**.
There is no DPR upscaling. These are decoded pixel estimates, not an enforced
process-memory ceiling: renderer textures, compressed caches, decode intermediates,
asynchronous observer delivery and delayed browser cache reclamation add overhead.
The server must honor resizing; an encoder returning an original on error can
exceed this estimate. We never intentionally request originals.

## Preview and verification

Three original geometric poster placeholders, generated using Pillow drawing and
WebP encoding at 220×330/quality 80, are reused across nine movie fixtures. Total
committed image weight is **7,962 bytes** (2,820 + 2,454 + 2,688). They are local
files under `dev/fixtures/artwork`, with no remote image service/dependency.
Movie 10 deliberately has no Primary tag. The stub implements `getImageUrl` with
those local paths and retains requested parameters in the query for inspection.
`npm run preview:tv` serves these files via the existing Python HTTP server.

New behaviour red/green evidence: restored the original cards.js, cards.css and
stub from HEAD, rebuilt, then ran:

```sh
node --test --test-name-pattern='artwork URL|missing tags|300 cards' test/e2e/card-artwork.spec.mjs
```

All six selected test cases failed on the original code: four item-type URL/resize
cases, missing/failed artwork state, and 300-card lazy scrolling. Restored the
implementation, rebuilt and ran `node --test test/e2e/card-artwork.spec.mjs`:
all eight collected cases passed (four parameterized URL cases plus four other
test functions). The other cases cover safe absence of IntersectionObserver and
real local fixture decode/geometry in the simulator. Logs are in ignored
`.cache/artwork-red-final.log` and `.cache/artwork-green.log`.

No TV was contacted, installed to, or tested. Desktop Playwright establishes DOM,
request/lifecycle behavior, fixture decoding and geometry only. It does not prove
on-TV WebP decoding, observer timing, physical D-pad scrolling, long-session TV
memory use, or live-server image responses. Series/episode navigation and screens
remain outside this change; their artwork metadata is tested through the shared
card renderer, not through nonexistent screens.

Final gates: `npx eslint .` exited 0 (repository lint scope, including ES5 parsing
of `src/overlay/**` and `dev/fixtures/**`); `npm test` passed 17 collected cases
in `test/configuration.test.mjs`; `npm run test:e2e` passed 90 collected cases
across `test/e2e/**/*.spec.mjs`. This includes the unchanged 42 spacing cases
and eight artwork cases. The repository defines no separate typecheck command;
ESLint's ES5 parser is the syntax compatibility gate. Generated bundle drift
checks passed. Also started `JELLYQUEST_PREVIEW_PORT=8093 npm run preview:tv`
and fetched a poster through its loopback HTTP server, byte-identical to the
committed file. Executing the pinned npm client bundle's real `getImageUrl`
in a local VM produced the example URL above without making a server request.

## PR review follow-up

Artwork errors now recover on a fresh viewport visit: leaving view and re-entering
permits another attempt, until that card has accumulated three failures in the
current screen render (initial failure plus two retries). Successful loads do not
reset the failure budget. There are no retry timers, and additional positive
intersection callbacks while the card remains visible do not trigger retries.
This lets ordinary transient failures recover without repeatedly hammering a
persistently missing image or an unavailable Wi-Fi/server connection. Exhausted
cards remain text-only until the screen is rendered again.

Overscan remains zero. Four extra 220×330 RGBA posters cost 1,161,600 bytes =
1.11 MiB, about 29% above the 14-poster estimate. The reviewer reports that a
20-step return scroll caused zero new network requests and no aborted requests;
that removes network churn as a reason to preload. Earlier decode might still
reduce visible pop-in, but we have no on-TV evidence that the improvement is
worth the additional decoded surfaces on the 2019 set. Preserve the original
visible-only requirement and revisit only with actual TV scroll/decode evidence.

Coverage now measures both episode image boxes at 220×124 and their card height
at 204px, and checks that overflowing poster/fallback titles stay one line with
ellipsis while retaining their full DOM text and fixed card geometry. Unknown,
malformed, and absent fixture IDs now reuse poster-1.webp; tests fetch the actual
local files. The N1 scrolling limitation and N4 item-type sizing were not changed.

Before these fixes, `node --test --test-name-pattern='failed artwork retries|fixture image URLs' test/e2e/card-artwork.spec.mjs`
failed all three selected cases (two retry scenarios and fixture fallback).
Afterward, `node --test test/e2e/card-artwork.spec.mjs` passed all 12 collected
cases. Red/green logs: `.cache/review-red.log`, `.cache/review-green.log`.

Follow-up gates: `npx eslint .` exited 0; `npm test` passed 17 collected cases in
`test/configuration.test.mjs`; `npm run test:e2e` passed 94 collected cases across
`test/e2e/**/*.spec.mjs`, including the unchanged 42 spacing cases. Both bundles
were regenerated; the CSS output is byte-identical because no styles changed.

## Type-aware selection and the episode fallback (S2)

Two decisions were separated, because conflating them is what produced the bug:

- **Card shape** follows the item's `Type` alone, never the artwork that happens
  to exist. `Movie`, `Series` and `Season` are 220×330 posters in 410px cards;
  `Episode` is a 220×124 still in a 204px card. A row of episodes therefore
  stays a row of equal boxes, and focus geometry is fixed before any decode
  even for an item with no artwork at all. **MEASURED against the merged code:
  `Season` was given the 124px episode still box** while every season poster is
  2:3. That is fixed here.
- **Which image is requested** follows what the item actually carries,
  preferring one whose native aspect matches that shape:
  1. the item's own `ImageTags.Primary`;
  2. for an `Episode`, `ParentBackdropItemId` + `ParentBackdropImageTags[0]`,
     requested as `type: 'Backdrop', index: 0` — 16:9, which fills the slot;
  3. for an `Episode` or a `Season`, `SeriesId` + `SeriesPrimaryImageTag`;
  4. otherwise text only.

**Step 3 is live in production and must not be tidied away as dead code.**
SOURCE-CONFIRMED against Jellyfin 10.11.11 — read from the tagged server
source, *not* probed against the household's server —
`SeriesPrimaryImageTag` is populated **unconditionally** for any episode or
season with a valid series:
`Emby.Server.Implementations/Dto/DtoService.cs:1213-1225` (episodes) and
`:1265-1277` (seasons). So on the real server every episode reaching step 3
carries the tag, and step 3 is the last thing between the viewer and a
text-only card. What is synthetic is only this repo's **fixture coverage** of
it — see the limitation below.

MEASURED on the household server (Jellyfin 10.11.11; reported in the S2 brief,
not probed from this repo): 26.4% of episodes — roughly 559 of 2118 — carry no
`ImageTags.Primary`, while 99.86% of episodes have a parent backdrop the merged
code never asked for. Because `getImageUrl` hardcoded `type: 'Primary'`, those
episodes fell through to step 3 and got the **series poster**, which
`object-fit: contain` letterboxes to 124 × 220/330 = **82.67px inside a 220px
box**, identical on every affected episode of the same show.

MEASURED in this repo, by `test/e2e/card-artwork.spec.mjs`, in the real
simulator page against the real fixture stub and the built bundle: an episode
that carries both fallbacks paints its parent backdrop at **220×124** — the
whole slot — where the same card restricted to the series poster paints
**82.67×124**. Both element boxes are 220×124 either way, which is precisely
why the assertion measures painted content (natural size against the measured
box) rather than the box alone.

Across the 700-episode fixture the selection is now 515 own stills, 184 parent
backdrops and 1 text-only (`episode-700`, deliberately given neither). Before
this change the same census was 515 / 0 / 185.

**FIXTURE-FIDELITY GAP, not a production claim.** `dev/fixtures/api-client-stub.js`
projects no `SeriesPrimaryImageTag` on any item — neither on its 700 episodes
nor on the four Primary-less PAW Patrol seasons (`season-34`…`season-37`,
api-client-stub.js:122-131). So *in the fixture* the before-state for those 185
episodes was text-only, and step 3 is exercised only by tests that build their
own items (`test/e2e/card-artwork.spec.mjs`). On the household's server the
before-state was a letterboxed series poster, because that tag is always there
(DtoService line ranges above). The squeeze itself is reproduced directly by the
painted-geometry test rather than by editing fixture data.

Closing the gap faithfully means projecting the tag on **all** 37 seasons *and*
all 700 episodes, which is what the same source citation implies — and that
moves the census (`none: 1` → `0`) and its `seriesPosterTags` control. Applying
it to the four Primary-less seasons alone would model the server as populating
the tag only where `Primary` is missing, which the source says is false. Left as
follow-up rather than half-done.

`index: 0` is sent explicitly on the backdrop request because the tag pinned is
`ParentBackdropImageTags[0]` and the real client turns `type`/`index` into path
components. INFERRED, not probed: that omitting `index` would resolve to the
same image. Sending it removes the question. Format, size bounds and quality 80
are unchanged from the pattern above, on every image type.

`dev/fixtures/api-client-stub.js`'s `getImageUrl` is now strict like the rest of
that stub (it rejects an unmodeled option, an unmodeled image type, and an index
on a `Primary` image) and serves a **220×124** `backdrop-1.webp` for a
`Backdrop` request. That aspect ratio matters: a stub that returned a poster for
every type would let a painted-geometry test pass on the very bug it models.
The placeholder was generated with Pillow (a vertical gradient, a horizon band
and two peaks, so landscape and portrait art are distinguishable by eye) and
encoded to WebP at quality 80: **510 bytes**.

### Contextual episode labelling (Decision 3)

`createCard(item, { context })` takes `'browse'` (the default) or `'series'`.
On an `Episode` in browse context the **show's** name is the card's primary
text and the episode's own name drops to the meta line as `S3 E12 · Name`; in
series context the **episode's** name leads and the meta line is just `S3 E12`.
Both text lines now truncate with an ellipsis rather than wrap, because the
footer is a fixed 80px under a fixed artwork box and a wrapped meta line spills
out of the card.

NOT EXERCISED BY THE APP: nothing passes `'series'` yet. The series screen is
S4's, and no screen was invented here to demonstrate the mechanism. The default
branch does have a real caller — Home's Continue Watching row queries
`IncludeItemTypes: 'Movie,Episode'`, so episode cards reach the television
today. The `'series'` branch is covered by tests only.
