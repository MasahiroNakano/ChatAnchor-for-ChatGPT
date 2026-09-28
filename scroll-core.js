/* ChatGPT Navigator 3 — signed, native scroll coordinates.
 * scrollTop is NOT necessarily in [0, scrollHeight - clientHeight].
 * In a bottom-origin / column-reverse scroller it can be negative, with 0 at
 * the bottom. Geometry stays signed. The browser, not us, clamps to its range.
 * No prototype patches, artificial wheel events, or scroll-hold loop here.
 */
(() => {
  'use strict';
  const docRoot = () => document.scrollingElement || document.documentElement;
  const element = n => n instanceof Element;
  const pageRoot = n => n === docRoot();
  const finite = n => typeof n === 'number' && Number.isFinite(n);

  function ancestors(node) {
    const result = [];
    for (let el = node?.parentElement; el; el = el.parentElement) {
      if (el === docRoot()) break;
      const style = getComputedStyle(el);
      if (el.clientHeight > 32 && el.scrollHeight > el.clientHeight + 1 &&
          /^(auto|scroll|overlay|hidden)$/.test(style.overflowY)) {
        result.push({el, hidden: style.overflowY === 'hidden'});
      }
    }
    return result;
  }

  function rootFor(node) {
    if (!element(node)) return docRoot();
    const candidates = ancestors(node);
    const marked = candidates.find(x => x.el.hasAttribute('data-app-action-timeline-scroll'));
    if (marked) return marked.el;
    const visible = candidates.find(x => !x.hidden);
    if (visible) return visible.el;
    if (candidates.length) return candidates[0].el;
    return docRoot();
  }

  function viewport(root) {
    if (pageRoot(root)) {
      return {top: 0, left: 0, height: document.documentElement.clientHeight,
        width: document.documentElement.clientWidth};
    }
    const rect = root.getBoundingClientRect();
    return {top: rect.top + root.clientTop, left: rect.left + root.clientLeft,
      height: root.clientHeight, width: root.clientWidth};
  }

  function position(node, root) {
    const box = node.getBoundingClientRect();
    const view = viewport(root);
    return {
      top: box.top - view.top,
      height: box.height,
      // This content-relative signed coordinate is invariant under scroll alone.
      contentTop: root.scrollTop + box.top - view.top,
      viewport: view.height
    };
  }

  function target(node, root, fraction = 0.22) {
    const p = position(node, root);
    return p.contentTop - Math.max(24, p.viewport * fraction);
  }

  function write(root, top) {
    if (!element(root) || !root.isConnected || !finite(top)) {
      throw new TypeError('Invalid scroll root or signed coordinate');
    }
    const before = root.scrollTop;
    // Do not replace with Math.max(0, top), abs(top), or clamp(top, 0, max).
    // "instant" also avoids an inherited CSS smooth-scroll race.
    if (pageRoot(root)) window.scrollTo({top, left: window.scrollX, behavior: 'instant'});
    else root.scrollTo({top, left: root.scrollLeft, behavior: 'instant'});
    return {before, requested: top, actual: root.scrollTop};
  }

  function model(root) {
    const style = getComputedStyle(root);
    const evidence = root.scrollTop < -0.5 ? 'observed-negative-scrollTop'
      : /flex/.test(style.display) && style.flexDirection === 'column-reverse'
        ? 'computed-column-reverse' : 'not-observed';
    return {
      originEvidence: evidence,
      scrollTop: root.scrollTop,
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
      display: style.display,
      flexDirection: style.flexDirection,
      overflowY: style.overflowY,
      scrollBehavior: style.scrollBehavior,
      overflowAnchor: style.overflowAnchor,
      scrollSnapType: style.scrollSnapType,
      writingMode: style.writingMode,
      timelineMarker: root.hasAttribute('data-app-action-timeline-scroll'),
      documentScroller: pageRoot(root)
    };
  }

  globalThis.CGNavScroll = Object.freeze({rootFor, viewport, position, target, write, model, docRoot});
})();
