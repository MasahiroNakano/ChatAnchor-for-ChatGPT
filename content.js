(() => {
  if (window.__chatgptNavigatorInstalled) return;
  window.__chatgptNavigatorInstalled = true;

  const STORAGE_KEY = "scrollLockEnabled";
  const UI_ID = "chatgpt-nav-widget";
  const TOC_CHAR_LIMIT = 50;
  const TOC_MAX_HEIGHT = 220;
  const LONG_JUMP_PX = 1200;

  const STATE = {
    scrollLockEnabled: false,
    currentIndex: -1,
    lockedScrollTop: 0,
    suppressRestoreUntil: 0,
    userScrollUntil: 0,
    navInFlight: false,
    initComplete: false,
    observer: null,
    messages: [],
    tocSignature: "",
    scanTimer: null,
    restoreTimer: null,
    activeRaf: 0,
  };

  const USER_SCROLL_KEYS = new Set([
    "ArrowUp",
    "ArrowDown",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    " ",
  ]);

  const now = () => Date.now();

  function dispatchToPage(name, detail = {}) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function getScrollableAncestors(node) {
    const out = [];
    let current = node;
    while (current && current !== document.documentElement) {
      if (current instanceof Element) {
        const style = getComputedStyle(current);
        const overflowY = style.overflowY;
        const isScrollable =
          (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
          current.scrollHeight > current.clientHeight + 10;
        if (isScrollable) out.push(current);
      }
      current = current.parentElement;
    }
    return out;
  }

  function getScrollRoot() {
    const candidateRoots = [];
    const main = document.querySelector("main") || document.querySelector('[role="main"]');
    if (main) {
      candidateRoots.push(...getScrollableAncestors(main));
      candidateRoots.push(main);
    }

    const composer = document.querySelector("form") || document.querySelector("textarea");
    if (composer) candidateRoots.push(...getScrollableAncestors(composer));

    candidateRoots.push(document.scrollingElement, document.documentElement, document.body);

    const unique = candidateRoots.filter(Boolean).filter((el, idx, arr) => arr.indexOf(el) === idx);
    const scored = unique
      .map((el) => ({ el, score: (el.scrollHeight - el.clientHeight) + el.clientHeight }))
      .filter(({ el }) => el.scrollHeight > el.clientHeight + 10);

    if (scored.length) {
      scored.sort((a, b) => b.score - a.score);
      return scored[0].el;
    }

    return document.scrollingElement || document.documentElement;
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
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function normalizeMessageNode(node) {
    if (!node || !(node instanceof Element)) return null;
    return node.closest("article") || node.closest("[data-message-author-role]") || node;
  }

  function queryUserMessages() {
    const selectors = [
      '[data-message-author-role="user"]',
      '[data-author="user"]',
      'article[data-author="user"]',
      'article [data-message-author-role="user"]',
      '[data-testid^="conversation-turn-"][data-message-author-role="user"]'
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
    if (!el) return "";
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

  function truncateText(text, maxChars = TOC_CHAR_LIMIT) {
    if (!text) return "(empty message)";
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  }

  function getElementMidYInViewport(el, root) {
    const rect = el.getBoundingClientRect();
    const metrics = getViewportMetrics(root);
    return rect.top - metrics.top + rect.height / 2;
  }

  function findNearestVisibleIndex(nodes, root) {
    if (!nodes.length) return -1;
    const metrics = getViewportMetrics(root);
    const anchor = metrics.height * 0.35;
    let bestIdx = 0;
    let bestDist = Infinity;

    for (let i = 0; i < nodes.length; i += 1) {
      const mid = getElementMidYInViewport(nodes[i], root);
      const dist = Math.abs(mid - anchor);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  function getTargetTopForCenter(el, root) {
    const rect = el.getBoundingClientRect();
    const metrics = getViewportMetrics(root);
    const currentTop = getScrollTop(root);
    const offsetWithinRoot = rect.top - metrics.top;
    return currentTop + offsetWithinRoot - (metrics.height / 2) + (rect.height / 2);
  }

  function fastScrollToTop(root, targetTop, { minDuration = 80, maxDuration = 160, pxPerMs = 20 } = {}) {
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
        const eased = easeOutCubic(t);
        setScrollTop(root, startTop + distance * eased, "auto");
        if (t < 1) {
          window.requestAnimationFrame(frame);
        } else {
          setScrollTop(root, targetTop, "auto");
          resolve();
        }
      }
      window.requestAnimationFrame(frame);
    });
  }

  async function scrollElementToCenter(el) {
    if (!el || !el.isConnected) return;

    const root = getScrollRoot();
    const targetTop = getTargetTopForCenter(el, root);
    const distance = Math.abs(targetTop - getScrollTop(root));

    STATE.navInFlight = true;
    try {
      dispatchToPage("CHATGPT_NAV_ALLOW_SCROLL_ONCE", { ms: 600 });
      STATE.suppressRestoreUntil = now() + 400;
      if (distance < LONG_JUMP_PX) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        await new Promise((resolve) => window.setTimeout(resolve, 180));
      } else {
        await fastScrollToTop(root, targetTop);
      }
      STATE.lockedScrollTop = getScrollTop(root);
    } finally {
      STATE.navInFlight = false;
      STATE.suppressRestoreUntil = now() + 80;
      updateActiveHighlightSoon();
    }
  }

  async function jump(dir) {
    const nodes = STATE.messages.length ? STATE.messages : queryUserMessages();
    if (!nodes.length || STATE.navInFlight) return;

    const root = getScrollRoot();
    if (STATE.currentIndex < 0 || STATE.currentIndex >= nodes.length) {
      STATE.currentIndex = findNearestVisibleIndex(nodes, root);
    }

    STATE.currentIndex = clamp(STATE.currentIndex + dir, 0, nodes.length - 1);
    await scrollElementToCenter(nodes[STATE.currentIndex]);
  }

  function setUserScrollIntent(ms = 800) {
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
    window.clearTimeout(STATE.restoreTimer);
    let ticks = 0;
    const run = () => {
      maybeRestoreScroll();
      ticks += 1;
      if (ticks < 4) STATE.restoreTimer = window.setTimeout(run, 70);
    };
    STATE.restoreTimer = window.setTimeout(run, 0);
  }

  function updateLockButton() {
    const btn = document.querySelector(`#${UI_ID} .chatgpt-nav-lock`);
    if (!btn) return;
    btn.textContent = STATE.scrollLockEnabled ? "Stay" : "Follow";
    btn.setAttribute("aria-pressed", String(STATE.scrollLockEnabled));
    btn.title = STATE.scrollLockEnabled
      ? "Scroll lock is ON: stay at the current position"
      : "Scroll lock is OFF: follow the latest messages";
    btn.style.opacity = STATE.scrollLockEnabled ? "1" : "0.82";
  }

  function applyLockState(enabled, persist = true) {
    STATE.scrollLockEnabled = Boolean(enabled);
    if (persist && chrome?.storage?.local) {
      chrome.storage.local.set({ [STORAGE_KEY]: STATE.scrollLockEnabled });
    }
    dispatchToPage("CHATGPT_NAV_SET_LOCK", { enabled: STATE.scrollLockEnabled });
    updateLockButton();
    if (STATE.scrollLockEnabled) {
      updateLockedPositionFromCurrent();
      scheduleRestoreBurst();
    }
  }

  function setButtonStyle(btn) {
    Object.assign(btn.style, {
      minWidth: "56px",
      height: "36px",
      borderRadius: "10px",
      border: "1px solid rgba(255,255,255,0.14)",
      background: "rgba(255,255,255,0.08)",
      color: "white",
      fontSize: "13px",
      fontWeight: "600",
      cursor: "pointer",
      transition: "background 120ms ease, opacity 120ms ease"
    });
    btn.addEventListener("mouseenter", () => {
      btn.style.background = "rgba(255,255,255,0.15)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background = "rgba(255,255,255,0.08)";
    });
  }

  function buildUI() {
    if (document.getElementById(UI_ID)) return;

    const box = document.createElement("div");
    box.id = UI_ID;
    Object.assign(box.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483647",
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      width: "220px",
      padding: "8px",
      borderRadius: "14px",
      background: "rgba(20,20,20,0.78)",
      backdropFilter: "blur(8px)",
      boxShadow: "0 10px 30px rgba(0,0,0,0.22)",
      border: "1px solid rgba(255,255,255,0.10)",
      fontFamily: "ui-sans-serif, system-ui, sans-serif"
    });

    const toc = document.createElement("div");
    toc.className = "chatgpt-nav-toc";
    Object.assign(toc.style, {
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      maxHeight: `${TOC_MAX_HEIGHT}px`,
      overflowY: "auto",
      paddingRight: "2px",
      marginBottom: "2px"
    });

    const controls = document.createElement("div");
    Object.assign(controls.style, {
      display: "grid",
      gridTemplateColumns: "1fr 1fr 1fr",
      gap: "6px"
    });

    const up = document.createElement("button");
    up.type = "button";
    up.className = "chatgpt-nav-up";
    up.textContent = "▲";
    up.title = "Jump to previous prompt you sent";
    setButtonStyle(up);
    up.addEventListener("click", () => void jump(-1));

    const down = document.createElement("button");
    down.type = "button";
    down.className = "chatgpt-nav-down";
    down.textContent = "▼";
    down.title = "Jump to next prompt you sent";
    setButtonStyle(down);
    down.addEventListener("click", () => void jump(1));

    const lock = document.createElement("button");
    lock.type = "button";
    lock.className = "chatgpt-nav-lock";
    lock.title = "Toggle scroll lock";
    setButtonStyle(lock);
    lock.addEventListener("click", () => applyLockState(!STATE.scrollLockEnabled, true));

    controls.appendChild(up);
    controls.appendChild(down);
    controls.appendChild(lock);
    box.appendChild(toc);
    box.appendChild(controls);
    document.body.appendChild(box);
    updateLockButton();
  }

  function buildTocSignature(messages) {
    return messages.map((el) => `${truncateText(getMessageText(el))}|${el.isConnected ? 1 : 0}`).join("\n");
  }

  function renderTOC(force = false) {
    const toc = document.querySelector(`#${UI_ID} .chatgpt-nav-toc`);
    if (!toc) return;

    const messages = STATE.messages;
    const nextSignature = buildTocSignature(messages);
    if (!force && nextSignature === STATE.tocSignature) {
      updateActiveHighlightSoon();
      return;
    }

    STATE.tocSignature = nextSignature;
    toc.replaceChildren();

    const frag = document.createDocumentFragment();
    messages.forEach((el, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "chatgpt-nav-toc-item";
      item.dataset.index = String(index);
      item.textContent = `${index + 1}. ${truncateText(getMessageText(el))}`;
      item.title = getMessageText(el) || "(empty message)";
      Object.assign(item.style, {
        width: "100%",
        textAlign: "left",
        padding: "6px 8px",
        borderRadius: "8px",
        border: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(255,255,255,0.04)",
        color: "white",
        fontSize: "12px",
        lineHeight: "1.25",
        cursor: "pointer",
        opacity: "0.92"
      });
      item.addEventListener("click", async () => {
        STATE.currentIndex = index;
        await scrollElementToCenter(el);
      });
      frag.appendChild(item);
    });
    toc.appendChild(frag);
    updateActiveHighlightSoon();
  }

  function updateActiveHighlight() {
    STATE.activeRaf = 0;
    const toc = document.querySelector(`#${UI_ID} .chatgpt-nav-toc`);
    if (!toc || !STATE.messages.length) return;

    const root = getScrollRoot();
    const activeIndex = findNearestVisibleIndex(STATE.messages, root);
    if (activeIndex < 0) return;

    STATE.currentIndex = activeIndex;
    toc.querySelectorAll(".chatgpt-nav-toc-item").forEach((item, index) => {
      const isActive = index === activeIndex;
      item.style.background = isActive ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.04)";
      item.style.borderColor = isActive ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.08)";
      item.style.opacity = isActive ? "1" : "0.9";
    });
  }

  function updateActiveHighlightSoon() {
    if (STATE.activeRaf) return;
    STATE.activeRaf = window.requestAnimationFrame(updateActiveHighlight);
  }

  function scanMessagesAndMaybeRender() {
    STATE.scanTimer = null;
    const nextMessages = queryUserMessages();
    const sameLength = nextMessages.length === STATE.messages.length;
    const sameOrder = sameLength && nextMessages.every((el, i) => el === STATE.messages[i]);

    STATE.messages = nextMessages;
    if (!sameOrder) {
      STATE.currentIndex = -1;
      renderTOC(true);
    } else {
      renderTOC(false);
    }
  }

  function scheduleScan() {
    if (STATE.scanTimer) return;
    STATE.scanTimer = window.setTimeout(scanMessagesAndMaybeRender, 120);
  }

  function installObservers() {
    if (STATE.observer) return;

    STATE.observer = new MutationObserver(() => {
      scheduleScan();
      scheduleRestoreBurst();
    });

    STATE.observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
    });

    window.addEventListener(
      "scroll",
      () => {
        updateActiveHighlightSoon();
        if (!STATE.scrollLockEnabled || STATE.navInFlight) return;
        if (now() < STATE.suppressRestoreUntil) return;
        if (now() < STATE.userScrollUntil) {
          updateLockedPositionFromCurrent();
          return;
        }
        maybeRestoreScroll();
      },
      true
    );

    window.addEventListener("wheel", () => setUserScrollIntent(1200), { capture: true, passive: true });
    window.addEventListener("touchmove", () => setUserScrollIntent(1200), { capture: true, passive: true });
    window.addEventListener(
      "mousedown",
      () => setUserScrollIntent(800),
      true
    );

    window.addEventListener(
      "keydown",
      (event) => {
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
        if (USER_SCROLL_KEYS.has(event.key)) {
          setUserScrollIntent(1200);
        }
      },
      true
    );

    window.addEventListener("popstate", scheduleScan, true);
    window.addEventListener("resize", updateActiveHighlightSoon, { passive: true });
  }

  function ensureReady() {
    if (STATE.initComplete) return;
    buildUI();
    installObservers();
    scanMessagesAndMaybeRender();
    STATE.initComplete = true;
  }

  function init() {
    if (chrome?.storage?.local) {
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        STATE.scrollLockEnabled = Boolean(result?.[STORAGE_KEY]);
        ensureReady();
      });
    } else {
      ensureReady();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
