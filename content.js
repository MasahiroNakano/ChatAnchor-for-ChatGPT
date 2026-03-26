(() => {
  if (window.__chatgptNavigatorInstalled) return;
  window.__chatgptNavigatorInstalled = true;

  const STORAGE_KEY = "scrollLockEnabled";
  const HOST_ID = "chatanchor-host";
  const PANEL_ID = "chatanchor-panel";
  const TOC_CHAR_LIMIT = 50;
  const TOC_MIN_HEIGHT = 240;
  const TOC_ITEM_HEIGHT = 56;
  const PANEL_RESERVED_HEIGHT = 112;
  const PANEL_VIEWPORT_MARGIN = 40;
  const LONG_JUMP_PX = 1200;
  const USER_SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

  const STATE = {
    scrollLockEnabled: false,
    currentIndex: -1,
    lockedScrollTop: 0,
    suppressRestoreUntil: 0,
    userScrollUntil: 0,
    navInFlight: false,
    messages: [],
    messagesSignature: "",
    observer: null,
    scanTimer: 0,
    restoreTimer: 0,
    settleTimer: 0,
    urlPollTimer: 0,
    lastHref: location.href,
    bootRetries: 0,
    ui: {
      host: null,
      shadow: null,
      panel: null,
      tocWrap: null,
      toc: null,
      lockBtn: null,
    },
  };

  const now = () => Date.now();

  function dispatchToPage(name, detail = {}) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function truncateText(text, maxChars = TOC_CHAR_LIMIT) {
    const clean = (text || "").replace(/\s+/g, " ").trim();
    if (!clean) return "(empty message)";
    if (clean.length <= maxChars) return clean;
    return `${clean.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  }

  function getScrollableAncestors(node) {
    const out = [];
    let current = node instanceof Element ? node : null;
    while (current && current !== document.documentElement) {
      const style = getComputedStyle(current);
      const overflowY = style.overflowY;
      const isScrollable =
        (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
        current.scrollHeight > current.clientHeight + 10;
      if (isScrollable) out.push(current);
      current = current.parentElement;
    }
    return out;
  }

  function getScrollRoot() {
    const roots = [];
    const main = document.querySelector("main") || document.querySelector('[role="main"]');
    const form = document.querySelector("form");
    const textarea = document.querySelector("textarea");

    if (main) {
      roots.push(...getScrollableAncestors(main));
      roots.push(main);
    }
    if (form) roots.push(...getScrollableAncestors(form));
    if (textarea) roots.push(...getScrollableAncestors(textarea));
    roots.push(document.scrollingElement, document.documentElement, document.body);

    const unique = roots.filter(Boolean).filter((el, idx, arr) => arr.indexOf(el) === idx);
    const candidates = unique
      .filter((el) => el.scrollHeight > el.clientHeight + 10)
      .map((el) => ({ el, score: (el.scrollHeight - el.clientHeight) + el.clientHeight }));

    if (!candidates.length) return document.scrollingElement || document.documentElement;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].el;
  }

  function isWindowRoot(root) {
    return root === document.body || root === document.documentElement || root === document.scrollingElement;
  }

  function getScrollTop(root) {
    return isWindowRoot(root)
      ? window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0
      : root.scrollTop;
  }

  function setScrollTop(root, top, behavior = "auto") {
    if (isWindowRoot(root)) {
      window.scrollTo({ top, behavior });
    } else {
      root.scrollTo({ top, behavior });
    }
  }

  function getViewportMetrics(root) {
    if (isWindowRoot(root)) {
      return { top: 0, height: window.innerHeight, scrollTop: getScrollTop(root) };
    }
    const rect = root.getBoundingClientRect();
    return { top: rect.top, height: root.clientHeight, scrollTop: root.scrollTop };
  }

  function isElementVisible(el) {
    if (!(el instanceof Element) || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function normalizeMessageNode(node) {
    if (!(node instanceof Element)) return null;
    return node.closest("article") || node.closest('[data-message-author-role="user"]') || node;
  }

  function queryUserMessages() {
    const selectors = [
      '[data-message-author-role="user"]',
      '[data-author="user"]',
      'article[data-author="user"]',
      '[data-testid^="conversation-turn-"] [data-message-author-role="user"]',
      'article [data-message-author-role="user"]'
    ];

    const nodes = [];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => {
        const normalized = normalizeMessageNode(node);
        if (normalized && isElementVisible(normalized)) nodes.push(normalized);
      });
    }

    const unique = nodes.filter((node, idx, arr) => arr.indexOf(node) === idx);
    unique.sort((a, b) => {
      if (a === b) return 0;
      const pos = a.compareDocumentPosition(b);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    return unique;
  }

  function getMessageText(el) {
    if (!(el instanceof Element)) return "";
    const candidates = [
      el.querySelector('[data-message-author-role="user"]'),
      el.querySelector('[data-testid*="user"]'),
      el,
    ].filter(Boolean);

    for (const candidate of candidates) {
      const text = (candidate.innerText || candidate.textContent || "").replace(/\s+/g, " ").trim();
      if (text) return text;
    }
    return "";
  }

  function buildMessageSignature(messages) {
    return messages
      .map((el, idx) => `${idx}:${truncateText(getMessageText(el), 80)}`)
      .join("\n");
  }

  function updateTOCLayout() {
    const panel = STATE.ui.panel;
    const toc = STATE.ui.toc;
    if (!(panel instanceof HTMLElement) || !(toc instanceof HTMLElement)) return;

    const viewportHeight = Math.max(window.innerHeight || 0, 320);
    const panelMaxHeight = Math.max(220, viewportHeight - PANEL_VIEWPORT_MARGIN);
    const availableTOCHeight = Math.max(120, panelMaxHeight - PANEL_RESERVED_HEIGHT);
    const minTOCHeight = Math.min(TOC_MIN_HEIGHT, availableTOCHeight);
    const desiredHeight = STATE.messages.length
      ? clamp(STATE.messages.length * TOC_ITEM_HEIGHT, minTOCHeight, availableTOCHeight)
      : minTOCHeight;
    const tocHeight = clamp(desiredHeight, minTOCHeight, availableTOCHeight);

    panel.style.maxHeight = `${panelMaxHeight}px`;
    toc.style.height = `${tocHeight}px`;
    toc.style.maxHeight = `${availableTOCHeight}px`;
  }

  function ensureUI() {
    if (STATE.ui.host?.isConnected && STATE.ui.shadow) return;

    let host = document.getElementById(HOST_ID);
    if (!(host instanceof HTMLElement)) {
      host = document.createElement("div");
      host.id = HOST_ID;
      host.style.position = "fixed";
      host.style.right = "20px";
      host.style.bottom = "20px";
      host.style.zIndex = "2147483647";
      host.style.pointerEvents = "none";
      document.documentElement.appendChild(host);
    }

    const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        #${PANEL_ID} {
          pointer-events: auto;
          box-sizing: border-box;
          width: min(340px, calc(100vw - 32px));
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 10px;
          border-radius: 16px;
          background: rgba(20,20,20,0.76);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border: 1px solid rgba(255,255,255,0.12);
          box-shadow: 0 10px 30px rgba(0,0,0,0.22);
          font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: white;
          overflow: hidden;
          max-height: calc(100vh - ${PANEL_VIEWPORT_MARGIN}px);
        }
        .toc-wrap {
          display: flex;
          flex-direction: column;
          gap: 6px;
          min-height: 0;
          flex: 1 1 auto;
        }
        .toc-label {
          color: rgba(255,255,255,0.86);
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.02em;
          padding: 0 2px;
        }
        .toc {
          display: flex;
          flex-direction: column;
          gap: 6px;
          min-height: 120px;
          height: ${TOC_MIN_HEIGHT}px;
          flex: 1 1 auto;
          overflow-y: auto;
          padding-right: 2px;
          scrollbar-gutter: stable;
        }
        .toc-item {
          width: 100%;
          display: block;
          text-align: left;
          padding: 7px 9px;
          border-radius: 10px;
          border: 1px solid rgba(255,255,255,0.08);
          background: rgba(255,255,255,0.06);
          color: white;
          font-size: 12px;
          line-height: 1.3;
          cursor: pointer;
          margin: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .toc-item:hover { background: rgba(255,255,255,0.12); }
        .toc-item.active {
          background: rgba(255,255,255,0.16);
          border-color: rgba(255,255,255,0.28);
        }
        .buttons {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
        }
        .btn {
          min-width: 0;
          height: 38px;
          border-radius: 12px;
          border: 1px solid rgba(255,255,255,0.16);
          background: rgba(255,255,255,0.08);
          color: white;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: transform 120ms ease, opacity 120ms ease, background 120ms ease;
        }
        .btn:hover { background: rgba(255,255,255,0.16); }
        .btn:active { transform: translateY(1px); }
        .empty {
          color: rgba(255,255,255,0.7);
          font-size: 12px;
          line-height: 1.4;
          padding: 6px 2px;
        }
      </style>
      <div id="${PANEL_ID}">
        <div class="toc-wrap">
          <div class="toc-label">Your prompts</div>
          <div class="toc"></div>
        </div>
        <div class="buttons">
          <button class="btn up" type="button" title="Jump to previous prompt you sent">▲</button>
          <button class="btn down" type="button" title="Jump to next prompt you sent">▼</button>
          <button class="btn lock" type="button" title="Toggle scroll lock">Follow</button>
        </div>
      </div>
    `;

    STATE.ui.host = host;
    STATE.ui.shadow = shadow;
    STATE.ui.panel = shadow.getElementById(PANEL_ID);
    STATE.ui.tocWrap = shadow.querySelector(".toc-wrap");
    STATE.ui.toc = shadow.querySelector(".toc");
    STATE.ui.lockBtn = shadow.querySelector(".lock");

    shadow.querySelector(".up")?.addEventListener("click", () => { void jump(-1); });
    shadow.querySelector(".down")?.addEventListener("click", () => { void jump(1); });
    STATE.ui.lockBtn?.addEventListener("click", () => {
      applyLockState(!STATE.scrollLockEnabled, true);
    });

    applyLockState(STATE.scrollLockEnabled, false);
    renderTOC(true);
  }

  function updateLockButton() {
    const btn = STATE.ui.lockBtn;
    if (!btn) return;
    btn.textContent = STATE.scrollLockEnabled ? "Stay" : "Follow";
    btn.setAttribute("aria-pressed", String(STATE.scrollLockEnabled));
    btn.title = STATE.scrollLockEnabled
      ? "Scroll lock is ON: stay at the current position"
      : "Scroll lock is OFF: follow the latest messages";
    btn.style.opacity = STATE.scrollLockEnabled ? "1" : "0.84";
  }

  function renderTOC(force = false) {
    ensureUI();
    const toc = STATE.ui.toc;
    if (!toc) return;

    const signature = buildMessageSignature(STATE.messages);
    const root = getScrollRoot();
    const activeIndex = STATE.messages.length ? findNearestVisibleIndex(STATE.messages, root) : -1;
    if (activeIndex >= 0 && !STATE.navInFlight) STATE.currentIndex = activeIndex;

    if (!force && signature === STATE.messagesSignature && toc.childElementCount === STATE.messages.length) {
      [...toc.children].forEach((child, idx) => {
        if (child instanceof HTMLElement) child.classList.toggle("active", idx === activeIndex);
      });
      const active = toc.children[activeIndex];
      if (active instanceof HTMLElement) active.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
      updateTOCLayout();
      return;
    }

    STATE.messagesSignature = signature;
    toc.innerHTML = "";

    if (!STATE.messages.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No prompts found yet";
      toc.appendChild(empty);
      updateTOCLayout();
      return;
    }

    STATE.messages.forEach((node, idx) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `toc-item${idx === activeIndex ? " active" : ""}`;
      const rawText = getMessageText(node);
      item.textContent = truncateText(rawText);
      item.title = rawText || "(empty message)";
      item.addEventListener("click", () => { void jumpToIndex(idx); });
      toc.appendChild(item);
    });

    updateTOCLayout();
  }

  function findNearestVisibleIndex(nodes, root) {
    if (!nodes.length) return -1;
    const metrics = getViewportMetrics(root);
    const anchor = metrics.height * 0.35;
    let bestIdx = 0;
    let bestDist = Infinity;

    for (let i = 0; i < nodes.length; i += 1) {
      const rect = nodes[i].getBoundingClientRect();
      const mid = rect.top - metrics.top + rect.height / 2;
      const dist = Math.abs(mid - anchor);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  function setUserScrollIntent(ms = 900) {
    STATE.userScrollUntil = now() + ms;
  }

  function updateLockedPositionFromCurrent() {
    STATE.lockedScrollTop = getScrollTop(getScrollRoot());
  }

  function maybeRestoreScroll() {
    if (!STATE.scrollLockEnabled || STATE.navInFlight) return;
    if (now() < STATE.suppressRestoreUntil) return;
    const root = getScrollRoot();
    const current = getScrollTop(root);
    if (Math.abs(current - STATE.lockedScrollTop) <= 2) return;
    dispatchToPage("CHATGPT_NAV_ALLOW_SCROLL_ONCE", { ms: 80 });
    setScrollTop(root, STATE.lockedScrollTop, "auto");
  }

  function scheduleRestoreBurst() {
    if (!STATE.scrollLockEnabled || STATE.navInFlight) return;
    clearTimeout(STATE.restoreTimer);
    let ticks = 0;
    const run = () => {
      maybeRestoreScroll();
      ticks += 1;
      if (ticks < 8) STATE.restoreTimer = window.setTimeout(run, 60);
    };
    STATE.restoreTimer = window.setTimeout(run, 0);
  }

  function applyLockState(enabled, persist = true) {
    STATE.scrollLockEnabled = Boolean(enabled);
    updateLockButton();
    if (persist && chrome?.storage?.local) {
      chrome.storage.local.set({ [STORAGE_KEY]: STATE.scrollLockEnabled });
    }
    dispatchToPage("CHATGPT_NAV_SET_LOCK", { enabled: STATE.scrollLockEnabled });
    if (STATE.scrollLockEnabled) {
      updateLockedPositionFromCurrent();
      scheduleRestoreBurst();
    }
  }

  function getTargetTopForCenter(el, root) {
    const rect = el.getBoundingClientRect();
    const metrics = getViewportMetrics(root);
    const currentTop = getScrollTop(root);
    const absoluteTop = currentTop + (rect.top - metrics.top);
    const maxTop = Math.max(0, root.scrollHeight - metrics.height);
    return clamp(absoluteTop - metrics.height / 2 + rect.height / 2, 0, maxTop);
  }

  function fastScrollToTop(root, targetTop, { minDuration = 80, maxDuration = 170, pxPerMs = 20 } = {}) {
    const startTop = getScrollTop(root);
    const distance = targetTop - startTop;
    const absDistance = Math.abs(distance);
    if (absDistance < 12) {
      setScrollTop(root, targetTop, "auto");
      return Promise.resolve();
    }

    const duration = Math.max(minDuration, Math.min(maxDuration, absDistance / pxPerMs));
    const startedAt = performance.now();
    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

    return new Promise((resolve) => {
      function frame(ts) {
        const elapsed = ts - startedAt;
        const t = Math.min(1, elapsed / duration);
        setScrollTop(root, startTop + distance * easeOutCubic(t), "auto");
        if (t < 1) {
          requestAnimationFrame(frame);
        } else {
          setScrollTop(root, targetTop, "auto");
          resolve();
        }
      }
      requestAnimationFrame(frame);
    });
  }

  function settleAfterNavigation(targetTop, delay = 120) {
    return new Promise((resolve) => {
      clearTimeout(STATE.settleTimer);
      STATE.settleTimer = window.setTimeout(() => {
        STATE.lockedScrollTop = getScrollTop(getScrollRoot());
        STATE.suppressRestoreUntil = now() + 100;
        resolve(targetTop);
      }, delay);
    });
  }

  async function scrollElementToCenter(el) {
    if (!(el instanceof Element) || !el.isConnected) return;
    const root = getScrollRoot();
    const targetTop = getTargetTopForCenter(el, root);
    const distance = Math.abs(targetTop - getScrollTop(root));
    const useNativeSmooth = distance <= Math.max(LONG_JUMP_PX, getViewportMetrics(root).height * 1.25);
    const allowMs = useNativeSmooth ? 900 : 260;

    STATE.navInFlight = true;
    try {
      STATE.suppressRestoreUntil = now() + allowMs;
      dispatchToPage("CHATGPT_NAV_ALLOW_SCROLL_ONCE", { ms: allowMs });
      if (useNativeSmooth) {
        setScrollTop(root, targetTop, "smooth");
        await new Promise((resolve) => setTimeout(resolve, 220));
      } else {
        await fastScrollToTop(root, targetTop);
      }
      await settleAfterNavigation(targetTop, 120);
    } finally {
      STATE.navInFlight = false;
      renderTOC(false);
    }
  }

  async function jump(dir) {
    if (STATE.navInFlight) return;
    if (!STATE.messages.length) refreshMessages();
    if (!STATE.messages.length) return;

    const root = getScrollRoot();
    if (STATE.currentIndex < 0 || STATE.currentIndex >= STATE.messages.length) {
      STATE.currentIndex = findNearestVisibleIndex(STATE.messages, root);
    }
    STATE.currentIndex = clamp(STATE.currentIndex + dir, 0, STATE.messages.length - 1);
    await scrollElementToCenter(STATE.messages[STATE.currentIndex]);
  }

  async function jumpToIndex(index) {
    if (!STATE.messages.length) refreshMessages();
    if (!STATE.messages.length) return;
    STATE.currentIndex = clamp(index, 0, STATE.messages.length - 1);
    await scrollElementToCenter(STATE.messages[STATE.currentIndex]);
  }

  function refreshMessages() {
    ensureUI();
    STATE.messages = queryUserMessages();
    renderTOC(false);
  }

  function scheduleScan(reason = "mutation", delay = 120) {
    clearTimeout(STATE.scanTimer);
    STATE.scanTimer = window.setTimeout(() => {
      ensureUI();
      refreshMessages();
      if (!STATE.messages.length && STATE.bootRetries < 6) {
        STATE.bootRetries += 1;
        scheduleScan("retry", Math.min(1200, 180 + STATE.bootRetries * 160));
      }
      if (STATE.scrollLockEnabled && reason !== "nav") scheduleRestoreBurst();
    }, delay);
  }

  function handlePossibleRouteChange() {
    if (location.href === STATE.lastHref) return;
    STATE.lastHref = location.href;
    STATE.currentIndex = -1;
    STATE.bootRetries = 0;
    scheduleScan("nav", 180);
  }

  function installObservers() {
    if (STATE.observer) return;

    STATE.observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const mutation of mutations) {
        if (mutation.type !== "childList") continue;
        if (mutation.addedNodes.length || mutation.removedNodes.length) {
          shouldScan = true;
          break;
        }
      }
      if (shouldScan) scheduleScan("mutation", 120);
    });

    const target = document.body || document.documentElement;
    if (target) {
      STATE.observer.observe(target, { childList: true, subtree: true });
    }

    window.addEventListener("scroll", () => {
      renderTOC(false);
      if (!STATE.scrollLockEnabled) return;
      if (now() < STATE.suppressRestoreUntil) return;
      if (now() < STATE.userScrollUntil) {
        updateLockedPositionFromCurrent();
        return;
      }
      maybeRestoreScroll();
    }, true);

    window.addEventListener("wheel", () => setUserScrollIntent(1200), { capture: true, passive: true });
    window.addEventListener("touchmove", () => setUserScrollIntent(1200), { capture: true, passive: true });
    window.addEventListener("mousedown", () => setUserScrollIntent(800), true);
    window.addEventListener("resize", () => renderTOC(false), { passive: true });
    window.addEventListener("popstate", handlePossibleRouteChange, true);
    window.addEventListener("hashchange", handlePossibleRouteChange, true);

    window.addEventListener("keydown", (event) => {
      if (event.altKey && !event.shiftKey && event.key === "ArrowUp") {
        event.preventDefault();
        void jump(-1);
        return;
      }
      if (event.altKey && !event.shiftKey && event.key === "ArrowDown") {
        event.preventDefault();
        void jump(1);
        return;
      }
      if (event.altKey && !event.shiftKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        applyLockState(!STATE.scrollLockEnabled, true);
        return;
      }
      if (USER_SCROLL_KEYS.has(event.key)) setUserScrollIntent(1200);
    }, true);

    STATE.urlPollTimer = window.setInterval(handlePossibleRouteChange, 700);
  }

  function start() {
    ensureUI();
    installObservers();
    refreshMessages();
    scheduleScan("boot", 250);
    scheduleScan("boot", 900);
  }

  function init() {
    if (chrome?.storage?.local) {
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        STATE.scrollLockEnabled = Boolean(result?.[STORAGE_KEY]);
        start();
      });
    } else {
      start();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
