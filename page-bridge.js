(() => {
  "use strict";

  if (globalThis.__chatgptNavigatorPageGuardV202Installed) return;
  globalThis.__chatgptNavigatorPageGuardV202Installed = true;

  const GUARD_ATTR = "data-cgn-scroll-guard-v202";
  const STATE_EVENT = "CGN_SCROLL_GUARD_V202_STATE";
  let enabled = false;

  const isElement = (value) => value instanceof Element;
  const scrollingElement = () => document.scrollingElement || document.documentElement;

  function isGuardedScroller(el) {
    return isElement(el) && el.hasAttribute(GUARD_ATTR);
  }

  function hasGuardedAncestor(el) {
    let current = isElement(el) ? el : null;
    while (current) {
      if (isGuardedScroller(current)) return true;
      current = current.parentElement;
    }
    return false;
  }

  function shouldBlockScroller(el) {
    return enabled && isGuardedScroller(el);
  }

  function shouldBlockIntoViewTarget(el) {
    return enabled && hasGuardedAncestor(el);
  }

  function shouldBlockWindowScroll() {
    if (!enabled) return false;
    const scroller = scrollingElement();
    return isGuardedScroller(scroller) ||
      document.documentElement?.hasAttribute(GUARD_ATTR) ||
      document.body?.hasAttribute(GUARD_ATTR);
  }

  window.addEventListener(STATE_EVENT, (event) => {
    enabled = Boolean(event?.detail?.enabled);
  });

  const marker = Symbol.for("chatgpt-navigator-scroll-guard-v202");

  function patchMethod(owner, methodName, shouldBlock) {
    const original = owner?.[methodName];
    if (typeof original !== "function" || original[marker]) return;

    const wrapped = function (...args) {
      if (shouldBlock(this, args)) return;
      return original.apply(this, args);
    };
    try { Object.defineProperty(wrapped, marker, { value: true }); } catch (_) {}

    try {
      Object.defineProperty(owner, methodName, {
        value: wrapped,
        writable: true,
        configurable: true
      });
    } catch (_) {
      try { owner[methodName] = wrapped; } catch (_) {}
    }
  }

  function patchScrollTopSetter() {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    if (!descriptor?.get || !descriptor?.set || descriptor.set[marker]) return;

    const originalGet = descriptor.get;
    const originalSet = descriptor.set;
    const wrappedSet = function (value) {
      if (shouldBlockScroller(this)) return;
      return originalSet.call(this, value);
    };
    try { Object.defineProperty(wrappedSet, marker, { value: true }); } catch (_) {}

    try {
      Object.defineProperty(Element.prototype, "scrollTop", {
        get: originalGet,
        set: wrappedSet,
        enumerable: descriptor.enumerable,
        configurable: true
      });
    } catch (_) {}
  }

  function installPatches() {
    patchMethod(Element.prototype, "scrollIntoView", (target) => shouldBlockIntoViewTarget(target));
    patchMethod(Element.prototype, "scrollTo", (target) => shouldBlockScroller(target));
    patchMethod(Element.prototype, "scrollBy", (target) => shouldBlockScroller(target));
    patchMethod(Element.prototype, "scroll", (target) => shouldBlockScroller(target));
    patchMethod(window, "scrollTo", () => shouldBlockWindowScroll());
    patchMethod(window, "scrollBy", () => shouldBlockWindowScroll());
    patchMethod(window, "scroll", () => shouldBlockWindowScroll());
    patchScrollTopSetter();
  }

  installPatches();
  // ChatGPT is a long-lived SPA. Re-check occasionally in case another script replaces a method.
  window.setInterval(installPatches, 1000);
})();
