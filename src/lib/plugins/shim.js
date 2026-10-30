// Środowisko wewnątrz iframe pluginu. Buduje obiekt `tx` (API z plugins/sdk/hermitty-plugin.d.ts)
// i przekazuje wywołania do hosta przez postMessage. Ten plik jest wstrzykiwany do srcdoc jako tekst.
(() => {
  let seq = 0;
  const pending = new Map();
  const listeners = new Map();
  let config = {};
  let manifest = null;
  let mod = null;
  const sectionActions = new Map();
  const statusItems = new Map();
  const commands = new Map();
  const dialogs = new Set();
  let tabDrop = null;

  const post = (msg) => parent.postMessage({ __tx: true, ...msg }, '*');
  const rpc = (method, args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    post({ kind: 'call', id, method, args });
  });
  const on = (name, cb) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(cb);
    return { dispose: () => listeners.get(name)?.delete(cb) };
  };
  const emit = (name, payload) => listeners.get(name)?.forEach((cb) => { try { cb(payload); } catch (e) { console.error(e); } });

  // Wysokość sekcji idzie do hosta, który dopasowuje iframe.
  const section = document.getElementById('tx-section');
  const layer = document.getElementById('tx-dialog-layer');
  let lastH = -1;
  const reportHeight = () => {
    if (dialogs.size) return;
    const h = Math.ceil(section.getBoundingClientRect().height);
    if (h !== lastH) { lastH = h; post({ kind: 'height', height: h }); }
  };
  new ResizeObserver(reportHeight).observe(section);

  const storage = {
    readText: (path) => rpc('storage', { op: 'read', path }),
    writeText: (path, data) => rpc('storage', { op: 'write', path, data }),
    async readJson(path, fallback) {
      try { return JSON.parse(await rpc('storage', { op: 'read', path })); } catch { return fallback; }
    },
    writeJson: (path, value) => rpc('storage', { op: 'write', path, data: JSON.stringify(value, null, 2) }),
    list: (dir) => rpc('storage', { op: 'list', path: dir }),
    exists: (path) => rpc('storage', { op: 'exists', path }),
    mkdir: (path) => rpc('storage', { op: 'mkdir', path }),
    move: (from, to) => rpc('storage', { op: 'move', path: from, to }),
    remove: (path) => rpc('storage', { op: 'remove', path }),
    trash: (path, opts) => rpc('trash', { path, label: opts?.label || path }),
    onChange: (cb) => on('storage', cb),
  };

  const makeStatusItem = (opts) => {
    const state = { text: '', tooltip: '', icon: '', variant: 'default', visible: false, clickable: false, place: 'bottom' };
    let onClick = null;
    let queued = false;
    const flush = () => { queued = false; rpc('status.update', { id: opts.id, ...state, clickable: !!onClick }); };
    const schedule = () => { if (!queued) { queued = true; queueMicrotask(flush); } };
    const item = {
      get text() { return state.text; }, set text(v) { state.text = String(v); schedule(); },
      get tooltip() { return state.tooltip; }, set tooltip(v) { state.tooltip = String(v || ''); schedule(); },
      get icon() { return state.icon; }, set icon(v) { state.icon = String(v || ''); schedule(); },
      get variant() { return state.variant; }, set variant(v) { state.variant = v || 'default'; schedule(); },
      get place() { return state.place; }, set place(v) { state.place = v === 'top' ? 'top' : 'bottom'; schedule(); },
      get onClick() { return onClick; }, set onClick(fn) { onClick = fn; schedule(); },
      show() { state.visible = true; schedule(); },
      hide() { state.visible = false; schedule(); },
      dispose() { statusItems.delete(opts.id); rpc('status.remove', { id: opts.id }); },
      _click() { onClick?.(); },
    };
    statusItems.set(opts.id, item);
    rpc('status.create', { id: opts.id, alignment: opts.alignment || 'right', priority: opts.priority || 0 });
    return item;
  };

  const openDialog = (opts) => {
    const box = document.createElement('div');
    box.className = 'tx-dialog';
    if (opts.width) box.style.width = `min(${opts.width}px, calc(100vw - 48px))`;
    box.innerHTML = '<header><b></b><button class="tx-x" title="Zamknij">✕</button></header><div class="tx-body"></div>';
    box.querySelector('b').textContent = opts.title || '';
    layer.appendChild(box);
    dialogs.add(box);
    layer.style.display = 'flex';
    section.style.display = 'none';
    post({ kind: 'dialog', open: true });
    let closed = false;
    const handle = {
      close() {
        if (closed) return;
        closed = true;
        box.remove();
        dialogs.delete(box);
        if (!dialogs.size) {
          layer.style.display = 'none';
          section.style.display = '';
          post({ kind: 'dialog', open: false });
          lastH = -1;
          requestAnimationFrame(reportHeight);
        }
        opts.onClose?.();
      },
    };
    box.querySelector('.tx-x').addEventListener('click', () => handle.close());
    layer.onclick = (e) => { if (e.target === layer) [...dialogs].pop() && handle.close(); };
    try { opts.render(box.querySelector('.tx-body'), handle); } catch (e) { console.error(e); }
    return handle;
  };

  const tx = {
    plugin: {},
    platform: { os: 'windows', appVersion: '' },
    config: {
      get: (k) => config[k],
      all: () => ({ ...config }),
      onChange: (cb) => on('config', cb),
    },
    storage,
    ui: {
      sidebar: {
        registerSection(s) {
          if (s.actions) s.actions.forEach((a) => sectionActions.set(`${s.id}:${a.id}`, a.run));
          tabDrop = s.onTabDrop || null;
          rpc('sidebar.register', {
            id: s.id, title: s.title, icon: s.icon,
            actions: (s.actions || []).map((a) => ({ id: a.id, icon: a.icon, title: a.title })),
            badge: s.badge ?? null, acceptsTabs: !!s.onTabDrop,
          });
          try { s.render(section); } catch (e) { console.error(e); }
          return {
            setBadge: (n) => rpc('sidebar.badge', { id: s.id, badge: n ?? null }),
            reveal: () => rpc('sidebar.reveal', { id: s.id }),
            dispose: () => rpc('sidebar.remove', { id: s.id }),
          };
        },
      },
      statusBar: { createItem: makeStatusItem },
      commands: {
        register(id, title, run, opts) {
          commands.set(id, run);
          rpc('command.register', { id, title, keybinding: opts?.keybinding || '' });
          return { dispose: () => { commands.delete(id); rpc('command.remove', { id }); } };
        },
      },
      tabMenu: { onSelect: (cb) => on('tabMenu', ({ itemId, tabId }) => cb(itemId, tabId)) },
      dialog: {
        open: openDialog,
        confirm: (o) => rpc('confirm', o),
      },
      notify: (o) => rpc('notify', o),
      openExternal: (url) => rpc('openExternal', { url }),
    },
    system: { stats: () => rpc('system.stats', {}) },
    shell: { exec: (cmd, args, opts) => rpc('shell.exec', { cmd, args: args || [], cwd: opts?.cwd || null, timeoutMs: opts?.timeoutMs || 60000 }) },
    net: {
      async fetch(url, init) {
        const r = await rpc('net.fetch', { url: String(url), method: init?.method || 'GET', headers: init?.headers || null, body: init?.body ?? null });
        return { ok: r.status < 400, status: r.status, text: async () => r.body, json: async () => JSON.parse(r.body) };
      },
    },
    terminal: {
      list: () => rpc('terminal.list', {}),
      onOutput(id, cb) {
        rpc('terminal.subscribe', { id });
        const d = on('termOutput', (p) => { if (p.id === id) cb(p.data); });
        return { dispose: () => { d.dispose(); rpc('terminal.unsubscribe', { id }); } };
      },
      write: (id, text) => rpc('terminal.write', { id, text }),
    },
    tabs: {
      list: () => rpc('tabs.list', {}),
      get: (id) => rpc('tabs.get', { id }),
      park: (id) => rpc('tabs.park', { id }),
      unpark: (id, opts) => rpc('tabs.unpark', { id, focus: opts?.focus ?? true }),
      close: (id, opts) => rpc('tabs.close', { id, label: opts?.label || '' }),
      tail: (id, lines) => rpc('tabs.tail', { id, lines }),
      onChanged(cb) { return on('tabsChanged', async () => cb(await rpc('tabs.list', {}))); },
    },
    ai: {
      complete: (o) => rpc('ai.complete', o),
      usage: () => rpc('ai.usage', {}),
      balance: (id) => rpc('ai.balance', { id }),
      plan: (service, account) => rpc('ai.plan', { service, account: account || null }),
      accounts: () => rpc('ai.accounts', {}),
      onUsage: (cb) => on('usage', cb),
    },
    keys: {
      add: (id, opts) => rpc('keys.add', { id, title: opts?.title, message: opts?.message }),
      masked: (ids) => rpc('keys.masked', { ids }),
      copy: (id, label) => rpc('keys.copy', { id, label }),
      delete: (id) => rpc('keys.delete', { id }),
    },
    events: { on: (name, cb) => on('app:' + name, cb) },
  };

  async function load(code) {
    // Najpierw jako moduł ES z blob URL; jeśli środowisko na to nie pozwala, prosty fallback bez `export`.
    try {
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      const m = await import(url);
      URL.revokeObjectURL(url);
      return m;
    } catch (e) {
      const body = code.replace(/export\s+(async\s+)?function\s+(\w+)/g, '$1function $2')
        + '\n;return { activate: typeof activate !== "undefined" ? activate : undefined, deactivate: typeof deactivate !== "undefined" ? deactivate : undefined };';
      return new Function(body)();
    }
  }

  addEventListener('message', async (ev) => {
    const msg = ev.data;
    if (!msg || !msg.__tx || ev.source !== parent) return;
    if (msg.kind === 'result') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.ok ? p.resolve(msg.value) : p.reject(new Error(msg.error));
      return;
    }
    if (msg.kind === 'theme') { document.getElementById('tx-theme').textContent = msg.css; return; }
    if (msg.kind === 'init') {
      manifest = msg.manifest;
      config = msg.config || {};
      tx.plugin = { id: manifest.id, version: manifest.version };
      tx.platform = msg.platform;
      try {
        mod = await load(msg.code);
        await mod.activate?.(tx);
        post({ kind: 'ready' });
      } catch (e) {
        post({ kind: 'crash', error: String(e && e.stack || e) });
      }
      return;
    }
    if (msg.kind === 'event') {
      const { name, payload } = msg;
      if (name === 'config') { config = payload.config; emit('config', payload.key); return; }
      if (name === 'sectionAction') { sectionActions.get(`${payload.sectionId}:${payload.actionId}`)?.(); return; }
      if (name === 'statusClick') { statusItems.get(payload.id)?._click(); return; }
      if (name === 'command') { commands.get(payload.id)?.(); return; }
      if (name === 'tabDrop') { tabDrop?.(payload.tabId); return; }
      if (name === 'deactivate') { try { await mod?.deactivate?.(); } catch (e) { console.error(e); } post({ kind: 'deactivated' }); return; }
      emit(name, payload);
    }
  });

  window.addEventListener('error', (e) => post({ kind: 'log', level: 'error', text: String(e.message) }));
  post({ kind: 'boot' });
})();
