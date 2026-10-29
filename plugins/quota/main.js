// Quota: ile tokenów zostało do zużycia u wybranych providerów, na górnym albo dolnym pasku.
// Źródła (w tej kolejności): własny limit tokenów na dzień/miesiąc liczony z zużycia w aplikacji,
// limit z nagłówków ostatniej odpowiedzi (Anthropic, OpenAI), saldo konta (OpenRouter, DeepSeek), samo zużycie.
// Ustawienia w `quota.json`: { place: 'top' | 'bottom', providers: { [id]: { show, budget, period } } }.

const FILE = 'quota.json';
const BALANCE_MS = 5 * 60_000;

/** @type {import('../sdk/terminalx-plugin').TxApi} */
let tx;
let cfg = { place: 'bottom', providers: {} };
let info = { providers: [], usage: {} };
const items = new Map();       // id providera → element paska
const balances = {};           // id providera → { text, at } | null
let timer = null;

export async function activate(api) {
  tx = api;
  cfg = { place: 'bottom', providers: {}, ...(await tx.storage.readJson(FILE, {})) };
  tx.ui.commands.register('quota.settings', 'Quota: ustawienia', openSettings);
  tx.ai.onUsage(() => update());
  timer = setInterval(() => update(), 15_000);   // odliczanie do resetu limitów
  await update();
}

export function deactivate() {
  clearInterval(timer);
  for (const it of items.values()) it.dispose();
  items.clear();
}

/* ---------- dane ---------- */

const pc = (id) => ({ show: false, budget: 0, period: 'month', ...(cfg.providers[id] || {}) });
const save = () => tx.storage.writeJson(FILE, cfg);

function fmt(n) {
  const a = Math.abs(n), f = (x) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, '')).replace('.', ',');
  return a >= 1e9 ? `${f(n / 1e9)}G` : a >= 1e6 ? `${f(n / 1e6)}M` : a >= 1e3 ? `${f(n / 1e3)}k` : String(Math.round(n));
}
/** „5M”, „500k”, „1 000 000” → liczba tokenów; puste albo błędne → 0 (bez limitu). */
function parseBudget(s) {
  const m = /^([\d\s.,]+)\s*([kmg])?$/i.exec(String(s).trim());
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
  return isFinite(n) ? Math.round(n * ({ k: 1e3, m: 1e6, g: 1e9 }[(m[2] || '').toLowerCase()] || 1)) : 0;
}
const today = () => { const t = new Date(); return new Date(t - t.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
function used(u, period) {
  if (!u) return 0;
  return period === 'day' ? (u.day === today() ? u.dayIn + u.dayOut : 0) : (u.month === today().slice(0, 7) ? u.monthIn + u.monthOut : 0);
}
/** Okno limitu po resecie jest znowu pełne. */
const live = (l) => (l ? (l.reset && Date.now() > l.reset ? { ...l, remaining: l.limit } : l) : null);
function resetIn(ms) {
  const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

async function balance(p) {
  const b = balances[p.id];
  if (b && Date.now() - b.at < BALANCE_MS) return b.value;
  balances[p.id] = { at: Date.now(), value: b?.value ?? null };
  try { balances[p.id].value = await tx.ai.balance(p.id); } catch { /* brak klucza albo sieci: zostaje poprzednie */ }
  return balances[p.id].value;
}

/** Tekst, podpowiedź i kolor dla jednego providera. */
function view(p, u, c, bal) {
  const usedNow = used(u, c.period);
  const per = c.period === 'day' ? 'dziś' : 'w tym miesiącu';
  const tip = [p.name + (p.host ? ` (${p.host})` : '')];
  let text, variant = 'default';
  const tok = live(u?.limits?.tokens) || live(u?.limits?.input);
  if (c.budget > 0) {
    const rem = Math.max(0, c.budget - usedNow), pct = rem / c.budget;
    text = `${fmt(rem)} · ${Math.round(pct * 100)}%`;
    variant = pct < 0.05 ? 'error' : pct < 0.2 ? 'warning' : 'default';
    tip.push(`Zostało ${fmt(rem)} z ${fmt(c.budget)} tokenów (${c.period === 'day' ? 'limit dzienny' : 'limit miesięczny'})`);
  } else if (tok) {
    const pct = tok.limit ? tok.remaining / tok.limit : 1;
    text = `${fmt(tok.remaining)}/${fmt(tok.limit)}`;
    variant = pct < 0.05 ? 'error' : pct < 0.2 ? 'warning' : 'default';
  } else if (bal) {
    text = bal.text;
  } else {
    text = `${fmt(usedNow)} ${c.period === 'day' ? 'dziś' : 'mies.'}`;
  }
  if (u) {
    tip.push(`Zużyto ${per}: ${fmt(usedNow)} (wejście ${fmt(c.period === 'day' ? u.dayIn : u.monthIn)}, wyjście ${fmt(c.period === 'day' ? u.dayOut : u.monthOut)})`);
    tip.push(`Łącznie: ${fmt(u.totalIn + u.totalOut)} tokenów, zapytań: ${u.calls}`);
  } else tip.push('Brak zapytań do tego providera z aplikacji.');
  if (tok) tip.push(`Limit API: ${fmt(tok.remaining)} z ${fmt(tok.limit)} tokenów${tok.reset ? `, pełny za ${resetIn(tok.reset)}` : ''}`);
  const out = live(u?.limits?.output);
  if (out) tip.push(`Limit wyjścia: ${fmt(out.remaining)} z ${fmt(out.limit)}`);
  const req = live(u?.limits?.requests);
  if (req) tip.push(`Zapytania: ${req.remaining} z ${req.limit}`);
  if (bal) tip.push(`Saldo: ${bal.text}`);
  tip.push('Kliknij: ustawienia Quota');
  return { text: `${p.name} ${text}`, tooltip: tip.join('\n'), variant };
}

async function update() {
  info = await tx.ai.usage();
  const shown = info.providers.filter((p) => pc(p.id).show);
  for (const [id, it] of items) if (!shown.some((p) => p.id === id)) { it.dispose(); items.delete(id); }
  for (const [i, p] of shown.entries()) {
    let it = items.get(p.id);
    if (!it) {
      it = tx.ui.statusBar.createItem({ id: `quota-${p.id}`, alignment: 'right', priority: 60 - i / 100 });
      it.icon = 'activity';
      it.onClick = openSettings;
      items.set(p.id, it);
    }
    const c = pc(p.id);
    const bal = c.budget > 0 ? null : await balance(p);
    Object.assign(it, view(p, info.usage[p.id], c, bal));
    it.place = cfg.place;
    it.show();
  }
}

/* ---------- ustawienia ---------- */

async function openSettings() {
  info = await tx.ai.usage();
  tx.ui.dialog.open({
    title: 'Quota',
    width: 560,
    render(el) {
      injectStyles(el.ownerDocument);
      const rows = info.providers.map((p) => {
        const c = pc(p.id), u = info.usage[p.id];
        return `<div class="qr" data-id="${p.id}">
          <label class="qs" title="Pokaż na pasku"><input type="checkbox" data-f="show" ${c.show ? 'checked' : ''}></label>
          <div class="qn"><b>${esc(p.name)}</b><small>${esc(p.host || p.type)}${u ? ` · ${fmt(used(u, c.period))} ${c.period === 'day' ? 'dziś' : 'w tym miesiącu'}` : ''}</small></div>
          <input class="qi" data-f="budget" placeholder="bez limitu" value="${c.budget ? fmt(c.budget).replace(',', '.') : ''}" title="Limit tokenów, np. 500k, 5M">
          <select class="qi" data-f="period"><option value="day" ${c.period === 'day' ? 'selected' : ''}>na dzień</option><option value="month" ${c.period !== 'day' ? 'selected' : ''}>na miesiąc</option></select>
        </div>`;
      }).join('');
      el.innerHTML = `
        <div class="qplace"><span>Gdzie pokazywać</span>
          <div class="qseg"><button data-place="top" class="${cfg.place === 'top' ? 'on' : ''}">Górny pasek</button><button data-place="bottom" class="${cfg.place !== 'top' ? 'on' : ''}">Dolny pasek</button></div></div>
        <div class="qlist">${rows || '<p class="qhint">Brak providerów czatu. Dodaj je w Ustawienia → Providerzy.</p>'}</div>
        <p class="qhint">Zaznacz providerów widocznych na pasku. Z limitem tokenów pasek pokazuje, ile z niego zostało (liczone z zapytań wysłanych z aplikacji). Bez limitu: limit API z ostatniej odpowiedzi (Anthropic, OpenAI), saldo konta (OpenRouter, DeepSeek) albo samo zużycie.</p>`;
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-place]');
        if (!b) return;
        cfg.place = b.dataset.place;
        el.querySelectorAll('[data-place]').forEach((x) => x.classList.toggle('on', x === b));
        save(); update();
      });
      el.addEventListener('change', (e) => {
        const row = e.target.closest('.qr');
        if (!row) return;
        const c = (cfg.providers[row.dataset.id] = pc(row.dataset.id));
        const f = e.target.dataset.f;
        if (f === 'show') c.show = e.target.checked;
        if (f === 'budget') { c.budget = parseBudget(e.target.value); e.target.value = c.budget ? fmt(c.budget).replace(',', '.') : ''; }
        if (f === 'period') c.period = e.target.value;
        save(); update();
      });
    },
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function injectStyles(doc) {
  if (doc.getElementById('tx-quota-css')) return;
  const style = doc.createElement('style');
  style.id = 'tx-quota-css';
  style.textContent = `
    .qplace{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12.5px}
    .qseg{display:flex;border:1px solid var(--border);border-radius:7px;overflow:hidden}
    .qseg button{font:inherit;font-size:12px;border:0;background:none;color:var(--muted-foreground);padding:5px 10px;cursor:pointer}
    .qseg button.on{background:var(--muted);color:var(--foreground)}
    .qlist{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:8px;overflow:hidden}
    .qr{display:grid;grid-template-columns:auto 1fr 96px 104px;gap:8px;align-items:center;padding:7px 10px;border-top:1px solid var(--border)}
    .qr:first-child{border-top:0}
    .qs input{accent-color:var(--primary);width:14px;height:14px;cursor:pointer}
    .qn{min-width:0;display:flex;flex-direction:column}
    .qn b{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .qn small{color:var(--muted-foreground);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .qi{font:inherit;font-size:12px;color:var(--foreground);background:var(--background);border:1px solid var(--border);border-radius:6px;padding:4px 7px;outline:none;min-width:0}
    .qi:focus{border-color:var(--primary)}
    .qhint{margin:0;color:var(--muted-foreground);font-size:11.5px;line-height:1.5}`;
  doc.head.appendChild(style);
}
