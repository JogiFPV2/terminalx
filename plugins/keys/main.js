// Klucze API: providerzy (nazwa + opcjonalny link) i ich klucze w pasku bocznym.
// W pliku `providers.json` pluginu są tylko nazwy, linki i etykiety. Same klucze trzyma host w magazynie
// poświadczeń systemu (tx.keys): plugin dostaje wersję zamaskowaną, a pełny klucz kopiuje do schowka host.

const FILE = 'providers.json';

/** @type {import('../sdk/terminalx-plugin').TxApi} */
let tx;
let root;
let data = { providers: [] };   // [{ id, name, url, open, keys: [{ id, label }] }]
let masked = {};                // id klucza → zamaskowany klucz (null: brak w sejfie)

export async function activate(api) {
  tx = api;
  data = await tx.storage.readJson(FILE, { providers: [] });
  tx.ui.sidebar.registerSection({
    id: 'keys',
    title: 'Klucze API',
    icon: 'key',
    actions: [{ id: 'new-provider', icon: 'plus', title: 'Nowy provider', run: () => editProvider(null) }],
    render(el) {
      root = el;
      injectStyles(el.ownerDocument);
      el.addEventListener('click', onClick);
      refresh();
    },
  });
  tx.ui.commands.register('keys.newProvider', 'Klucze API: nowy provider', () => editProvider(null));
}

export function deactivate() { root = null; }

/* ---------- model ---------- */

const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const save = () => tx.storage.writeJson(FILE, data);
const findProvider = (id) => data.providers.find((p) => p.id === id);
function findKey(id) {
  for (const p of data.providers) { const k = p.keys.find((x) => x.id === id); if (k) return { p, k }; }
  return null;
}

async function refresh() {
  const ids = data.providers.flatMap((p) => p.keys.map((k) => k.id));
  masked = ids.length ? await tx.keys.masked(ids).catch(() => ({})) : {};
  render();
}

function validUrl(s) {
  if (!s) return '';
  const v = /^[a-z]+:\/\//i.test(s) ? s : `https://${s}`;
  try { const u = new URL(v); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
}

/* ---------- akcje ---------- */

function editProvider(p) {
  tx.ui.dialog.open({
    title: p ? 'Edytuj providera' : 'Nowy provider',
    width: 420,
    render(el, dialog) {
      el.innerHTML = `
        <label class="kf"><span>Nazwa</span><input class="kin" data-f="name" placeholder="np. OpenAI" maxlength="80"></label>
        <label class="kf"><span>Link (opcjonalnie)</span><input class="kin" data-f="url" placeholder="https://platform.openai.com/api-keys" maxlength="500"></label>
        <p class="kerr" hidden></p>
        <div class="kfoot"><button class="kbtn" data-act="cancel">Anuluj</button><button class="kbtn kpri" data-act="save">Zapisz</button></div>`;
      injectStyles(el.ownerDocument);
      const name = el.querySelector('[data-f=name]'), url = el.querySelector('[data-f=url]'), err = el.querySelector('.kerr');
      name.value = p?.name || '';
      url.value = p?.url || '';
      name.focus();
      const ok = async () => {
        const n = name.value.trim(), u = validUrl(url.value.trim());
        const fail = !n ? 'Podaj nazwę providera.' : u === null ? 'Link musi zaczynać się od http:// albo https://.' : '';
        if (fail) { err.textContent = fail; err.hidden = false; return; }
        if (p) Object.assign(p, { name: n, url: u });
        else data.providers.push({ id: uid('p'), name: n, url: u, open: true, keys: [] });
        await save();
        dialog.close();
        render();
      };
      el.querySelector('[data-act=save]').onclick = ok;
      el.querySelector('[data-act=cancel]').onclick = () => dialog.close();
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
    },
  });
}

async function addKey(p) {
  const id = uid('k');
  const r = await tx.keys.add(id, { title: `Nowy klucz · ${p.name}`, message: 'Klucz trafi do magazynu poświadczeń systemu. Na liście będzie częściowo ukryty.' });
  if (!r) return;
  p.keys.push({ id, label: '' });
  p.open = true;
  masked[id] = r.masked;
  await save();
  render();
}

function renameKey(k) {
  tx.ui.dialog.open({
    title: 'Nazwa klucza',
    width: 380,
    render(el, dialog) {
      el.innerHTML = `
        <label class="kf"><span>Nazwa (opcjonalnie)</span><input class="kin" placeholder="np. produkcja, prywatny" maxlength="60"></label>
        <div class="kfoot"><button class="kbtn" data-act="cancel">Anuluj</button><button class="kbtn kpri" data-act="save">Zapisz</button></div>`;
      injectStyles(el.ownerDocument);
      const inp = el.querySelector('input');
      inp.value = k.label || '';
      inp.focus();
      inp.select();
      const ok = async () => { k.label = inp.value.trim(); await save(); dialog.close(); render(); };
      el.querySelector('[data-act=save]').onclick = ok;
      el.querySelector('[data-act=cancel]').onclick = () => dialog.close();
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
    },
  });
}

async function removeKey(p, k) {
  const sure = await tx.ui.dialog.confirm({ title: 'Usunąć klucz?', message: `${k.label || masked[k.id] || 'Klucz'} (${p.name}) zniknie z sejfu. Tego nie da się cofnąć.`, confirmLabel: 'Usuń', danger: true });
  if (!sure) return;
  await tx.keys.delete(k.id);
  p.keys = p.keys.filter((x) => x !== k);
  await save();
  render();
}

async function removeProvider(p) {
  const n = p.keys.length;
  const sure = await tx.ui.dialog.confirm({ title: `Usunąć ${p.name}?`, message: n ? `Razem z providerem z sejfu znikną jego klucze (${n}). Tego nie da się cofnąć.` : 'Provider nie ma kluczy.', confirmLabel: 'Usuń', danger: true });
  if (!sure) return;
  for (const k of p.keys) await tx.keys.delete(k.id).catch(() => {});
  data.providers = data.providers.filter((x) => x !== p);
  await save();
  render();
}

async function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const row = btn.closest('[data-p]');
  const p = row && findProvider(row.dataset.p);
  const k = btn.closest('[data-k]') && findKey(btn.closest('[data-k]').dataset.k)?.k;
  switch (btn.dataset.act) {
    case 'toggle': p.open = !p.open; await save(); render(); break;
    case 'link': tx.ui.openExternal(p.url); break;
    case 'add-key': addKey(p); break;
    case 'edit': editProvider(p); break;
    case 'del': removeProvider(p); break;
    case 'copy': tx.keys.copy(k.id, k.label ? `klucz „${k.label}”` : `klucz ${p.name}`).catch((err) => tx.ui.notify({ title: 'Nie skopiowano', body: String(err), level: 'error' })); break;
    case 'rename': renameKey(k); break;
    case 'del-key': removeKey(p, k); break;
  }
}

/* ---------- rendering ---------- */

const ICON = {
  chev: '<path d="m9 6 6 6-6 6"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M17 6l3 3M14 9l2 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  link: '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24">${ICON[name]}</svg>`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function render() {
  if (!root) return;
  if (!data.providers.length) {
    root.innerHTML = '<div class="kempty">Brak providerów. Kliknij +, żeby dodać.</div>';
    return;
  }
  root.innerHTML = `<div class="keys">${data.providers.map((p) => `
    <div class="kp${p.open ? ' open' : ''}" data-p="${p.id}">
      <div class="kr prov">
        <button class="chev" data-act="toggle" aria-label="${p.open ? 'Zwiń' : 'Rozwiń'}">${svg('chev')}</button>
        <span class="nm" data-act="toggle" title="${esc(p.url || p.name)}">${esc(p.name)}</span>
        ${p.keys.length ? `<span class="cnt">${p.keys.length}</span>` : ''}
        <span class="acts">
          ${p.url ? `<button data-act="link" title="Otwórz ${esc(p.url)}">${svg('link')}</button>` : ''}
          <button data-act="add-key" title="Dodaj klucz">${svg('plus')}</button>
          <button data-act="edit" title="Edytuj providera">${svg('edit')}</button>
          <button class="del" data-act="del" title="Usuń providera">${svg('trash')}</button>
        </span>
      </div>
      ${p.open ? p.keys.map((k) => `
        <div class="kr key" data-k="${k.id}">
          ${svg('key')}
          <span class="kv">${k.label ? `<span class="lb">${esc(k.label)}</span>` : ''}<code class="${masked[k.id] ? '' : 'miss'}">${masked[k.id] ? esc(masked[k.id]) : 'brak w sejfie'}</code></span>
          <span class="acts">
            <button data-act="rename" title="Nazwa klucza">${svg('edit')}</button>
            <button class="del" data-act="del-key" title="Usuń klucz">${svg('trash')}</button>
          </span>
          <button class="cp" data-act="copy" title="Kopiuj pełny klucz" ${masked[k.id] ? '' : 'disabled'}>${svg('copy')}</button>
        </div>`).join('') + (p.keys.length ? '' : `<div class="kr key none"><button class="add" data-act="add-key">${svg('plus')} Dodaj klucz</button></div>`) : ''}
    </div>`).join('')}</div>`;
}

function injectStyles(doc) {
  if (doc.getElementById('tx-keys-css')) return;
  const style = doc.createElement('style');
  style.id = 'tx-keys-css';
  style.textContent = `
    .keys{display:flex;flex-direction:column;gap:1px;padding-bottom:6px}
    .keys svg{width:14px;height:14px;flex:none;stroke:currentColor;fill:none;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
    .kr{display:flex;align-items:center;gap:6px;min-height:26px;padding:0 3px 0 6px;border-radius:5px;color:var(--muted-foreground);user-select:none}
    .kr:hover{background:var(--accent);color:var(--foreground)}
    .kr button{all:unset;cursor:pointer;display:grid;place-items:center;border-radius:4px}
    .kr .chev{width:16px;height:16px;margin-left:-4px}
    .kr .chev svg{width:12px;height:12px;transition:transform .12s}
    .kp.open .chev svg{transform:rotate(90deg)}
    .prov .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;color:var(--foreground);font-weight:500}
    .cnt{font-size:10.5px;color:var(--muted-foreground);opacity:.8}
    .acts{display:flex;gap:1px;opacity:0}
    .kr:hover .acts,.kr:focus-within .acts{opacity:1}
    .acts button,.cp{width:20px;height:20px}
    .acts button:hover,.cp:hover{background:var(--background);color:var(--foreground)}
    .acts svg,.cp svg{width:12px;height:12px}
    .acts .del:hover{color:var(--destructive)}
    .key{padding-left:22px}
    .key>svg{width:12px;height:12px;opacity:.6}
    .kv{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.25;padding:3px 0}
    .kv .lb{font-size:11.5px;color:var(--foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .kv code{font-family:var(--font-mono);font-size:11.5px;letter-spacing:.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .kv code.miss{font-style:italic;opacity:.7;font-family:inherit}
    .cp{color:var(--muted-foreground);opacity:.75}
    .cp:hover{opacity:1;color:var(--primary)}
    .cp[disabled]{opacity:.25;cursor:default}
    .none .add{display:flex;gap:5px;align-items:center;font-size:12px;opacity:.8}
    .none .add svg{width:12px;height:12px}
    .kempty{padding:4px 8px;color:var(--muted-foreground);font-size:12px}
    .kf{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted-foreground)}
    .kin{font:inherit;font-size:13px;color:var(--foreground);background:var(--background);border:1px solid var(--border);border-radius:6px;padding:6px 8px;outline:none}
    .kin:focus{border-color:var(--primary)}
    .kerr{margin:0;color:var(--destructive);font-size:12px}
    .kfoot{display:flex;justify-content:flex-end;gap:8px;border-top:1px solid var(--border);padding-top:10px}
    .kbtn{font:inherit;font-size:12px;font-weight:500;padding:5px 10px;border-radius:6px;border:1px solid var(--border);background:none;color:inherit;cursor:pointer}
    .kpri{background:var(--primary);border-color:var(--primary);color:var(--primary-foreground)}`;
  doc.head.appendChild(style);
}
