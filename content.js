(() => {
  'use strict';
  if (globalThis.__CGNavV3) return;
  globalThis.__CGNavV3 = true;
  const S = globalThis.CGNavScroll;
  if (!S) return;
  const VERSION = '3.0.0';
  const HOST = 'chatgpt-navigator-v3';
  const PREF = 'cgnV3StayEnabled'; // Do not carry a v2 hold into the first v3 run.
  const USER = '[data-user-message-bubble], [data-message-author-role="user"], section[data-turn="user"], [data-conversation-role="user"], [data-role="user"], [data-message-author="user"]';
  const SHELL = '[data-turn-key], section[data-turn], [data-testid^="conversation-turn-"]';
  const state = {
    route: location.pathname, prompts: [], cache: new Map(), current: -1,
    stay: false, anchor: null, nav: null, navSeq: 0, captureTimer: 0,
    userUntil: 0, dragging: false, internalUntil: 0, scanTimer: 0, frame: 0,
    lastJump: null, jumpSeq: 0, traceTimers: [], observations: [], ui: null,
    nodeIds: new WeakMap(), nextNodeId: 1, corrections: [],
    pageCount: 0, scanCount: 0
  };
  const time = () => performance.now();
  const normal = text => (text || '').replace(/\s+/g, ' ').trim();
  const isEl = x => x instanceof Element;
  const rounded = n => Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  const id = node => {
    if (!node || typeof node !== 'object') return null;
    if (!state.nodeIds.has(node)) state.nodeIds.set(node, `e${state.nextNodeId++}`);
    return state.nodeIds.get(node);
  };
  const inUI = e => e.composedPath?.().includes(state.ui?.host);
  const editable = el => isEl(el) && !!el.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]');
  const status = text => { if (state.ui) state.ui.status.textContent = text; };

  function userIn(node) {
    // Prefer the actual user bubble over a role-bearing outer turn shell.
    for (const selector of ['[data-user-message-bubble]', '[data-message-author-role="user"]',
      '[data-conversation-role="user"]', '[data-role="user"]', '[data-message-author="user"]']) {
      if (node.matches(selector)) return node;
      const found = node.querySelector(selector);
      if (found) return found;
    }
    return node.matches('section[data-turn="user"]') ? node : node.querySelector('section[data-turn="user"]');
  }
  function shellOf(node) {
    return node.closest('[data-turn-key]') || node.closest('section[data-turn]') ||
      node.closest('[data-testid^="conversation-turn-"]') || node;
  }
  function keyFor(shell, marker) {
    for (const node of [shell, marker].filter(Boolean)) {
      for (const attr of ['data-turn-key', 'data-turn-id', 'data-message-id', 'data-testid']) {
        const value = node.getAttribute(attr);
        if (value) return `${attr}:${value}`;
      }
    }
    return `node:${id(shell)}`;
  }
  function promptText(marker) {
    if (!marker) return '';
    const inner = marker.querySelector('.whitespace-pre-wrap,[data-message-content="user"],[data-message-text]');
    // textContent avoids forcing layout of content-visibility-skipped messages.
    return normal((inner || marker).textContent);
  }

  function collect() {
    const map = new Map();
    function add(shell, marker) {
      if (!shell.isConnected || shell.closest('[hidden],[aria-hidden="true"]')) return;
      const key = keyFor(shell, marker);
      const cached = state.cache.get(key);
      if (!marker && shell.getAttribute('data-turn') !== 'user' && !cached) return;
      const text = promptText(marker) || cached?.text || '';
      const record = {key, shell, marker, text};
      const existing = map.get(key);
      if (!existing || (!existing.marker && marker)) map.set(key, record);
    }
    // Keep persistent shells even while their previously seen text is unmounted.
    document.querySelectorAll(SHELL).forEach(shell => {
      const canonical = shellOf(shell);
      if (canonical !== shell) return;
      const marker = userIn(shell);
      add(shell, marker);
    });
    document.querySelectorAll(USER).forEach(marker => add(shellOf(marker), marker));
    const result = [...map.values()].sort((a, b) => {
      const p = a.shell.compareDocumentPosition(b.shell);
      return p & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : p & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
    });
    // Cache only the current set of persistent shells: no ghost entries on branch/edit.
    state.cache = new Map(result.map(p => [p.key, {text: p.text}]));
    return result;
  }

  function resolve(key) {
    const record = state.prompts.find(p => p.key === key);
    if (!record?.shell?.isConnected) return null;
    const marker = userIn(record.shell);
    if (marker?.isConnected && marker.getBoundingClientRect().height > 0) return marker;
    return record.shell.getBoundingClientRect().height > 0 ? record.shell : null;
  }

  function nearest() {
    let best = -1, distance = Infinity;
    state.prompts.forEach((record, index) => {
      const node = resolve(record.key);
      if (!node) return;
      const root = S.rootFor(node);
      const p = S.position(node, root);
      const d = Math.abs(p.top - p.viewport * 0.22);
      if (d < distance) { best = index; distance = d; }
    });
    return best;
  }

  function describe(node) {
    if (!isEl(node)) return {node: id(node), kind: node === document ? 'document' : 'other'};
    return {node: id(node), tag: node.localName,
      composer: node.id === 'prompt-textarea' || editable(node),
      extensionUI: node === state.ui?.host || node.getRootNode() === state.ui?.shadow};
  }
  function activeDescription() {
    let node = document.activeElement;
    while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
    return describe(node);
  }
  function observe(kind, extra = {}) {
    const report = state.lastJump;
    if (!report || time() > report.started + 2400) return;
    state.observations.push({ms: rounded(time() - report.started), kind, ...extra});
    if (state.observations.length > 120) state.observations.shift();
  }
  function sample(label) {
    const report = state.lastJump;
    if (!report) return;
    const node = resolve(report.key);
    const root = node ? S.rootFor(node) : report.root;
    const connected = !!root?.isConnected;
    const pos = node && connected ? S.position(node, root) : null;
    report.samples.push({ms: rounded(time() - report.started), label,
      root: describe(root), connected,
      model: connected ? S.model(root) : null,
      target: node ? describe(node) : null,
      geometry: pos ? {top: rounded(pos.top), height: rounded(pos.height),
        contentTop: rounded(pos.contentTop), viewport: rounded(pos.viewport)} : null,
      active: activeDescription(), stay: state.stay,
      ownScrollWrites: report.writes.length});
    if (report.samples.length > 30) report.samples.shift();
  }
  function write(root, value, reason) {
    state.internalUntil = time() + 45;
    const result = S.write(root, value);
    const report = state.lastJump;
    if (report && time() <= report.started + 2400) {
      report.writes.push({ms: rounded(time() - report.started), reason, root: id(root),
        before: rounded(result.before), requested: rounded(result.requested), actual: rounded(result.actual)});
      if (report.writes.length > 80) report.writes.shift();
    }
    return result;
  }

  function stopNav(reason) {
    state.navSeq++;
    const nav = state.nav;
    state.nav = null;
    nav?.timers.forEach(clearTimeout);
    if (nav && reason) observe('navigation-cancelled', {reason});
  }

  function jumpTo(key) {
    ensureRoute();
    scan();
    const index = state.prompts.findIndex(p => p.key === key);
    const node = resolve(key);
    stopNav('new-navigation');
    state.traceTimers.forEach(clearTimeout);
    state.traceTimers = [];
    if (index < 0 || !node) {
      state.observations = [];
      state.lastJump = {id: ++state.jumpSeq, key,
        root: index >= 0 ? S.rootFor(state.prompts[index].shell) : null,
        started: time(), promptIndex: index + 1, promptCount: state.prompts.length,
        writes: [], samples: [], inputInterrupted: false, outcome: 'target-unmounted'};
      sample('target-unavailable');
      status('対象の表示領域が未読込です。会話を少しスクロールして再試行してください。');
      return;
    }
    const root = S.rootFor(node);
    const initial = S.position(node, root);
    const token = state.navSeq;
    const report = state.lastJump = {id: ++state.jumpSeq, key, root, started: time(),
      promptIndex: index + 1, promptCount: state.prompts.length, writes: [], samples: [],
      inputInterrupted: false, outcome: 'observing'};
    state.observations = [];
    state.anchor = null; // A jump must not compete with the previous Stay anchor.
    clearTimeout(state.captureTimer);
    state.current = index;
    const nav = state.nav = {token, key, root, timers: [], contentTop: initial.contentTop, corrections: 0};
    renderActive();
    sample('before-navigation');
    write(root, S.target(node, root), 'navigate-signed');
    sample('after-navigation');
    status(`${index + 1} / ${state.prompts.length} へ移動`);

    // A small bounded layout-settle phase, NOT a contest with page scroll writes.
    // Only a content-relative geometry change permits a correction. A pure page
    // scroll leaves contentTop unchanged, so Follow never chases it back.
    for (const delay of [80, 220]) {
      nav.timers.push(setTimeout(() => {
        if (state.nav !== nav || token !== state.navSeq || state.route !== location.pathname) return;
        const target = resolve(key);
        if (!target || S.rootFor(target) !== root || !root.isConnected) return;
        const pos = S.position(target, root);
        if (Math.abs(pos.contentTop - nav.contentTop) > 1 && nav.corrections < 2) {
          nav.contentTop = pos.contentTop;
          nav.corrections++;
          write(root, S.target(target, root), 'layout-change-only');
        }
        sample(`layout-check-${delay}`);
      }, delay));
    }
    nav.timers.push(setTimeout(() => {
      if (state.nav !== nav || token !== state.navSeq) return;
      state.nav = null;
      if (state.stay) captureAnchor();
    }, 260));
    for (const delay of [450, 1200, 2200]) {
      state.traceTimers.push(setTimeout(() => {
        if (state.lastJump !== report) return;
        sample(`observe-only-${delay}`);
        if (delay !== 1200) return;
        const target = resolve(key);
        const p = target && root.isConnected ? S.position(target, root) : null;
        report.outcome = report.inputInterrupted ? 'user-input-interrupted'
          : !p ? 'target-unmounted'
          : p.top < p.viewport && p.top + p.height > 0 ? 'target-visible'
          : 'target-outside-viewport';
        if (report.outcome === 'target-outside-viewport') {
          status('対象が画面外です。「診断をコピー」で移動記録を確認できます。');
        }
      }, delay));
    }
  }

  function jumpRelative(direction) {
    ensureRoute(); scan();
    if (!state.prompts.length) return;
    const current = state.current >= 0 ? state.current : nearest();
    const next = Math.max(0, Math.min(state.prompts.length - 1, current + direction));
    jumpTo(state.prompts[next].key);
  }

  function captureAnchor() {
    clearTimeout(state.captureTimer);
    if (!state.stay || state.nav || state.dragging) return;
    const index = nearest();
    const record = state.prompts[index];
    const node = record && resolve(record.key);
    if (!node) { state.anchor = null; return; }
    const root = S.rootFor(node);
    const position = S.position(node, root);
    state.anchor = {key: record.key, root, top: position.top, contentTop: position.contentTop};
    state.corrections = [];
  }
  function captureWhenSettled() {
    clearTimeout(state.captureTimer);
    if (!state.stay) return;
    state.captureTimer = setTimeout(() => {
      if (state.dragging || time() < state.userUntil) captureWhenSettled();
      else captureAnchor();
    }, 120);
  }
  function keepAnchor() {
    if (!state.stay || state.nav || state.dragging || time() < state.userUntil ||
        time() < state.internalUntil || !state.anchor) return;
    const anchor = state.anchor;
    const node = resolve(anchor.key);
    if (!node) return; // Do not substitute an unrelated stale numeric offset.
    const root = S.rootFor(node);
    if (root !== anchor.root || !root.isConnected) {
      state.anchor = null;
      status('表示領域が変わったため、Stay位置を解除しました。');
      return;
    }
    const position = S.position(node, root);
    const layoutChanged = Math.abs(position.contentTop - anchor.contentTop) > 1;
    anchor.contentTop = position.contentTop;
    const delta = position.top - anchor.top;
    if (Math.abs(delta) < 1.25) return;
    // Distinguish benign streaming layout changes from competing scroll writes.
    // A changing content origin (normal in column-reverse) is NOT a conflict.
    state.corrections = state.corrections.filter(t => time() - t < 1200);
    if (!layoutChanged && state.corrections.length >= 8) {
      setStay(false);
      status('Stayの競合を検出しFollowに戻しました。診断をコピーできます。');
      observe('stay-suspended-conflict');
      return;
    }
    if (!layoutChanged) state.corrections.push(time());
    write(root, root.scrollTop + delta, 'stay-anchor-signed');
  }
  function setStay(enabled) {
    state.stay = !!enabled;
    state.anchor = null;
    clearTimeout(state.captureTimer);
    state.corrections = [];
    renderStay();
    if (state.stay) captureAnchor();
    try { globalThis.chrome?.storage?.local?.set({[PREF]: state.stay}, () => {
      void globalThis.chrome?.runtime?.lastError;
    }); } catch (_) { /* Extension may have been reloaded while the tab is open. */ }
    status(state.stay ? 'Stay：読んでいる位置を保持します' : 'Follow：位置の固定はしません');
  }

  function userScroll(event) {
    if (inUI(event) || !event.isTrusted) return;
    stopNav('user-input');
    if (state.lastJump && time() < state.lastJump.started + 2400) state.lastJump.inputInterrupted = true;
    state.userUntil = time() + 260;
    state.anchor = null;
    observe('user-scroll-input', {type: event.type});
    captureWhenSettled();
  }
  function scheduleFrame() {
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      if (!state.nav) {
        const index = nearest();
        if (index !== state.current) { state.current = index; renderActive(); }
      }
      keepAnchor();
    });
  }

  function ensureRoute() {
    if (state.route === location.pathname) return;
    stopNav('route-change');
    state.traceTimers.forEach(clearTimeout);
    state.traceTimers = [];
    state.lastJump = null;
    state.observations = [];
    state.route = location.pathname;
    state.prompts = []; state.cache.clear(); state.anchor = null; state.current = -1;
    state.corrections = [];
    state.pageCount++;
    // Keep the preference, but never restore a numeric position into another chat.
    status('会話が切り替わりました');
  }
  function scan() {
    clearTimeout(state.scanTimer); state.scanTimer = 0;
    ensureRoute();
    state.scanCount++;
    const old = state.prompts;
    const key = old[state.current]?.key;
    state.prompts = collect();
    const changed = old.length !== state.prompts.length ||
      old.some((p, i) => p.key !== state.prompts[i]?.key || p.text !== state.prompts[i]?.text);
    if (changed) {
      state.current = key ? state.prompts.findIndex(p => p.key === key) : nearest();
      renderList();
    }
    // Do not silently overwrite an existing Stay anchor on every DOM mutation.
    if (state.stay && !state.anchor && !state.nav && !state.dragging && time() >= state.userUntil) captureAnchor();
    scheduleFrame();
  }
  function scheduleScan() {
    if (!state.scanTimer) state.scanTimer = setTimeout(scan, 180);
  }

  function renderStay() {
    state.ui.stay.textContent = state.stay ? 'Stay' : 'Follow';
    state.ui.stay.setAttribute('aria-pressed', String(state.stay));
  }
  function renderList() {
    const {toc, count} = state.ui;
    count.textContent = `${state.prompts.length}件`;
    const oldScroll = toc.scrollTop;
    const fragment = document.createDocumentFragment();
    for (const [index, record] of state.prompts.entries()) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'item'; b.dataset.index = String(index);
      b.textContent = `${index + 1}. ${record.text ? record.text.slice(0, 58) + (record.text.length > 58 ? '…' : '') : '質問（本文未表示）'}`;
      b.title = record.text || '本文は会話内で表示されたときに取得します';
      b.addEventListener('click', () => jumpTo(record.key));
      fragment.appendChild(b);
    }
    if (!state.prompts.length) {
      const empty = document.createElement('div'); empty.className = 'empty';
      empty.textContent = '表示中の会話から質問を探しています'; fragment.appendChild(empty);
    }
    toc.replaceChildren(fragment); toc.scrollTop = oldScroll;
    renderActive();
  }
  function renderActive() {
    state.ui.toc.querySelectorAll('.item').forEach((b, index) => {
      b.setAttribute('aria-current', index === state.current ? 'true' : 'false');
    });
    state.ui.previous.disabled = state.current <= 0 || !state.prompts.length;
    state.ui.next.disabled = state.current >= state.prompts.length - 1 || !state.prompts.length;
    const current = state.ui.toc.querySelector('[aria-current="true"]');
    if (current && !state.ui.toc.matches(':hover')) {
      // Scroll only our TOC; never call scrollIntoView on a floating control.
      const r = current.getBoundingClientRect(), t = state.ui.toc.getBoundingClientRect();
      if (r.top < t.top) state.ui.toc.scrollTop += r.top - t.top;
      else if (r.bottom > t.bottom) state.ui.toc.scrollTop += r.bottom - t.bottom;
    }
  }

  function diagnosticReport() {
    const report = state.lastJump;
    if (report) sample('copy-request');
    return {extension: VERSION, kind: 'signed-scroll-diagnostic',
      privacy: 'No conversation text, inputs, turn IDs, URLs, cookies, or tokens are included.',
      scope: 'DOM geometry and this extension writes only. Other scripts are not intercepted; observed changes do not identify their author.',
      promptCount: state.prompts.length, stay: state.stay,
      oldWidgetDetected: !!document.querySelector('#chatgpt-nav-widget,#chatgpt-navigator-stay-v2'),
      browser: navigator.userAgent.match(/(?:Chrome|Chromium)\/[\d.]+/)?.[0] || 'unknown',
      viewport: {width: innerWidth, height: innerHeight, devicePixelRatio},
      lastJump: report ? {id: report.id, promptIndex: report.promptIndex,
        promptCount: report.promptCount, outcome: report.outcome,
        inputInterrupted: report.inputInterrupted, writes: report.writes, samples: report.samples,
        observations: state.observations} : null};
  }
  async function copyDiagnostic() {
    const text = JSON.stringify(diagnosticReport(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      status('診断をコピーしました（会話本文・URLは含みません）');
    } catch (_) {
      // No clipboard permission request: provide a selectable local fallback.
      state.ui.dump.hidden = false;
      state.ui.dump.value = text;
      state.ui.dump.focus({preventScroll: true});
      state.ui.dump.select();
      status('下の診断欄を Ctrl/Cmd+C でコピーしてください');
    }
  }

  function buildUI() {
    document.getElementById(HOST)?.remove();
    const host = document.createElement('div'); host.id = HOST;
    const shadow = host.attachShadow({mode: 'open'});
    const style = document.createElement('style');
    style.textContent = `
      :host{all:initial;position:fixed!important;right:16px!important;bottom:16px!important;z-index:2147483647!important;font:12px/1.5 system-ui,sans-serif;color-scheme:light dark}
      *{box-sizing:border-box}.panel{width:252px;max-width:calc(100vw - 32px);padding:10px;border-radius:12px;border:1px solid #73737366;background:light-dark(#fafafa,#202124);color:light-dark(#202124,#eee);box-shadow:0 8px 28px #0003}
      header{display:flex;justify-content:space-between;gap:8px;margin-bottom:8px}.count{opacity:.65}.toc{max-height:min(38vh,280px);overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;display:flex;flex-direction:column;gap:4px}
      button{font:inherit;color:inherit;background:transparent;border:1px solid #73737355;border-radius:7px;cursor:pointer;padding:6px 8px}button:hover{background:#8882}button:focus-visible{outline:2px solid #5c9aff;outline-offset:1px}button:disabled{opacity:.4;cursor:default}
      .item{text-align:left;flex:none;width:100%;overflow-wrap:anywhere}.item[aria-current=true]{background:#8883;border-color:#888b}.controls{display:grid;grid-template-columns:1fr 1fr 1.2fr;gap:6px;margin-top:9px}.stay[aria-pressed=true]{background:#27845333}.status{font-size:11px;opacity:.75;margin-top:8px;overflow-wrap:anywhere}.diagnostic{width:100%;font-size:11px;margin-top:7px;padding:4px}textarea{width:100%;height:120px;margin-top:6px;font-size:10px}.empty{padding:10px;opacity:.7}
    `;
    const panel = document.createElement('nav'); panel.className = 'panel';
    panel.setAttribute('aria-label', 'ChatGPT 質問ナビゲーター');
    const header = document.createElement('header');
    const title = document.createElement('strong'); title.textContent = 'Navigator 3.0';
    const count = document.createElement('span'); count.className = 'count';
    header.append(title, count);
    const toc = document.createElement('div'); toc.className = 'toc';
    const controls = document.createElement('div'); controls.className = 'controls';
    const button = (text, cls, label, click) => {
      const el = document.createElement('button'); el.type = 'button'; el.className = cls;
      el.textContent = text; el.title = label; el.setAttribute('aria-label', label);
      el.addEventListener('click', click); return el;
    };
    const previous = button('▲','previous','前の質問（Alt+↑）', () => jumpRelative(-1));
    const next = button('▼','next','次の質問（Alt+↓）', () => jumpRelative(1));
    const stay = button('Follow','stay','Stay / Follow（Alt+L）', () => setStay(!state.stay));
    controls.append(previous, next, stay);
    const statusNode = document.createElement('div'); statusNode.className = 'status';
    statusNode.setAttribute('role', 'status'); statusNode.textContent = 'Follow：位置の固定はしません';
    const diagnostic = button('診断をコピー','diagnostic','会話本文を含まない移動記録をコピー', copyDiagnostic);
    const dump = document.createElement('textarea'); dump.hidden = true; dump.readOnly = true;
    dump.setAttribute('aria-label','診断テキスト');
    panel.append(header,toc,controls,statusNode,diagnostic,dump); shadow.append(style,panel);
    for (const type of ['click','pointerdown','pointerup','mousedown','mouseup']) {
      shadow.addEventListener(type, event => event.stopPropagation());
    }
    // Prevent button mousedown from taking the composer's focus; keyboard focus remains accessible.
    shadow.addEventListener('mousedown', event => {
      if (event.button === 0 && isEl(event.target) && event.target.closest('button')) event.preventDefault();
    });
    document.documentElement.appendChild(host);
    state.ui = {host,shadow,toc,count,previous,next,stay,status:statusNode,dump};
    renderStay(); renderList();
  }

  function install() {
    const observer = new MutationObserver(mutations => {
      if (mutations.some(m => m.target !== state.ui.host)) scheduleScan();
      scheduleFrame();
    });
    observer.observe(document.body || document.documentElement, {subtree:true,childList:true,characterData:true,
      attributes:true,attributeFilter:['data-turn-key','data-turn','data-testid','data-message-author-role','hidden']});
    window.addEventListener('scroll', e => {
      if (inUI(e)) return;
      const target = e.target === document ? S.docRoot() : e.target;
      observe('scroll-observed', {target: describe(target), scrollTop: isEl(target) ? rounded(target.scrollTop) : null});
      if (state.dragging || time() < state.userUntil) {
        state.userUntil = Math.max(state.userUntil, time() + 100); captureWhenSettled();
      }
      scheduleFrame();
    }, {capture:true,passive:true});
    window.addEventListener('wheel', e => { if (e.deltaY) userScroll(e); }, {capture:true,passive:true});
    window.addEventListener('touchstart', e => {
      if (!inUI(e)) { state.dragging = true; userScroll(e); }
    }, {capture:true,passive:true});
    window.addEventListener('touchmove', userScroll, {capture:true,passive:true});
    const finish = () => {
      if (!state.dragging) return;
      state.dragging = false; state.userUntil = time() + 120; captureWhenSettled();
    };
    window.addEventListener('touchend',finish,{capture:true,passive:true});
    window.addEventListener('touchcancel',finish,{capture:true,passive:true});
    window.addEventListener('pointerdown', e => {
      if (inUI(e) || e.button !== 0 || !e.isTrusted) return;
      const current = state.prompts[state.current]; const node = current && resolve(current.key);
      if (!node) return;
      const root = S.rootFor(node), view = S.viewport(root);
      const inScrollbar = e.clientX >= view.left + view.width - 17 && e.clientX <= view.left + view.width + 20;
      if (inScrollbar) { state.dragging = true; userScroll(e); }
    }, {capture:true,passive:true});
    window.addEventListener('pointerup',finish,{capture:true,passive:true});
    window.addEventListener('pointercancel',finish,{capture:true,passive:true});
    window.addEventListener('keydown', e => {
      if (e.isComposing) return;
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (['ArrowUp','ArrowDown'].includes(e.key)) {
          e.preventDefault(); e.stopPropagation(); jumpRelative(e.key === 'ArrowUp' ? -1 : 1); return;
        }
        if (e.key.toLowerCase() === 'l') {
          e.preventDefault(); e.stopPropagation(); setStay(!state.stay); return;
        }
      }
      if (!editable(e.target) && ['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(e.key)) userScroll(e);
    }, true);
    window.addEventListener('focusin', e => {
      observe('focus-observed',{target:describe(e.composedPath?.()[0] || e.target)});
    }, true);
    window.addEventListener('resize', () => { scheduleScan(); scheduleFrame(); },{passive:true});
    window.addEventListener('popstate', scheduleScan, true);
    // Passive health/SPA check. In Follow this timer NEVER writes scroll positions.
    setInterval(() => {
      if (state.route !== location.pathname) scan();
      if (state.stay) keepAnchor();
      if (!state.ui.host.isConnected) {
        stopNav('ui-removed'); state.anchor=null; buildUI(); renderList();
      }
    }, 250);
  }

  buildUI(); install(); scan();
  if (document.querySelector('#chatgpt-nav-widget,#chatgpt-navigator-stay-v2')) {
    status('旧版のUIも検出しました。旧版を無効にしてタブを再読込してください。');
  }
  try {
    globalThis.chrome?.storage?.local?.get([PREF], data => {
      if (globalThis.chrome?.runtime?.lastError) return;
      state.stay = data?.[PREF] === true; renderStay();
      if (state.stay) { captureAnchor(); status('Stay：読んでいる位置を保持します'); }
    });
  } catch (_) { /* Storage unavailable: start in Follow. */ }
})();
