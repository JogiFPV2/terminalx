// Android (ADB): telefon przez debugowanie bezprzewodowe, obok mostka Telefon. Rdzeń: src-tauri/src/adb.rs.
// Parowanie kodem QR (jak w Android Studio) albo kodem z telefonu, zrzut ekranu, podgląd na żywo (scrcpy),
// pliki w obie strony, instalacja APK i komendy powłoki. ADB i scrcpy pobiera sama, jeśli ich nie ma.

/** @type {import('../sdk/hermitty-plugin').TxApi} */
let tx;
let root = null;
let section = null;
let st = null;
let err = '';
let devices = [];
let serial = '';
let info = null;
let busy = '';
let timer = 0;

export async function activate(api) {
  tx = api;
  section = tx.ui.sidebar.registerSection({
    id: 'adb',
    title: 'Android (ADB)',
    icon: 'phone',
    actions: [
      { id: 'pair', icon: 'plus', title: 'Sparuj przez Wi-Fi', run: openPair },
      { id: 'refresh', icon: 'refresh', title: 'Odśwież', run: () => refresh(true) },
    ],
    render(el) {
      root = el;
      injectStyles(el.ownerDocument);
      el.addEventListener('click', onClick);
      draw();
    },
  });
  tx.ui.commands.register('adb.pair', 'Android: sparuj przez Wi-Fi (ADB)', openPair);
  tx.ui.commands.register('adb.mirror', 'Android: podgląd ekranu na żywo (scrcpy)', () => mirror());
  tx.ui.commands.register('adb.install', 'Android: zainstaluj APK', () => install());
  await refresh(true);
  // Lista urządzeń co kilka sekund, tylko gdy sekcja jest widoczna.
  timer = setInterval(() => { if (root?.isConnected && st?.adb) refresh(false); }, 6000);
}

export async function deactivate() { clearInterval(timer); root = null; }

const fail = (e) => tx.ui.notify({ title: 'Android', body: String(e?.message || e), level: 'error' });
const ok = (title, body) => tx.ui.notify({ title, body, level: 'success' });
const cur = () => devices.find((d) => d.serial === serial) || null;
const ready = () => cur()?.state === 'device';

async function refresh(full) {
  try {
    if (full || !st) st = await tx.adb.status();
    if (st.adb) {
      const prev = serial;
      devices = await tx.adb.devices();
      if (!devices.some((d) => d.serial === serial)) serial = (devices.find((d) => d.state === 'device') || devices[0])?.serial || '';
      if (serial && (serial !== prev || full) && ready()) info = await tx.adb.info(serial).catch(() => null);
      if (!serial) info = null;
    }
    err = '';
  } catch (e) { err = String(e?.message || e); }
  draw();
}

/* ---------- akcje ---------- */

async function getTools(which) {
  busy = which; draw();
  try {
    const p = await tx.adb.getTools(which);
    ok(which === 'adb' ? 'Pobrano ADB' : 'Pobrano scrcpy', p);
  } catch (e) { fail(e); }
  busy = '';
  await refresh(true);
}

async function mirror() {
  if (!ready()) return fail('Najpierw połącz telefon.');
  if (!st?.scrcpy) {
    if (!st?.canDownloadScrcpy) return fail('Zainstaluj scrcpy z menedżera pakietów (apt install scrcpy, brew install scrcpy).');
    if (!(await tx.ui.dialog.confirm({ title: 'Pobrać scrcpy?', message: 'Podgląd ekranu na żywo używa darmowego programu scrcpy (Genymobile, licencja Apache 2.0). Pobrać najnowszą wersję z GitHuba do folderu aplikacji?', confirmLabel: 'Pobierz' }))) return;
    await getTools('scrcpy');
    if (!st?.scrcpy) return;
  }
  try { await tx.adb.mirror(serial); } catch (e) { fail(e); }
}

async function install() {
  if (!ready()) return fail('Najpierw połącz telefon.');
  busy = 'install'; draw();
  try { const n = await tx.adb.install(serial); if (n) ok('Zainstalowano', n); } catch (e) { fail(e); }
  busy = ''; draw();
}

async function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act;
  try {
    switch (a) {
      case 'getAdb': return getTools('adb');
      case 'pair': return openPair();
      case 'pick': serial = b.dataset.k; info = null; await refresh(true); return;
      case 'shot': return openShot();
      case 'mirror': return mirror();
      case 'files': return openFiles('/sdcard');
      case 'install': return install();
      case 'shell': return openShell();
      case 'disconnect': await tx.adb.disconnect(serial); serial = ''; return refresh(true);
    }
  } catch (err) { fail(err); }
}

/* ---------- okna ---------- */

function openPair() {
  if (!st?.adb) return fail('Najpierw pobierz ADB (przycisk w sekcji Android).');
  let poll = 0;
  tx.ui.dialog.open({
    title: 'Sparuj telefon przez Wi-Fi',
    width: 520,
    onClose: () => clearInterval(poll),
    async render(el, handle) {
      el.innerHTML = `
        <p class="ad-muted">Na telefonie: Ustawienia → System → Opcje programistyczne → <b>Debugowanie bezprzewodowe</b> (włącz). Telefon i komputer w tej samej sieci Wi-Fi.
        Opcji programistycznych nie widać? Ustawienia → Informacje o telefonie → 7 razy stuknij „Numer kompilacji”.</p>
        <div class="ad-tabs"><button data-t="qr" class="on">Kod QR</button><button data-t="code">Kod parowania</button><button data-t="connect">Adres</button></div>
        <div data-pane="qr">
          <div class="ad-pair"><div class="ad-qr" data-qr><p class="ad-muted">Generuję kod…</p></div>
          <div><p>Na telefonie w „Debugowanie bezprzewodowe” stuknij <b>Sparuj urządzenie za pomocą kodu QR</b> i zeskanuj ten kod.</p><p class="ad-muted" data-qs>Czekam na telefon…</p></div></div>
        </div>
        <div data-pane="code" hidden>
          <p>Na telefonie stuknij <b>Sparuj urządzenie za pomocą kodu parowania</b> i przepisz adres (IP:port) oraz 6 cyfr.</p>
          <div class="ad-row"><input class="ad-inp" data-addr placeholder="192.168.1.30:37123"><input class="ad-inp ad-short" data-code placeholder="123456" inputmode="numeric"></div>
          <button class="ad-btn ad-pri" data-go="pair">Sparuj</button>
        </div>
        <div data-pane="connect" hidden>
          <p>Telefon jest już sparowany? Wpisz adres z ekranu „Debugowanie bezprzewodowe” (IP i port pod nazwą urządzenia).</p>
          <div class="ad-row"><input class="ad-inp" data-caddr placeholder="192.168.1.30:41235"></div>
          <button class="ad-btn ad-pri" data-go="connect">Połącz</button>
        </div>
        <p class="ad-err" data-err></p>`;
      const $ = (s) => el.querySelector(s);
      const errEl = $('[data-err]');
      const show = (t) => {
        el.querySelectorAll('.ad-tabs button').forEach((x) => x.classList.toggle('on', x.dataset.t === t));
        el.querySelectorAll('[data-pane]').forEach((x) => (x.hidden = x.dataset.pane !== t));
      };
      el.querySelector('.ad-tabs').onclick = (ev) => { const t = ev.target.closest('[data-t]')?.dataset.t; if (t) show(t); };
      const done = async (msg) => { clearInterval(poll); ok('Telefon sparowany', msg); handle.close(); await refresh(true); };
      $('[data-go="pair"]').onclick = async (ev) => {
        ev.target.disabled = true; errEl.textContent = '';
        try { await done(await tx.adb.pair($('[data-addr]').value.trim(), $('[data-code]').value.trim())); }
        catch (x) { errEl.textContent = String(x?.message || x); ev.target.disabled = false; }
      };
      $('[data-go="connect"]').onclick = async (ev) => {
        ev.target.disabled = true; errEl.textContent = '';
        try { const r = await tx.adb.connect($('[data-caddr]').value.trim()); handle.close(); ok('Połączono', r); await refresh(true); }
        catch (x) { errEl.textContent = String(x?.message || x); ev.target.disabled = false; }
      };
      try {
        const q = await tx.adb.qrBegin();
        $('[data-qr]').innerHTML = q.qrSvg;
        let busyPoll = false;
        poll = setInterval(async () => {
          if (!el.isConnected) return clearInterval(poll);
          if (busyPoll) return;
          busyPoll = true;
          try {
            const r = await tx.adb.qrPoll(q.name, q.password);
            if (r) await done(r);
          } catch (x) { $('[data-qs]').textContent = String(x?.message || x); }
          busyPoll = false;
        }, 2500);
      } catch (x) { $('[data-qr]').innerHTML = `<p class="ad-err">${esc(x?.message || x)}</p>`; }
    },
  });
}

function openShot() {
  tx.ui.dialog.open({
    title: `Ekran · ${cur()?.model || serial}`,
    width: 420,
    async render(el) {
      const load = async () => {
        el.innerHTML = '<p class="ad-muted">Robię zrzut…</p>';
        try {
          const src = await tx.adb.screenshot(serial);
          el.innerHTML = `<img class="ad-shot" src="${src}" alt="Zrzut ekranu telefonu"><div class="ad-row"><button class="ad-btn" data-r>Odśwież</button><button class="ad-btn" data-m>Podgląd na żywo (scrcpy)</button></div>`;
          el.querySelector('[data-r]').onclick = load;
          el.querySelector('[data-m]').onclick = () => mirror();
        } catch (x) { el.innerHTML = `<p class="ad-err">${esc(x?.message || x)}</p>`; }
      };
      load();
    },
  });
}

function openFiles(start) {
  let path = start;
  let last = '';
  tx.ui.dialog.open({
    title: `Pliki · ${cur()?.model || serial}`,
    width: 560,
    async render(el) {
      const load = async () => {
        el.innerHTML = '<p class="ad-muted">Wczytuję…</p>';
        let list;
        try { list = await tx.adb.ls(serial, path); } catch (x) { el.innerHTML = `<p class="ad-err">${esc(x?.message || x)}</p><button class="ad-btn" data-up>W górę</button>`; el.querySelector('[data-up]').onclick = up; return; }
        const crumbs = path.split('/').filter(Boolean);
        el.innerHTML = `
          <div class="ad-row ad-path"><button class="ad-btn" data-up title="W górę">..</button><code>/${crumbs.map(esc).join('/')}</code>
            <span class="ad-sp"></span><button class="ad-btn" data-push>Wyślij tutaj…</button></div>
          <div class="ad-files">${list.map((f, i) => `<div class="ad-file"><button data-i="${i}" class="ad-fname">${f.isDir ? svg('folder') : svg('file')}<span>${esc(f.name)}</span></button>
            <button class="ad-btn" data-get="${i}" title="Pobierz do Pobrane/Hermitty">Pobierz</button></div>`).join('') || '<p class="ad-muted">Pusty folder.</p>'}</div>
          <div class="ad-row" data-last ${last ? '' : 'hidden'}><span class="ad-muted">Pobrano: <code>${esc(last)}</code></span><span class="ad-sp"></span><button class="ad-btn" data-reveal>Pokaż w folderze</button></div>`;
        el.querySelector('[data-reveal]').onclick = () => tx.adb.reveal(last).catch(fail);
        el.querySelector('[data-up]').onclick = up;
        el.querySelector('[data-push]').onclick = async () => {
          try { const s = await tx.adb.push(serial, path); if (s.length) { ok('Wysłano na telefon', s.join(', ')); load(); } } catch (x) { fail(x); }
        };
        el.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => { const f = list[Number(b.dataset.i)]; if (f.isDir) { path = f.path; load(); } else get(f); }));
        el.querySelectorAll('[data-get]').forEach((b) => (b.onclick = () => get(list[Number(b.dataset.get)])));
      };
      const up = () => { path = path.replace(/\/[^/]+\/?$/, '') || '/'; load(); };
      const get = async (f) => {
        try {
          const p = await tx.adb.pull(serial, f.path);
          last = p;
          ok('Pobrano z telefonu', p);
          const row = el.querySelector('[data-last]');
          if (row) { row.hidden = false; row.querySelector('code').textContent = p; }
        } catch (x) { fail(x); }
      };
      load();
    },
  });
}

function openShell() {
  tx.ui.dialog.open({
    title: `Powłoka · ${cur()?.model || serial}`,
    width: 620,
    render(el) {
      el.innerHTML = `<p class="ad-muted">Jedna komenda w powłoce telefonu (adb shell), np. <code>pm list packages -3</code>, <code>dumpsys battery</code>, <code>getprop</code>.</p>
        <form class="ad-row" data-f><input class="ad-inp" data-c placeholder="komenda" autocomplete="off" spellcheck="false"><button class="ad-btn ad-pri">Uruchom</button></form>
        <pre class="ad-out" data-o></pre>`;
      const out = el.querySelector('[data-o]');
      el.querySelector('[data-f]').onsubmit = async (ev) => {
        ev.preventDefault();
        const c = el.querySelector('[data-c]').value.trim();
        if (!c) return;
        out.textContent = '…';
        try { const r = await tx.adb.shell(serial, c); out.textContent = (r.output || '(brak wyjścia)') + (r.code ? `\n[kod ${r.code}]` : ''); }
        catch (x) { out.textContent = String(x?.message || x); }
      };
    },
  });
}

/* ---------- widok ---------- */

const ICON = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  shot: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3"/>',
  live: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  apk: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  term: '<path d="m5 7 5 5-5 5M12 19h7"/>',
  unlink: '<path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 4 8M8 12h4M3 3l18 18"/>',
  wifi: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01"/>',
  usb: '<path d="M12 2v14M8 6l4-4 4 4M7 13v3h10v-3M12 16v6"/>',
};
const svg = (n) => `<svg viewBox="0 0 24 24">${ICON[n]}</svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const STATE = { device: 'połączony', unauthorized: 'zatwierdź na telefonie', offline: 'offline' };

function draw() {
  if (!root) return;
  if (err && !st) { root.innerHTML = `<p class="ad-err">${esc(err)}</p>`; return; }
  if (!st) { root.innerHTML = '<p class="ad-muted">Sprawdzam ADB…</p>'; return; }
  if (!st.adb) {
    root.innerHTML = `<div class="ad-empty"><p>Do sterowania telefonem przez debugowanie bezprzewodowe potrzebny jest ADB (Android platform-tools od Google, ok. 7 MB).</p>
      <button class="ad-btn ad-pri" data-act="getAdb" ${busy ? 'disabled' : ''}>${busy === 'adb' ? 'Pobieram…' : 'Pobierz ADB'}</button></div>`;
    return;
  }
  const d = cur();
  const list = devices.map((x) => `<button class="ad-dev ${x.serial === serial ? 'on' : ''}" data-act="pick" data-k="${esc(x.serial)}">
      <span class="ad-dot ${x.state === 'device' ? 'ok' : x.state === 'unauthorized' ? 'warn' : ''}"></span>${svg(x.wifi ? 'wifi' : 'usb')}
      <b>${esc(x.model || x.serial)}</b><small>${esc(STATE[x.state] || x.state)}</small></button>`).join('');
  const acts = d && d.state === 'device' ? `
    ${info ? `<p class="ad-muted">${esc([info.maker, info.model].filter(Boolean).join(' '))} · Android ${esc(info.android)}${info.battery ? ` · bateria ${esc(info.battery)}%` : ''}</p>` : ''}
    <div class="ad-grid">
      <button class="ad-tile" data-act="shot">${svg('shot')}Zrzut ekranu</button>
      <button class="ad-tile" data-act="mirror">${svg('live')}${busy === 'scrcpy' ? 'Pobieram…' : 'Na żywo'}</button>
      <button class="ad-tile" data-act="files">${svg('folder')}Pliki</button>
      <button class="ad-tile" data-act="install">${svg('apk')}${busy === 'install' ? 'Instaluję…' : 'Instaluj APK'}</button>
      <button class="ad-tile" data-act="shell">${svg('term')}Powłoka</button>
      ${d.wifi ? `<button class="ad-tile" data-act="disconnect">${svg('unlink')}Rozłącz</button>` : ''}
    </div>` : d?.state === 'unauthorized' ? '<p class="ad-muted">Na ekranie telefonu zatwierdź „Zezwolić na debugowanie?”.</p>' : '';
  root.innerHTML = `
    ${devices.length ? `<div class="ad-list">${list}</div>${acts}` : `<div class="ad-empty"><p>Brak urządzeń. Włącz na telefonie Debugowanie bezprzewodowe i sparuj go z tym komputerem (albo podłącz kablem USB z włączonym debugowaniem USB).</p></div>`}
    <button class="ad-btn ad-wide" data-act="pair">Sparuj przez Wi-Fi</button>
    ${err ? `<p class="ad-err">${esc(err)}</p>` : ''}
    <p class="ad-muted ad-ver">${esc(st.version)}</p>`;
}

function injectStyles(doc) {
  if (doc.getElementById('tx-adb-css')) return;
  const style = doc.createElement('style');
  style.id = 'tx-adb-css';
  style.textContent = `
    .ad-muted{color:var(--muted-foreground);font-size:11.5px;margin:6px 2px;line-height:1.45}
    .ad-err{color:var(--destructive);font-size:12px;margin:6px 2px;white-space:pre-wrap}
    .ad-empty{display:flex;flex-direction:column;gap:8px;padding:4px 2px}
    .ad-empty p{margin:0;color:var(--muted-foreground);font-size:12px;line-height:1.45}
    .ad-btn,.ad-dev,.ad-tile,.ad-tabs button,.ad-fname{all:unset;cursor:pointer;box-sizing:border-box}
    .ad-btn{padding:4px 9px;border-radius:6px;border:1px solid var(--border);font-size:12px;display:inline-flex;align-items:center;gap:5px;justify-content:center}
    .ad-btn:hover{background:var(--accent)}
    .ad-btn[disabled]{opacity:.5;pointer-events:none}
    .ad-pri{background:var(--primary);color:var(--primary-foreground);border-color:transparent;padding:6px 10px}
    .ad-wide{display:flex;width:100%;margin-top:8px}
    svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}
    .ad-list{display:flex;flex-direction:column;gap:2px}
    .ad-dev{display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:6px;min-width:0}
    .ad-dev:hover{background:var(--accent)}
    .ad-dev.on{background:var(--accent)}
    .ad-dev b{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ad-dev small{margin-left:auto;color:var(--muted-foreground);font-size:11px;white-space:nowrap}
    .ad-dot{width:7px;height:7px;border-radius:50%;background:var(--muted-foreground);opacity:.6;flex:none}
    .ad-dot.ok{background:var(--chart-1);opacity:1}
    .ad-dot.warn{background:var(--chart-4, orange);opacity:1}
    .ad-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-top:4px}
    .ad-tile{display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 2px;border-radius:8px;border:1px solid var(--border);font-size:11px;text-align:center}
    .ad-tile:hover{background:var(--accent)}
    .ad-tile svg{width:16px;height:16px}
    .ad-ver{font-size:10.5px;opacity:.7}
    .ad-tabs{display:flex;gap:4px;margin:10px 0}
    .ad-tabs button{padding:5px 10px;border-radius:6px;font-size:12px;border:1px solid var(--border)}
    .ad-tabs button.on{background:var(--foreground);color:var(--background);border-color:transparent}
    .ad-pair{display:flex;gap:16px;align-items:center}
    .ad-qr{width:190px;height:190px;background:#fff;border-radius:8px;padding:4px;flex:none;display:grid;place-items:center}
    .ad-qr svg{width:100%;height:100%;stroke:none}
    .ad-row{display:flex;gap:6px;align-items:center;margin:8px 0}
    .ad-inp{flex:1;min-width:0;background:var(--background);color:var(--foreground);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font:12px var(--font-mono, monospace)}
    .ad-short{flex:0 0 100px}
    .ad-shot{display:block;max-width:100%;max-height:70vh;margin:0 auto;border-radius:10px;border:1px solid var(--border)}
    .ad-path code{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ad-sp{flex:1}
    .ad-files{max-height:55vh;overflow:auto;border:1px solid var(--border);border-radius:8px}
    .ad-file{display:flex;align-items:center;gap:6px;padding:3px 6px;border-bottom:1px solid var(--border)}
    .ad-file:last-child{border-bottom:0}
    .ad-fname{flex:1;min-width:0;display:flex;align-items:center;gap:6px;font-size:12.5px;padding:3px 0}
    .ad-fname span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ad-out{max-height:50vh;overflow:auto;background:var(--muted);border-radius:8px;padding:8px;font:12px/1.45 var(--font-mono, monospace);white-space:pre-wrap;margin:0}
  `;
  doc.head.appendChild(style);
}
