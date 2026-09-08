// Shared media-card rendering, used by Home, Library, and Search --
// factored out once a second screen needed the same card shape, rather
// than speculatively up front.
(function () {
    'use strict';

    // Bound decoded surfaces to visible cards. Zero overscan: ancestor overflow
    // clipping and viewport intersection both count. See docs/card-artwork.md.
    var observer;

    var CARD_WIDTH = 220;
    var POSTER_HEIGHT = 330;  // 2:3, the shape of a Movie/Series/Season poster.
    var STILL_HEIGHT = 124;   // 16:9 at 220px wide, rounded to whole pixels.

    // Card SHAPE follows the item's Type alone, never the artwork that
    // happens to exist, so a row of episodes stays a row of equal boxes and
    // focus geometry is fixed before any decode. A Season is a poster like
    // its Series -- MEASURED as wrong in the merged code, which gave Season
    // the 124px episode still box while every Season poster is 2:3.
    function isPosterShaped(item) {
        return item.Type === 'Movie' || item.Type === 'Series' || item.Type === 'Season';
    }

    // Which IMAGE to request is a separate decision, made from what the item
    // actually carries, preferring one whose native aspect matches the slot.
    //
    // MEASURED on the household server (Jellyfin 10.11.11; reported in the
    // task brief, not probed from this worktree): 26.4% of episodes -- ~559 of
    // 2118 -- carry no Primary still, while 99.86% of episodes have a parent
    // backdrop that was never requested. The merged code hardcoded type
    // 'Primary' and so fell through to the SERIES POSTER for those: a 2:3
    // image letterboxed by `object-fit: contain` to 124 * 220/330 = 82.7px
    // inside a 220px still box, and identical on every affected episode of the
    // same show. The parent backdrop is 16:9 and fills the slot.
    function artworkSource(item) {
        var height = isPosterShaped(item) ? POSTER_HEIGHT : STILL_HEIGHT;
        if (item.ImageTags && item.ImageTags.Primary) {
            return { id: item.Id, tag: item.ImageTags.Primary, type: 'Primary', index: null, height: height };
        }
        if (item.Type === 'Episode' && item.ParentBackdropItemId
            && item.ParentBackdropImageTags && item.ParentBackdropImageTags.length) {
            // index 0 is explicit because the tag we pin is tags[0]; the real
            // client turns type/index into path components (docs/card-artwork.md).
            return { id: item.ParentBackdropItemId, tag: item.ParentBackdropImageTags[0],
                type: 'Backdrop', index: 0, height: height };
        }
        // Last resort, and LIVE IN PRODUCTION -- not a defensive branch, and
        // not dead code to be tidied away. SOURCE-CONFIRMED against Jellyfin
        // 10.11.11 (read from tagged server source, NOT probed against the
        // household's server): SeriesPrimaryImageTag is populated
        // unconditionally for any episode or season with a valid series, at
        // Emby.Server.Implementations/Dto/DtoService.cs:1213-1225 (episodes)
        // and :1265-1277 (seasons). So on the real server every episode that
        // reaches here carries this tag, and this is the last thing standing
        // between the viewer and a text-only card.
        //
        // For a Season this is also the CORRECT shape (the show's own 2:3
        // poster in a 2:3 slot); for an Episode it is the letterboxed poster
        // described above, now reached only when the parent backdrop is
        // genuinely absent -- one episode in 700 in the fixture.
        //
        // What is synthetic is only the FIXTURE's coverage of this tier: the
        // stub projects no SeriesPrimaryImageTag, so the tests that exercise
        // it build their own items. See docs/card-artwork.md.
        if ((item.Type === 'Episode' || item.Type === 'Season')
            && item.SeriesId && item.SeriesPrimaryImageTag) {
            return { id: item.SeriesId, tag: item.SeriesPrimaryImageTag, type: 'Primary', index: null, height: height };
        }
        return null;
    }

    function releaseImage(card) {
        var image = card.querySelector('.jq-media-card-image');
        if (image) {
            image.onload = null;
            image.onerror = null;
            image.removeAttribute('src');
            card.removeChild(image);
        }
    }

    function failImage(card) {
        card._jqArtwork.failures += 1;
        if (card._jqArtwork.retryBudget) {
            card._jqArtwork.retryBudget.failures = card._jqArtwork.failures;
        }
        card.setAttribute('data-artwork-state', 'error');
        releaseImage(card);
    }

    function loadImage(card) {
        if (card.querySelector('img') || card.getAttribute('data-artwork-state') === 'error') return;
        var source = card._jqArtwork;
        var client = window.ApiClient;
        if (!source || !client || typeof client.getImageUrl !== 'function') return;
        var url;
        // The real client mutates the options object, so build a fresh one per
        // attempt (docs/card-artwork.md). Every type keeps the same pattern:
        // an explicit format plus size bounds, and quality 80, which alone
        // forecloses the server's return-the-original passthrough (>= 90).
        var options = {
            type: source.type, tag: source.tag, maxWidth: CARD_WIDTH,
            maxHeight: source.height, quality: 80, format: 'webp'
        };
        if (source.index !== null) options.index = source.index;
        try {
            url = client.getImageUrl(source.id, options);
        } catch (_error) {
            failImage(card);
            return;
        }
        if (!url) return;
        var image = document.createElement('img');
        image.className = 'jq-media-card-image';
        image.alt = '';
        image.onload = function () { image.style.visibility = 'visible'; };
        image.onerror = function () {
            failImage(card);
        };
        card.insertBefore(image, card.firstChild);
        image.src = url;
    }

    // retryBudget is an optional mutable { failures } object. The Library
    // passes the same object whenever windowing recreates one item, so a new
    // card does not reset that screen render's three-attempt cap.
    function observeArtwork(card, source, retryBudget) {
        // Safely retain text-only cards on hosts without the supported API.
        if (!source || !window.IntersectionObserver) return;
        // Once a shared budget reaches three, recreation leaves the card
        // text-only for the rest of this Library visit even if the network
        // recovers. A new screen render creates a fresh budget. This matches
        // the old per-render terminal error, while preventing windowing from
        // turning every revisit into another request.
        source.retryBudget = retryBudget || null;
        source.failures = retryBudget && retryBudget.failures ? retryBudget.failures : 0;
        source.visible = false;
        card._jqArtwork = source;
        if (!observer) {
            observer = new window.IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    var card = entry.target;
                    var artwork = card._jqArtwork;
                    if (entry.intersectionRatio > 0 && document.documentElement.contains(card)) {
                        if (!artwork.visible) {
                            artwork.visible = true;
                            // Retry only on a fresh visit, never on a timer or
                            // another positive threshold. Three failures per
                            // screen render cap persistent Wi-Fi/server errors.
                            if (artwork.failures < 3) {
                                card.removeAttribute('data-artwork-state');
                                loadImage(card);
                            } else {
                                card.setAttribute('data-artwork-state', 'error');
                            }
                        }
                    } else {
                        artwork.visible = false;
                        releaseImage(card);
                    }
                });
            }, { rootMargin: '0px', threshold: [0, 0.001] });
            // Screens replace their DOM with innerHTML. Unobserve removed cards
            // so the shared observer cannot retain entire old screens/items.
            new window.MutationObserver(function (records) {
                records.forEach(function (record) {
                    Array.prototype.forEach.call(record.removedNodes, function (node) {
                        if (node.nodeType !== 1 || document.documentElement.contains(node)) return;
                        var cards = Array.prototype.slice.call(node.querySelectorAll('.jq-media-card'));
                        if (node.classList.contains('jq-media-card')) cards.push(node);
                        cards.forEach(function (removed) {
                            observer.unobserve(removed);
                            releaseImage(removed);
                        });
                    });
                });
            }).observe(document.documentElement, { childList: true, subtree: true });
        }
        observer.observe(card);
    }

    // 'S3 E12', or '' when the server did not number the episode. MEASURED:
    // every fixture episode carries both numbers, including the 129 virtual
    // PAW Patrol placeholders (dev/fixtures/api-client-stub.js:180-184), so no
    // fixture data exercises this guard.
    // INFERRED, not established here: that real specials and unmatched files
    // can lack one or both. Nothing in this task's brief or in this repo
    // measured that, so the guard is defensive on an unverified premise --
    // cheap, and it prints '' rather than 'SundefinedEundefined' if the
    // premise is right.
    function episodeNumbering(item) {
        var parts = '';
        if (typeof item.ParentIndexNumber === 'number') parts += 'S' + item.ParentIndexNumber;
        if (typeof item.IndexNumber === 'number') parts += (parts ? ' ' : '') + 'E' + item.IndexNumber;
        return parts;
    }

    // Decision 3: an episode's PRIMARY text is contextual. On Home you
    // are picking a show, so the show's name leads and the episode's own name
    // drops to the meta line; inside a show's own page the show name is
    // already on screen, so the episode's name leads.
    //
    // `context` is 'browse' (the default -- Home, Library, Search) or
    // 'series'. Nothing passes 'series' in production yet: S3's Series seam
    // is deliberately an inert placeholder and renders no episode cards;
    // S4 supplies that caller when it builds the browser. The 'browse' branch
    // has a real caller -- Home's Continue Watching row queries
    // 'Movie,Episode' (screens/home.js).
    function cardText(item, context) {
        var numbering = item.Type === 'Episode' ? episodeNumbering(item) : '';
        if (item.Type === 'Episode' && context !== 'series' && item.SeriesName) {
            return {
                title: item.SeriesName,
                // Keep the episode identifiable: a Continue Watching row from
                // one show would otherwise be several identical cards.
                meta: numbering ? numbering + ' · ' + item.Name : item.Name
            };
        }
        if (item.Type === 'Episode') {
            return { title: item.Name, meta: numbering };
        }
        return { title: item.Name, meta: item.ProductionYear ? String(item.ProductionYear) : '' };
    }

    function createCard(item, options) {
        options = options || {};
        var source = artworkSource(item);
        var card = document.createElement('button');
        card.className = 'jq-card jq-focusable jq-media-card';
        card.setAttribute('data-item-id', item.Id);
        if (isPosterShaped(item)) card.className += ' jq-media-card-poster';
        else if (item.Type === 'Episode' || source) card.className += ' jq-media-card-episode';

        var text = cardText(item, options.context);
        var title = document.createElement('span');
        title.className = 'jq-media-card-title';
        title.textContent = text.title;
        card.appendChild(title);

        if (text.meta) {
            var meta = document.createElement('small');
            meta.className = 'jq-media-card-meta';
            meta.textContent = text.meta;
            card.appendChild(meta);
        }

        var position = item.UserData && item.UserData.PlaybackPositionTicks;
        if (position && item.RunTimeTicks) {
            var progress = document.createElement('div');
            progress.className = 'jq-media-card-progress';
            var bar = document.createElement('div');
            bar.className = 'jq-media-card-progress-bar';
            var percent = Math.min(100, Math.round((position / item.RunTimeTicks) * 100));
            bar.style.width = percent + '%';
            progress.appendChild(bar);
            card.appendChild(progress);
        }

        if (options.onSelect) {
            card.addEventListener('click', function () { options.onSelect(item); });
        }
        observeArtwork(card, source, options.artworkRetryBudget);
        return card;
    }

    window.JellyQuestCards = {
        createCard: createCard,
        // Detail explicitly uses this formatter with 'browse' because Home is
        // the only production Episode entry point today. This shares the
        // current wording; it does not carry an opening card's context. S4
        // must pass route context if Series-page cards should open Detail in
        // the 'series' form.
        textFor: cardText
    };
})();
