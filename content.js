(() => {
  "use strict";

  if (globalThis.__chatgptNavigatorStayV2Installed) return;
  globalThis.__chatgptNavigatorStayV2Installed = true;

  const HOST_ID = "chatgpt-navigator-stay-v2";
  const STORAGE_KEY = "scrollLockEnabled"; // Keep the v1 key so the old preference carries over.
  const PREVIEW_CHARS = 58;
  const SCAN_DELAY_MS = 120;
  const USER_SCROLL_GRACE_MS = 260;
  const PERIODIC_STAY_CHECK_MS = 220;

  // Keep ChatGPT-specific selectors in one place. The code deliberately uses several
  // independent signals instead of relying on one exact DOM hierarchy.
  const SELECTORS = {
    currentShell: "[data-turn-key]",
    legacyShell: '[data-testid^="conversation-turn-"]',
    userMarkers: [
      "[data-user-message-bubble]",
      '[data-message-author-role="user"]',
      '[data-conversation-role="user"]',
      '[data-role="user"]',
      '[data-message-author="user"]'
    ],
    assistantMarkers: [
      '[data-message-author-role="assistant"]',
      '[data-conversation-role="assistant"]',
      '[data-role="assistant"]',
      '[data-message-author="assistant"]'
    ],
    userText: [
      ".whitespace-pre-wrap",
      '[data-message-content="user"]',
      '[data-message-text]',
      '[class*="whitespace-pre-wrap"]'
    ],
    composer: [
      "#prompt-textarea",
      '[contenteditable="true"][role="textbox"]',
      "textarea",
      "form"
    ]
  };

  const state = {
    stayEnabled: false,
    routeKey: "",
    prompts: [],
    promptCache: new Map(),
    ephemeralIds: new WeakMap(),
    nextEphemeralId: 1,
    currentIndex: -1,
    scrollRoot: null,
    anchor: null,
    fallbackScrollTop: 0,
    scanTimer: 0,
    highlightRaf: 0,
    maintainRaf: 0,
    periodicTimer: 0,
    routeTimer: 0,
    userSettleTimer: 0,
    navRaf: 0,
    navToken: 0,
    navigationInFlight: false,
    internalScrollUntil: 0,
    userIntentUntil: 0,
    pointerScrolling: false,
    observer: null,
    ui: null
  };

  const now = () => Date.now();
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function routeKey() {
    return `${location.pathname}${location.search}${location.hash}`;
  }

  function isExtensionEvent(event) {
    if (!state.ui?.host || typeof event?.composedPath !== "function") return false;
    return event.composedPath().includes(state.ui.host);
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest(
        'input, textarea, select, [contenteditable="true"], [role="textbox"]'
      )
    );
  }

  function isHiddenByAttribute(el) {
    if (!(el instanceof Element)) return true;
    return Boolean(el.closest('[hidden], [aria-hidden="true"]'));
  }

  function normalizeText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function truncate(value, max = PREVIEW_CHARS) {
    const text = normalizeText(value);
    if (!text) return "(prompt text unavailable)";
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
  }

  function firstMatchWithin(root, selectors) {
    if (!(root instanceof Element)) return null;
    for (const selector of selectors) {
      if (root.matches(selector)) return root;
      const found = root.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  function findUserMarker(root) {
    return firstMatchWithin(root, SELECTORS.userMarkers);
  }

  function findAssistantMarker(root) {
    return firstMatchWithin(root, SELECTORS.assistantMarkers);
  }

  function normalizeShell(marker) {
    if (!(marker instanceof Element)) return null;
    return (
      marker.closest(SELECTORS.currentShell) ||
      marker.closest(SELECTORS.legacyShell) ||
      marker
    );
  }

  function getStableKey(shell, marker) {
    const candidates = [shell, marker].filter((node) => node instanceof Element);
    for (const el of candidates) {
      const turnKey = el.getAttribute("data-turn-key");
      if (turnKey) return `turn-key:${turnKey}`;
      const turnId = el.getAttribute("data-turn-id");
      if (turnId) return `turn-id:${turnId}`;
      const testId = el.getAttribute("data-testid");
      if (testId && testId.startsWith("conversation-turn-")) return `testid:${testId}`;
    }

    if (!state.ephemeralIds.has(shell)) {
      state.ephemeralIds.set(shell, state.nextEphemeralId++);
    }
    return `dom:${state.ephemeralIds.get(shell)}`;
  }

  function extractPromptText(marker, shell) {
    const roots = [];
    if (marker instanceof Element) roots.push(marker);
    if (shell instanceof Element && shell !== marker) roots.push(shell);

    for (const root of roots) {
      for (const selector of SELECTORS.userText) {
        if (root.matches(selector)) {
          const text = normalizeText(root.innerText || root.textContent);
          if (text) return text;
        }
        const el = root.querySelector(selector);
        if (el) {
          const text = normalizeText(el.innerText || el.textContent);
          if (text) return text;
        }
      }

      // Prefer the user-role node over the whole turn shell, because current ChatGPT
      // can group the user prompt and assistant answer beneath one stable turn key.
      const userNode = findUserMarker(root);
      if (userNode) {
        const text = normalizeText(userNode.innerText || userNode.textContent);
        if (text) return text;
      }
    }

    return "";
  }

  function addPromptRecord(records, seenKeys, shell, marker, forceUser = false) {
    if (!(shell instanceof Element) || !shell.isConnected || isHiddenByAttribute(shell)) return;

    const userMarker = marker instanceof Element ? marker : findUserMarker(shell);
    if (!forceUser && !userMarker) return;

    const key = getStableKey(shell, userMarker);
    if (seenKeys.has(key)) return;

    let text = extractPromptText(userMarker, shell);
    if (text) state.promptCache.set(key, text);
    else text = state.promptCache.get(key) || "";

    const focus = userMarker || shell;
    records.push({ key, shell, focus, text });
    seenKeys.add(key);
  }

  function collectPrompts() {
    const records = [];
    const seenKeys = new Set();

    // Current renderer: stable exchange shells keyed by data-turn-key. Avoid nested
    // data-turn-key elements so one exchange cannot appear multiple times.
    document.querySelectorAll(SELECTORS.currentShell).forEach((shell) => {
      if (!(shell instanceof Element)) return;
      const parentTurnKey = shell.parentElement?.closest(SELECTORS.currentShell);
      if (parentTurnKey) return;
      const marker = findUserMarker(shell);
      if (marker) addPromptRecord(records, seenKeys, shell, marker, true);
    });

    // Legacy / alternate renderer: persistent conversation-turn shells. A shell with
    // data-turn="user" remains useful even if its text was temporarily virtualized.
    document.querySelectorAll(SELECTORS.legacyShell).forEach((shell) => {
      if (!(shell instanceof Element)) return;
      const explicitRole = shell.getAttribute("data-turn");
      const marker = findUserMarker(shell);
      if (explicitRole === "user" || marker) {
        addPromptRecord(records, seenKeys, normalizeShell(marker || shell), marker, true);
      }
    });

    // Last-resort role-marker scan. This survived multiple ChatGPT DOM rewrites and
    // also covers experiments that do not expose a recognizable turn shell.
    for (const selector of SELECTORS.userMarkers) {
      document.querySelectorAll(selector).forEach((marker) => {
        if (!(marker instanceof Element)) return;
        const shell = normalizeShell(marker);
        addPromptRecord(records, seenKeys, shell, marker, true);
      });
    }

    records.sort((a, b) => {
      if (a.shell === b.shell) return 0;
      const pos = a.shell.compareDocumentPosition(b.shell);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    return records;
  }

  function getScrollerElement(root) {
    if (
      root === document.scrollingElement ||
      root === document.documentElement ||
      root === document.body ||
      root === window
    ) {
      return document.scrollingElement || document.documentElement;
    }
    return root;
  }

  function isWindowRoot(root) {
    const scroller = getScrollerElement(root);
    return scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body;
  }

  function canScroll(el) {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    const overflowY = style.overflowY;
    return (
      /auto|scroll|overlay/.test(overflowY) &&
      el.scrollHeight > el.clientHeight + 8 &&
      el.clientHeight >= 180
    );
  }

  function scrollableAncestors(node) {
    const out = [];
    let current = node instanceof Element ? node.parentElement : null;
    let depth = 0;
    while (current && current !== document.documentElement) {
      if (canScroll(current)) out.push({ el: current, depth });
      current = current.parentElement;
      depth += 1;
    }
    return out;
  }

  function resolveScrollRoot() {
    const sample = [];
    if (state.prompts.length) {
      sample.push(state.prompts[0]);
      if (state.prompts.length > 2) sample.push(state.prompts[Math.floor(state.prompts.length / 2)]);
      if (state.prompts.length > 1) sample.push(state.prompts[state.prompts.length - 1]);
    }

    const scores = new Map();
    for (const prompt of sample) {
      const target = prompt.focus?.isConnected ? prompt.focus : prompt.shell;
      for (const { el, depth } of scrollableAncestors(target)) {
        const item = scores.get(el) || { count: 0, minDepth: Infinity };
        item.count += 1;
        item.minDepth = Math.min(item.minDepth, depth);
        scores.set(el, item);
      }
    }

    if (!scores.size) {
      for (const selector of SELECTORS.composer) {
        const composer = document.querySelector(selector);
        if (!composer) continue;
        for (const { el, depth } of scrollableAncestors(composer)) {
          const item = scores.get(el) || { count: 0, minDepth: Infinity };
          item.count += 1;
          item.minDepth = Math.min(item.minDepth, depth);
          scores.set(el, item);
        }
        if (scores.size) break;
      }
    }

    let best = null;
    let bestScore = -Infinity;
    for (const [el, meta] of scores) {
      const range = Math.max(0, el.scrollHeight - el.clientHeight);
      const score = meta.count * 1_000_000 - meta.minDepth * 10_000 + el.clientHeight + range * 0.001;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    return best || document.scrollingElement || document.documentElement;
  }

  function refreshScrollRoot() {
    const next = resolveScrollRoot();
    const changed = getScrollerElement(next) !== getScrollerElement(state.scrollRoot);
    state.scrollRoot = next;
    if (changed && state.stayEnabled) captureStayAnchor();
    return next;
  }

  function getScrollRoot() {
    const root = state.scrollRoot;
    if (root instanceof Element && root.isConnected) return root;
    return refreshScrollRoot();
  }

  function getScrollTop(root = getScrollRoot()) {
    const scroller = getScrollerElement(root);
    return Number(scroller?.scrollTop || 0);
  }

  function maxScrollTop(root = getScrollRoot()) {
    const scroller = getScrollerElement(root);
    if (!scroller) return 0;
    return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  }

  function setScrollTop(root, top) {
    const scroller = getScrollerElement(root);
    if (!scroller) return;
    state.internalScrollUntil = now() + 80;
    scroller.scrollTop = clamp(top, 0, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
  }

  function viewportMetrics(root = getScrollRoot()) {
    if (isWindowRoot(root)) {
      return { top: 0, height: window.innerHeight || document.documentElement.clientHeight || 1 };
    }
    const rect = root.getBoundingClientRect();
    return { top: rect.top, height: root.clientHeight || rect.height || 1 };
  }

  function elementY(el, root = getScrollRoot()) {
    if (!(el instanceof Element) || !el.isConnected) return null;
    const rect = el.getBoundingClientRect();
    const metrics = viewportMetrics(root);
    return rect.top - metrics.top;
  }

  function promptFocusElement(prompt) {
    if (prompt?.focus instanceof Element && prompt.focus.isConnected) return prompt.focus;
    if (prompt?.shell instanceof Element && prompt.shell.isConnected) return prompt.shell;
    return null;
  }

  function findNearestPromptIndex(root = getScrollRoot()) {
    if (!state.prompts.length) return -1;
    const metrics = viewportMetrics(root);
    const targetY = metrics.height * 0.34;
    let bestIndex = -1;
    let bestDistance = Infinity;

    state.prompts.forEach((prompt, index) => {
      const el = promptFocusElement(prompt);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (!Number.isFinite(rect.top)) return;
      const y = rect.top - metrics.top + Math.min(rect.height, 80) / 2;
      const distance = Math.abs(y - targetY);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    return bestIndex;
  }

  function resolveAnchorElement(anchor) {
    if (!anchor) return null;
    if (anchor.element instanceof Element && anchor.element.isConnected) return anchor.element;

    const prompt = state.prompts.find((item) => item.key === anchor.key);
    if (prompt?.shell?.isConnected) {
      anchor.element = prompt.shell;
      return prompt.shell;
    }
    return null;
  }

  function captureStayAnchor() {
    if (!state.stayEnabled || state.navigationInFlight) return;
    const root = getScrollRoot();
    state.fallbackScrollTop = getScrollTop(root);

    const index = findNearestPromptIndex(root);
    if (index < 0) {
      state.anchor = null;
      return;
    }

    const prompt = state.prompts[index];
    const anchorElement = prompt.shell?.isConnected ? prompt.shell : promptFocusElement(prompt);
    const y = elementY(anchorElement, root);
    if (y == null) {
      state.anchor = null;
      return;
    }

    state.anchor = {
      key: prompt.key,
      element: anchorElement,
      screenY: y,
      fallbackScrollTop: state.fallbackScrollTop
    };
  }

  function maintainStayPosition() {
    if (!state.stayEnabled || state.navigationInFlight) return;
    if (now() < state.userIntentUntil || state.pointerScrolling) return;
    if (now() < state.internalScrollUntil) return;

    const root = getScrollRoot();
    const anchor = state.anchor;
    const anchorEl = resolveAnchorElement(anchor);

    if (anchor && anchorEl) {
      const currentY = elementY(anchorEl, root);
      if (currentY == null) return;
      const delta = currentY - anchor.screenY;
      if (Math.abs(delta) > 0.75) {
        const nextTop = clamp(getScrollTop(root) + delta, 0, maxScrollTop(root));
        setScrollTop(root, nextTop);
        state.fallbackScrollTop = nextTop;
        anchor.fallbackScrollTop = nextTop;
      }
      return;
    }

    const currentTop = getScrollTop(root);
    if (Math.abs(currentTop - state.fallbackScrollTop) > 1) {
      setScrollTop(root, state.fallbackScrollTop);
    }
  }

  function scheduleMaintain() {
    if (!state.stayEnabled || state.maintainRaf) return;
    state.maintainRaf = requestAnimationFrame(() => {
      state.maintainRaf = 0;
      maintainStayPosition();
    });
  }

  function startPeriodicStayCheck() {
    stopPeriodicStayCheck();
    if (!state.stayEnabled) return;
    const tick = () => {
      state.periodicTimer = window.setTimeout(() => {
        scheduleMaintain();
        tick();
      }, PERIODIC_STAY_CHECK_MS);
    };
    tick();
  }

  function stopPeriodicStayCheck() {
    if (state.periodicTimer) window.clearTimeout(state.periodicTimer);
    state.periodicTimer = 0;
  }

  function markUserScrollIntent(ms = USER_SCROLL_GRACE_MS) {
    state.userIntentUntil = Math.max(state.userIntentUntil, now() + ms);
  }

  function scheduleAnchorCaptureAfterUserScroll(delay = 90) {
    if (!state.stayEnabled) return;
    window.clearTimeout(state.userSettleTimer);
    state.userSettleTimer = window.setTimeout(() => {
      if (!state.pointerScrolling && now() >= state.userIntentUntil - 10) {
        captureStayAnchor();
      } else {
        scheduleAnchorCaptureAfterUserScroll(80);
      }
    }, delay);
  }

  function targetTopForElement(el, root) {
    const current = getScrollTop(root);
    const rect = el.getBoundingClientRect();
    const metrics = viewportMetrics(root);
    const yWithinViewport = rect.top - metrics.top;
    const visualHeight = Math.min(rect.height || 0, 120);
    const target = current + yWithinViewport - metrics.height / 2 + visualHeight / 2;
    return clamp(target, 0, maxScrollTop(root));
  }

  function cancelNavigationAnimation() {
    state.navToken += 1;
    if (state.navRaf) cancelAnimationFrame(state.navRaf);
    state.navRaf = 0;
    state.navigationInFlight = false;
  }

  function animateScroll(root, targetTop) {
    cancelNavigationAnimation();
    const token = state.navToken;
    const startTop = getScrollTop(root);
    const distance = targetTop - startTop;
    const absDistance = Math.abs(distance);

    if (absDistance < 8) {
      setScrollTop(root, targetTop);
      return Promise.resolve();
    }

    const duration = clamp(120 + absDistance / 18, 140, 260);
    const started = performance.now();
    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
    state.navigationInFlight = true;

    return new Promise((resolve) => {
      const frame = (ts) => {
        if (token !== state.navToken) {
          state.navigationInFlight = false;
          resolve();
          return;
        }
        const t = clamp((ts - started) / duration, 0, 1);
        setScrollTop(root, startTop + distance * easeOutCubic(t));
        if (t < 1) {
          state.navRaf = requestAnimationFrame(frame);
        } else {
          state.navRaf = 0;
          setScrollTop(root, targetTop);
          state.navigationInFlight = false;
          resolve();
        }
      };
      state.navRaf = requestAnimationFrame(frame);
    });
  }

  async function scrollToPrompt(index) {
    if (!state.prompts.length) return;
    const nextIndex = clamp(index, 0, state.prompts.length - 1);
    const prompt = state.prompts[nextIndex];
    const el = promptFocusElement(prompt);
    if (!el) return;

    const root = refreshScrollRoot();
    state.currentIndex = nextIndex;
    renderActiveState();
    await animateScroll(root, targetTopForElement(el, root));

    state.currentIndex = nextIndex;
    renderActiveState();
    if (state.stayEnabled) captureStayAnchor();
  }

  async function jump(direction) {
    if (!state.prompts.length || state.navigationInFlight) return;
    const root = getScrollRoot();
    let index = state.currentIndex;
    if (index < 0 || index >= state.prompts.length) index = findNearestPromptIndex(root);
    if (index < 0) index = direction > 0 ? -1 : 0;
    await scrollToPrompt(clamp(index + direction, 0, state.prompts.length - 1));
  }

  function updateStayButton() {
    if (!state.ui) return;
    const { stayButton } = state.ui;
    stayButton.textContent = state.stayEnabled ? "Stay" : "Follow";
    stayButton.setAttribute("aria-pressed", String(state.stayEnabled));
    stayButton.dataset.active = state.stayEnabled ? "true" : "false";
    stayButton.title = state.stayEnabled
      ? "Stay is ON: keep the current reading position"
      : "Follow is ON: let ChatGPT control scrolling normally";
  }

  function persistStayState() {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage) return;
    storage.set({ [STORAGE_KEY]: state.stayEnabled });
  }

  function setStayEnabled(enabled, persist = true) {
    state.stayEnabled = Boolean(enabled);
    updateStayButton();
    if (persist) persistStayState();

    if (state.stayEnabled) {
      refreshScrollRoot();
      captureStayAnchor();
      startPeriodicStayCheck();
      scheduleMaintain();
    } else {
      stopPeriodicStayCheck();
      state.anchor = null;
    }
  }

  function buildUI() {
    const existing = document.getElementById(HOST_ID);
    if (existing) existing.remove();

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.position = "fixed";
    host.style.right = "16px";
    host.style.bottom = "16px";
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "auto";

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .panel {
          width: 246px;
          max-width: min(246px, calc(100vw - 24px));
          padding: 8px;
          border: 1px solid rgba(255,255,255,.12);
          border-radius: 14px;
          background: rgba(23,23,23,.88);
          color: #f7f7f7;
          box-shadow: 0 12px 34px rgba(0,0,0,.26);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          font: 12px/1.3 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 2px 4px 7px;
          color: rgba(255,255,255,.78);
          user-select: none;
        }
        .title { font-weight: 650; letter-spacing: .01em; }
        .count { font-variant-numeric: tabular-nums; opacity: .72; }
        .toc {
          display: flex;
          flex-direction: column;
          gap: 4px;
          max-height: min(260px, 42vh);
          overflow-y: auto;
          overscroll-behavior: contain;
          scrollbar-width: thin;
          padding-right: 2px;
        }
        .empty {
          padding: 9px 8px;
          border-radius: 8px;
          color: rgba(255,255,255,.58);
          background: rgba(255,255,255,.04);
        }
        button {
          appearance: none;
          border: 1px solid rgba(255,255,255,.10);
          color: #fff;
          background: rgba(255,255,255,.055);
          font: inherit;
          cursor: pointer;
        }
        button:hover { background: rgba(255,255,255,.12); }
        button:focus-visible { outline: 2px solid rgba(142,198,255,.9); outline-offset: 1px; }
        .toc-item {
          width: 100%;
          min-height: 30px;
          padding: 6px 8px;
          border-radius: 8px;
          text-align: left;
          line-height: 1.28;
          opacity: .9;
        }
        .toc-item[data-active="true"] {
          background: rgba(255,255,255,.17);
          border-color: rgba(255,255,255,.24);
          opacity: 1;
        }
        .controls {
          display: grid;
          grid-template-columns: 1fr 1fr 1.22fr;
          gap: 6px;
          margin-top: 8px;
        }
        .control {
          height: 36px;
          border-radius: 9px;
          font-weight: 650;
        }
        .stay[data-active="true"] {
          background: rgba(68,153,104,.28);
          border-color: rgba(111,209,151,.34);
        }
        @media (prefers-color-scheme: light) {
          .panel {
            border-color: rgba(0,0,0,.11);
            background: rgba(250,250,250,.92);
            color: #171717;
            box-shadow: 0 12px 34px rgba(0,0,0,.16);
          }
          .header { color: rgba(0,0,0,.64); }
          .empty { color: rgba(0,0,0,.55); background: rgba(0,0,0,.04); }
          button { color: #171717; border-color: rgba(0,0,0,.10); background: rgba(0,0,0,.045); }
          button:hover { background: rgba(0,0,0,.09); }
          .toc-item[data-active="true"] { background: rgba(0,0,0,.10); border-color: rgba(0,0,0,.18); }
          .stay[data-active="true"] { background: rgba(32,137,77,.13); border-color: rgba(32,137,77,.28); }
        }
      </style>
      <div class="panel" role="navigation" aria-label="ChatGPT prompt navigator">
        <div class="header"><span class="title">Prompts</span><span class="count">0</span></div>
        <div class="toc"></div>
        <div class="controls">
          <button type="button" class="control previous" title="Previous prompt (Alt+Up)" aria-label="Previous prompt">▲</button>
          <button type="button" class="control next" title="Next prompt (Alt+Down)" aria-label="Next prompt">▼</button>
          <button type="button" class="control stay" title="Toggle Stay / Follow (Alt+L)" aria-label="Toggle Stay or Follow"></button>
        </div>
      </div>
    `;

    const toc = shadow.querySelector(".toc");
    const count = shadow.querySelector(".count");
    const previousButton = shadow.querySelector(".previous");
    const nextButton = shadow.querySelector(".next");
    const stayButton = shadow.querySelector(".stay");

    previousButton.addEventListener("click", () => void jump(-1));
    nextButton.addEventListener("click", () => void jump(1));
    stayButton.addEventListener("click", () => setStayEnabled(!state.stayEnabled, true));

    document.documentElement.appendChild(host);
    state.ui = { host, shadow, toc, count, previousButton, nextButton, stayButton };
    updateStayButton();
  }

  function promptSignature(prompts) {
    return prompts.map((prompt) => `${prompt.key}\u0000${prompt.text}`).join("\n");
  }

  let lastRenderedSignature = "";

  function renderTOC(force = false) {
    if (!state.ui) return;
    const signature = promptSignature(state.prompts);
    if (!force && signature === lastRenderedSignature) {
      renderActiveState();
      return;
    }
    lastRenderedSignature = signature;

    const { toc, count } = state.ui;
    count.textContent = String(state.prompts.length);
    toc.replaceChildren();

    if (!state.prompts.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No user prompts detected";
      toc.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    state.prompts.forEach((prompt, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "toc-item";
      button.dataset.index = String(index);
      button.dataset.active = "false";
      button.textContent = `${index + 1}. ${truncate(prompt.text)}`;
      button.title = prompt.text || `Prompt ${index + 1}`;
      button.addEventListener("click", () => void scrollToPrompt(index));
      frag.appendChild(button);
    });
    toc.appendChild(frag);
    renderActiveState();
  }

  function renderActiveState() {
    if (!state.ui || !state.prompts.length) return;
    const items = state.ui.toc.querySelectorAll(".toc-item");
    items.forEach((item, index) => {
      item.dataset.active = index === state.currentIndex ? "true" : "false";
    });

    const active = state.ui.toc.querySelector(`.toc-item[data-index="${state.currentIndex}"]`);
    if (active && state.ui.toc.matches(":hover") === false) {
      const top = active.offsetTop;
      const bottom = top + active.offsetHeight;
      if (top < state.ui.toc.scrollTop) state.ui.toc.scrollTop = top;
      else if (bottom > state.ui.toc.scrollTop + state.ui.toc.clientHeight) {
        state.ui.toc.scrollTop = bottom - state.ui.toc.clientHeight;
      }
    }
  }

  function updateActiveSoon() {
    if (state.highlightRaf) return;
    state.highlightRaf = requestAnimationFrame(() => {
      state.highlightRaf = 0;
      if (!state.prompts.length || state.navigationInFlight) return;
      const index = findNearestPromptIndex(getScrollRoot());
      if (index >= 0 && index !== state.currentIndex) {
        state.currentIndex = index;
        renderActiveState();
      }
    });
  }

  function resetForRoute(nextRoute) {
    cancelNavigationAnimation();
    state.routeKey = nextRoute;
    state.prompts = [];
    state.promptCache.clear();
    state.ephemeralIds = new WeakMap();
    state.nextEphemeralId = 1;
    state.currentIndex = -1;
    state.scrollRoot = null;
    state.anchor = null;
    state.fallbackScrollTop = 0;
    lastRenderedSignature = "";
    renderTOC(true);
  }

  function scanNow() {
    state.scanTimer = 0;
    const nextRoute = routeKey();
    if (nextRoute !== state.routeKey) resetForRoute(nextRoute);

    const previous = state.prompts;
    const next = collectPrompts();
    const same =
      previous.length === next.length &&
      previous.every((item, index) => item.key === next[index].key && item.text === next[index].text);

    state.prompts = next;
    refreshScrollRoot();

    if (!same) {
      const activeKey = previous[state.currentIndex]?.key;
      const newIndex = activeKey ? next.findIndex((item) => item.key === activeKey) : -1;
      state.currentIndex = newIndex >= 0 ? newIndex : findNearestPromptIndex(getScrollRoot());
      renderTOC(true);
      if (state.stayEnabled && now() >= state.userIntentUntil) captureStayAnchor();
    } else {
      renderTOC(false);
    }

    updateActiveSoon();
    scheduleMaintain();
  }

  function scheduleScan(delay = SCAN_DELAY_MS) {
    if (state.scanTimer) return;
    state.scanTimer = window.setTimeout(scanNow, delay);
  }

  function isRootScrollEvent(event) {
    const root = getScrollRoot();
    if (isWindowRoot(root)) {
      return (
        event.target === document ||
        event.target === document.documentElement ||
        event.target === document.body
      );
    }
    return event.target === root;
  }

  function installObservers() {
    state.observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const mutation of mutations) {
        if (mutation.type === "childList" || mutation.type === "attributes") {
          shouldScan = true;
          break;
        }
      }
      if (shouldScan) scheduleScan();
      scheduleMaintain();
    });

    state.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "data-turn-key",
        "data-turn-id",
        "data-testid",
        "data-turn",
        "data-user-message-bubble",
        "data-message-author-role",
        "data-conversation-role",
        "data-role",
        "data-message-author"
      ]
    });

    window.addEventListener(
      "scroll",
      (event) => {
        if (!isRootScrollEvent(event)) return;
        updateActiveSoon();
        if (!state.stayEnabled || state.navigationInFlight) return;
        if (now() < state.internalScrollUntil) return;

        if (state.pointerScrolling || now() < state.userIntentUntil) {
          markUserScrollIntent();
          state.fallbackScrollTop = getScrollTop(getScrollRoot());
          scheduleAnchorCaptureAfterUserScroll();
        } else {
          scheduleMaintain();
        }
      },
      true
    );

    window.addEventListener(
      "wheel",
      (event) => {
        if (isExtensionEvent(event)) return;
        markUserScrollIntent(360);
        scheduleAnchorCaptureAfterUserScroll();
      },
      { capture: true, passive: true }
    );

    window.addEventListener(
      "touchstart",
      (event) => {
        if (isExtensionEvent(event)) return;
        state.pointerScrolling = true;
        markUserScrollIntent(500);
      },
      { capture: true, passive: true }
    );

    window.addEventListener(
      "touchmove",
      (event) => {
        if (isExtensionEvent(event)) return;
        state.pointerScrolling = true;
        markUserScrollIntent(500);
        scheduleAnchorCaptureAfterUserScroll();
      },
      { capture: true, passive: true }
    );

    window.addEventListener(
      "touchend",
      () => {
        state.pointerScrolling = false;
        markUserScrollIntent(120);
        scheduleAnchorCaptureAfterUserScroll(130);
      },
      true
    );

    window.addEventListener(
      "pointerdown",
      (event) => {
        if (isExtensionEvent(event)) return;
        if (event.pointerType === "mouse" && event.button !== 0) return;
        state.pointerScrolling = true;
        markUserScrollIntent(500);
      },
      true
    );

    window.addEventListener(
      "pointermove",
      (event) => {
        if (!state.pointerScrolling || isExtensionEvent(event)) return;
        markUserScrollIntent(300);
      },
      { capture: true, passive: true }
    );

    const finishPointer = () => {
      if (!state.pointerScrolling) return;
      state.pointerScrolling = false;
      markUserScrollIntent(120);
      scheduleAnchorCaptureAfterUserScroll(130);
    };
    window.addEventListener("pointerup", finishPointer, true);
    window.addEventListener("pointercancel", finishPointer, true);

    window.addEventListener(
      "keydown",
      (event) => {
        if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
          if (event.key === "ArrowUp") {
            event.preventDefault();
            void jump(-1);
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            void jump(1);
            return;
          }
          if (event.key.toLowerCase() === "l") {
            event.preventDefault();
            setStayEnabled(!state.stayEnabled, true);
            return;
          }
        }

        if (isEditableTarget(event.target)) return;
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
          markUserScrollIntent(420);
          scheduleAnchorCaptureAfterUserScroll();
        }
      },
      true
    );

    window.addEventListener("resize", () => {
      refreshScrollRoot();
      updateActiveSoon();
      if (state.stayEnabled) captureStayAnchor();
    }, { passive: true });

    window.addEventListener("popstate", () => scheduleScan(0), true);
    window.addEventListener("hashchange", () => scheduleScan(0), true);

    state.routeTimer = window.setInterval(() => {
      if (routeKey() !== state.routeKey) scheduleScan(0);
    }, 700);
  }

  function loadPreferenceAndStart() {
    state.routeKey = routeKey();
    buildUI();
    installObservers();

    const storage = globalThis.chrome?.storage?.local;
    if (!storage) {
      scanNow();
      return;
    }

    storage.get([STORAGE_KEY], (result) => {
      state.stayEnabled = Boolean(result?.[STORAGE_KEY]);
      updateStayButton();
      scanNow();
      if (state.stayEnabled) {
        captureStayAnchor();
        startPeriodicStayCheck();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", loadPreferenceAndStart, { once: true });
  } else {
    loadPreferenceAndStart();
  }
})();
