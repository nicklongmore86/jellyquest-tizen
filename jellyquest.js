// GENERATED FILE -- do not edit directly.
// Edit src/overlay/*.js and re-run `node scripts/build-overlay.mjs` (or `npm run build`).

/* ---- node_modules/spatial-navigation-polyfill/polyfill/spatial-navigation-polyfill.js ---- */
/* Spatial Navigation Polyfill
 *
 * It follows W3C official specification
 * https://drafts.csswg.org/css-nav-1/
 *
 * Copyright (c) 2018-2019 LG Electronics Inc.
 * https://github.com/WICG/spatial-navigation/polyfill
 *
 * Licensed under the MIT license (MIT)
 */

(function () {

  // The polyfill must not be executed, if it's already enabled via browser engine or browser extensions.
  if ('navigate' in window) {
    return;
  }

  const ARROW_KEY_CODE = {37: 'left', 38: 'up', 39: 'right', 40: 'down'};
  const TAB_KEY_CODE = 9;
  let mapOfBoundRect = null;
  let startingPoint = null; // Saves spatial navigation starting point
  let savedSearchOrigin = {element: null, rect: null};  // Saves previous search origin
  let searchOriginRect = null;  // Rect of current search origin

  /**
   * Initiate the spatial navigation features of the polyfill.
   * @function initiateSpatialNavigation
   */
  function initiateSpatialNavigation() {
    /*
     * Bind the standards APIs to be exposed to the window object for authors
     */
    window.navigate = navigate;
    window.Element.prototype.spatialNavigationSearch = spatialNavigationSearch;
    window.Element.prototype.focusableAreas = focusableAreas;
    window.Element.prototype.getSpatialNavigationContainer = getSpatialNavigationContainer;

    /*
     * CSS.registerProperty() from the Properties and Values API
     * Reference: https://drafts.css-houdini.org/css-properties-values-api/#the-registerproperty-function
     */
    if (window.CSS && CSS.registerProperty) {
      if (window.getComputedStyle(document.documentElement).getPropertyValue('--spatial-navigation-contain') === '') {
        CSS.registerProperty({
          name: '--spatial-navigation-contain',
          syntax: 'auto | contain',
          inherits: false,
          initialValue: 'auto'
        });
      }

      if (window.getComputedStyle(document.documentElement).getPropertyValue('--spatial-navigation-action') === '') {
        CSS.registerProperty({
          name: '--spatial-navigation-action',
          syntax: 'auto | focus | scroll',
          inherits: false,
          initialValue: 'auto'
        });
      }

      if (window.getComputedStyle(document.documentElement).getPropertyValue('--spatial-navigation-function') === '') {
        CSS.registerProperty({
          name: '--spatial-navigation-function',
          syntax: 'normal | grid',
          inherits: false,
          initialValue: 'normal'
        });
      }
    }
  }

  /**
   * Add event handlers for the spatial navigation behavior.
   * This function defines which input methods trigger the spatial navigation behavior.
   * @function spatialNavigationHandler
   */
  function spatialNavigationHandler() {
    /*
     * keydown EventListener :
     * If arrow key pressed, get the next focusing element and send it to focusing controller
     */
    window.addEventListener('keydown', (e) => {
      const currentKeyMode = (parent && parent.__spatialNavigation__.keyMode) || window.__spatialNavigation__.keyMode;
      const eventTarget = document.activeElement;
      const dir = ARROW_KEY_CODE[e.keyCode];

      if (e.keyCode === TAB_KEY_CODE) {
        startingPoint = null;
      }

      if (!currentKeyMode ||
          (currentKeyMode === 'NONE') ||
          ((currentKeyMode === 'SHIFTARROW') && !e.shiftKey) ||
          ((currentKeyMode === 'ARROW') && e.shiftKey))
        return;

      if (!e.defaultPrevented) {
        let focusNavigableArrowKey = {left: true, up: true, right: true, down: true};

        // Edge case (text input, area) : Don't move focus, just navigate cursor in text area
        if ((eventTarget.nodeName === 'INPUT') || eventTarget.nodeName === 'TEXTAREA') {
          focusNavigableArrowKey = handlingEditableElement(e);
        }

        if (focusNavigableArrowKey[dir]) {
          e.preventDefault();
          mapOfBoundRect = new Map();

          navigate(dir);

          mapOfBoundRect = null;
          startingPoint = null;
        }
      }
    });

    /*
     * mouseup EventListener :
     * If the mouse click a point in the page, the point will be the starting point.
     * NOTE: Let UA set the spatial navigation starting point based on click
     */
    document.addEventListener('mouseup', (e) => {
      startingPoint = {x: e.clientX, y: e.clientY};
    });

    /*
     * focusin EventListener :
     * When the element get the focus, save it and its DOMRect for resetting the search origin
     * if it disappears.
     */
    window.addEventListener('focusin', (e) => {
      if (e.target !== window) {
        savedSearchOrigin.element = e.target;
        savedSearchOrigin.rect = e.target.getBoundingClientRect();
      }
    });
  }

  /**
   * Enable the author to trigger spatial navigation programmatically, as if the user had done so manually.
   * @see {@link https://drafts.csswg.org/css-nav-1/#dom-window-navigate}
   * @function navigate
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   */
  function navigate(dir) {
    // spatial navigation steps

    // 1
    const searchOrigin = findSearchOrigin();
    let eventTarget = searchOrigin;

    let elementFromPosition = null;

    // 2 Optional step, UA defined starting point
    if (startingPoint) {
      // if there is a starting point, set eventTarget as the element from position for getting the spatnav container
      elementFromPosition = document.elementFromPoint(startingPoint.x, startingPoint.y);

      // Use starting point if the starting point isn't inside the focusable element (but not container)
      // * Starting point is meaningfull when:
      // 1) starting point is inside the spatnav container
      // 2) starting point is inside the non-focusable element
      if (elementFromPosition === null) {
        elementFromPosition = document.body;
      }
      if (isFocusable(elementFromPosition) && !isContainer(elementFromPosition)) {
        startingPoint = null;
      } else if (isContainer(elementFromPosition)) {
        eventTarget = elementFromPosition;
      } else {
        eventTarget = elementFromPosition.getSpatialNavigationContainer();
      }
    }

    // 4
    if (eventTarget === document || eventTarget === document.documentElement) {
      eventTarget = document.body || document.documentElement;
    }

    // 5
    // At this point, spatialNavigationSearch can be applied.
    // If startingPoint is either a scroll container or the document,
    // find the best candidate within startingPoint
    let container = null;
    if ((isContainer(eventTarget) || eventTarget.nodeName === 'BODY') && !(eventTarget.nodeName === 'INPUT')) {
      if (eventTarget.nodeName === 'IFRAME') {
        eventTarget = eventTarget.contentDocument.documentElement;
      }
      container = eventTarget;
      let bestInsideCandidate = null;

      // 5-2
      if ((document.activeElement === searchOrigin) || 
          (document.activeElement === document.body) && (searchOrigin === document.documentElement)) {
        if (getCSSSpatNavAction(eventTarget) === 'scroll') {
          if (scrollingController(eventTarget, dir)) return;
        } else if (getCSSSpatNavAction(eventTarget) === 'focus') {
          bestInsideCandidate = eventTarget.spatialNavigationSearch(dir, {container: eventTarget, candidates: getSpatialNavigationCandidates(eventTarget, {mode: 'all'})});
          if (focusingController(bestInsideCandidate, dir)) return;
        } else if (getCSSSpatNavAction(eventTarget) === 'auto') {
          bestInsideCandidate = eventTarget.spatialNavigationSearch(dir, {container: eventTarget});
          if (focusingController(bestInsideCandidate, dir) || scrollingController(eventTarget, dir)) return;
        }
      } else {
        // when the previous search origin became offscreen
        container = container.getSpatialNavigationContainer();
      }
    }

    // 6
    // Let container be the nearest ancestor of eventTarget
    container = eventTarget.getSpatialNavigationContainer();
    let parentContainer = (container.parentElement) ? container.getSpatialNavigationContainer() : null;

    // When the container is the viewport of a browsing context
    if (!parentContainer && ( window.location !== window.parent.location)) {
      parentContainer = window.parent.document.documentElement;
    }

    if (getCSSSpatNavAction(container) === 'scroll') {
      if (scrollingController(container, dir)) return;
    } else if (getCSSSpatNavAction(container) === 'focus') {
      navigateChain(eventTarget, container, parentContainer, dir, 'all');
    } else if (getCSSSpatNavAction(container) === 'auto') {
      navigateChain(eventTarget, container, parentContainer, dir, 'visible');
    }
  }

  /**
   * Move the focus to the best candidate or do nothing.
   * @function focusingController
   * @param bestCandidate {Node} - The best candidate of the spatial navigation
   * @param dir {SpatialNavigationDirection}- The directional information for the spatial navigation (e.g. LRUD)
   * @returns {boolean}
   */
  function focusingController(bestCandidate, dir) {
    // 10 & 11
    // When bestCandidate is found
    if (bestCandidate) {
      // When bestCandidate is a focusable element and not a container : move focus
      /*
       * [event] navbeforefocus : Fired before spatial or sequential navigation changes the focus.
       */
      if (!createSpatNavEvents('beforefocus', bestCandidate, null, dir)) 
        return true;

      const container = bestCandidate.getSpatialNavigationContainer();

      if ((container !== window) && (getCSSSpatNavAction(container) === 'focus')) {
        bestCandidate.focus();
      } else {
        bestCandidate.focus({preventScroll: true});
      }

      startingPoint = null;
      return true;
    }

    // When bestCandidate is not found within the scrollport of a container: Nothing
    return false;
  }

  /**
   * Directionally scroll the scrollable spatial navigation container if it can be manually scrolled more.
   * @function scrollingController
   * @param container {Node} - The spatial navigation container which can scroll
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   * @returns {boolean}
   */
  function scrollingController(container, dir) {

    // If there is any scrollable area among parent elements and it can be manually scrolled, scroll the document
    if (isScrollable(container, dir) && !isScrollBoundary(container, dir)) {
      moveScroll(container, dir);
      return true;
    }

    // If the spatnav container is document and it can be scrolled, scroll the document
    if (!container.parentElement && !isHTMLScrollBoundary(container, dir)) {
      moveScroll(container.ownerDocument.documentElement, dir);
      return true;
    }
    return false;
  }

  /**
   * Find the candidates within a spatial navigation container include delegable container.
   * This function does not search inside delegable container or focusable container.
   * In other words, this return candidates set is not included focusable elements inside delegable container or focusable container.
   *
   * @function getSpatialNavigationCandidates
   * @param container {Node} - The spatial navigation container
   * @param option {FocusableAreasOptions} - 'mode' attribute takes 'visible' or 'all' for searching the boundary of focusable elements.
   *                                          Default value is 'visible'.
   * @returns {sequence<Node>} candidate elements within the container
   */
  function getSpatialNavigationCandidates (container, option = {mode: 'visible'}) {
    let candidates = [];

    if (container.childElementCount > 0) {
      if (!container.parentElement) {
        container = container.getElementsByTagName('body')[0] || document.body;
      }
      const children = container.children;
      for (const elem of children) {
        if (isDelegableContainer(elem)) {
          candidates.push(elem);
        } else if (isFocusable(elem)) {
          candidates.push(elem);

          if (!isContainer(elem) && elem.childElementCount) {
            candidates = candidates.concat(getSpatialNavigationCandidates(elem, {mode: 'all'}));
          }
        } else if (elem.childElementCount) {
          candidates = candidates.concat(getSpatialNavigationCandidates(elem, {mode: 'all'}));
        }
      }
    }
    return (option.mode === 'all') ? candidates : candidates.filter(isVisible);
  }

  /**
   * Find the candidates among focusable elements within a spatial navigation container from the search origin (currently focused element)
   * depending on the directional information.
   * @function getFilteredSpatialNavigationCandidates
   * @param element {Node} - The currently focused element which is defined as 'search origin' in the spec
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   * @param candidates {sequence<Node>} - The candidates for spatial navigation without the directional information
   * @param container {Node} - The spatial navigation container
   * @returns {Node} The candidates for spatial navigation considering the directional information
   */
  function getFilteredSpatialNavigationCandidates (element, dir, candidates, container) {
    const targetElement = element;
    // Removed below line due to a bug. (iframe body rect is sometime weird.)
    // const targetElement = (element.nodeName === 'IFRAME') ? element.contentDocument.body : element;
    // If the container is unknown, get the closest container from the element
    container = container || targetElement.getSpatialNavigationContainer();

    // If the candidates is unknown, find candidates
    // 5-1
    candidates = (!candidates || candidates.length <= 0) ? getSpatialNavigationCandidates(container) : candidates;
    return filteredCandidates(targetElement, candidates, dir, container);
  }

  /**
   * Find the best candidate among the candidates within the container from the search origin (currently focused element)
   * @see {@link https://drafts.csswg.org/css-nav-1/#dom-element-spatialnavigationsearch}
   * @function spatialNavigationSearch
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   * @param candidates {sequence<Node>} - The candidates for spatial navigation
   * @param container {Node} - The spatial navigation container
   * @returns {Node} The best candidate which will gain the focus
   */
  function spatialNavigationSearch (dir, args) {
    const targetElement = this;
    let internalCandidates = [];
    let externalCandidates = [];
    let insideOverlappedCandidates = getOverlappedCandidates(targetElement);
    let bestTarget;

    // Set default parameter value
    if (!args)
      args = {};

    const defaultContainer = targetElement.getSpatialNavigationContainer();
    let defaultCandidates = getSpatialNavigationCandidates(defaultContainer);
    const container = args.container || defaultContainer;
    if (args.container && (defaultContainer.contains(args.container))) {
      defaultCandidates = defaultCandidates.concat(getSpatialNavigationCandidates(container));
    }
    const candidates = (args.candidates && args.candidates.length > 0) ? 
                          args.candidates.filter((candidate) => container.contains(candidate)) : 
                          defaultCandidates.filter((candidate) => container.contains(candidate) && (container !== candidate));

    // Find the best candidate
    // 5
    // If startingPoint is either a scroll container or the document,
    // find the best candidate within startingPoint
    if (candidates && candidates.length > 0) {

      // Divide internal or external candidates
      candidates.forEach(candidate => {
        if (candidate !== targetElement) {
          (targetElement.contains(candidate) && targetElement !== candidate ? internalCandidates : externalCandidates).push(candidate);
        }
      });

      // include overlapped element to the internalCandidates
      let fullyOverlapped = insideOverlappedCandidates.filter(candidate => !internalCandidates.includes(candidate));
      let overlappedContainer = candidates.filter(candidate => (isContainer(candidate) && isEntirelyVisible(targetElement, candidate)));
      let overlappedByParent = overlappedContainer.map((elm) => elm.focusableAreas()).flat().filter(candidate => candidate !== targetElement);
      
      internalCandidates = internalCandidates.concat(fullyOverlapped).filter((candidate) => container.contains(candidate));
      externalCandidates = externalCandidates.concat(overlappedByParent).filter((candidate) => container.contains(candidate));

      // Filter external Candidates
      if (externalCandidates.length > 0) {
        externalCandidates = getFilteredSpatialNavigationCandidates(targetElement, dir, externalCandidates, container);
      }
      
      // If there isn't search origin element but search orgin rect exist  (search origin isn't in the layout case)
      if (searchOriginRect) {
        bestTarget = selectBestCandidate(targetElement, getFilteredSpatialNavigationCandidates(targetElement, dir, internalCandidates, container), dir);
      }

      if ((internalCandidates && internalCandidates.length > 0) && !(targetElement.nodeName === 'INPUT')) {
        bestTarget = selectBestCandidateFromEdge(targetElement, internalCandidates, dir);
      }

      bestTarget = bestTarget || selectBestCandidate(targetElement, externalCandidates, dir);

      if (bestTarget && isDelegableContainer(bestTarget)) {
        // if best target is delegable container, then find descendants candidate inside delegable container.
        const innerTarget = getSpatialNavigationCandidates(bestTarget, {mode: 'all'});
        const descendantsBest = innerTarget.length > 0 ? targetElement.spatialNavigationSearch(dir, {candidates: innerTarget, container: bestTarget}) : null;
        if (descendantsBest) {
          bestTarget = descendantsBest;
        } else if (!isFocusable(bestTarget)) {
          // if there is no target inside bestTarget and delegable container is not focusable,
          // then try to find another best target without curren best target.
          candidates.splice(candidates.indexOf(bestTarget), 1);
          bestTarget = candidates.length ? targetElement.spatialNavigationSearch(dir, {candidates: candidates, container: container}) : null;
        }
      }
      return bestTarget;
    }

    return null;
  }

  /**
   * Get the filtered candidate among candidates.
   * @see {@link https://drafts.csswg.org/css-nav-1/#select-the-best-candidate}
   * @function filteredCandidates
   * @param currentElm {Node} - The currently focused element which is defined as 'search origin' in the spec
   * @param candidates {sequence<Node>} - The candidates for spatial navigation
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   * @param container {Node} - The spatial navigation container
   * @returns {sequence<Node>} The filtered candidates which are not the search origin and not in the given spatial navigation direction from the search origin
   */
  // TODO: Need to fix filtering the candidates with more clean code
  function filteredCandidates(currentElm, candidates, dir, container) {
    const originalContainer = currentElm.getSpatialNavigationContainer();
    let eventTargetRect;

    // If D(dir) is null, let candidates be the same as visibles
    if (dir === undefined)
      return candidates;

    // Offscreen handling when originalContainer is not <HTML>
    if (originalContainer.parentElement && container !== originalContainer && !isVisible(currentElm)) {
      eventTargetRect = getBoundingClientRect(originalContainer);
    } else {
      eventTargetRect = searchOriginRect || getBoundingClientRect(currentElm);
    }

    /*
     * Else, let candidates be the subset of the elements in visibles
     * whose principal box’s geometric center is within the closed half plane
     * whose boundary goes through the geometric center of starting point and is perpendicular to D.
     */
    if ((isContainer(currentElm) || currentElm.nodeName === 'BODY') && !(currentElm.nodeName === 'INPUT')) {
      return candidates.filter(candidate => {
        const candidateRect = getBoundingClientRect(candidate);
        return container.contains(candidate) &&
          ((currentElm.contains(candidate) && isInside(eventTargetRect, candidateRect) && candidate !== currentElm) ||
          isOutside(candidateRect, eventTargetRect, dir));
      });
    } else {
      return candidates.filter(candidate => {
        const candidateRect = getBoundingClientRect(candidate);
        const candidateBody = (candidate.nodeName === 'IFRAME') ? candidate.contentDocument.body : null;
        return container.contains(candidate) &&
          candidate !== currentElm && candidateBody !== currentElm &&
          isOutside(candidateRect, eventTargetRect, dir) &&
          !isInside(eventTargetRect, candidateRect);
      });
    }
  }

  /**
   * Select the best candidate among given candidates.
   * @see {@link https://drafts.csswg.org/css-nav-1/#select-the-best-candidate}
   * @function selectBestCandidate
   * @param currentElm {Node} - The currently focused element which is defined as 'search origin' in the spec
   * @param candidates {sequence<Node>} - The candidates for spatial navigation
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   * @returns {Node} The best candidate which will gain the focus
   */
  function selectBestCandidate(currentElm, candidates, dir) {
    const container = currentElm.getSpatialNavigationContainer();
    const spatialNavigationFunction = getComputedStyle(container).getPropertyValue('--spatial-navigation-function');
    const currentTargetRect = searchOriginRect || getBoundingClientRect(currentElm);
    let distanceFunction;
    let alignedCandidates;

    switch (spatialNavigationFunction) {
    case 'grid':
      alignedCandidates = candidates.filter(elm => isAligned(currentTargetRect, getBoundingClientRect(elm), dir));
      if (alignedCandidates.length > 0) {
        candidates = alignedCandidates;
      }
      distanceFunction = getAbsoluteDistance;
      break;
    default:
      distanceFunction = getDistance;
      break;
    }
    return getClosestElement(currentElm, candidates, dir, distanceFunction);
  }

  /**
   * Select the best candidate among candidates by finding the closet candidate from the edge of the currently focused element (search origin).
   * @see {@link https://drafts.csswg.org/css-nav-1/#select-the-best-candidate (Step 5)}
   * @function selectBestCandidateFromEdge
   * @param currentElm {Node} - The currently focused element which is defined as 'search origin' in the spec
   * @param candidates {sequence<Node>} - The candidates for spatial navigation
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   * @returns {Node} The best candidate which will gain the focus
   */
  function selectBestCandidateFromEdge(currentElm, candidates, dir) {
    if (startingPoint)
      return getClosestElement(currentElm, candidates, dir, getDistanceFromPoint);
    else
      return getClosestElement(currentElm, candidates, dir, getInnerDistance);
  }

  /**
   * Select the closest candidate from the currently focused element (search origin) among candidates by using the distance function.
   * @function getClosestElement
   * @param currentElm {Node} - The currently focused element which is defined as 'search origin' in the spec
   * @param candidates {sequence<Node>} - The candidates for spatial navigation
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   * @param distanceFunction {function} - The distance function which measures the distance from the search origin to each candidate
   * @returns {Node} The candidate which is the closest one from the search origin
   */
  function getClosestElement(currentElm, candidates, dir, distanceFunction) {
    let eventTargetRect = null;
    if (( window.location !== window.parent.location ) && (currentElm.nodeName === 'BODY' || currentElm.nodeName === 'HTML')) {
      // If the eventTarget is iframe, then get rect of it based on its containing document
      // Set the iframe's position as (0,0) because the rects of elements inside the iframe don't know the real iframe's position.
      eventTargetRect = window.frameElement.getBoundingClientRect();
      eventTargetRect.x = 0;
      eventTargetRect.y = 0;
    } else {
      eventTargetRect = searchOriginRect || currentElm.getBoundingClientRect();
    }

    let minDistance = Number.POSITIVE_INFINITY;
    let minDistanceElements = [];

    if (candidates) {
      for (let i = 0; i < candidates.length; i++) {
        const distance = distanceFunction(eventTargetRect, getBoundingClientRect(candidates[i]), dir);

        // If the same distance, the candidate will be selected in the DOM order
        if (distance < minDistance) {
          minDistance = distance;
          minDistanceElements = [candidates[i]];
        } else if (distance === minDistance) {
          minDistanceElements.push(candidates[i]);
        }
      }
    }
    if (minDistanceElements.length === 0)
      return null;

    return (minDistanceElements.length > 1 && distanceFunction === getAbsoluteDistance) ?
      getClosestElement(currentElm, minDistanceElements, dir, getEuclideanDistance) : minDistanceElements[0];
  }

  /**
   * Get container of an element.
   * @see {@link https://drafts.csswg.org/css-nav-1/#dom-element-getspatialnavigationcontainer}
   * @module Element
   * @function getSpatialNavigationContainer
   * @returns {Node} The spatial navigation container
   */
  function getSpatialNavigationContainer() {
    let container = this;

    do {
      if (!container.parentElement) {
        if (window.location !== window.parent.location) {
          container = window.parent.document.documentElement;
        } else {
          container = window.document.documentElement;
        }
        break;
      } else {
        container = container.parentElement;
      }
    } while (!isContainer(container));
    return container;
  }

  /**
   * Get nearest scroll container of an element.
   * @function getScrollContainer
   * @param Element
   * @returns {Node} The spatial navigation container
   */
  function getScrollContainer(element) {
    let scrollContainer = element;

    do {
      if (!scrollContainer.parentElement) {
        if (window.location !== window.parent.location) {
          scrollContainer = window.parent.document.documentElement;
        } else {
          scrollContainer = window.document.documentElement;
        }
        break;
      } else {
        scrollContainer = scrollContainer.parentElement;
      }
    } while (!isScrollContainer(scrollContainer) || !isVisible(scrollContainer));

    if (scrollContainer === document || scrollContainer === document.documentElement) {
      scrollContainer = window;
    }
  
    return scrollContainer;
  }

  /**
   * Find focusable elements within the spatial navigation container.
   * @see {@link https://drafts.csswg.org/css-nav-1/#dom-element-focusableareas}
   * @function focusableAreas
   * @param option {FocusableAreasOptions} - 'mode' attribute takes 'visible' or 'all' for searching the boundary of focusable elements.
   *                                          Default value is 'visible'.
   * @returns {sequence<Node>} All focusable elements or only visible focusable elements within the container
   */
  function focusableAreas(option = {mode: 'visible'}) {
    const container = this.parentElement ? this : document.body;
    const focusables = Array.prototype.filter.call(container.getElementsByTagName('*'), isFocusable);
    return (option.mode === 'all') ? focusables : focusables.filter(isVisible);
  }

  /**
   * Create the NavigationEvent: navbeforefocus, navnotarget
   * @see {@link https://drafts.csswg.org/css-nav-1/#events-navigationevent}
   * @function createSpatNavEvents
   * @param option {string} - Type of the navigation event (beforefocus, notarget)
   * @param element {Node} - The target element of the event
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   */
  function createSpatNavEvents(eventType, containerElement, currentElement, direction) {
    if (['beforefocus', 'notarget'].includes(eventType)) {
      const data = {
        causedTarget: currentElement,
        dir: direction
      };
      const triggeredEvent = new CustomEvent('nav' + eventType, {bubbles: true, cancelable: true, detail: data});
      return containerElement.dispatchEvent(triggeredEvent);
    }
  }

  /**
   * Get the value of the CSS custom property of the element
   * @function readCssVar
   * @param element {Node}
   * @param varName {string} - The name of the css custom property without '--'
   * @returns {string} The value of the css custom property
   */
  function readCssVar(element, varName) {
    return element.style.getPropertyValue(`--${varName}`).trim();
  }

  /**
   * Decide whether or not the 'contain' value is given to 'spatial-navigation-contain' css property of an element
   * @function isCSSSpatNavContain
   * @param element {Node}
   * @returns {boolean}
   */
  function isCSSSpatNavContain(element) {
    return readCssVar(element, 'spatial-navigation-contain') === 'contain';
  }

  /**
   * Return the value of 'spatial-navigation-action' css property of an element
   * @function getCSSSpatNavAction
   * @param element {Node} - would be the spatial navigation container
   * @returns {string} auto | focus | scroll
   */
  function getCSSSpatNavAction(element) {
    return readCssVar(element, 'spatial-navigation-action') || 'auto';
  }

  /**
   * Only move the focus with spatial navigation. Manually scrolling isn't available.
   * @function navigateChain
   * @param eventTarget {Node} - currently focused element
   * @param container {SpatialNavigationContainer} - container
   * @param parentContainer {SpatialNavigationContainer} - parent container
   * @param option - visible || all
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   */
  function navigateChain(eventTarget, container, parentContainer, dir, option) {
    let currentOption = {candidates: getSpatialNavigationCandidates(container, {mode: option}), container};

    while (parentContainer) {
      if (focusingController(eventTarget.spatialNavigationSearch(dir, currentOption), dir)) {
        return;
      } else {
        if ((option === 'visible') && scrollingController(container, dir)) return;
        else {
          if (!createSpatNavEvents('notarget', container, eventTarget, dir)) return;

          // find the container
          if (container === document || container === document.documentElement) {
            if ( window.location !== window.parent.location ) {
              // The page is in an iframe. eventTarget needs to be reset because the position of the element in the iframe
              eventTarget = window.frameElement;
              container = eventTarget.ownerDocument.documentElement;              
            }
          } else {
            container = parentContainer;
          }
          currentOption = {candidates: getSpatialNavigationCandidates(container, {mode: option}), container};
          let nextContainer = container.getSpatialNavigationContainer();

          if (nextContainer !== container) {
            parentContainer = nextContainer;
          } else {
            parentContainer = null;
          }
        }
      }
    }

    currentOption = {candidates: getSpatialNavigationCandidates(container, {mode: option}), container};

    // Behavior after 'navnotarget' - Getting out from the current spatnav container
    if ((!parentContainer && container) && focusingController(eventTarget.spatialNavigationSearch(dir, currentOption), dir)) return;

    if (!createSpatNavEvents('notarget', currentOption.container, eventTarget, dir)) return;

    if ((getCSSSpatNavAction(container) === 'auto') && (option === 'visible')) {
      if (scrollingController(container, dir)) return;
    }
  }

  /**
   * Find search origin
   * @see {@link https://drafts.csswg.org/css-nav-1/#nav}
   * @function findSearchOrigin
   * @returns {Node} The search origin for the spatial navigation
   */
  function findSearchOrigin() {
    let searchOrigin = document.activeElement;

    if (!searchOrigin || (searchOrigin === document.body && !document.querySelector(':focus'))) {
      // When the previous search origin lost its focus by blur: (1) disable attribute (2) visibility: hidden
      if (savedSearchOrigin.element && (searchOrigin !== savedSearchOrigin.element)) {
        const elementStyle = window.getComputedStyle(savedSearchOrigin.element, null);
        const invisibleStyle = ['hidden', 'collapse'];

        if (savedSearchOrigin.element.disabled || invisibleStyle.includes(elementStyle.getPropertyValue('visibility'))) {
          searchOrigin = savedSearchOrigin.element;
          return searchOrigin;
        }
      }
      searchOrigin = document.documentElement;
    }
    // When the previous search origin lost its focus by blur: (1) display:none () element size turned into zero
    if (savedSearchOrigin.element &&
      ((getBoundingClientRect(savedSearchOrigin.element).height === 0) || (getBoundingClientRect(savedSearchOrigin.element).width === 0))) {
      searchOriginRect = savedSearchOrigin.rect;
    }
    
    if (!isVisibleInScroller(searchOrigin)) {
      const scroller = getScrollContainer(searchOrigin);
      if (scroller && ((scroller === window) || (getCSSSpatNavAction(scroller) === 'auto')))
        return scroller;
    }
    return searchOrigin;
  }

  /**
   * Move the scroll of an element depending on the given spatial navigation directrion
   * (Assume that User Agent defined distance is '40px')
   * @see {@link https://drafts.csswg.org/css-nav-1/#directionally-scroll-an-element}
   * @function moveScroll
   * @param element {Node} - The scrollable element
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   * @param offset {Number} - The explicit amount of offset for scrolling. Default value is 0.
   */
  function moveScroll(element, dir, offset = 0) {
    if (element) {
      switch (dir) {
      case 'left': element.scrollLeft -= (40 + offset); break;
      case 'right': element.scrollLeft += (40 + offset); break;
      case 'up': element.scrollTop -= (40 + offset); break;
      case 'down': element.scrollTop += (40 + offset); break;
      }
    }
  }

  /**
   * Decide whether an element is container or not.
   * @function isContainer
   * @param element {Node} element
   * @returns {boolean}
   */
  function isContainer(element) {
    return (!element.parentElement) ||
            (element.nodeName === 'IFRAME') ||
            (isScrollContainer(element)) ||
            (isCSSSpatNavContain(element));
  }

  /**
   * Decide whether an element is delegable container or not.
   * NOTE: THIS IS NON-NORMATIVE API. 
   * @function isDelegableContainer
   * @param element {Node} element
   * @returns {boolean}
   */
  function isDelegableContainer(element) {
    return readCssVar(element, 'spatial-navigation-contain') === 'delegable';
  }

  /**
   * Decide whether an element is a scrollable container or not.
   * @see {@link https://drafts.csswg.org/css-overflow-3/#scroll-container}
   * @function isScrollContainer
   * @param element {Node}
   * @returns {boolean}
   */
  function isScrollContainer(element) {
    const elementStyle = window.getComputedStyle(element, null);
    const overflowX = elementStyle.getPropertyValue('overflow-x');
    const overflowY = elementStyle.getPropertyValue('overflow-y');

    return ((overflowX !== 'visible' && overflowX !== 'clip' && isOverflow(element, 'left')) ||
          (overflowY !== 'visible' && overflowY !== 'clip' && isOverflow(element, 'down'))) ?
           true : false;
  }

  /**
   * Decide whether this element is scrollable or not.
   * NOTE: If the value of 'overflow' is given to either 'visible', 'clip', or 'hidden', the element isn't scrollable.
   *       If the value is 'hidden', the element can be only programmically scrollable. (https://drafts.csswg.org/css-overflow-3/#valdef-overflow-hidden)
   * @function isScrollable
   * @param element {Node}
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   * @returns {boolean}
   */
  function isScrollable(element, dir) { // element, dir
    if (element && typeof element === 'object') {
      if (dir && typeof dir === 'string') { // parameter: dir, element
        if (isOverflow(element, dir)) {
          // style property
          const elementStyle = window.getComputedStyle(element, null);
          const overflowX = elementStyle.getPropertyValue('overflow-x');
          const overflowY = elementStyle.getPropertyValue('overflow-y');

          switch (dir) {
          case 'left':
            /* falls through */
          case 'right':
            return (overflowX !== 'visible' && overflowX !== 'clip' && overflowX !== 'hidden');
          case 'up':
            /* falls through */
          case 'down':
            return (overflowY !== 'visible' && overflowY !== 'clip' && overflowY !== 'hidden');
          }
        }
        return false;
      } else { // parameter: element
        return (element.nodeName === 'HTML' || element.nodeName === 'BODY') ||
                (isScrollContainer(element) && isOverflow(element));
      }
    }
  }

  /**
   * Decide whether an element is overflow or not.
   * @function isOverflow
   * @param element {Node}
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   * @returns {boolean}
   */
  function isOverflow(element, dir) {
    if (element && typeof element === 'object') {
      if (dir && typeof dir === 'string') { // parameter: element, dir
        switch (dir) {
        case 'left':
          /* falls through */
        case 'right':
          return (element.scrollWidth > element.clientWidth);
        case 'up':
          /* falls through */
        case 'down':
          return (element.scrollHeight > element.clientHeight);
        }
      } else { // parameter: element
        return (element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight);
      }
      return false;
    }
  }

  /**
   * Decide whether the scrollbar of the browsing context reaches to the end or not.
   * @function isHTMLScrollBoundary
   * @param element {Node} - The top browsing context
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   * @returns {boolean}
   */
  function isHTMLScrollBoundary(element, dir) {
    let result = false;
    switch (dir) {
    case 'left':
      result = element.scrollLeft === 0;
      break;
    case 'right':
      result = (element.scrollWidth - element.scrollLeft - element.clientWidth) === 0;
      break;
    case 'up':
      result = element.scrollTop === 0;
      break;
    case 'down':
      result = (element.scrollHeight - element.scrollTop - element.clientHeight) === 0;
      break;
    }
    return result;
  }

  /**
   * Decide whether the scrollbar of an element reaches to the end or not.
   * @function isScrollBoundary
   * @param element {Node}
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   * @returns {boolean}
   */
  function isScrollBoundary(element, dir) {
    if (isScrollable(element, dir)) {
      const winScrollY = element.scrollTop;
      const winScrollX = element.scrollLeft;

      const height = element.scrollHeight - element.clientHeight;
      const width = element.scrollWidth - element.clientWidth;

      switch (dir) {
      case 'left': return (winScrollX === 0);
      case 'right': return (Math.abs(winScrollX - width) <= 1);
      case 'up': return (winScrollY === 0);
      case 'down': return (Math.abs(winScrollY - height) <= 1);
      }
    }
    return false;
  }

  /**
   * Decide whether an element is inside the scorller viewport or not
   *
   * @function isVisibleInScroller
   * @param element {Node}
   * @returns {boolean}
   */
  function isVisibleInScroller(element) {
    const elementRect = element.getBoundingClientRect();
    let nearestScroller = getScrollContainer(element);

    let scrollerRect = null;
    if (nearestScroller !== window) {
      scrollerRect = getBoundingClientRect(nearestScroller);
    } else {
      scrollerRect = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    }
   
    if (isInside(scrollerRect, elementRect, 'left') && isInside(scrollerRect, elementRect, 'down'))
      return true; 
    else
      return false;
  }

  /**
   * Decide whether an element is focusable for spatial navigation.
   * 1. If element is the browsing context (document, iframe), then it's focusable,
   * 2. If the element is scrollable container (regardless of scrollable axis), then it's focusable,
   * 3. The value of tabIndex >= 0, then it's focusable,
   * 4. If the element is disabled, it isn't focusable,
   * 5. If the element is expressly inert, it isn't focusable,
   * 6. Whether the element is being rendered or not.
   *
   * @function isFocusable
   * @param element {Node}
   * @returns {boolean}
   *
   * @see {@link https://html.spec.whatwg.org/multipage/interaction.html#focusable-area}
   */
  function isFocusable(element) {
    if ((element.tabIndex < 0) || isAtagWithoutHref(element) || isActuallyDisabled(element) || isExpresslyInert(element) || !isBeingRendered(element))
      return false;
    else if ((!element.parentElement) || (isScrollable(element) && isOverflow(element)) || (element.tabIndex >= 0))
      return true;
  }

  /**
   * Decide whether an element is a tag without href attribute or not.
   *
   * @function isAtagWithoutHref
   * @param element {Node}
   * @returns {boolean}
   */
  function isAtagWithoutHref(element) {
    return (element.tagName === 'A' && element.getAttribute('href') === null && element.getAttribute('tabIndex') === null);
  }

  /**
   * Decide whether an element is actually disabled or not.
   *
   * @function isActuallyDisabled
   * @param element {Node}
   * @returns {boolean}
   *
   * @see {@link https://html.spec.whatwg.org/multipage/semantics-other.html#concept-element-disabled}
   */
  function isActuallyDisabled(element) {
    if (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTGROUP', 'OPTION', 'FIELDSET'].includes(element.tagName))
      return (element.disabled);
    else
      return false;
  }

  /**
   * Decide whether the element is expressly inert or not.
   * @see {@link https://html.spec.whatwg.org/multipage/interaction.html#expressly-inert}
   * @function isExpresslyInert
   * @param element {Node}
   * @returns {boolean}
   */
  function isExpresslyInert(element) {
    return ((element.inert) && (!element.ownerDocument.documentElement.inert));
  }

  /**
   * Decide whether the element is being rendered or not.
   * 1. If an element has the style as "visibility: hidden | collapse" or "display: none", it is not being rendered.
   * 2. If an element has the style as "opacity: 0", it is not being rendered.(that is, invisible).
   * 3. If width and height of an element are explicitly set to 0, it is not being rendered.
   * 4. If a parent element is hidden, an element itself is not being rendered.
   * (CSS visibility property and display property are inherited.)
   * @see {@link https://html.spec.whatwg.org/multipage/rendering.html#being-rendered}
   * @function isBeingRendered
   * @param element {Node}
   * @returns {boolean}
   */
  function isBeingRendered(element) {
    if (!isVisibleStyleProperty(element.parentElement))
      return false;
    if (!isVisibleStyleProperty(element) || (element.style.opacity === '0') ||
        (window.getComputedStyle(element).height === '0px' || window.getComputedStyle(element).width === '0px'))
      return false;
    return true;
  }

  /**
   * Decide whether this element is partially or completely visible to user agent.
   * @function isVisible
   * @param element {Node}
   * @returns {boolean}
   */
  function isVisible(element) {
    return (!element.parentElement) || (isVisibleStyleProperty(element) && hitTest(element));
  }

  /**
   * Decide whether this element is completely visible in this viewport for the arrow direction.
   * @function isEntirelyVisible
   * @param element {Node}
   * @returns {boolean}
   */
  function isEntirelyVisible(element, container) {
    const rect = getBoundingClientRect(element);
    const containerElm = container || element.getSpatialNavigationContainer();
    const containerRect = getBoundingClientRect(containerElm);

    // FIXME: when element is bigger than container?
    const entirelyVisible = !((rect.left < containerRect.left) ||
      (rect.right > containerRect.right) ||
      (rect.top < containerRect.top) ||
      (rect.bottom > containerRect.bottom));

    return entirelyVisible;
  }

  /**
   * Decide the style property of this element is specified whether it's visible or not.
   * @function isVisibleStyleProperty
   * @param element {CSSStyleDeclaration}
   * @returns {boolean}
   */
  function isVisibleStyleProperty(element) {
    const elementStyle = window.getComputedStyle(element, null);
    const thisVisibility = elementStyle.getPropertyValue('visibility');
    const thisDisplay = elementStyle.getPropertyValue('display');
    const invisibleStyle = ['hidden', 'collapse'];

    return (thisDisplay !== 'none' && !invisibleStyle.includes(thisVisibility));
  }

  /**
   * Decide whether this element is entirely or partially visible within the viewport.
   * @function hitTest
   * @param element {Node}
   * @returns {boolean}
   */
  function hitTest(element) {
    const elementRect = getBoundingClientRect(element);
    if (element.nodeName !== 'IFRAME' && (elementRect.top < 0 || elementRect.left < 0 ||
      elementRect.top > element.ownerDocument.documentElement.clientHeight || elementRect.left >element.ownerDocument.documentElement.clientWidth))
      return false;

    let offsetX = parseInt(element.offsetWidth) / 10;
    let offsetY = parseInt(element.offsetHeight) / 10;

    offsetX = isNaN(offsetX) ? 1 : offsetX;
    offsetY = isNaN(offsetY) ? 1 : offsetY;

    const hitTestPoint = {
      // For performance, just using the three point(middle, leftTop, rightBottom) of the element for hit testing
      middle: [(elementRect.left + elementRect.right) / 2, (elementRect.top + elementRect.bottom) / 2],
      leftTop: [elementRect.left + offsetX, elementRect.top + offsetY],
      rightBottom: [elementRect.right - offsetX, elementRect.bottom - offsetY]
    };

    for(const point in hitTestPoint) {
      const elemFromPoint = element.ownerDocument.elementFromPoint(...hitTestPoint[point]);
      if (element === elemFromPoint || element.contains(elemFromPoint)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Decide whether a child element is entirely or partially Included within container visually.
   * @function isInside
   * @param containerRect {DOMRect}
   * @param childRect {DOMRect}
   * @returns {boolean}
   */
  function isInside(containerRect, childRect) {
    const rightEdgeCheck = (containerRect.left <= childRect.right && containerRect.right >= childRect.right);
    const leftEdgeCheck = (containerRect.left <= childRect.left && containerRect.right >= childRect.left);
    const topEdgeCheck = (containerRect.top <= childRect.top && containerRect.bottom >= childRect.top);
    const bottomEdgeCheck = (containerRect.top <= childRect.bottom && containerRect.bottom >= childRect.bottom);
    return (rightEdgeCheck || leftEdgeCheck) && (topEdgeCheck || bottomEdgeCheck);
  }

  /**
   * Decide whether this element is entirely or partially visible within the viewport.
   * Note: rect1 is outside of rect2 for the dir
   * @function isOutside
   * @param rect1 {DOMRect}
   * @param rect2 {DOMRect}
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   * @returns {boolean}
   */
  function isOutside(rect1, rect2, dir) {
    switch (dir) {
    case 'left':
      return isRightSide(rect2, rect1);
    case 'right':
      return isRightSide(rect1, rect2);
    case 'up':
      return isBelow(rect2, rect1);
    case 'down':
      return isBelow(rect1, rect2);
    default:
      return false;
    }
  }

  /* rect1 is right of rect2 */
  function isRightSide(rect1, rect2) {
    return rect1.left >= rect2.right || (rect1.left >= rect2.left && rect1.right > rect2.right && rect1.bottom > rect2.top && rect1.top < rect2.bottom);
  }

  /* rect1 is below of rect2 */
  function isBelow(rect1, rect2) {
    return rect1.top >= rect2.bottom || (rect1.top >= rect2.top && rect1.bottom > rect2.bottom && rect1.left < rect2.right && rect1.right > rect2.left);
  }

  /* rect1 is completely aligned or partially aligned for the direction */
  function isAligned(rect1, rect2, dir) {
    switch (dir) {
    case 'left' :
      /* falls through */
    case 'right' :
      return rect1.bottom > rect2.top && rect1.top < rect2.bottom;
    case 'up' :
      /* falls through */
    case 'down' :
      return rect1.right > rect2.left && rect1.left < rect2.right;
    default:
      return false;
    }
  }

  /**
   * Get distance between the search origin and a candidate element along the direction when candidate element is inside the search origin.
   * @see {@link https://drafts.csswg.org/css-nav-1/#find-the-shortest-distance}
   * @function getDistanceFromPoint
   * @param point {Point} - The search origin
   * @param element {DOMRect} - A candidate element
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   * @returns {Number} The euclidian distance between the spatial navigation container and an element inside it
   */
  function getDistanceFromPoint(point, element, dir) {
    point = startingPoint;
    // Get exit point, entry point -> {x: '', y: ''};
    const points = getEntryAndExitPoints(dir, point, element);

    // Find the points P1 inside the border box of starting point and P2 inside the border box of candidate
    // that minimize the distance between these two points
    const P1 = Math.abs(points.entryPoint.x - points.exitPoint.x);
    const P2 = Math.abs(points.entryPoint.y - points.exitPoint.y);

    // The result is euclidian distance between P1 and P2.
    return Math.sqrt(Math.pow(P1, 2) + Math.pow(P2, 2));
  }

  /**
   * Get distance between the search origin and a candidate element along the direction when candidate element is inside the search origin.
   * @see {@link https://drafts.csswg.org/css-nav-1/#find-the-shortest-distance}
   * @function getInnerDistance
   * @param rect1 {DOMRect} - The search origin
   * @param rect2 {DOMRect} - A candidate element
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   * @returns {Number} The euclidean distance between the spatial navigation container and an element inside it
   */
  function getInnerDistance(rect1, rect2, dir) {
    const baseEdgeForEachDirection = {left: 'right', right: 'left', up: 'bottom', down: 'top'};
    const baseEdge = baseEdgeForEachDirection[dir];

    return Math.abs(rect1[baseEdge] - rect2[baseEdge]);
  }

  /**
   * Get the distance between the search origin and a candidate element considering the direction.
   * @see {@link https://drafts.csswg.org/css-nav-1/#calculating-the-distance}
   * @function getDistance
   * @param searchOrigin {DOMRect | Point} - The search origin
   * @param candidateRect {DOMRect} - A candidate element
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   * @returns {Number} The distance scoring between two elements
   */
  function getDistance(searchOrigin, candidateRect, dir) {
    const kOrthogonalWeightForLeftRight = 30;
    const kOrthogonalWeightForUpDown = 2;

    let orthogonalBias = 0;
    let alignBias = 0;
    const alignWeight = 5.0;

    // Get exit point, entry point -> {x: '', y: ''};
    const points = getEntryAndExitPoints(dir, searchOrigin, candidateRect);

    // Find the points P1 inside the border box of starting point and P2 inside the border box of candidate
    // that minimize the distance between these two points
    const P1 = Math.abs(points.entryPoint.x - points.exitPoint.x);
    const P2 = Math.abs(points.entryPoint.y - points.exitPoint.y);

    // A: The euclidean distance between P1 and P2.
    const A = Math.sqrt(Math.pow(P1, 2) + Math.pow(P2, 2));
    let B, C;

    // B: The absolute distance in the direction which is orthogonal to dir between P1 and P2, or 0 if dir is null.
    // C: The intersection edges between a candidate and the starting point.

    // D: The square root of the area of intersection between the border boxes of candidate and starting point
    const intersectionRect = getIntersectionRect(searchOrigin, candidateRect);
    const D = intersectionRect.area;

    switch (dir) {
    case 'left':
      /* falls through */
    case 'right' :
      // If two elements are aligned, add align bias
      // else, add orthogonal bias
      if (isAligned(searchOrigin, candidateRect, dir))
        alignBias = Math.min(intersectionRect.height / searchOrigin.height , 1);
      else
        orthogonalBias = (searchOrigin.height / 2);

      B = (P2 + orthogonalBias) * kOrthogonalWeightForLeftRight;
      C = alignWeight * alignBias;
      break;

    case 'up' :
      /* falls through */
    case 'down' :
      // If two elements are aligned, add align bias
      // else, add orthogonal bias
      if (isAligned(searchOrigin, candidateRect, dir))
        alignBias = Math.min(intersectionRect.width / searchOrigin.width , 1);
      else
        orthogonalBias = (searchOrigin.width / 2);

      B = (P1 + orthogonalBias) * kOrthogonalWeightForUpDown;
      C = alignWeight * alignBias;
      break;

    default:
      B = 0;
      C = 0;
      break;
    }

    return (A + B - C - D);
  }

  /**
   * Get the euclidean distance between the search origin and a candidate element considering the direction.
   * @function getEuclideanDistance
   * @param rect1 {DOMRect} - The search origin
   * @param rect2 {DOMRect} - A candidate element
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   * @returns {Number} The distance scoring between two elements
   */
  function getEuclideanDistance(rect1, rect2, dir) {
    // Get exit point, entry point
    const points = getEntryAndExitPoints(dir, rect1, rect2);

    // Find the points P1 inside the border box of starting point and P2 inside the border box of candidate
    // that minimize the distance between these two points
    const P1 = Math.abs(points.entryPoint.x - points.exitPoint.x);
    const P2 = Math.abs(points.entryPoint.y - points.exitPoint.y);

    // Return the euclidean distance between P1 and P2.
    return Math.sqrt(Math.pow(P1, 2) + Math.pow(P2, 2));
  }

  /**
   * Get the absolute distance between the search origin and a candidate element considering the direction.
   * @function getAbsoluteDistance
   * @param rect1 {DOMRect} - The search origin
   * @param rect2 {DOMRect} - A candidate element
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD)
   * @returns {Number} The distance scoring between two elements
   */
  function getAbsoluteDistance(rect1, rect2, dir) {
    // Get exit point, entry point
    const points = getEntryAndExitPoints(dir, rect1, rect2);

    // Return the absolute distance in the dir direction between P1 and P.
    return ((dir === 'left') || (dir === 'right')) ?
      Math.abs(points.entryPoint.x - points.exitPoint.x) : Math.abs(points.entryPoint.y - points.exitPoint.y);
  }

  /**
   * Get entry point and exit point of two elements considering the direction.
   * @function getEntryAndExitPoints
   * @param dir {SpatialNavigationDirection} - The directional information for the spatial navigation (e.g. LRUD). Default value for dir is 'down'.
   * @param searchOrigin {DOMRect | Point} - The search origin which contains the exit point
   * @param candidateRect {DOMRect} - One of candidates which contains the entry point
   * @returns {Points} The exit point from the search origin and the entry point from a candidate
   */
  function getEntryAndExitPoints(dir = 'down', searchOrigin, candidateRect) {
    /**
     * User type definition for Point
     * @typeof {Object} Points
     * @property {Point} Points.entryPoint
     * @property {Point} Points.exitPoint
     */
    const points = {entryPoint: {x: 0, y: 0}, exitPoint:{x: 0, y: 0}};

    if (startingPoint) {
      points.exitPoint = searchOrigin;

      switch (dir) {
      case 'left':
        points.entryPoint.x = candidateRect.right;
        break;
      case 'up':
        points.entryPoint.y = candidateRect.bottom;
        break;
      case 'right':
        points.entryPoint.x = candidateRect.left;
        break;
      case 'down':
        points.entryPoint.y = candidateRect.top;
        break;
      }

      // Set orthogonal direction
      switch (dir) {
      case 'left':
      case 'right':
        if (startingPoint.y <= candidateRect.top) {
          points.entryPoint.y = candidateRect.top;
        } else if (startingPoint.y < candidateRect.bottom) {
          points.entryPoint.y = startingPoint.y;
        } else {
          points.entryPoint.y = candidateRect.bottom;
        }
        break;

      case 'up':
      case 'down':
        if (startingPoint.x <= candidateRect.left) {
          points.entryPoint.x = candidateRect.left;
        } else if (startingPoint.x < candidateRect.right) {
          points.entryPoint.x = startingPoint.x;
        } else {
          points.entryPoint.x = candidateRect.right;
        }
        break;
      }
    }
    else {
      // Set direction
      switch (dir) {
      case 'left':
        points.exitPoint.x = searchOrigin.left;
        points.entryPoint.x = (candidateRect.right < searchOrigin.left) ? candidateRect.right : searchOrigin.left;
        break;
      case 'up':
        points.exitPoint.y = searchOrigin.top;
        points.entryPoint.y = (candidateRect.bottom < searchOrigin.top) ? candidateRect.bottom : searchOrigin.top;
        break;
      case 'right':
        points.exitPoint.x = searchOrigin.right;
        points.entryPoint.x = (candidateRect.left > searchOrigin.right) ? candidateRect.left : searchOrigin.right;
        break;
      case 'down':
        points.exitPoint.y = searchOrigin.bottom;
        points.entryPoint.y = (candidateRect.top > searchOrigin.bottom) ? candidateRect.top : searchOrigin.bottom;
        break;
      }

      // Set orthogonal direction
      switch (dir) {
      case 'left':
      case 'right':
        if (isBelow(searchOrigin, candidateRect)) {
          points.exitPoint.y = searchOrigin.top;
          points.entryPoint.y = (candidateRect.bottom < searchOrigin.top) ? candidateRect.bottom : searchOrigin.top;
        } else if (isBelow(candidateRect, searchOrigin)) {
          points.exitPoint.y = searchOrigin.bottom;
          points.entryPoint.y = (candidateRect.top > searchOrigin.bottom) ? candidateRect.top : searchOrigin.bottom;
        } else {
          points.exitPoint.y = Math.max(searchOrigin.top, candidateRect.top);
          points.entryPoint.y = points.exitPoint.y;
        }
        break;

      case 'up':
      case 'down':
        if (isRightSide(searchOrigin, candidateRect)) {
          points.exitPoint.x = searchOrigin.left;
          points.entryPoint.x = (candidateRect.right < searchOrigin.left) ? candidateRect.right : searchOrigin.left;
        } else if (isRightSide(candidateRect, searchOrigin)) {
          points.exitPoint.x = searchOrigin.right;
          points.entryPoint.x = (candidateRect.left > searchOrigin.right) ? candidateRect.left : searchOrigin.right;
        } else {
          points.exitPoint.x = Math.max(searchOrigin.left, candidateRect.left);
          points.entryPoint.x = points.exitPoint.x;
        }
        break;
      }
    }

    return points;
  }

  /**
   * Find focusable elements within the container
   * @see {@link https://drafts.csswg.org/css-nav-1/#find-the-shortest-distance}
   * @function getIntersectionRect
   * @param rect1 {DOMRect} - The search origin which contains the exit point
   * @param rect2 {DOMRect} - One of candidates which contains the entry point
   * @returns {IntersectionArea} The intersection area between two elements.
   *
   * @typeof {Object} IntersectionArea
   * @property {Number} IntersectionArea.width
   * @property {Number} IntersectionArea.height
   */
  function getIntersectionRect(rect1, rect2) {
    const intersection_rect = {width: 0, height: 0, area: 0};

    const new_location = [Math.max(rect1.left, rect2.left), Math.max(rect1.top, rect2.top)];
    const new_max_point = [Math.min(rect1.right, rect2.right), Math.min(rect1.bottom, rect2.bottom)];

    intersection_rect.width = Math.abs(new_location[0] - new_max_point[0]);
    intersection_rect.height = Math.abs(new_location[1] - new_max_point[1]);

    if (!(new_location[0] >= new_max_point[0] || new_location[1] >= new_max_point[1])) {
      // intersecting-cases
      intersection_rect.area = Math.sqrt(intersection_rect.width * intersection_rect.height);
    }

    return intersection_rect;
  }

  /**
   * Handle the spatial navigation behavior for HTMLInputElement, HTMLTextAreaElement
   * @see {@link https://developer.mozilla.org/en-US/docs/Web/HTML/Element/input|HTMLInputElement (MDN)}
   * @function handlingEditableElement
   * @param e {Event} - keydownEvent
   * @returns {boolean}
   */
  function handlingEditableElement(e) {
    const SPINNABLE_INPUT_TYPES = ['email', 'date', 'month', 'number', 'time', 'week'],
      TEXT_INPUT_TYPES = ['password', 'text', 'search', 'tel', 'url', null];
    const eventTarget = document.activeElement;
    const startPosition = eventTarget.selectionStart;
    const endPosition = eventTarget.selectionEnd;
    const focusNavigableArrowKey = {left: false, up: false, right: false, down: false};

    const dir = ARROW_KEY_CODE[e.keyCode];
    if (dir === undefined) {
      return focusNavigableArrowKey;
    }

    if (SPINNABLE_INPUT_TYPES.includes(eventTarget.getAttribute('type')) &&
      (dir === 'up' || dir === 'down')) {
      focusNavigableArrowKey[dir] = true;
    } else if (TEXT_INPUT_TYPES.includes(eventTarget.getAttribute('type')) || eventTarget.nodeName === 'TEXTAREA') {
      if (startPosition === endPosition) { // if there isn't any selected text
        if (startPosition === 0) {
          focusNavigableArrowKey.left = true;
          focusNavigableArrowKey.up = true;
        }
        if (endPosition === eventTarget.value.length) {
          focusNavigableArrowKey.right = true;
          focusNavigableArrowKey.down = true;
        }
      }
    } else { // HTMLDataListElement, HTMLSelectElement, HTMLOptGroup
      focusNavigableArrowKey[dir] = true;
    }

    return focusNavigableArrowKey;
  }

  /**
   * Get the DOMRect of an element
   * @function getBoundingClientRect
   * @param {Node} element 
   * @returns {DOMRect}
   */
  function getBoundingClientRect(element) {
    // memoization
    let rect = mapOfBoundRect && mapOfBoundRect.get(element);
    if (!rect) {
      const boundingClientRect = element.getBoundingClientRect();
      rect = {
        top: Number(boundingClientRect.top.toFixed(2)),
        right: Number(boundingClientRect.right.toFixed(2)),
        bottom: Number(boundingClientRect.bottom.toFixed(2)),
        left: Number(boundingClientRect.left.toFixed(2)),
        width: Number(boundingClientRect.width.toFixed(2)),
        height: Number(boundingClientRect.height.toFixed(2))
      };
      mapOfBoundRect && mapOfBoundRect.set(element, rect);
    }
    return rect;
  }

  /**
   * Get the candidates which is fully inside the target element in visual
   * @param {Node} targetElement
   * @returns {sequence<Node>}  overlappedCandidates
   */
  function getOverlappedCandidates(targetElement) {      
    const container = targetElement.getSpatialNavigationContainer();
    const candidates = container.focusableAreas();
    const overlappedCandidates = [];

    candidates.forEach(element => {
      if ((targetElement !== element) && isEntirelyVisible(element, targetElement)) {
        overlappedCandidates.push(element);
      }
    });

    return overlappedCandidates;
  }

  /**
   * Get the list of the experimental APIs
   * @function getExperimentalAPI
   */
  function getExperimentalAPI() {
    function canScroll(container, dir) {
      return (isScrollable(container, dir) && !isScrollBoundary(container, dir)) ||
             (!container.parentElement && !isHTMLScrollBoundary(container, dir));
    }

    function findTarget(findCandidate, element, dir, option) {
      let eventTarget = element;
      let bestNextTarget = null;

      // 4
      if (eventTarget === document || eventTarget === document.documentElement) {
        eventTarget = document.body || document.documentElement;
      }

      // 5
      // At this point, spatialNavigationSearch can be applied.
      // If startingPoint is either a scroll container or the document,
      // find the best candidate within startingPoint
      if ((isContainer(eventTarget) || eventTarget.nodeName === 'BODY') && !(eventTarget.nodeName === 'INPUT')) {
        if (eventTarget.nodeName === 'IFRAME')
          eventTarget = eventTarget.contentDocument.body;

        const candidates = getSpatialNavigationCandidates(eventTarget, option);

        // 5-2
        if (Array.isArray(candidates) && candidates.length > 0) {
          return findCandidate ? getFilteredSpatialNavigationCandidates(eventTarget, dir, candidates) : eventTarget.spatialNavigationSearch(dir, {candidates});
        }
        if (canScroll(eventTarget, dir)) {
          return findCandidate ? [] : eventTarget;
        }
      }

      // 6
      // Let container be the nearest ancestor of eventTarget
      let container = eventTarget.getSpatialNavigationContainer();
      let parentContainer = (container.parentElement) ? container.getSpatialNavigationContainer() : null;

      // When the container is the viewport of a browsing context
      if (!parentContainer && ( window.location !== window.parent.location)) {
        parentContainer = window.parent.document.documentElement;
      }

      // 7
      while (parentContainer) {
        const candidates = filteredCandidates(eventTarget, getSpatialNavigationCandidates(container, option), dir, container);

        if (Array.isArray(candidates) && candidates.length > 0) {
          bestNextTarget = eventTarget.spatialNavigationSearch(dir, {candidates, container});
          if (bestNextTarget) {
            return findCandidate ? candidates : bestNextTarget;
          }
        }

        // If there isn't any candidate and the best candidate among candidate:
        // 1) Scroll or 2) Find candidates of the ancestor container
        // 8 - if
        else if (canScroll(container, dir)) {
          return findCandidate ? [] : eventTarget;
        } else if (container === document || container === document.documentElement) {
          container = window.document.documentElement;

          // The page is in an iframe
          if ( window.location !== window.parent.location ) {
            // eventTarget needs to be reset because the position of the element in the IFRAME
            // is unuseful when the focus moves out of the iframe
            eventTarget = window.frameElement;
            container = window.parent.document.documentElement;
            if (container.parentElement)
              parentContainer = container.getSpatialNavigationContainer();
            else {
              parentContainer = null;
              break;
            }
          }
        } else {
          // avoiding when spatnav container with tabindex=-1
          if (isFocusable(container)) {
            eventTarget = container;
          }

          container = parentContainer;
          if (container.parentElement)
            parentContainer = container.getSpatialNavigationContainer();
          else {
            parentContainer = null;
            break;
          }
        }
      }

      if (!parentContainer && container) {
        // Getting out from the current spatnav container
        const candidates = filteredCandidates(eventTarget, getSpatialNavigationCandidates(container, option), dir, container);

        // 9
        if (Array.isArray(candidates) && candidates.length > 0) {
          bestNextTarget = eventTarget.spatialNavigationSearch(dir, {candidates, container});
          if (bestNextTarget) {
            return findCandidate ? candidates : bestNextTarget;
          }
        }
      }

      if (canScroll(container, dir)) {
        bestNextTarget = eventTarget;
        return bestNextTarget;
      }
    }

    return {
      isContainer,
      isScrollContainer,
      isVisibleInScroller,
      findCandidates: findTarget.bind(null, true),
      findNextTarget: findTarget.bind(null, false),
      getDistanceFromTarget: (element, candidateElement, dir) => {
        if ((isContainer(element) || element.nodeName === 'BODY') && !(element.nodeName === 'INPUT')) {
          if (getSpatialNavigationCandidates(element).includes(candidateElement)) {
            return getInnerDistance(getBoundingClientRect(element), getBoundingClientRect(candidateElement), dir);
          }
        }
        return getDistance(getBoundingClientRect(element), getBoundingClientRect(candidateElement), dir);
      }
    };
  }

  /**
   * Makes to use the experimental APIs.
   * @function enableExperimentalAPIs
   * @param option {boolean} - If it is true, the experimental APIs can be used or it cannot.
   */
  function enableExperimentalAPIs (option) {
    const currentKeyMode = window.__spatialNavigation__ && window.__spatialNavigation__.keyMode;
    window.__spatialNavigation__ = (option === false) ? getInitialAPIs() : Object.assign(getInitialAPIs(), getExperimentalAPI());
    window.__spatialNavigation__.keyMode = currentKeyMode;
    Object.seal(window.__spatialNavigation__);
  }

  /**
   * Set the environment for using the spatial navigation polyfill.
   * @function getInitialAPIs
   */
  function getInitialAPIs() {
    return {
      enableExperimentalAPIs,
      get keyMode() { return this._keymode ? this._keymode : 'ARROW'; },
      set keyMode(mode) { this._keymode = (['SHIFTARROW', 'ARROW', 'NONE'].includes(mode)) ? mode : 'ARROW'; },
      setStartingPoint: function (x, y) {startingPoint = (x && y) ? {x, y} : null;}
    };
  }

  initiateSpatialNavigation();
  enableExperimentalAPIs(false);
  
  window.addEventListener('load', () => {
    spatialNavigationHandler();
  });
})();

/* ---- src/overlay/focus.js ---- */
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
    function focusFirst(container) {
        if (!container) return false;
        if (activeModal) return activeModal.contains(container) ? focusInto(container) : false;
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
        setFallbackContainer: setFallbackContainer,
        openModal: openModal,
        closeModal: closeModal,
        closeOnBack: closeOnBack
    };
})();

/* ---- src/overlay/session.js ---- */
// JellyQuest session/profile module.
//
// Stock jellyfin-web is account/login-centric: one signed-in user per
// session, switching means signing out and back in through a full login
// screen. JellyQuest's household accounts are passwordless by design
// (see the JellyPass household-gateway hardening this depends on), so
// "switching profiles" doesn't need a login screen at all -- it's one
// AuthenticateByName call with a blank password, and an in-place swap of
// the active ApiClient user. No navigation, no visible auth step.
//
// This is the ONE place that call happens. Every profile-switching
// surface (the picker, an in-shell switcher) goes through switchProfile()
// here rather than re-implementing the auth call itself.
(function () {
    'use strict';

    var currentUser = null;
    var listeners = [];

    function notify() {
        listeners.forEach(function (listener) { listener(currentUser); });
    }

    // The household's visible profiles -- already filtered server-side to
    // just this household by the JellyPass household gateway, so there is
    // no client-side filtering to get right (or wrong) here.
    function listProfiles() {
        return window.ApiClient.getPublicUsers();
    }

    // Switches the active profile. `user` is an entry from listProfiles()
    // (needs .Name; Jellyfin's AuthenticateByName takes a username, not
    // an id). Resolves with the authenticated user on success; rejects
    // (e.g. the account unexpectedly has a real password, or the
    // household gateway rejects it) without changing the current profile.
    function switchProfile(user) {
        return window.ApiClient.authenticateUserByName(user.Name, '').then(function (result) {
            currentUser = result.User;
            notify();
            return currentUser;
        });
    }

    function getCurrentProfile() {
        return currentUser;
    }

    // Returns to no active profile (used when the shell's "switch
    // profile" action sends the viewer back to the picker) without
    // touching the ApiClient's own auth state -- the next switchProfile()
    // call re-authenticates cleanly regardless.
    function clearProfile() {
        currentUser = null;
        notify();
    }

    function onProfileChange(listener) {
        listeners.push(listener);
        return function unsubscribe() {
            listeners = listeners.filter(function (entry) { return entry !== listener; });
        };
    }

    window.JellyQuestSession = {
        listProfiles: listProfiles,
        switchProfile: switchProfile,
        getCurrentProfile: getCurrentProfile,
        clearProfile: clearProfile,
        onProfileChange: onProfileChange
    };
})();

/* ---- src/overlay/cards.js ---- */
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

/* ---- src/overlay/requests-bridge.js ---- */
// Low-level client for JellyPass's request bridge (see jellypass's
// src/request-bridge.ts): a hidden iframe loaded at the deployment's
// requestsBridgeUrl, talked to over postMessage with an origin check and
// a per-open random nonce. This is the same security pattern the old
// (deleted) jellyquest.js used for its eligibility probe, generalized to
// also carry the full request/proxy session Requests needs -- callers
// never touch postMessage directly.
//
// Protocol (fixed by the JellyPass server, not this file):
//   - Opening the iframe at `${bridgeUrl}#user=..&id=..&nonce=..`
//     (add `mode=eligibility&` to just check eligibility, no session)
//     gets back exactly one `{source:'jellyquest-bridge', nonce, type}`
//     message: 'ready' or 'eligibility' on success, 'error' on failure.
//   - Once a session is open, `{source:'jellyquest-app', type:'request',
//     nonce, id, path, options}` posted to the frame gets back
//     `{source:'jellyquest-bridge', nonce, type:'response', id, ok,
//     data|error}` -- `call()` below is the request/response pairing for
//     that.
(function () {
    'use strict';

    var OPEN_TIMEOUT_MS = 15000;
    var CALL_TIMEOUT_MS = 20000;

    var frame = null;
    var frameOrigin = '';
    var frameNonce = '';
    var pendingCalls = {};
    var nextCallId = 1;

    function randomNonce() {
        var values = new Uint32Array(4);
        window.crypto.getRandomValues(values);
        return Array.prototype.map.call(values, function (value) { return value.toString(16); }).join('');
    }

    function receiveCallResponse(event) {
        if (!frame || event.source !== frame.contentWindow || event.origin !== frameOrigin) return;
        var data = event.data || {};
        if (data.source !== 'jellyquest-bridge' || data.nonce !== frameNonce || data.type !== 'response') return;
        var pending = pendingCalls[data.id];
        if (!pending) return;
        delete pendingCalls[data.id];
        window.clearTimeout(pending.timer);
        if (data.ok) pending.resolve(data.data);
        else pending.reject(new Error(data.error || 'Requests bridge call failed.'));
    }

    // Opens the bridge iframe in `mode` ('eligibility' or null for a full
    // session) and resolves with the bridge's first message. Tears down
    // any previously-open frame first -- only one bridge session is ever
    // live at a time.
    function openFrame(bridgeUrl, mode, userId, userName) {
        close();
        return new Promise(function (resolve, reject) {
            var target;
            // The catch below has to name a binding because ES5 -- the
            // dialect this file ships in, for the Tizen 5.0 / Chromium
            // M63 floor, where eval('try{}catch{}') was measured to
            // throw SyntaxError (see the README's "Target hardware"
            // section) -- has no optional catch binding, and it then
            // deliberately discards it: whatever the URL parser objected
            // to, the only actionable problem for the caller is that no
            // usable bridge URL is configured, so that is what gets
            // reported. Hence the narrow eslint-disable-line rather than
            // a repo-wide rule.
            try {
                // Resolved against the page's own URL rather than required
                // to stand alone: production config is always an absolute
                // https URL (scripts/configure-jellyquest.mjs enforces
                // that at build time), but this also lets a dev/test
                // fixture pass a same-origin relative path.
                target = new URL(bridgeUrl, window.location.href);
            } catch (error) { // eslint-disable-line no-unused-vars -- ES5 requires the binding; discarded on purpose (see above)
                reject(new Error('Requests bridge is not configured.'));
                return;
            }

            var opened = document.createElement('iframe');
            opened.hidden = true;
            opened.setAttribute('aria-hidden', 'true');
            opened.setAttribute('title', 'Requests');

            var origin = target.origin;
            var nonce = randomNonce();
            var hash = 'user=' + encodeURIComponent(userName || '') + '&id=' + encodeURIComponent(userId) + '&nonce=' + encodeURIComponent(nonce);
            if (mode) hash = 'mode=' + encodeURIComponent(mode) + '&' + hash;
            target.hash = hash;

            var timer = window.setTimeout(function () {
                window.removeEventListener('message', onInit);
                if (opened.parentNode) opened.parentNode.removeChild(opened);
                reject(new Error('Requests bridge timed out.'));
            }, OPEN_TIMEOUT_MS);

            function onInit(event) {
                if (event.source !== opened.contentWindow || event.origin !== origin) return;
                var data = event.data || {};
                if (data.source !== 'jellyquest-bridge' || data.nonce !== nonce) return;
                if (data.type === 'error') {
                    window.clearTimeout(timer);
                    window.removeEventListener('message', onInit);
                    if (opened.parentNode) opened.parentNode.removeChild(opened);
                    reject(new Error(data.error || 'Requests bridge rejected this profile.'));
                    return;
                }
                window.clearTimeout(timer);
                window.removeEventListener('message', onInit);
                frame = opened;
                frameOrigin = origin;
                frameNonce = nonce;
                window.addEventListener('message', receiveCallResponse);
                resolve(data);
            }
            window.addEventListener('message', onInit);

            opened.src = target.href;
            document.body.appendChild(opened);
        });
    }

    function checkEligibility(bridgeUrl, userId, userName) {
        return openFrame(bridgeUrl, 'eligibility', userId, userName).then(function (data) {
            var eligible = data.eligible === true;
            close();
            return eligible;
        });
    }

    function openSession(bridgeUrl, userId, userName) {
        return openFrame(bridgeUrl, null, userId, userName).then(function () { return true; });
    }

    // path/options mirror JellyPass's own proxy contract: options may
    // carry { method, headers: {'Content-Type': ...}, body } same as a
    // fetch() call would.
    function call(path, options) {
        if (!frame) return Promise.reject(new Error('Requests session is not open.'));
        var openFrameRef = frame;
        return new Promise(function (resolve, reject) {
            var id = String(nextCallId);
            nextCallId += 1;
            var timer = window.setTimeout(function () {
                delete pendingCalls[id];
                reject(new Error('Requests bridge call timed out.'));
            }, CALL_TIMEOUT_MS);
            pendingCalls[id] = { resolve: resolve, reject: reject, timer: timer };
            openFrameRef.contentWindow.postMessage({
                source: 'jellyquest-app',
                type: 'request',
                nonce: frameNonce,
                id: id,
                path: path,
                options: options || {}
            }, frameOrigin);
        });
    }

    function close() {
        window.removeEventListener('message', receiveCallResponse);
        if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
        frame = null;
        frameOrigin = '';
        frameNonce = '';
        Object.keys(pendingCalls).forEach(function (id) {
            window.clearTimeout(pendingCalls[id].timer);
            pendingCalls[id].reject(new Error('Requests bridge closed.'));
        });
        pendingCalls = {};
    }

    window.JellyQuestRequestsBridge = {
        checkEligibility: checkEligibility,
        openSession: openSession,
        call: call,
        close: close
    };
})();

/* ---- src/overlay/screens/profiles.js ---- */
// Profile picker screen -- the true landing screen (see
// docs/rebuild-plan.md, Phase 2). No login form, no manual-login/Quick
// Connect/admin chrome: just the household's own visible profiles,
// already filtered server-side by the JellyPass household gateway.
// Selecting one is a single Enter/click away from being on Home.
(function () {
    'use strict';

    // onSelected(user) is called after a successful switchProfile().
    function renderProfiles(container, onSelected) {
        container.innerHTML = '';
        container.className = 'jq-profiles-screen';

        var heading = document.createElement('h1');
        heading.className = 'jq-profiles-heading';
        heading.textContent = "Who's watching?";
        container.appendChild(heading);

        // A single row, not .jq-grid: grid mode's row/column snapping
        // misbehaves once the CSS column template has more columns than
        // there are actual items (a household smaller than the layout's
        // column count is the normal case, not an edge case), and a
        // profile picker is semantically one row anyway.
        var row = document.createElement('div');
        row.className = 'jq-row jq-profiles-row';
        container.appendChild(row);

        var error = document.createElement('p');
        error.className = 'jq-profiles-error';
        error.hidden = true;
        container.appendChild(error);

        window.JellyQuestSession.listProfiles().then(function (profiles) {
            profiles.forEach(function (user, index) {
                var card = document.createElement('button');
                card.className = 'jq-card jq-focusable jq-profile-card';
                card.setAttribute('data-profile-id', user.Id);
                card.textContent = user.Name;
                if (index === 0) card.setAttribute('data-jq-autofocus', '');
                card.addEventListener('click', function () {
                    error.hidden = true;
                    card.disabled = true;
                    window.JellyQuestSession.switchProfile(user).then(function (currentUser) {
                        onSelected(currentUser);
                    }, function () {
                        card.disabled = false;
                        error.textContent = 'Could not sign in as ' + user.Name + '. Try again.';
                        error.hidden = false;
                    });
                });
                row.appendChild(card);
            });
            window.JellyQuestFocus.focusFirst(container);
        }).catch(function (failure) {
            error.textContent = 'Profiles are unavailable right now. Try again.';
            error.hidden = false;
            console.error('[JellyQuest] Profiles failed:', failure);
        });
    }

    window.JellyQuestProfilesScreen = {
        render: renderProfiles
    };
})();

/* ---- src/overlay/screens/home.js ---- */
// Home screen: Continue Watching + Recently Added rows. Real screen
// content replacing the Phase 2 placeholder ("Home -- Phase 3").
(function () {
    'use strict';

    // callbacks: { onSelectItem(item), onSeeAll(row) } where row is
    // { title, fetch: () => Promise<{Items}> } for the Library screen.
    function renderHome(container, callbacks) {
        container.innerHTML = '';
        container.className = 'jq-home-screen';

        var userId = window.ApiClient.getCurrentUserId();
        var rows = [
            {
                title: 'Continue Watching',
                fetch: function () { return window.ApiClient.getItems(userId, { Filters: 'IsResumable' }); },
                seeAll: false,
            },
            {
                title: 'Recently Added',
                fetch: function () { return window.ApiClient.getItems(userId, { SortBy: 'DateCreated', Limit: 8 }); },
                seeAll: true,
            },
        ];

        var firstCard = null;
        var pending = rows.map(function (row) {
            return row.fetch().then(function (result) {
                if (!result.Items.length) return;
                var section = renderRow(row, result.Items, callbacks);
                container.appendChild(section);
                if (!firstCard) firstCard = section.querySelector('.jq-focusable');
            }).catch(function (error) {
                var status = document.createElement('p');
                status.className = 'jq-home-empty';
                status.textContent = row.title + ' is unavailable right now.';
                container.appendChild(status);
                console.error('[JellyQuest] Home row failed:', error);
            });
        });

        Promise.all(pending).then(function () {
            if (!container.children.length) {
                var empty = document.createElement('p');
                empty.className = 'jq-home-empty';
                empty.textContent = 'Nothing here yet.';
                container.appendChild(empty);
            }
            if (firstCard) firstCard.setAttribute('data-jq-autofocus', '');
            window.JellyQuestFocus.focusFirst(container);
        });
    }

    function renderRow(row, items, callbacks) {
        var section = document.createElement('section');
        section.className = 'jq-home-row-section';

        var heading = document.createElement('h2');
        heading.className = 'jq-home-row-heading';
        heading.textContent = row.title;
        section.appendChild(heading);

        var rowEl = document.createElement('div');
        rowEl.className = 'jq-row jq-home-row';
        items.forEach(function (item) {
            rowEl.appendChild(window.JellyQuestCards.createCard(item, {
                onSelect: function () { callbacks.onSelectItem(item); },
            }));
        });
        if (row.seeAll) {
            var seeAll = document.createElement('button');
            seeAll.className = 'jq-card jq-focusable jq-see-all';
            seeAll.textContent = 'See All';
            seeAll.addEventListener('click', function () { callbacks.onSeeAll(row); });
            rowEl.appendChild(seeAll);
        }
        section.appendChild(rowEl);
        return section;
    }

    window.JellyQuestHomeScreen = {
        render: renderHome
    };
})();

/* ---- src/overlay/screens/library.js ---- */
// Library screen: a full grid for one category (reached via a Home
// row's "See All"). Uses .jq-grid -- safe here because the column count
// matches how many cards actually fill a row throughout (only the last,
// naturally partial row is short), unlike the profile picker's ragged
// grid template (see docs/rebuild-plan.md's Phase 2 caveat).
(function () {
    'use strict';

    var COLUMNS = 4;

    // callbacks: { onSelectItem(item), onBack() }
    function renderLibrary(container, row, callbacks) {
        container.innerHTML = '';
        container.className = 'jq-library-screen';

        var backButton = document.createElement('button');
        backButton.className = 'jq-back-button jq-focusable';
        backButton.textContent = '< Back';
        backButton.addEventListener('click', callbacks.onBack);
        container.appendChild(backButton);

        var heading = document.createElement('h1');
        heading.className = 'jq-library-heading';
        heading.textContent = row.title;
        container.appendChild(heading);

        var grid = document.createElement('div');
        grid.className = 'jq-grid jq-library-grid';
        grid.style.gridTemplateColumns = 'repeat(' + COLUMNS + ', 220px)';
        container.appendChild(grid);

        row.fetch().then(function (result) {
            result.Items.forEach(function (item, index) {
                var card = window.JellyQuestCards.createCard(item, {
                    onSelect: function () { callbacks.onSelectItem(item); },
                });
                // Focus the first card, not Back (which is reached via Up
                // from the top row instead) -- focusFirst()'s DOM-order
                // fallback would otherwise land on Back since it comes
                // first in the markup.
                if (index === 0) card.setAttribute('data-jq-autofocus', '');
                grid.appendChild(card);
            });
            window.JellyQuestFocus.focusFirst(container);
        }).catch(function (error) {
            var status = document.createElement('p');
            status.className = 'jq-library-status';
            status.textContent = 'Library is unavailable right now. Try again.';
            container.appendChild(status);
            window.JellyQuestFocus.focusFirst(container);
            console.error('[JellyQuest] Library failed:', error);
        });
    }

    window.JellyQuestLibraryScreen = {
        render: renderLibrary
    };
})();

/* ---- src/overlay/screens/search.js ---- */
// Search screen: a text input (the platform's on-screen keyboard handles
// text entry on real Tizen hardware -- no custom input UI needed) plus a
// live-filtered results row.
(function () {
    'use strict';

    var DEBOUNCE_MS = 200;

    // callbacks: { onSelectItem(item) }
    function renderSearch(container, callbacks) {
        container.innerHTML = '';
        container.className = 'jq-search-screen';

        var input = document.createElement('input');
        input.type = 'search';
        input.className = 'jq-search-input jq-focusable';
        input.placeholder = 'Search your library';
        input.setAttribute('data-jq-autofocus', '');
        container.appendChild(input);

        var resultsRow = document.createElement('div');
        resultsRow.className = 'jq-row jq-search-results';
        container.appendChild(resultsRow);

        var empty = document.createElement('p');
        empty.className = 'jq-search-empty';
        empty.textContent = 'No matches.';
        empty.hidden = true;
        container.appendChild(empty);

        var timer = null;
        var searchId = 0;
        input.addEventListener('input', function () {
            searchId += 1;
            window.clearTimeout(timer);
            timer = window.setTimeout(function () { runSearch(input.value); }, DEBOUNCE_MS);
        });

        function runSearch(term) {
            var currentSearchId = searchId;
            resultsRow.innerHTML = '';
            empty.hidden = true;
            empty.textContent = 'No matches.';
            empty.classList.remove('jq-search-error');
            if (!term.trim()) return;
            var userId = window.ApiClient.getCurrentUserId();
            window.ApiClient.getItems(userId, { SearchTerm: term }).then(function (result) {
                if (currentSearchId !== searchId || input.value !== term) return; // a newer search superseded this one
                empty.hidden = true;
                empty.textContent = 'No matches.';
                empty.classList.remove('jq-search-error');
                if (!result.Items.length) {
                    empty.hidden = false;
                    return;
                }
                result.Items.forEach(function (item) {
                    resultsRow.appendChild(window.JellyQuestCards.createCard(item, {
                        onSelect: function () { callbacks.onSelectItem(item); },
                    }));
                });
            }).catch(function (error) {
                if (currentSearchId !== searchId || input.value !== term) return;
                empty.textContent = 'Search failed. Try again.';
                empty.classList.add('jq-search-error');
                empty.hidden = false;
                console.error('[JellyQuest] Library search failed:', error);
            });
        }

        window.JellyQuestFocus.focusFirst(container);
    }

    window.JellyQuestSearchScreen = {
        render: renderSearch
    };
})();

/* ---- src/overlay/screens/detail.js ---- */
// Detail/playback screen for Movie items -- see DETAIL_ACTIONS.md for
// the full intended behavior across movies/shows/sports. This first pass
// covers movies only (Resume/Play, Trailer, My List, and a conditional
// More menu for track selection); Series/Sports-specific behavior
// (seasons, episodes, highlights, chapters) is explicit follow-up work,
// not silently missing -- see docs/rebuild-plan.md's Phase 3 status.
//
// There's no dedicated "Back" control here: per DETAIL_ACTIONS.md, Left
// from the first action returns to the persistent rail (shell.js), which
// is reachable from every screen -- that's the way back, same as it is
// from Home, Search, and Library.
(function () {
    'use strict';

    // callbacks: { onPlay(item, startTicks), onPlayTrailer(item) -> Promise<boolean> }
    // Trailer lookup resolves false when no trailer exists, and rejects on failure.
    function renderDetail(container, item, callbacks) {
        container.innerHTML = '';
        container.className = 'jq-detail-screen';

        var heading = document.createElement('h1');
        heading.className = 'jq-detail-title';
        heading.textContent = item.Name + (item.ProductionYear ? ' (' + item.ProductionYear + ')' : '');
        container.appendChild(heading);

        if (item.Overview) {
            var overview = document.createElement('p');
            overview.className = 'jq-detail-overview';
            overview.textContent = item.Overview;
            container.appendChild(overview);
        }

        var actions = document.createElement('div');
        actions.className = 'jq-row jq-detail-actions';
        container.appendChild(actions);

        var resumable = item.UserData && item.UserData.PlaybackPositionTicks > 0;
        var playButton = document.createElement('button');
        playButton.className = 'jq-detail-action jq-focusable';
        playButton.setAttribute('data-jq-autofocus', '');
        playButton.textContent = resumable ? 'Resume' : 'Play';
        playButton.addEventListener('click', function () {
            callbacks.onPlay(item, resumable ? item.UserData.PlaybackPositionTicks : 0);
        });
        actions.appendChild(playButton);

        if (resumable) {
            var startOverButton = document.createElement('button');
            startOverButton.className = 'jq-detail-action jq-focusable';
            startOverButton.textContent = 'Start Over';
            startOverButton.addEventListener('click', function () { callbacks.onPlay(item, 0); });
            actions.appendChild(startOverButton);
        }

        if (item.LocalTrailerCount) {
            var trailerStatus = document.createElement('p');
            trailerStatus.className = 'jq-detail-error';
            trailerStatus.hidden = true;
            container.appendChild(trailerStatus);
            var trailerButton = document.createElement('button');
            trailerButton.className = 'jq-detail-action jq-focusable';
            trailerButton.textContent = 'Trailer';
            trailerButton.addEventListener('click', function () {
                trailerStatus.hidden = true;
                callbacks.onPlayTrailer(item).then(function (played) {
                    if (played) return;
                    trailerStatus.textContent = 'No trailer available.';
                    trailerStatus.hidden = false;
                }).catch(function (error) {
                    trailerStatus.textContent = 'Could not load trailer. Try again.';
                    trailerStatus.hidden = false;
                    console.error('[JellyQuest] Trailer lookup failed:', error);
                });
            });
            actions.appendChild(trailerButton);
        }

        var favoriteButton = document.createElement('button');
        favoriteButton.className = 'jq-detail-action jq-focusable jq-my-list-action';
        var isFavorite = Boolean(item.UserData && item.UserData.IsFavorite);
        favoriteButton.textContent = isFavorite ? 'Remove from My List' : 'Add to My List';
        var favoriteError = document.createElement('p');
        favoriteError.className = 'jq-detail-error';
        favoriteError.hidden = true;
        container.appendChild(favoriteError);
        favoriteButton.addEventListener('click', function () {
            favoriteError.hidden = true;
            var userId = window.ApiClient.getCurrentUserId();
            var next = !isFavorite;
            window.ApiClient.updateFavoriteStatus(userId, item.Id, next).then(function () {
                isFavorite = next;
                favoriteButton.textContent = isFavorite ? 'Remove from My List' : 'Add to My List';
            }).catch(function (error) {
                favoriteError.textContent = 'Could not update My List. Try again.';
                favoriteError.hidden = false;
                console.error('[JellyQuest] My List update failed:', error);
            });
        });
        actions.appendChild(favoriteButton);

        var configurable = hasConfigurableTracks(item);
        if (configurable) {
            var moreButton = document.createElement('button');
            moreButton.className = 'jq-detail-action jq-focusable';
            moreButton.textContent = 'More';
            actions.appendChild(moreButton);
            appendMoreMenu(container, item, moreButton);
        }

        window.JellyQuestFocus.focusFirst(container);
    }

    function hasConfigurableTracks(item) {
        var streams = item.MediaStreams || [];
        var audioCount = streams.filter(function (stream) { return stream.Type === 'Audio'; }).length;
        var subtitleCount = streams.filter(function (stream) { return stream.Type === 'Subtitle'; }).length;
        return audioCount > 1 || subtitleCount > 0;
    }

    function appendMoreMenu(container, item, moreButton) {
        var streams = item.MediaStreams || [];
        var audioTracks = streams.filter(function (stream) { return stream.Type === 'Audio'; });
        var subtitleTracks = streams.filter(function (stream) { return stream.Type === 'Subtitle'; });

        var backdrop = document.createElement('div');
        backdrop.className = 'jq-modal-backdrop';
        backdrop.hidden = true;

        var modal = document.createElement('div');
        modal.className = 'jq-modal jq-focusable jq-playback-options';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-label', 'Playback Options');
        backdrop.appendChild(modal);
        container.appendChild(backdrop);

        var heading = document.createElement('h2');
        heading.textContent = 'Playback Options';
        modal.appendChild(heading);

        if (audioTracks.length > 1) {
            modal.appendChild(optionGroup('Audio', audioTracks.map(function (track) { return track.DisplayTitle; })));
        }
        if (subtitleTracks.length > 0) {
            modal.appendChild(optionGroup('Subtitles', ['Off'].concat(subtitleTracks.map(function (track) { return track.DisplayTitle; }))));
        }

        var closeButton = document.createElement('button');
        closeButton.className = 'jq-modal-option jq-focusable';
        closeButton.textContent = 'Close';
        closeButton.addEventListener('click', close);
        modal.appendChild(closeButton);

        moreButton.addEventListener('click', function () {
            backdrop.hidden = false;
            window.JellyQuestFocus.openModal(modal, close);
        });

        function close() {
            backdrop.hidden = true;
            window.JellyQuestFocus.closeModal(modal, moreButton);
        }
    }

    function optionGroup(label, options) {
        var group = document.createElement('div');
        group.className = 'jq-playback-option-group';
        var groupLabel = document.createElement('h3');
        groupLabel.textContent = label;
        group.appendChild(groupLabel);
        options.forEach(function (text) {
            var option = document.createElement('button');
            option.className = 'jq-modal-option jq-focusable';
            option.textContent = text;
            group.appendChild(option);
        });
        return group;
    }

    window.JellyQuestDetailScreen = {
        render: renderDetail
    };
})();

/* ---- src/overlay/screens/requests.js ---- */
// Requests screen: search Jellyseerr (through JellyPass's request bridge,
// see requests-bridge.js) and either request a title Jellyseerr doesn't
// have yet, or claim access to one that's already available in the
// library. Movie-only for this pass, matching Detail's scope (see
// docs/rebuild-plan.md, Phase 3) -- TV/season-aware requesting is
// explicit follow-up work, not silently missing.
//
// Household visibility is intentionally simple: any household member can
// request or claim independently, and a title someone else in the same
// household already requested just shows as "Requested" -- nobody's name
// is attached, and nothing here restricts a *different* household from
// independently requesting or claiming the same title (JellyPass tracks
// claims per Jellyfin user, not per household). See docs/rebuild-plan.md's
// Phase 4 notes.
(function () {
    'use strict';

    var DEBOUNCE_MS = 300;
    // Jellyseerr's MediaInfo.status enum (unknown/pending/processing/
    // partially_available/available) -- only the "has this been asked
    // for" and "is this watchable" buckets matter here, not each stage.
    var STATUS_REQUESTED = [2, 3];
    var STATUS_AVAILABLE = [4, 5];

    // config: { bridgeUrl, userId, userName, configurationFailed, onRetryConfiguration }
    function renderRequests(container, config) {
        container.innerHTML = '';
        container.className = 'jq-requests-screen';

        var status = document.createElement('p');
        status.className = 'jq-requests-status';
        container.appendChild(status);
        window.JellyQuestFocus.focusFirst(container);

        if (config.configurationFailed) {
            status.textContent = 'Could not load Requests configuration. Try again.';
            var retry = document.createElement('button');
            retry.className = 'jq-requests-retry jq-focusable';
            retry.textContent = 'Retry';
            retry.addEventListener('click', config.onRetryConfiguration);
            container.appendChild(retry);
            window.JellyQuestFocus.focusFirst(container);
            return;
        }

        if (!config.bridgeUrl) {
            status.textContent = 'Requests are not configured for this server.';
            return;
        }

        var bridge = window.JellyQuestRequestsBridge;
        status.textContent = 'Checking Requests for this profile…';

        bridge.checkEligibility(config.bridgeUrl, config.userId, config.userName).then(function (eligible) {
            if (!eligible) {
                status.textContent = 'Requests are not available for this profile.';
                return;
            }
            return bridge.openSession(config.bridgeUrl, config.userId, config.userName).then(function () {
                renderSearch(container, status);
            });
        }).catch(function (error) {
            status.textContent = 'Requests are unavailable right now.';
            console.error('[JellyQuest] Requests bridge error:', error);
        });
    }

    function renderSearch(container, status) {
        status.hidden = true;

        var input = document.createElement('input');
        input.type = 'search';
        input.className = 'jq-search-input jq-requests-input jq-focusable';
        input.placeholder = 'Search movies to request';
        input.setAttribute('data-jq-autofocus', '');
        container.appendChild(input);

        var results = document.createElement('div');
        results.className = 'jq-row jq-requests-results';
        container.appendChild(results);

        var empty = document.createElement('p');
        empty.className = 'jq-requests-empty';
        empty.textContent = 'No matches.';
        empty.hidden = true;
        container.appendChild(empty);

        var timer = null;
        var searchId = 0;
        input.addEventListener('input', function () {
            searchId += 1;
            window.clearTimeout(timer);
            timer = window.setTimeout(function () { runSearch(input.value); }, DEBOUNCE_MS);
        });

        function runSearch(term) {
            var currentSearchId = searchId;
            results.innerHTML = '';
            empty.hidden = true;
            status.hidden = true;
            if (!term.trim()) return;
            window.JellyQuestRequestsBridge.call('/api/v1/search?query=' + encodeURIComponent(term)).then(function (data) {
                if (currentSearchId !== searchId || input.value !== term) return; // a newer search superseded this one
                status.hidden = true;
                empty.hidden = true;
                var movies = (data.results || []).filter(function (item) { return item.mediaType === 'movie'; });
                if (!movies.length) {
                    empty.hidden = false;
                    return;
                }
                movies.forEach(function (movie) { results.appendChild(createRequestCard(movie)); });
            }).catch(function (error) {
                if (currentSearchId !== searchId || input.value !== term) return;
                status.textContent = 'Search failed. Try again.';
                status.hidden = false;
                console.error('[JellyQuest] Requests search failed:', error);
            });
        }

        window.JellyQuestFocus.focusFirst(container);
    }

    function createRequestCard(movie) {
        var card = document.createElement('div');
        card.className = 'jq-card jq-request-card';
        card.setAttribute('data-tmdb-id', String(movie.id));

        var title = document.createElement('span');
        title.className = 'jq-request-card-title';
        title.textContent = movie.title;
        card.appendChild(title);

        if (movie.releaseDate) {
            var year = document.createElement('small');
            year.className = 'jq-request-card-meta';
            year.textContent = movie.releaseDate.slice(0, 4);
            card.appendChild(year);
        }

        renderAction(card, movie);
        return card;
    }

    function movieState(movie) {
        var status = movie.mediaInfo && movie.mediaInfo.status;
        if (status && STATUS_AVAILABLE.indexOf(status) !== -1) return 'available';
        if (status && STATUS_REQUESTED.indexOf(status) !== -1) return 'requested';
        return 'none';
    }

    function renderAction(card, movie) {
        var existing = card.querySelector('.jq-request-card-action');
        if (existing) existing.remove();

        var state = movieState(movie);
        if (state === 'requested') {
            appendLabel(card, 'Requested');
            return;
        }
        if (state === 'none') {
            appendButton(card, 'Request', function (button) {
                button.disabled = true;
                window.JellyQuestRequestsBridge.call('/api/v1/request', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mediaType: 'movie', mediaId: movie.id })
                }).then(function () {
                    movie.mediaInfo = movie.mediaInfo || {};
                    movie.mediaInfo.status = 2;
                    renderAction(card, movie);
                }).catch(function (error) {
                    button.disabled = false;
                    showActionError(card, 'Request failed. Try again.');
                    console.error('[JellyQuest] Request failed:', error);
                });
            });
            return;
        }

        // Available -- resolve this profile's own claim before offering
        // to claim it again. Cached on the item once claimed so
        // re-rendering after a click doesn't need another round trip.
        if (movie.__claimed) {
            appendLabel(card, 'In My Library');
            return;
        }
        var checking = appendLabel(card, 'Checking…');
        window.JellyQuestRequestsBridge.call('/jellyquest/access?mediaType=movie&tmdbId=' + movie.id).then(function (access) {
            checking.remove();
            if (access.claimed) {
                movie.__claimed = true;
                appendLabel(card, 'In My Library');
                return;
            }
            appendButton(card, 'Add to My Library', function (button) {
                button.disabled = true;
                window.JellyQuestRequestsBridge.call('/jellyquest/access', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mediaType: 'movie', tmdbId: movie.id })
                }).then(function () {
                    movie.__claimed = true;
                    renderAction(card, movie);
                }).catch(function (error) {
                    button.disabled = false;
                    showActionError(card, 'Could not add to My Library. Try again.');
                    console.error('[JellyQuest] Claim failed:', error);
                });
            });
        }).catch(function (error) {
            checking.textContent = 'Unavailable';
            console.error('[JellyQuest] Access check failed:', error);
        });
    }

    function showActionError(card, text) {
        var error = document.createElement('p');
        error.className = 'jq-request-card-error';
        error.textContent = text;
        card.appendChild(error);
    }

    function appendLabel(card, text) {
        var label = document.createElement('span');
        label.className = 'jq-request-card-action jq-request-card-label';
        label.textContent = text;
        card.appendChild(label);
        return label;
    }

    function appendButton(card, text, onClick) {
        var button = document.createElement('button');
        button.className = 'jq-request-card-action jq-focusable';
        button.textContent = text;
        button.addEventListener('click', function () {
            var error = card.querySelector('.jq-request-card-error');
            if (error) error.remove();
            onClick(button);
        });
        card.appendChild(button);
        return button;
    }

    window.JellyQuestRequestsScreen = {
        render: renderRequests
    };
})();

/* ---- src/overlay/shell.js ---- */
// Top-level nav shell -- the persistent rail (Profile/Home/Search/Requests)
// stays mounted across every screen; app.js swaps what's in the content
// area beneath/beside it (Home, Search, Library, Detail). This matches
// DETAIL_ACTIONS.md's focus graph, which has the rail reachable by Up
// from the detail page's own action row, not hidden while viewing detail.
//
// shell.js only owns the rail chrome and the content container; it has
// no idea what's inside the content area at any given moment -- that's
// app.js's job (see showHome/showSearch/showLibrary/showDetail there).
(function () {
    'use strict';

    var contentEl = null;

    // callbacks: { onSwitchProfile(), onHome(), onSearch(), onRequests() }
    function renderShell(container, callbacks) {
        container.innerHTML = '';
        container.className = 'jq-shell';

        var rail = document.createElement('nav');
        rail.className = 'jq-rail';
        rail.setAttribute('aria-label', 'Primary');

        var profileButton = document.createElement('button');
        profileButton.className = 'jq-rail-item jq-focusable jq-profile-switch';
        profileButton.setAttribute('data-jq-autofocus', '');
        var user = window.JellyQuestSession.getCurrentProfile();
        profileButton.textContent = user ? user.Name : 'Profile';
        profileButton.addEventListener('click', function () {
            window.JellyQuestSession.clearProfile();
            callbacks.onSwitchProfile();
        });
        rail.appendChild(profileButton);

        var homeButton = document.createElement('button');
        homeButton.className = 'jq-rail-item jq-focusable jq-nav-home';
        homeButton.textContent = 'Home';
        homeButton.addEventListener('click', callbacks.onHome);
        rail.appendChild(homeButton);

        var searchButton = document.createElement('button');
        searchButton.className = 'jq-rail-item jq-focusable jq-nav-search';
        searchButton.textContent = 'Search';
        searchButton.addEventListener('click', callbacks.onSearch);
        rail.appendChild(searchButton);

        var requestsButton = document.createElement('button');
        requestsButton.className = 'jq-rail-item jq-focusable jq-nav-requests';
        requestsButton.textContent = 'Requests';
        requestsButton.addEventListener('click', callbacks.onRequests);
        rail.appendChild(requestsButton);

        container.appendChild(rail);

        contentEl = document.createElement('main');
        contentEl.className = 'jq-content jq-shell-content';
        container.appendChild(contentEl);

        // The rail outlives every content screen, so it is the one thing
        // that can always take focus when a screen has nothing focusable of
        // its own (an empty library's Home, for one) -- see focusFirst().
        window.JellyQuestFocus.setFallbackContainer(rail);
        window.JellyQuestFocus.focusFirst(rail);
    }

    function getContent() {
        return contentEl;
    }

    window.JellyQuestShell = {
        render: renderShell,
        getContent: getContent
    };
})();

/* ---- src/overlay/app.js ---- */
// Bootstraps JellyQuest and owns the (small, hand-rolled) router between
// screens: creates #jellyquest-root (no host markup required -- gulp's
// injection provides no container div), then switches between the
// profile picker and the shell, and -- within the shell -- between
// Home/Search/Library/Detail/Requests. The shell's rail (shell.js) stays
// mounted across all of those; only its content area swaps.
//
// Also owns the remote's hardware Back button: every screen but Home
// registers a "go back to where I came from" handler here, so Back
// behaves the way every other TV app's does, distinct from (and in
// addition to) Left-into-the-rail spatial navigation. Home -- the top of
// the navigation stack -- answers Back with the exit confirmation below.
(function () {
    'use strict';

    // 10009 is Tizen's documented hardware Back. jellyfin-web's own
    // keyboardnavigation maps BOTH 461 and 10009 to Back, so some sets are
    // expected to emit 461 instead; which one this hardware sends is
    // UNVERIFIED (it needs a TV), and listening for both costs nothing --
    // if it emits 461, JellyQuest's listener would otherwise never fire on
    // any screen. 27/Escape is for desktop/simulator testing.
    var BACK_KEY_CODES = [10009, 461, 27];
    var currentBackHandler = null;
    var buildConfig = null;
    var configurationPromise = null;

    // jellyquest-build.json is written by scripts/configure-jellyquest.mjs
    // next to index.html at packaging time (fetched here the same way the
    // old app's loadConfiguration() did); Requests is the only thing that
    // needs it; every other screen works with no configuration at all.
    function loadConfiguration() {
        if (configurationPromise) return configurationPromise;
        configurationPromise = fetch('jellyquest-build.json', { cache: 'no-store' }).then(function (response) {
            if (!response.ok) throw new Error('configuration returned ' + response.status);
            return response.json();
        }).then(function (config) {
            buildConfig = config || {};
        }).catch(function (error) {
            // Loads only run without cached configuration today. If refresh is
            // added, preserve the last good configuration on a failed refresh.
            buildConfig = null;
            console.error('[JellyQuest] Requests configuration unavailable:', error);
        }).then(function () {
            configurationPromise = null;
        });
        return configurationPromise;
    }

    function showProfiles(root) {
        currentBackHandler = null;
        window.JellyQuestRequestsBridge.close();
        window.JellyQuestProfilesScreen.render(root, function () {
            showShell(root);
        });
    }

    function showShell(root) {
        window.JellyQuestShell.render(root, {
            onSwitchProfile: function () { showProfiles(root); },
            onHome: showHome,
            onSearch: showSearch,
            onRequests: showRequests,
        });
        showHome();
    }

    function showHome() {
        currentBackHandler = confirmExit; // top of the navigation stack: Back offers to quit
        window.JellyQuestRequestsBridge.close();
        window.JellyQuestHomeScreen.render(window.JellyQuestShell.getContent(), {
            onSelectItem: function (item) { showDetail(item, showHome); },
            onSeeAll: function (row) { showLibrary(row, showHome); },
        });
    }

    function showSearch() {
        currentBackHandler = showHome;
        window.JellyQuestRequestsBridge.close();
        window.JellyQuestSearchScreen.render(window.JellyQuestShell.getContent(), {
            onSelectItem: function (item) { showDetail(item, showSearch); },
        });
    }

    function showLibrary(row, returnTo) {
        currentBackHandler = returnTo;
        window.JellyQuestRequestsBridge.close();
        window.JellyQuestLibraryScreen.render(window.JellyQuestShell.getContent(), row, {
            onSelectItem: function (item) { showDetail(item, function () { showLibrary(row, returnTo); }); },
            onBack: returnTo,
        });
    }

    function showDetail(item, returnTo) {
        currentBackHandler = returnTo;
        window.JellyQuestRequestsBridge.close();
        window.JellyQuestDetailScreen.render(window.JellyQuestShell.getContent(), item, {
            onPlay: function (playItem, startPositionTicks) {
                window.playbackManager.play({ ids: [playItem.Id], startPositionTicks: startPositionTicks });
            },
            onPlayTrailer: function (playItem) {
                var userId = window.ApiClient.getCurrentUserId();
                return window.ApiClient.getLocalTrailers(userId, playItem.Id).then(function (trailers) {
                    if (!trailers.length) return false;
                    window.playbackManager.play({ ids: [trailers[0].Id] });
                    return true;
                });
            },
        });
    }

    function showRequests() {
        currentBackHandler = showHome;
        var container = window.JellyQuestShell.getContent();
        var user = window.JellyQuestSession.getCurrentProfile();
        container.innerHTML = '';
        container.className = 'jq-requests-screen';
        var loading = document.createElement('p');
        loading.className = 'jq-requests-status';
        loading.textContent = 'Loading Requests configuration…';
        container.appendChild(loading);
        var ready = buildConfig ? Promise.resolve() : loadConfiguration();
        ready.then(function () {
            if (loading.parentNode !== container) return; // navigated away while loading
            window.JellyQuestRequestsScreen.render(container, {
                bridgeUrl: buildConfig && buildConfig.requestsBridgeUrl,
                configurationFailed: !buildConfig,
                onRetryConfiguration: showRequests,
                userId: user.Id,
                userName: user.Name
            });
        }).catch(function (error) {
            console.error('[JellyQuest] Requests render failed:', error);
            container.innerHTML = '';
            loading.textContent = 'Requests are unavailable right now.';
            loading.hidden = false;
            container.appendChild(loading);
        });
    }

    // ---- Root-level Back: the exit confirmation -------------------------
    //
    // Samsung's certification policy (CO-US-05, "Terminating Applications")
    // requires that a short Return press on the app's root screen shows an
    // app-created HTML confirmation, and that only an affirmative answer
    // terminates the app. Home is that root screen.
    //
    // Leaving Back unhandled here does NOT get that behaviour for free.
    // jellyfin-web does show its own Samsung-style confirmation when its
    // router cannot go back, but #jellyquest-root sits at z-index
    // 2147483000 with an opaque background (see app.css) while
    // jellyfin-web's .dialogContainer is z-index 999999, so that dialog
    // renders behind the overlay and is invisible. What the user sees is
    // only its side effect: opening the dialog blurs the outside
    // activeElement (removing the .jq-focusable:focus outline that IS the
    // cursor) and closing it restores focus to the same element -- the
    // reported "cursor disappears, then comes back to the same spot".
    //
    // So JellyQuest owns the prompt, built on the same modal primitives
    // every other JellyQuest dialog uses (focus.js's openModal/closeModal/
    // closeOnBack and the .jq-modal conventions).
    var exitConfirm = null;

    function buildExitConfirm(root) {
        var backdrop = document.createElement('div');
        backdrop.className = 'jq-modal-backdrop jq-exit-backdrop';
        backdrop.hidden = true;

        var modal = document.createElement('div');
        modal.className = 'jq-modal jq-exit-confirm';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-label', 'Exit JellyQuest');
        backdrop.appendChild(modal);

        var heading = document.createElement('h2');
        heading.className = 'jq-exit-title';
        heading.textContent = 'Exit JellyQuest?';
        modal.appendChild(heading);

        var message = document.createElement('p');
        message.className = 'jq-exit-message';
        message.textContent = 'Closing the app will stop anything that is playing.';
        modal.appendChild(message);

        var actions = document.createElement('div');
        actions.className = 'jq-exit-actions';
        modal.appendChild(actions);

        // "No" is autofocused deliberately: Back is a frequently-pressed key
        // and the press that opens this dialog is often followed by a reflex
        // Enter, which must not be able to quit the app by accident.
        var no = document.createElement('button');
        no.className = 'jq-modal-option jq-focusable jq-exit-no';
        no.textContent = 'No';
        no.setAttribute('data-jq-autofocus', '');
        no.addEventListener('click', dismissExit);
        actions.appendChild(no);

        var yes = document.createElement('button');
        yes.className = 'jq-modal-option jq-focusable jq-exit-yes';
        yes.textContent = 'Yes, exit';
        yes.addEventListener('click', function () {
            dismissExit();
            exitApp();
        });
        actions.appendChild(yes);

        root.appendChild(backdrop);
        return { backdrop: backdrop, modal: modal, restoreTarget: null };
    }

    // Built lazily on the first root-level Back and reused after that:
    // showHome() runs on every navigation back to Home, and the dialog
    // lives on #jellyquest-root rather than inside the shell's content
    // area, which each screen clears when it renders.
    //
    // Reuse is not unconditional, though. #jellyquest-root's own contents
    // are cleared wholesale by both shell.js's renderShell() and
    // profiles.js's renderProfiles() (`container.innerHTML = ''`), so a
    // profile switch detaches this dialog while the cached reference
    // survives. Opening a detached dialog shows nothing while still
    // consuming the Back key -- strictly worse than having no handler at
    // all, and dead until reload. Re-parenting is preferred over rebuilding
    // because it is one comparison instead of a fresh DOM subtree and set
    // of listeners on every Back press, and the same check covers both
    // cases: the node was detached, or the root element itself was
    // replaced.
    function confirmExit() {
        var root = document.getElementById('jellyquest-root');
        if (!root) return;
        if (!exitConfirm) {
            exitConfirm = buildExitConfirm(root);
        } else if (exitConfirm.backdrop.parentNode !== root) {
            root.appendChild(exitConfirm.backdrop);
        }
        exitConfirm.restoreTarget = document.activeElement;
        exitConfirm.backdrop.hidden = false;
        window.JellyQuestFocus.openModal(exitConfirm.modal, dismissExit);
    }

    function dismissExit() {
        if (!exitConfirm) return;
        var restore = exitConfirm.restoreTarget;
        exitConfirm.restoreTarget = null;
        exitConfirm.backdrop.hidden = true;
        if (restore && restore !== document.body && document.body.contains(restore)) {
            window.JellyQuestFocus.closeModal(exitConfirm.modal, restore);
            return;
        }
        // Nothing focusable to go back to -- either the element that had
        // focus is gone (a re-render while the dialog was open), or nothing
        // was focused at all and activeElement was <body>, which focus()
        // cannot meaningfully restore. Fall back to whatever the current
        // screen focuses first rather than leaving the TV with no cursor.
        window.JellyQuestFocus.closeModal(exitConfirm.modal, null);
        window.JellyQuestFocus.focusFirst(window.JellyQuestShell.getContent());
    }

    // NativeShell.AppHost.exit() is tizen.js's shim over
    // tizen.application.getCurrentApplication().exit(). It is genuinely
    // absent in any embedding that does not load tizen.js, and in the
    // simulator dev/fixtures/tizen-stub.js supplies an exit() that only
    // logs -- so guard rather than assume, and never let a missing or
    // throwing host API take the UI down with it.
    function exitApp() {
        var appHost = window.NativeShell && window.NativeShell.AppHost;
        if (!appHost || typeof appHost.exit !== 'function') {
            console.warn('[JellyQuest] No AppHost.exit() available -- cannot terminate.');
            return;
        }
        try {
            appHost.exit();
        } catch (err) {
            console.error('[JellyQuest] AppHost.exit() failed:', err);
        }
    }

    // Consuming Back means consuming it for everyone. jellyfin-web installs
    // its own Back handling (keyboardNavigation -> inputManager
    // .handleCommand('back') -> appRouter.back() or appHost.exit()), and
    // that listener does bail out on an already-prevented event -- its first
    // line is `if (e.defaultPrevented) return;`.
    //
    // preventDefault() alone still is not enough to rely on, because it only
    // marks the event prevented if the event is CANCELABLE, and whether
    // these key presses are cancelable on this hardware is UNVERIFIED --
    // neither confirmed nor refuted; it needs a TV. stopPropagation() does
    // not depend on that at all: jellyfin-web's listener is on `window` in
    // the bubble phase and this one is on `document`, so the press stops
    // before it ever gets there. Both calls, deliberately.
    // True only while jellyfin-web is actually playing video -- not merely
    // "Detail is the current screen". playbackManager is jellyfin-web's own
    // global (the same one Detail's Play button already calls through, see
    // showDetail above) and isPlayingVideo() is its public accessor.
    //
    // Guarded rather than called directly: JellyQuest also runs in the
    // simulator, and this must never throw inside a keydown handler -- if
    // the API is not there, the answer is "no video is playing", which
    // leaves every existing Back behaviour exactly as it was.
    function isVideoPlaying() {
        var manager = window.playbackManager;
        if (!manager || typeof manager.isPlayingVideo !== 'function') return false;
        try {
            return !!manager.isPlayingVideo();
        } catch (err) {
            console.error('[JellyQuest] playbackManager.isPlayingVideo() failed:', err);
            return false;
        }
    }

    function consumeBack(event) {
        event.preventDefault();
        event.stopPropagation();
    }

    document.addEventListener('keydown', function (event) {
        if (BACK_KEY_CODES.indexOf(event.keyCode) === -1) return;
        // An open modal (e.g. Detail's Playback Options) owns Back first,
        // closing itself rather than navigating the whole screen away --
        // see DETAIL_ACTIONS.md's "Left or Back returns one level before
        // closing" rule.
        if (window.JellyQuestFocus.closeOnBack()) {
            consumeBack(event);
            return;
        }
        // While a video is playing, Back belongs to jellyfin-web. JellyQuest
        // has no player screen of its own -- playback is delegated whole to
        // playbackManager and Detail stays the current JellyQuest screen --
        // and it is jellyfin-web that owns getting the user out of the
        // video. Crucially that exit is NAVIGATION-driven and runs from the
        // WINDOW-level listener: keyboardNavigation ->
        // inputManager.handleCommand('back') -> appRouter.back(), which
        // hides the video view, whose own 'viewbeforehide' handler
        // (onViewHideStopPlayback) calls playbackManager.stop().
        //
        // The video controller's own document-level keydown handler does
        // NOT stop playback; its Escape/Back case only calls hideOsd(). So
        // consuming the press here -- stopPropagation() in particular, which
        // is what keeps the window listener from ever running -- would leave
        // the video playing with no way out. Deferring costs nothing: with
        // no video playing this branch never fires.
        if (isVideoPlaying()) return;
        if (!currentBackHandler) return;
        consumeBack(event);
        currentBackHandler();
    });

    var API_CLIENT_POLL_MS = 50;
    var API_CLIENT_MAX_ATTEMPTS = 300; // ~15s

    // jellyquest.js is injected (deferred) before jellyfin-web's own
    // bundle in the built index.html, and deferred scripts run in
    // document order -- so window.ApiClient is NOT guaranteed to exist
    // the instant this file runs; jellyfin-web's own bundle hasn't
    // necessarily executed yet at all. Confirmed on real hardware
    // (Phase 5): this crashed every time in the field (session.js's
    // listProfiles() calling ApiClient.getPublicUsers() on undefined),
    // but never in the simulator, where the fixture scripts set
    // window.ApiClient synchronously before jellyquest.js's own <script>
    // tag even runs -- the simulator never actually exercised real
    // script load-order timing.
    function waitForApiClient(callback, attempt) {
        attempt = attempt || 0;
        if (window.ApiClient && typeof window.ApiClient.getPublicUsers === 'function') {
            callback();
            return;
        }
        if (attempt >= API_CLIENT_MAX_ATTEMPTS) {
            console.error('[JellyQuest] Jellyfin Web never initialized ApiClient -- giving up.');
            var root = document.getElementById('jellyquest-root');
            if (root) root.textContent = 'Unable to start -- Jellyfin did not finish loading.';
            return;
        }
        window.setTimeout(function () { waitForApiClient(callback, attempt + 1); }, API_CLIENT_POLL_MS);
    }

    window.JellyQuestFocus.ready(function () {
        loadConfiguration(); // fire-and-forget: Requests waits on it lazily, nothing else needs it

        var root = document.getElementById('jellyquest-root');
        if (!root) {
            root = document.createElement('div');
            root.id = 'jellyquest-root';
            document.body.appendChild(root);
        }

        waitForApiClient(function () {
            if (window.JellyQuestSession.getCurrentProfile()) {
                showShell(root);
            } else {
                showProfiles(root);
            }
        });
    });
})();
