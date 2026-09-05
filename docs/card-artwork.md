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
