// JellyQuest focus/navigation conventions.
//
// This is the ONE navigation implementation every screen shares -- unlike
// the previous overlay, which hand-rolled DOM-geometry focus matching
// independently in jellyquest.js and integration/jellyseerr-login.html.
// Directional movement itself is handled entirely by the vendored
// spatial-navigation-polyfill (concatenated immediately before this file
// by scripts/build-overlay.mjs); this module only adds the small set of
// conventions JellyQuest screens build on top of it.
//
// Container conventions (set the CSS custom properties the polyfill reads):
//   .jq-rail, .jq-row   -- plain directional containers (default 'auto' mode).
//                          Arrow keys flow between containers based on
//                          geometry, e.g. Right from the last rail item
//                          enters the adjacent content row.
//   .jq-grid            -- uniform card grids. Uses 'grid' mode so Up/Down
//                          move by row instead of nearest-element geometry,
//                          which behaves oddly once card sizes vary.
//   .jq-modal           -- overlays (Settings, Playback Options). Uses
//                          'contain' mode so focus cannot escape the dialog
//                          via arrow keys while it's open, matching
//                          DETAIL_ACTIONS.md's "dialogs contain focus" rule.
//
// Element convention:
//   [data-jq-autofocus] -- marks the element a screen should focus first
//                          when it becomes active.
//
// This module also keeps the focused element inside its scrollport (see
// "Keeping the focused element on screen" below), which is what makes a
// row or grid longer than the screen walkable with the remote at all.
(function () {
    'use strict';

    function ready(callback) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', callback);
        } else {
            callback();
        }
    }

    // Screens call this when they finish rendering. A screen's render can
    // finish WHILE a modal is open -- Home's rows arrive over the network,
    // and app.js installs Home's Back handler before that render completes,
    // so a slow response lands after the exit confirmation is already up.
    // `--spatial-navigation-contain: contain` only constrains arrow-key
    // movement; it does nothing about a programmatic .focus() call, which
    // would silently move the cursor to a card behind the dialog and make
    // Enter act on it. The guard lives here, in the one helper every screen
    // routes focus through (shell.js, home.js, search.js, library.js,
    // requests.js, profiles.js, detail.js all call focusFirst and nothing
    // else), rather than in each screen that might ever render late.
    function focusFirst(container, expectedFocus) {
        if (!container) return false;
        if (activeModal) return activeModal.contains(container) ? focusInto(container) : false;
        // Async screens may name the element that held focus when their
        // request began. If the user has moved to another visible control in
        // the meantime, that selection is newer intent and must win. Keeping
        // this check in the shared funnel prevents individual screens from
        // growing subtly different definitions of "real focus".
        if (arguments.length > 1
            && document.activeElement !== expectedFocus
            && hasVisibleFocus()) return false;
        if (focusInto(container)) return true;
        // Nothing in the screen could take focus. That is a real state, not a
        // bug: an empty Jellyfin library gives Home no cards at all, only a
        // "Nothing here yet." paragraph. If the element that had focus was
        // inside the content the screen just replaced, it is gone too and
        // document.activeElement has fallen back to <body> -- no focus ring,
        // no cursor, and on a TV that reads as the app having died until the
        // user happens to press an arrow. The rail is always mounted and
        // always focusable, so it is the last resort.
        //
        // But only when focus really is nowhere. A render can finish long
        // after the user gave up waiting and moved the cursor onto the rail
        // themselves, and pulling it back to the rail's default item would
        // discard a selection they just made -- the same
        // asynchronous-completion-beats-newer-intent shape as a late render
        // stealing focus from an open modal, with a rail selection in place
        // of the dialog. If something real already holds focus, that is the
        // newer intent and this render leaves it alone.
        if (hasVisibleFocus()) return false;
        if (fallbackContainer
            && fallbackContainer !== container
            && document.body.contains(fallbackContainer)) {
            return focusInto(fallbackContainer);
        }
        return false;
    }

    // Whether the cursor is currently on something the user can actually see.
    // Deliberately three narrow conditions -- attached, not <body>, and
    // rendering a box -- because this decides whether to override what the
    // user is looking at. getClientRects() is empty for anything inside a
    // display:none subtree, which is the dismissed dialog's case.
    function hasVisibleFocus() {
        var active = document.activeElement;
        if (!active || active === document.body) return false;
        if (!document.body.contains(active)) return false;
        if (typeof active.getClientRects !== 'function') return false;
        return active.getClientRects().length > 0;
    }

    function focusInto(container) {
        var target = container.querySelector('[data-jq-autofocus]') || firstFocusable(container);
        if (target && typeof target.focus === 'function') {
            target.focus();
            return true;
        }
        return false;
    }

    function firstFocusable(container) {
        return container.querySelector(
            'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
    }

    // ---- Keeping the focused element on screen --------------------------
    //
    // A Home row holds one card per library item, so it is routinely wider
    // than the screen; .jq-home-screen and .jq-library-screen clip the
    // overflow. Nothing scrolled, and the polyfill will not move focus to
    // an element it cannot see. So a Recently Added row of 8 cards plus
    // "See All" dead-ended on card 7, the last one with any pixels on
    // screen: card 8 and "See All" were unreachable by remote, permanently.
    //
    // The fix belongs here rather than in each screen because this is the
    // one place every focus change passes through -- not just the
    // focusFirst() calls above, but the polyfill's own arrow-key .focus(),
    // closeModal()'s restore, and anything else that ever moves the cursor.
    // A capture-phase 'focus' listener on document sees all of them (focus
    // does not bubble; capture is how you observe it document-wide), so no
    // screen has to remember to opt in, and the Library grid gets vertical
    // scrolling from the same code that gives Home horizontal scrolling.
    //
    // WHAT THE POLYFILL NEEDS TO SEE. Scrolling on focus is also what makes
    // the NEXT element reachable: bringing the focused card into view drags
    // its neighbour in behind it, so the following key press has a visible
    // candidate. How much of that neighbour has to be showing is decided by
    // hitTest(), and it is not symmetric:
    //
    //   1. hitTest() rejects outright on the candidate's TOP-LEFT CORNER --
    //      `elementRect.top < 0 || elementRect.left < 0` -- before it looks
    //      at any visible portion at all.
    //   2. Only if that passes does it probe three points (centre, a
    //      top-left inset at offsetWidth/10 and offsetHeight/10, and the
    //      mirrored bottom-right inset) with elementFromPoint().
    //
    // So a neighbour BEHIND the cursor is the hard case: its top-left corner
    // is its far corner from us, and revealing anything less than the whole
    // of it fails rule 1 no matter how much is on screen. A neighbour AHEAD
    // is cheap: its top-left corner is the near one, so the gap plus its own
    // leading tenth -- where probe 2's top-left inset sits -- is enough.
    // revealMargin() below is that asymmetry, and it is the whole reason
    // Up could not walk back out of a scrolled grid: a fixed margin left the
    // row above spanning y = -86 to y = 44, which rule 1 discards.
    //
    // API CHOICE. Direct scrollLeft/scrollTop assignment, present since the
    // earliest Chromium releases (MDN's compat data lists Chrome 1), so
    // support is not in question anywhere in the supported range. Neither is
    // it in question for the alternatives -- scrollIntoView() with an
    // options object and CSS scroll-behavior are both Chrome 61
    // (https://caniuse.com/scrollintoview,
    // https://caniuse.com/css-scroll-behavior), which PRECEDES the measured
    // Tizen 5.0 / Chromium M63 floor; both target sets can run them. This is
    // not a support decision. It is chosen for behaviour:
    //   * scrollIntoView() walks every scrollable ancestor up to and
    //     including the document, and jellyfin-web's page scroll is not ours
    //     to move (see revealFocus()'s overlay scoping below). Assigning
    //     offsets scrolls exactly the containers we choose.
    //   * scrollIntoView() offers no control over HOW MUCH to reveal, and a
    //     computed amount is the entire mechanism here -- `block: 'nearest'`
    //     reveals the minimum, which is precisely the dead-end being fixed.
    //   * The reveal has to be complete before the next key press is
    //     searched for candidates, or the polyfill runs its hitTest()
    //     against geometry still in motion. Offset assignment is
    //     instantaneous GIVEN that no `scroll-behavior: smooth` computes on
    //     the container -- the setters use the `auto` behavior, which
    //     honours that property, and under it an assignment animates and an
    //     immediate read still returns the old offset. Nothing in the
    //     overlay declares scroll-behavior, so it is instantaneous here;
    //     that is an invariant to keep, and a narrower one to keep than
    //     `behavior: 'smooth'`, which opts into animation outright.
    //
    // Containers are `overflow: hidden` rather than auto/scroll: the TV has
    // no pointer, scrollbars would be visible chrome, and the polyfill's
    // own isScrollable() deliberately excludes `hidden` ("the element can
    // be only programmically scrollable"), so it leaves these containers
    // to us instead of nudging them 40px at a time via moveScroll().

    // Slack added on top of a neighbour's own extent. It has to exceed the
    // spacing between items -- 20px everywhere in this overlay, whether
    // sibling margin or grid-gap -- and the surplus leaves the visible
    // sliver of the next card that tells a viewer the row continues.
    var GAP_PX = 64;

    function revealFocus(element) {
        if (!element || element.nodeType !== 1) return;
        // Scoped to the overlay, deliberately. jellyfin-web is still mounted
        // underneath #jellyquest-root -- its router, its own view tree, and
        // dialogHelper, which blurs and restores focus of its own accord --
        // and its scroll containers are emphatically not ours to move. A
        // document-wide listener would scroll them on any focus jellyfin-web
        // performs for its own reasons. No simulator test can catch that,
        // because the simulator loads no jellyfin-web at all, so the
        // boundary is enforced here explicitly rather than assumed from
        // "the overlay owns the screen".
        var root = document.getElementById('jellyquest-root');
        if (!root || !root.contains(element)) return;
        var node = element.parentNode;
        // contains() is reflexive, so this walks up to and including the
        // root and stops there -- never <body> or <html>.
        while (node && node.nodeType === 1 && root.contains(node)) {
            revealInto(node, element);
            node = node.parentNode;
        }
    }

    function revealInto(container, element) {
        var scrollsX = container.scrollWidth > container.clientWidth;
        var scrollsY = container.scrollHeight > container.clientHeight;
        // Assigning scrollLeft/scrollTop to a non-scrolling box is a no-op,
        // but skipping the geometry reads keeps this cheap on the deep
        // ancestor chains every focus change walks.
        if (!scrollsX && !scrollsY) return;
        var port = container.getBoundingClientRect();
        var rect = element.getBoundingClientRect();
        // Both axes' neighbours are measured BEFORE either offset is written:
        // assigning a scroll offset dirties layout, and reading afterwards
        // would both force a second reflow and measure geometry mid-move.
        var acrossX = scrollsX ? neighbours(container, element, true) : null;
        var acrossY = scrollsY ? neighbours(container, element, false) : null;
        if (scrollsX) {
            // clientLeft/clientTop discount a border, which offsets the
            // scrollport from the border box getBoundingClientRect gives.
            var portLeft = port.left + container.clientLeft;
            container.scrollLeft = revealOffset(
                container.scrollLeft, rect.left, rect.right,
                portLeft, portLeft + container.clientWidth, acrossX
            );
        }
        if (scrollsY) {
            var portTop = port.top + container.clientTop;
            container.scrollTop = revealOffset(
                container.scrollTop, rect.top, rect.bottom,
                portTop, portTop + container.clientHeight, acrossY
            );
        }
    }

    // The nearest focusable CANDIDATE on each side of `element` along one
    // axis. hitTest() judges candidates, not boxes in general, so
    // `.jq-focusable` is the right population -- and measuring them is the
    // whole point: see revealMargin.
    //
    // What each side reports differs because the two rules differ. Behind the
    // cursor, rule 1 needs the neighbour's leading edge on screen, so what
    // matters is the DISTANCE back to it -- which carries the neighbour's own
    // extent AND whatever separates the two, and a row separation is not a
    // card separation (76px between Home's rows against 20px inside one).
    // Ahead of the cursor, rule 2 needs a point one tenth into the neighbour,
    // so what matters there is its SIZE.
    //
    // WHAT THIS COSTS, measured rather than assumed. It runs only for a
    // container that actually scrolls, but that is not once per key press:
    // one Home key press invokes it up to THREE times, because three
    // ancestors of a card scroll -- the row on X, the row's section on X,
    // and the Home screen on Y. Each walk covers the container's MOUNTED
    // candidates, which is not the same as what is on screen: the Library's
    // windowed grid mounts 48 cards plus the Back button, so its walk visits
    // 49, and that 48-card window spans considerably more than the viewport.
    //
    // Measured at 1920x1080 under a 20x CPU throttle, keydown handling only,
    // the walks add ~0.75ms per Library key press (4.0 p95, 5.0 max) and
    // move the whole handler's median from 35.3ms to 36.2ms. They do not add
    // a second hitTest-sized sweep. Those are desktop-under-throttle
    // numbers; the M63 television was not measured.
    //
    // No writes are interleaved, so the loop runs against one settled layout.
    // `visibility: hidden` keeps an element's box, so a geometry-only scan
    // cannot tell such an element apart from a real one -- but it is not
    // focusable and elementFromPoint() never returns it, so hitTest() would
    // never pick it. Left in the running it can win the "nearest behind"
    // contest on a box the cursor can never reach, and drag the reveal with
    // it.
    //
    // Two passes, because the cost rule is that a style read must not be paid
    // per candidate: the first pass reads no styles at all, and only if the
    // element it CHOSE turns out to be hidden is a filtering pass run. In the
    // overlay as it stands that second pass never runs -- nothing focusable
    // uses `visibility: hidden` (the card images do, and they are not
    // candidates) -- so the standing cost is two style reads per axis.
    //
    // It skips hidden candidates rather than giving up on the side: an
    // earlier attempt here fell back to "no neighbour" instead, which is a
    // coin flip. MEASURED on a synthetic 400px scrollport with a tall hidden
    // predecessor, falling back left the next real candidate at top = -136,
    // outside the port, where skipping puts it at 0 and inside.
    function neighbours(container, element, horizontal) {
        var candidates = container.querySelectorAll('.jq-focusable');
        var found = scanNeighbours(candidates, element, horizontal, false);
        if ((found.leadNode && isHidden(found.leadNode))
            || (found.trailNode && isHidden(found.trailNode))) {
            found = scanNeighbours(candidates, element, horizontal, true);
        }
        return found;
    }

    function scanNeighbours(candidates, element, horizontal, skipHidden) {
        var rect = element.getBoundingClientRect();
        var start = horizontal ? rect.left : rect.top;
        var end = horizontal ? rect.right : rect.bottom;
        var found = { leadDistance: null, trailSize: null, leadNode: null, trailNode: null };
        var leadEdge = null;
        var trailEdge = null;
        for (var i = 0; i < candidates.length; i++) {
            var other = candidates[i];
            if (other === element) continue;
            var box = other.getBoundingClientRect();
            // A candidate with no box at all is not one hitTest() could pick,
            // and its all-zero rect would otherwise read as sitting at the
            // very start of the axis.
            if (!box.width && !box.height) continue;
            if (skipHidden && isHidden(other)) continue;
            var otherStart = horizontal ? box.left : box.top;
            var otherEnd = horizontal ? box.right : box.bottom;
            if (otherEnd <= start) {
                if (leadEdge === null || otherEnd > leadEdge) {
                    leadEdge = otherEnd;
                    found.leadNode = other;
                    found.leadDistance = start - otherStart;
                }
            } else if (otherStart >= end) {
                if (trailEdge === null || otherStart < trailEdge) {
                    trailEdge = otherStart;
                    found.trailNode = other;
                    found.trailSize = horizontal ? box.width : box.height;
                }
            }
        }
        return found;
    }

    function isHidden(node) {
        var view = node.ownerDocument && node.ownerDocument.defaultView;
        if (!view || typeof view.getComputedStyle !== 'function') return false;
        return view.getComputedStyle(node).visibility === 'hidden';
    }

    // How much room to keep on each side of an element of `size` along one
    // axis, given `spare` px of scrollport left over once the element itself
    // is placed. See "WHAT THE POLYFILL NEEDS TO SEE" above for why `lead`
    // covers a whole neighbour and `trail` only a tenth of one.
    //
    // `across` carries what neighbours() measured on each side. Both terms
    // used to be derived from the focused element's OWN size, on the premise
    // that "rows and grids here are uniform" -- and that premise died when
    // Home grew a third row. Home stacks a 204px episode row between two
    // 410px poster rows, separated by 76px of heading and section margin, so
    // walking DOWN the stack and back UP left the poster row above at
    // top = -176. A lead computed as 204 + 64 cannot reveal a neighbour that
    // starts 486px back, and hitTest() rejects a candidate whose top is
    // negative before it looks at how much of it is on screen -- so focus
    // left the screen for the rail instead of returning to Continue Watching.
    //
    // A uniform container measures its own geometry back, so the SHAPE of
    // every other traversal is preserved -- but not, and this was overclaimed
    // once already, the exact pixels. `lead` becomes size + spacing + GAP_PX
    // where it was size + GAP_PX, so the spacing that was always between two
    // uniform items is now revealed as well: MEASURED, upward traversal in
    // the Library and on the Series screen, and Home's horizontal return
    // traversal, each settle 20px further along than before. Focus
    // identities and traversal order are unchanged in all of them; what
    // changed is where the container comes to rest. `trail` is unchanged
    // wherever the neighbour ahead is the same size. `size` remains the
    // fallback for an element with no candidate on that side.
    function revealMargin(size, spare, across) {
        var leadDistance = across && across.leadDistance !== null ? across.leadDistance : size;
        var trailSize = across && across.trailSize !== null ? across.trailSize : size;
        var lead = leadDistance + GAP_PX;
        var trail = GAP_PX + trailSize / 10;
        // Both margins and the element itself have to fit inside the
        // scrollport. When they cannot, give up the trailing margin first --
        // it is the one asking for the least -- and then the leading one.
        if (lead > spare) return { lead: spare > 0 ? spare : 0, trail: 0 };
        if (lead + trail > spare) return { lead: lead, trail: spare - lead };
        return { lead: lead, trail: trail };
    }

    // The scroll offset one axis should take, given where the element sits
    // now (`start`/`end`) relative to the scrollport (`portStart`/`portEnd`)
    // in viewport coordinates.
    //
    // Shifting the offset by d moves the element by -d, so every offset in
    // [lowest, highest] leaves the element on screen with its margins. The
    // browser clamps whatever comes back to the scrollable range, which is
    // also what carries the last element in a row all the way to the end:
    // its trailing margin asks for more scroll than exists.
    function revealOffset(offset, start, end, portStart, portEnd, across) {
        var size = end - start;
        var margin = revealMargin(size, (portEnd - portStart) - size, across);
        var lowest = offset + (end - portEnd) + margin.trail;
        var highest = offset + (start - portStart) - margin.lead;
        // revealMargin() keeps the range non-empty whenever the element
        // fits at all, so this is the element-longer-than-the-scrollport
        // case: show its leading edge, where its label and focus ring are.
        if (lowest > highest) return highest;
        // Otherwise the nearest acceptable offset, so a key press scrolls as
        // little as it can get away with.
        //
        // There was a special case here that jumped straight to 0 whenever
        // the element still fitted there, to expose a container's leading
        // chrome -- the Library screen's "< Back" above its first grid row.
        // It was load-bearing when the leading margin was a flat 64px; it is
        // not any more, because a margin that reveals a whole neighbouring
        // row reaches that chrome by itself. Measured with it removed: every
        // traversal is unchanged and every test still passes, while an Up
        // press moves one row (150px) instead of occasionally teleporting
        // over five (701px). Fewer viewport crossings, too, which matters to
        // anything that loads or discards artwork as cards cross the edge.
        if (offset < lowest) return lowest;
        if (offset > highest) return highest;
        return offset;
    }

    document.addEventListener('focus', function (event) {
        revealFocus(event.target);
    }, true);

    // Tracks the currently-open modal's own close handler so the
    // hardware Back button can close it first, before any screen-level
    // "go back to where I came from" handler runs (see app.js's router
    // and DETAIL_ACTIONS.md's "Left or Back returns one level before
    // closing" rule) -- without every screen having to coordinate this
    // itself.
    var activeModalClose = null;
    // The open modal's own container, so focusFirst() can tell "this screen
    // just finished rendering underneath the dialog" from "the dialog itself
    // is asking for focus".
    var activeModal = null;

    // Where focus goes when a screen has nowhere to put it -- shell.js
    // registers its rail. Checked for being attached before use, because the
    // profile picker clears the shell (and with it the rail) out of the root.
    var fallbackContainer = null;

    function setFallbackContainer(container) {
        fallbackContainer = container || null;
    }

    // Opens a modal-style container: marks it contained (see .jq-modal
    // above) and focuses its first element. Screens call this instead of
    // writing their own focus-trap logic. onClose is called by
    // closeOnBack() (wired to the hardware Back button); it must itself
    // call closeModal().
    function openModal(container, onClose) {
        if (!container) return;
        container.classList.add('jq-modal');
        container.hidden = false;
        // Set before focusFirst() so the guard there sees the dialog as the
        // active modal and lets it focus itself.
        activeModal = container;
        focusFirst(container);
        activeModalClose = onClose || null;
    }

    function closeModal(container, restoreTarget) {
        if (!container) return;
        container.hidden = true;
        activeModalClose = null;
        if (activeModal === container) activeModal = null;
        if (restoreTarget && typeof restoreTarget.focus === 'function') {
            restoreTarget.focus();
        }
    }

    // Returns true if a modal was open and its own close handler ran (the
    // caller should stop there); false if there was nothing to close, so
    // the caller's own Back behavior should run instead.
    function closeOnBack() {
        if (!activeModalClose) return false;
        var close = activeModalClose;
        activeModalClose = null;
        close();
        return true;
    }

    window.JellyQuestFocus = {
        ready: ready,
        focusFirst: focusFirst,
        // The same reveal the capture listener below performs, exposed for
        // the one case that changes what needs revealing WITHOUT changing
        // what has focus: the Library mounting a newly-paged row beneath the
        // cursor. No focus event fires for that, so the scroll that makes the
        // new row visible -- and therefore reachable by the polyfill, which
        // will not move to a candidate it cannot see -- has to be asked for.
        // It moves scroll offsets only; it never moves the cursor.
        reveal: revealFocus,
        setFallbackContainer: setFallbackContainer,
        openModal: openModal,
        closeModal: closeModal,
        closeOnBack: closeOnBack
    };
})();
