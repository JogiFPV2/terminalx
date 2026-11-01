// Telefon: aplikacja Hermitty na Androida połączona z komputerem przez szyfrowany mostek w rdzeniu
// (src-tauri/src/phone.rs). Sekcja w pasku bocznym pokazuje telefon, dyktafon, powiadomienia, SMS-y
// i nagrania odebrane na komputer. Kody jednorazowe telefon maskuje sam, zanim cokolwiek wyśle.

/** @type {import('../sdk/hermitty-plugin').TxApi} */
let tx;
let root = null;
let section = null;
let status = null;
let statusErr = '';
let deviceId = '';
let tab = 'notif';
let notifs = [];
let threads = null;
let files = [];
let phoneRecs = [];
let rec = { recording: false, secs: 0 };
let recAt = 0;
let busy = '';
let item = null;
let pairDialog = null;
let timer = 0;
const audio = {};
const texts = {};

const RELEASES = 'https://github.com/JogiFPV2/terminalx/releases';

export async function activate(api) {
  tx = api;
  section = tx.ui.sidebar.registerSection({
    id: 'phone',
    title: 'Telefon',
    icon: 'phone',
    actions: [
      { id: 'pair', icon: 'plus', title: 'Sparuj telefon', run: openPair },
      { id: 'refresh', icon: 'refresh', title: 'Odśwież', run: () => refresh(true) },
    ],
    render(el) {
      root = el;
      injectStyles(el.ownerDocument);
      el.addEventListener('click', onClick);
      el.addEventListener('keydown', onKey);
      draw();
    },
  });
  item = tx.ui.statusBar.createItem({ id: 'phone', alignment: 'right', priority: 5 });
  item.icon = 'phone';
  item.onClick = () => section.reveal();
  tx.ui.commands.register('phone.pair', 'Telefon: sparuj nowy telefon', openPair);
  tx.ui.commands.register('phone.rec', 'Telefon: dyktafon start/stop', toggleRec, { keybinding: 'Ctrl+Alt+R' });
  tx.ui.commands.register('phone.ring', 'Telefon: znajdź telefon (dzwonek)', () => req('ring').then(() => tx.ui.notify({ title: 'Telefon dzwoni', body: 'Przez 30 s albo do zatrzymania.' })).catch(fail));
  tx.phone.onEvent(onEvent);
  tx.config.onChange((k) => { if (k === 'port') start(); else drawStatusBar(); });
  await start();
  timer = setInterval(() => { if (rec.recording) draw(); }, 1000);
}

export async function deactivate() {
  clearInterval(timer);
  await tx.phone.stop().catch(() => {});
  root = null;
}

async function start() {
  try {
    await tx.phone.start(Number(tx.config.get('port')) || 47390);
    statusErr = '';
  } catch (e) {
    statusErr = String(e.message || e);
  }
  await refresh(true);
}

/* ---------- dane ---------- */

const dev = () => status?.devices.find((d) => d.id === deviceId) || null;
const online = () => !!dev()?.online;
const req = (m, p, timeoutMs) => tx.phone.request(deviceId, m, p, { timeoutMs });
const fail = (e) => tx.ui.notify({ title: 'Telefon', body: String(e.message || e), level: 'error' });

async function refresh(full) {
  try { status = await tx.phone.status(); } catch (e) { statusErr = String(e.message || e); }
  const list = status?.devices || [];
  if (!list.some((d) => d.id === deviceId)) deviceId = (list.find((d) => d.online) || list[0])?.id || '';
  else if (!online() && list.some((d) => d.online)) deviceId = list.find((d) => d.online).id;
  if (dev()?.info?.rec) setRec(dev().info.rec);
  files = await tx.phone.files().catch(() => []);
  if (full && online()) {
    await Promise.all([
      req('notif.list').then((l) => (notifs = l)).catch(() => (notifs = [])),
      tab === 'sms' ? loadThreads() : null,
      req('rec.list').then((l) => (phoneRecs = l)).catch(() => (phoneRecs = [])),
    ]);
  }
  draw();
}

async function loadThreads() {
  threads = await req('sms.threads', { limit: 40 }).catch((e) => ({ error: String(e.message || e) }));
}

function setRec(r) {
  rec = { recording: !!r.recording, secs: r.secs || 0 };
  recAt = Date.now() - rec.secs * 1000;
}

function onEvent(ev) {
  if (ev.e === 'devices') return refresh(true);
  if (ev.e === 'pair') {
    if (ev.p?.state === 'paired') {
      pairDialog?.close();
      deviceId = ev.p.device;
      tx.ui.notify({ title: 'Telefon sparowany', body: ev.p.name, level: 'success' });
    }
    if (ev.p?.state === 'failed') tx.ui.notify({ title: 'Parowanie przerwane', body: 'Za dużo błędnych kodów. Wygeneruj nowy.', level: 'warning' });
    return refresh(true);
  }
  if (ev.device !== deviceId) return;
  const p = ev.p || {};
  switch (ev.e) {
    case 'info': {
      const d = dev();
      if (d) d.info = p;
      if (p.rec) setRec(p.rec);
      break;
    }
    case 'notif':
      notifs = [p, ...notifs.filter((n) => n.key !== p.key)].slice(0, 100);
      if (tx.config.get('appToasts')) tx.ui.notify({ title: `${p.app}: ${p.title}`, body: p.text.slice(0, 140) });
      break;
    case 'notif.removed':
      notifs = notifs.filter((n) => n.key !== p.key);
      break;
    case 'sms':
      if (tx.config.get('smsToasts')) tx.ui.notify({ title: `SMS · ${p.name || p.addr}`, body: p.body.slice(0, 160) });
      if (threads && !threads.error) loadThreads().then(draw);
      break;
    case 'rec':
      setRec(p);
      if (p.last) req('rec.list').then((l) => { phoneRecs = l; draw(); }).catch(() => {});
      break;
    case 'file':
      tx.phone.files().then((f) => { files = f; draw(); });
      req('rec.list').then((l) => { phoneRecs = l; draw(); }).catch(() => {});
      if (p.kind === 'recording') tx.ui.notify({ title: 'Nagranie z telefonu', body: `${p.name} (${kb(p.size)})`, level: 'success' });
      break;
  }
  draw();
}

/* ---------- akcje ---------- */

async function toggleRec() {
  if (!online()) return fail('Telefon jest offline.');
  try {
    const r = await req(rec.recording ? 'rec.stop' : 'rec.start');
    if (rec.recording) rec = { recording: false, secs: 0 };
    else setRec(r);
  } catch (e) { fail(e); }
  draw();
}

async function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act, k = b.dataset.k;
  try {
    switch (a) {
      case 'pair': return openPair();
      case 'apk': return tx.ui.openExternal(RELEASES);
      case 'tab':
        tab = k;
        if (tab === 'sms' && !threads && online()) { draw(); await loadThreads(); }
        break;
      case 'rec': return toggleRec();
      case 'ring': await req('ring'); tx.ui.notify({ title: 'Telefon dzwoni', body: 'Przez 30 s albo do zatrzymania.' }); return;
      case 'ringStop': await req('ring.stop'); return;
      case 'unpair': {
        const d = dev();
        if (!d || !(await tx.ui.dialog.confirm({ title: `Zapomnieć ${d.name}?`, message: 'Telefon straci połączenie. Żeby wrócić, sparujesz go ponownie. Nagrania na komputerze zostają.', confirmLabel: 'Zapomnij', danger: true }))) return;
        await tx.phone.unpair(d.id);
        deviceId = '';
        return refresh(true);
      }
      case 'nAct': {
        const n = notifs.find((x) => x.key === k);
        await req('notif.action', { key: k, action: Number(b.dataset.i) });
        if (n) notifs = notifs.filter((x) => x !== n);
        break;
      }
      case 'nReply': return sendReply(k);
      case 'nDismiss': await req('notif.dismiss', { key: k }); notifs = notifs.filter((x) => x.key !== k); break;
      case 'thread': return openThread(Number(k));
      case 'newSms': return openThread(null);
      case 'play': audio[k] = audio[k] || (await tx.phone.audio(k)); break;
      case 'text': {
        busy = k; draw();
        try { texts[k] = await tx.phone.transcribe(k); } finally { busy = ''; }
        break;
      }
      case 'copy': return copyText(b.closest('.ph-text').querySelector('p'));
      case 'folder': return tx.phone.reveal(k);
      case 'del': {
        if (!(await tx.ui.dialog.confirm({ title: 'Usunąć nagranie z komputera?', message: k.split(/[\\/]/).pop(), confirmLabel: 'Usuń', danger: true }))) return;
        await tx.phone.deleteFile(k);
        delete audio[k]; delete texts[k];
        files = await tx.phone.files();
        break;
      }
      case 'fetch': for (const r of phoneRecs.filter((x) => !x.sent)) await req('rec.send', { name: r.name }); break;
    }
  } catch (err) { fail(err); }
  draw();
}

/** Ramka pluginu nie zawsze ma dostęp do schowka: wtedy zostaje zaznaczony tekst do skopiowania Ctrl+C. */
async function copyText(p) {
  const sel = root.ownerDocument.getSelection();
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(p);
  sel.removeAllRanges();
  sel.addRange(range);
  let ok = false;
  try { await navigator.clipboard.writeText(p.textContent); ok = true; } catch { ok = root.ownerDocument.execCommand('copy'); }
  tx.ui.notify(ok ? { title: 'Skopiowano tekst nagrania', level: 'success' } : { title: 'Tekst zaznaczony', body: 'Naciśnij Ctrl+C, żeby go skopiować.' });
}

function onKey(e) {
  if (e.key === 'Enter' && e.target.matches('.ph-reply input')) { e.preventDefault(); sendReply(e.target.dataset.k); }
}

async function sendReply(key) {
  const inp = root.querySelector(`.ph-reply input[data-k="${CSS.escape(key)}"]`);
  const text = inp?.value.trim();
  const n = notifs.find((x) => x.key === key);
  const act = n?.actions.find((x) => x.reply);
  if (!text || !act) return;
  inp.disabled = true;
  try {
    await req('notif.reply', { key, action: act.i, text });
    inp.value = '';
    tx.ui.notify({ title: 'Wysłano odpowiedź', body: `${n.app}: ${n.title}`, level: 'success' });
  } catch (e) { fail(e); }
  inp.disabled = false;
}

/* ---------- okna ---------- */

function openPair() {
  pairDialog = tx.ui.dialog.open({
    title: 'Sparuj telefon',
    width: 460,
    onClose: () => { pairDialog = null; tx.phone.cancelPair().catch(() => {}); },
    async render(el, handle) {
      el.innerHTML = '<p class="ph-muted">Generuję kod…</p>';
      let p;
      try { p = await tx.phone.pair(); } catch (e) { el.innerHTML = `<p class="ph-err">${esc(e.message || e)}</p>`; return; }
      const end = Date.now() + p.expiresIn * 1000;
      el.innerHTML = `
        <div class="ph-pair">
          <div class="ph-qr">${p.qrSvg}</div>
          <div class="ph-steps">
            <p><b>1.</b> Zainstaluj na telefonie aplikację Hermitty (plik APK) <button class="ph-link" data-x="apk">z GitHuba</button>.</p>
            <p><b>2.</b> Zeskanuj kod aparatem albo w aplikacji wybierz ten komputer i wpisz kod:</p>
            <div class="ph-code">${esc(p.code)}</div>
            <p class="ph-muted">Komputer: ${esc(status?.pcName || '')} · ${esc((status?.addrs || []).join(', ') || 'brak adresu w sieci lokalnej')}</p>
            <p class="ph-muted" data-left></p>
          </div>
        </div>
        <p class="ph-muted">Kod działa raz i wygasa po 5 minutach. Poza domem połącz oba urządzenia przez Tailscale.</p>`;
      el.querySelector('[data-x="apk"]').onclick = () => tx.ui.openExternal(RELEASES);
      const left = el.querySelector('[data-left]');
      const t = setInterval(() => {
        const s = Math.max(0, Math.round((end - Date.now()) / 1000));
        if (!left.isConnected) return clearInterval(t);
        left.textContent = s ? `Ważny jeszcze ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Kod wygasł. Zamknij i otwórz ponownie.';
        if (!s) clearInterval(t);
      }, 1000);
      void handle;
    },
  });
}

function openThread(thread) {
  const t = threads && !threads.error ? threads.find((x) => x.thread === thread) : null;
  tx.ui.dialog.open({
    title: t ? (t.name || t.addr) : 'Nowy SMS',
    width: 480,
    async render(el) {
      el.innerHTML = `${t ? '<div class="ph-conv"><p class="ph-muted">Wczytuję…</p></div>' : '<input class="ph-inp" data-to placeholder="Numer telefonu, np. +48 600 100 200">'}
        <div class="ph-compose"><textarea class="ph-inp" rows="3" placeholder="Wiadomość"></textarea><button class="ph-btn ph-pri" data-send>Wyślij</button></div>`;
      const conv = el.querySelector('.ph-conv');
      const load = async () => {
        if (!conv) return;
        try {
          const msgs = await req('sms.thread', { thread, limit: 80 });
          conv.innerHTML = msgs.map((m) => `<div class="ph-msg ${m.out ? 'out' : ''}"><span>${esc(m.body)}</span><small>${when(m.date)}</small></div>`).join('') || '<p class="ph-muted">Brak wiadomości.</p>';
          conv.scrollTop = conv.scrollHeight;
        } catch (e) { conv.innerHTML = `<p class="ph-err">${esc(e.message || e)}</p>`; }
      };
      await load();
      const ta = el.querySelector('textarea');
      const send = async () => {
        const to = t ? t.addr : el.querySelector('[data-to]').value.trim();
        const body = ta.value.trim();
        if (!to || !body) return;
        ta.disabled = true;
        try {
          await req('sms.send', { to, body });
          ta.value = '';
          tx.ui.notify({ title: 'Wysłano SMS', body: t ? (t.name || t.addr) : to, level: 'success' });
          setTimeout(load, 1200);
          loadThreads().then(draw);
        } catch (e) { fail(e); }
        ta.disabled = false;
        ta.focus();
      };
      el.querySelector('[data-send]').onclick = send;
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); });
      ta.focus();
    },
  });
}

/* ---------- rysowanie ---------- */

const ICON = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 0 0 4 0"/>',
  ring: '<path d="M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  play: '<path d="m7 4 13 8-13 8V4z"/>',
  text: '<path d="M4 6h16M4 12h10M4 18h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  unlink: '<path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 4 8M8 12h4M3 3l18 18"/>',
};
const svg = (n) => `<svg viewBox="0 0 24 24">${ICON[n]}</svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
function when(ms) {
  if (!ms) return '';
  const d = new Date(ms), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' });
}
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function drawStatusBar() {
  const d = dev();
  if (!d || !tx.config.get('statusBar')) return item.hide();
  const b = d.info?.battery;
  item.text = rec.recording ? `● ${mmss(Math.round((Date.now() - recAt) / 1000))}` : d.online ? (b >= 0 ? `${b}%${d.info?.charging ? '⚡' : ''}` : 'online') : 'offline';
  item.tooltip = `${d.name}: ${d.online ? `połączony (${d.addr})` : 'offline'}${rec.recording ? ' · nagrywa dyktafon' : ''}`;
  item.variant = rec.recording ? 'error' : d.online ? 'default' : 'warning';
  item.show();
}

function draw() {
  drawStatusBar();
  section?.setBadge(notifs.length || null);
  if (!root) return;
  if (statusErr && !status?.running) {
    root.innerHTML = `<div class="ph-empty"><p class="ph-err">${esc(statusErr)}</p><p class="ph-muted">Zmień port w Ustawienia → Pluginy → Telefon → Konfiguracja.</p></div>`;
    return;
  }
  const list = status?.devices || [];
  if (!list.length) {
    root.innerHTML = `<div class="ph-empty">
      <p>Połącz telefon z Androidem: powiadomienia, SMS-y i dyktafon tutaj, na komputerze.</p>
      <button class="ph-btn ph-pri" data-act="pair">Sparuj telefon</button>
      <button class="ph-link" data-act="apk">Pobierz aplikację na Androida (APK)</button></div>`;
    return;
  }
  const d = dev();
  const info = d.info || {};
  const perms = info.perms || {};
  const secs = rec.recording ? Math.round((Date.now() - recAt) / 1000) : 0;
  const head = `
    <div class="ph-dev">
      <span class="ph-dot ${d.online ? 'on' : ''}"></span>
      ${list.length > 1 ? `<select class="ph-sel" data-dev>${list.map((x) => `<option value="${esc(x.id)}" ${x.id === d.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : `<b title="${esc(d.model)}">${esc(d.name)}</b>`}
      <small>${d.online ? (info.battery >= 0 ? `${info.battery}%${info.charging ? ' ⚡' : ''}` : '') : `offline${d.lastSeen ? ' · ' + when(d.lastSeen) : ''}`}</small>
      <span class="ph-acts">
        ${d.online ? `<button data-act="ring" title="Znajdź telefon (dzwonek 30 s)">${svg('ring')}</button>` : ''}
        <button data-act="unpair" title="Zapomnij telefon">${svg('unlink')}</button>
      </span>
    </div>
    ${d.online ? `<button class="ph-rec ${rec.recording ? 'on' : ''}" data-act="rec" ${info.mic === false && !rec.recording ? 'title="Otwórz raz aplikację na telefonie, żeby włączyć zdalny dyktafon"' : ''}>
        ${svg(rec.recording ? 'stop' : 'mic')}<span>${rec.recording ? `Zatrzymaj · ${mmss(secs)}` : 'Dyktafon'}</span></button>
      ${info.mic === false ? '<p class="ph-hint">Po restarcie telefonu otwórz raz aplikację Hermitty: dopiero wtedy Android pozwala włączyć mikrofon zdalnie.</p>' : ''}`
    : '<p class="ph-hint">Telefon jest offline. Sprawdź, czy jest w tej samej sieci Wi-Fi (albo w Tailscale) i czy aplikacja Hermitty działa.</p>'}`;
  const tabs = `<div class="ph-tabs">
    <button data-act="tab" data-k="notif" class="${tab === 'notif' ? 'on' : ''}">Powiadomienia${notifs.length ? ` <i>${notifs.length}</i>` : ''}</button>
    <button data-act="tab" data-k="sms" class="${tab === 'sms' ? 'on' : ''}">SMS</button>
    <button data-act="tab" data-k="rec" class="${tab === 'rec' ? 'on' : ''}">Nagrania</button></div>`;
  root.innerHTML = head + tabs + `<div class="ph-list">${tab === 'notif' ? drawNotifs(d, perms) : tab === 'sms' ? drawSms(d, perms) : drawRecs(d)}</div>`;
  root.querySelector('[data-dev]')?.addEventListener('change', async (e) => { deviceId = e.target.value; threads = null; await refresh(true); });
  // Odtwarzacze wracają po przerysowaniu z zapamiętanym źródłem.
  for (const el of root.querySelectorAll('audio[data-k]')) el.src = audio[el.dataset.k] || '';
}

function drawNotifs(d, perms) {
  if (!d.online) return '<p class="ph-muted">Powiadomienia widać, gdy telefon jest połączony.</p>';
  if (perms.notifications === false) return '<p class="ph-muted">Włącz w aplikacji na telefonie „Dostęp do powiadomień”.</p>';
  if (!notifs.length) return '<p class="ph-muted">Brak powiadomień.</p>';
  return notifs.slice(0, 40).map((n) => {
    const reply = n.actions.find((a) => a.reply);
    const other = n.actions.filter((a) => !a.reply).slice(0, 2);
    return `<div class="ph-item">
      <div class="ph-top"><small class="ph-app">${esc(n.app)}</small><small>${when(n.time)}</small>
        ${n.clearable ? `<button class="ph-x" data-act="nDismiss" data-k="${esc(n.key)}" title="Zamknij na telefonie">${svg('x')}</button>` : ''}</div>
      <b>${esc(n.title)}</b><p>${esc(n.text)}</p>
      ${other.length ? `<div class="ph-row">${other.map((a) => `<button class="ph-btn" data-act="nAct" data-k="${esc(n.key)}" data-i="${a.i}">${esc(a.title)}</button>`).join('')}</div>` : ''}
      ${reply ? `<div class="ph-reply"><input class="ph-inp" data-k="${esc(n.key)}" placeholder="${esc(reply.title || 'Odpowiedz')}…"><button data-act="nReply" data-k="${esc(n.key)}" title="Wyślij">${svg('send')}</button></div>` : ''}
    </div>`;
  }).join('');
}

function drawSms(d, perms) {
  if (!d.online) return '<p class="ph-muted">SMS-y widać, gdy telefon jest połączony.</p>';
  if (perms.sms === false) return '<p class="ph-muted">Zezwól w aplikacji na telefonie na „SMS-y i kontakty”.</p>';
  const top = '<button class="ph-btn ph-wide" data-act="newSms">' + svg('plus') + ' Nowy SMS</button>';
  if (!threads) return top + '<p class="ph-muted">Wczytuję…</p>';
  if (threads.error) return top + `<p class="ph-err">${esc(threads.error)}</p>`;
  return top + (threads.map((t) => `<button class="ph-item ph-thread" data-act="thread" data-k="${t.thread}">
      <div class="ph-top"><b>${esc(t.name || t.addr)}</b>${t.unread ? `<i class="ph-badge">${t.unread}</i>` : ''}<small>${when(t.date)}</small></div>
      <p>${t.out ? 'Ty: ' : ''}${esc(t.body)}</p></button>`).join('') || '<p class="ph-muted">Brak SMS-ów.</p>');
}

function drawRecs(d) {
  const mine = files.filter((f) => f.device === d.id && f.kind === 'nagrania');
  const waiting = phoneRecs.filter((r) => !r.sent).length;
  let out = '';
  if (d.online && waiting) out += `<div class="ph-row ph-note"><span>${waiting} ${waiting === 1 ? 'nagranie czeka' : 'nagrania czekają'} na telefonie</span><button class="ph-btn" data-act="fetch">Pobierz</button></div>`;
  if (!mine.length) return out + '<p class="ph-muted">Nagrania z dyktafonu pojawią się tutaj. Start: przycisk Dyktafon albo Ctrl+Alt+R.</p>';
  return out + mine.slice(0, 30).map((f) => `<div class="ph-item">
      <div class="ph-top"><b>${esc(f.name.replace(/^dyktafon-/, '').replace(/\.ogg$/, '').replace(/^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)$/, '$3.$2 $4:$5'))}</b><small>${kb(f.size)}</small>
        <span class="ph-acts">
          <button data-act="play" data-k="${esc(f.path)}" title="Odtwórz">${svg('play')}</button>
          <button data-act="text" data-k="${esc(f.path)}" title="Zamień na tekst (Ustawienia → Głos)">${svg('text')}</button>
          <button data-act="folder" data-k="${esc(f.path)}" title="Pokaż w folderze">${svg('folder')}</button>
          <button data-act="del" data-k="${esc(f.path)}" title="Usuń z komputera" class="del">${svg('trash')}</button>
        </span></div>
      ${audio[f.path] ? `<audio controls autoplay data-k="${esc(f.path)}"></audio>` : ''}
      ${busy === f.path ? '<p class="ph-muted">Zamieniam na tekst…</p>' : ''}
      ${texts[f.path] != null ? `<div class="ph-text"><p>${esc(texts[f.path]) || '<i>(cisza)</i>'}</p><button data-act="copy" data-k="${esc(f.path)}" title="Kopiuj">${svg('copy')}</button></div>` : ''}
    </div>`).join('');
}

function injectStyles(doc) {
  if (doc.getElementById('tx-phone-css')) return;
  const style = doc.createElement('style');
  style.id = 'tx-phone-css';
  style.textContent = `
    #tx-section{padding:2px 6px 8px}
    .ph-muted,.ph-hint{color:var(--muted-foreground);font-size:11.5px;margin:6px 2px}
    .ph-err{color:var(--destructive);font-size:12px;margin:6px 2px;white-space:pre-wrap}
    .ph-empty{display:flex;flex-direction:column;gap:8px;padding:4px 2px}
    .ph-empty p{margin:0;color:var(--muted-foreground);font-size:12px}
    .ph-btn,.ph-link,.ph-acts button,.ph-x,.ph-tabs button,.ph-rec,.ph-reply button,.ph-thread,.ph-text button{all:unset;cursor:pointer;box-sizing:border-box}
    .ph-btn{padding:4px 9px;border-radius:6px;border:1px solid var(--border);font-size:12px;display:inline-flex;align-items:center;gap:5px;justify-content:center}
    .ph-btn:hover{background:var(--accent)}
    .ph-pri{background:var(--primary);color:var(--primary-foreground);border-color:transparent;padding:6px 10px}
    .ph-pri:hover{background:color-mix(in oklab,var(--primary) 88%,black)}
    .ph-wide{display:flex;width:100%;margin-bottom:6px}
    .ph-link{color:var(--primary);font-size:12px;text-decoration:underline;text-underline-offset:2px}
    svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}
    .ph-dev{display:flex;align-items:center;gap:7px;padding:4px 2px;min-width:0}
    .ph-dev b{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ph-dev small{color:var(--muted-foreground);font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums}
    .ph-sel{background:transparent;color:var(--foreground);border:0;font:inherit;font-weight:600;min-width:0;max-width:130px}
    .ph-dot{width:7px;height:7px;border-radius:50%;background:var(--muted-foreground);flex:none;opacity:.6}
    .ph-dot.on{background:var(--chart-1);opacity:1;box-shadow:0 0 0 2px color-mix(in oklab,var(--chart-1) 25%,transparent)}
    .ph-acts{display:flex;gap:1px;margin-left:auto}
    .ph-acts button,.ph-x{width:22px;height:22px;display:grid;place-items:center;border-radius:5px;color:var(--muted-foreground)}
    .ph-acts button:hover,.ph-x:hover{background:var(--accent);color:var(--foreground)}
    .ph-acts .del:hover{color:var(--destructive)}
    .ph-rec{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;padding:7px;border-radius:8px;border:1px solid var(--border);margin:4px 0 2px;font-weight:500}
    .ph-rec:hover{background:var(--accent)}
    .ph-rec.on{background:color-mix(in oklab,var(--destructive) 16%,transparent);border-color:color-mix(in oklab,var(--destructive) 50%,transparent);color:var(--destructive);font-variant-numeric:tabular-nums}
    .ph-rec.on svg{fill:currentColor}
    .ph-tabs{display:flex;gap:2px;margin:8px 0 6px;border-bottom:1px solid var(--border)}
    .ph-tabs button{padding:5px 6px;font-size:12px;white-space:nowrap;color:var(--muted-foreground);border-bottom:2px solid transparent;margin-bottom:-1px}
    .ph-tabs button.on{color:var(--foreground);border-color:var(--primary)}
    .ph-tabs i{font-style:normal;font-size:10px;background:var(--muted);border-radius:8px;padding:0 5px;margin-left:2px}
    .ph-list{display:flex;flex-direction:column;gap:2px;max-height:420px;overflow:auto}
    .ph-item{display:flex;flex-direction:column;gap:2px;padding:6px 6px;border-radius:6px;min-width:0}
    .ph-item:hover{background:var(--accent)}
    .ph-item b{font-weight:500;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
    .ph-item p{margin:0;font-size:12px;color:var(--muted-foreground);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
    .ph-top{display:flex;align-items:center;gap:6px;min-width:0}
    .ph-top b{flex:1}
    .ph-top small{color:var(--muted-foreground);font-size:10.5px;white-space:nowrap}
    .ph-app{flex:1;overflow:hidden;text-overflow:ellipsis}
    .ph-x{width:18px;height:18px;opacity:.6}
    .ph-row{display:flex;gap:4px;flex-wrap:wrap;margin-top:3px}
    .ph-note{align-items:center;justify-content:space-between;font-size:12px;padding:4px 6px;background:var(--muted);border-radius:6px;margin-bottom:4px}
    .ph-badge{font-style:normal;font-size:10px;background:var(--primary);color:var(--primary-foreground);border-radius:8px;padding:0 5px}
    .ph-inp{width:100%;background:var(--background);color:var(--foreground);border:1px solid var(--border);border-radius:6px;padding:5px 7px;font:inherit;font-size:12px;resize:vertical}
    .ph-inp:focus{outline:2px solid color-mix(in oklab,var(--primary) 50%,transparent);outline-offset:-1px}
    .ph-reply{display:flex;gap:4px;margin-top:4px}
    .ph-reply button{width:28px;display:grid;place-items:center;border-radius:6px;color:var(--primary)}
    .ph-reply button:hover{background:var(--background)}
    .ph-thread{display:flex;cursor:pointer}
    .ph-text{display:flex;gap:4px;align-items:flex-start;background:var(--muted);border-radius:6px;padding:5px 6px;margin-top:3px}
    .ph-text p{-webkit-line-clamp:unset;color:var(--foreground);flex:1;user-select:text}
    .ph-text button{width:20px;height:20px;display:grid;place-items:center;border-radius:4px;color:var(--muted-foreground)}
    audio{width:100%;height:30px;margin-top:3px}
    .ph-pair{display:flex;gap:16px;align-items:flex-start}
    .ph-qr{width:170px;flex:none;background:#fff;border-radius:10px;padding:6px}
    .ph-qr svg{width:100%;height:auto;display:block}
    .ph-steps p{margin:0 0 8px;font-size:12.5px}
    .ph-code{font-family:var(--font-mono);font-size:22px;letter-spacing:.08em;font-weight:600;margin:4px 0 10px;user-select:all}
    .ph-conv{display:flex;flex-direction:column;gap:6px;max-height:50vh;overflow:auto;padding:2px}
    .ph-msg{align-self:flex-start;max-width:85%;background:var(--muted);border-radius:12px 12px 12px 4px;padding:6px 9px;display:flex;flex-direction:column;gap:2px}
    .ph-msg.out{align-self:flex-end;background:color-mix(in oklab,var(--primary) 22%,var(--card));border-radius:12px 12px 4px 12px}
    .ph-msg span{white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}
    .ph-msg small{color:var(--muted-foreground);font-size:10px;align-self:flex-end}
    .ph-compose{display:flex;gap:6px;align-items:flex-end;margin-top:8px}
    .ph-compose .ph-btn{padding:7px 12px}
  `;
  doc.head.appendChild(style);
}
