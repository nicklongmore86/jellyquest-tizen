// Shared media-card rendering, used by Home, Library, and Search --
// factored out once a second screen needed the same card shape, rather
// than speculatively up front.
(function () {
    'use strict';

    // Bound decoded surfaces to visible cards. Zero overscan: ancestor overflow
    // clipping and viewport intersection both count. See docs/card-artwork.md.
    var observer;

    function artworkSource(item) {
        if (item.ImageTags && item.ImageTags.Primary) {
            return { id: item.Id, tag: item.ImageTags.Primary };
        }
        if (item.Type === 'Episode' && item.SeriesId && item.SeriesPrimaryImageTag) {
            return { id: item.SeriesId, tag: item.SeriesPrimaryImageTag };
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

    function loadImage(card) {
        if (card.querySelector('img') || card.getAttribute('data-artwork-state') === 'error') return;
        var source = card._jqArtwork;
        var client = window.ApiClient;
        if (!source || !client || typeof client.getImageUrl !== 'function') return;
        var url;
        try {
            url = client.getImageUrl(source.id, {
                type: 'Primary', tag: source.tag, maxWidth: 220,
                maxHeight: source.height, quality: 80, format: 'webp'
            });
        } catch (_error) {
            card.setAttribute('data-artwork-state', 'error');
            return;
        }
        if (!url) return;
        var image = document.createElement('img');
        image.className = 'jq-media-card-image';
        image.alt = '';
        image.onload = function () { image.style.visibility = 'visible'; };
        image.onerror = function () {
            card.setAttribute('data-artwork-state', 'error');
            releaseImage(card);
        };
        card.insertBefore(image, card.firstChild);
        image.src = url;
    }

    function observeArtwork(card, item) {
        var source = artworkSource(item);
        // Safely retain text-only cards on hosts without the supported API.
        if (!source || !window.IntersectionObserver) return;
        source.height = item.Type === 'Movie' || item.Type === 'Series' ? 330 : 124;
        card._jqArtwork = source;
        if (!observer) {
            observer = new window.IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    if (entry.intersectionRatio > 0 && document.documentElement.contains(entry.target)) {
                        loadImage(entry.target);
                    } else {
                        releaseImage(entry.target);
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

    function createCard(item, options) {
        options = options || {};
        var card = document.createElement('button');
        card.className = 'jq-card jq-focusable jq-media-card';
        card.setAttribute('data-item-id', item.Id);
        if (item.Type === 'Movie' || item.Type === 'Series') card.className += ' jq-media-card-poster';
        if (item.Type !== 'Movie' && item.Type !== 'Series' && (item.Type === 'Episode' || artworkSource(item))) {
            card.className += ' jq-media-card-episode';
        }

        var title = document.createElement('span');
        title.className = 'jq-media-card-title';
        title.textContent = item.Name;
        card.appendChild(title);

        if (item.ProductionYear) {
            var meta = document.createElement('small');
            meta.className = 'jq-media-card-meta';
            meta.textContent = String(item.ProductionYear);
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
        observeArtwork(card, item);
        return card;
    }

    window.JellyQuestCards = {
        createCard: createCard
    };
})();
