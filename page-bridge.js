(() => {
  if (window.__chatgptNavigatorBridgeInstalled) return;
  window.__chatgptNavigatorBridgeInstalled = true;

  let lockEnabled = false;
  let allowUntil = 0;

  const now = () => Date.now();
  const allowOnce = (ms = 800) => {
    allowUntil = Math.max(allowUntil, now() + ms);
  };
  const shouldBlock = () => lockEnabled && now() > allowUntil;

  window.addEventListener("CHATGPT_NAV_SET_LOCK", (event) => {
    lockEnabled = Boolean(event?.detail?.enabled);
  });

  window.addEventListener("CHATGPT_NAV_ALLOW_SCROLL_ONCE", (event) => {
    const ms = Number(event?.detail?.ms) || 800;
    allowOnce(ms);
  });

  const originalWindowScrollTo = window.scrollTo.bind(window);
  const originalWindowScrollBy = window.scrollBy.bind(window);
  const originalElementScrollIntoView = Element.prototype.scrollIntoView;
  const originalElementScrollTo = Element.prototype.scrollTo;
  const originalElementScrollBy = Element.prototype.scrollBy;

  window.scrollTo = function patchedWindowScrollTo(...args) {
    if (shouldBlock()) return;
    return originalWindowScrollTo(...args);
  };

  window.scrollBy = function patchedWindowScrollBy(...args) {
    if (shouldBlock()) return;
    return originalWindowScrollBy(...args);
  };

  Element.prototype.scrollIntoView = function patchedScrollIntoView(...args) {
    if (shouldBlock()) return;
    return originalElementScrollIntoView.apply(this, args);
  };

  Element.prototype.scrollTo = function patchedElementScrollTo(...args) {
    if (shouldBlock()) return;
    return originalElementScrollTo.apply(this, args);
  };

  Element.prototype.scrollBy = function patchedElementScrollBy(...args) {
    if (shouldBlock()) return;
    return originalElementScrollBy.apply(this, args);
  };
})();
