// Procesy w tle: zakładki z działającym procesem odłożone do sekcji w pasku bocznym.
// Zakładka trafia tu przez przeciągnięcie na sekcję albo przez PPM na zakładce. Proces działa dalej,
// a „Przywróć” odkłada zakładkę na jej poprzednie miejsce. Po wyłączeniu pluginu host sam oddaje
// wszystkie zaparkowane zakładki do ich workspace'ów.

/** @type {import('../sdk/hermitty-plugin').TxApi} */
let tx;
let root = null;
let section = null;
let tabs = [];
let timer = null;
let drawSeq = 0;

export function activate(api) {
  tx = api;
  section = tx.ui.sidebar.registerSection({
    id: 'bg',
    title: 'Procesy w tle',
    icon: 'layers',
    onTabDrop: (tabId) => park(tabId),
    render(el) {
      root = el;
      injectStyles(el.ownerDocument);
      el.addEventListener('click', onClick);
      refresh();
    },
  });
  tx.ui.tabMenu.onSelect((item, tabId) => { if (item === 'park') park(tabId); });
  tx.tabs.onChanged((list) => { tabs = list; draw(); });
  tx.config.onChange(schedule);
  schedule();
}

export function deactivate() {
  clearInterval(timer);
  root = null;
}

function schedule() {
  clearInterval(timer);
  // Odświeżanie tylko dla czasu działania i ostatniej linii; zmiany zakładek przychodzą zdarzeniem.
  timer = setInterval(refresh, Math.max(2, tx.config.get('refreshSec')) * 1000);
}

async function refresh() {
  tabs = await tx.tabs.list();
  await draw();
}

async function park(id) {
  const t = await tx.tabs.get(id);
  if (!t || t.kind !== 'terminal' || t.parked) return;
  await tx.tabs.park(id);
  section.reveal();
  await refresh();
}

async function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const t = tabs.find((x) => x.id === id);
  if (!t) return;

  switch (btn.dataset.act) {
    case 'park':
      await park(id);
      break;
    case 'restore':
      await tx.tabs.unpark(id, { focus: true });
      await refresh();
      break;
    case 'stop': {
      if (tx.config.get('confirmStop')) {
        const ok = await tx.ui.dialog.confirm({
          title: `Zatrzymać „${t.title}”?`,
          message: `${t.process ? t.process.command : 'Proces'} zostanie zakończony. Przez 20 s możesz to cofnąć.`,
          confirmLabel: 'Zatrzymaj',
          danger: true,
        });
        if (!ok) return;
      }
      await tx.tabs.close(id, { label: `Zatrzymano „${t.title}”` });
      await refresh();
      break;
    }
    case 'peek':
      peek(t);
      break;
  }
}

async function peek(t) {
  const lines = await tx.tabs.tail(t.id, 200);
  tx.ui.dialog.open({
    title: `${t.title} · ${t.process ? t.process.command : ''}`,
    width: 640,
    render(el, dialog) {
      injectStyles(el.ownerDocument);
      el.innerHTML = `<pre class="bg-peek">${escapeHtml(lines.join('\n'))}</pre>
        <div class="bg-foot"><small>Proces działa w tle. Podgląd go nie przerywa.</small>
          <button class="bg-btn" data-x="close">Zamknij</button>
          <button class="bg-btn bg-pri" data-x="restore">Przywróć zakładkę</button></div>`;
      const pre = el.querySelector('pre');
      pre.scrollTop = pre.scrollHeight;
      el.addEventListener('click', async (e) => {
        const x = e.target.closest('[data-x]')?.dataset.x;
        if (x === 'close') dialog.close();
        if (x === 'restore') { dialog.close(); await tx.tabs.unpark(t.id, { focus: true }); refresh(); }
      });
    },
  });
}

/* ---------- rendering ---------- */

const ICON = {
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24">${ICON[name]}</svg>`;

function uptime(startedAt) {
  const m = Math.floor((Date.now() - startedAt) / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

async function draw() {
  if (!root) return;
  const seq = ++drawSeq; // starsze, wolniejsze rysowanie nie nadpisze nowszego
  const parked = tabs.filter((t) => t.parked);
  const suggested = tx.config.get('suggestRunning') ? tabs.filter((t) => !t.parked && t.process && !t.process.idleShell) : [];
  const last = tx.config.get('showLastLine')
    ? await Promise.all(parked.map((t) => tx.tabs.tail(t.id, 1).then((l) => l[0] || '').catch(() => '')))
    : [];
  if (seq !== drawSeq || !root) return;

  section.setBadge(parked.length || null);
  root.innerHTML = parked.map((t, i) => `
    <div class="bg-row">
      <div class="bg-top"><span class="bg-dot" title="Proces działa"></span><b title="${escapeHtml(t.process ? t.process.command : '')}">${escapeHtml(t.title)}</b>
        <span class="bg-acts">
          <button data-act="peek" data-id="${t.id}" title="Podgląd">${svg('eye')}</button>
          <button data-act="restore" data-id="${t.id}" title="Przywróć do ${escapeHtml(t.workspaceName)}">${svg('undo')}</button>
          <button class="del" data-act="stop" data-id="${t.id}" title="Zatrzymaj proces">${svg('stop')}</button>
        </span></div>
      <div class="bg-meta">${escapeHtml(t.workspaceName)}${t.process ? ` · ${uptime(t.process.startedAt)}` : ''}</div>
      ${last[i] ? `<div class="bg-last" title="${escapeHtml(last[i])}">${escapeHtml(last[i])}</div>` : ''}
    </div>`).join('')
    + '<div class="bg-hint">Przeciągnij tu zakładkę albo kliknij ją prawym przyciskiem.</div>'
    + (suggested.length ? '<div class="bg-label">Wykryte procesy</div>' + suggested.map((t) => `
      <div class="bg-sugg"><span><code>${escapeHtml(t.process.command)}</code> · ${escapeHtml(t.title)}</span>
        <button data-act="park" data-id="${t.id}">Przenieś</button></div>`).join('') : '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function injectStyles(doc) {
  if (doc.getElementById('tx-bg-css')) return;
  const style = doc.createElement('style');
  style.id = 'tx-bg-css';
  style.textContent = `
    .bg-row{display:flex;flex-direction:column;gap:2px;padding:5px 3px 5px 8px;border-radius:5px;color:var(--muted-foreground)}
    .bg-row:hover{background:var(--accent)}
    .bg-top{display:flex;align-items:center;gap:7px;min-width:0}
    .bg-top b{font-weight:500;color:var(--foreground);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .bg-dot{width:6px;height:6px;border-radius:50%;background:var(--chart-1);box-shadow:0 0 0 2px color-mix(in oklab,var(--chart-1) 25%,transparent);flex:none}
    .bg-meta{font-size:11px;padding-left:13px;font-variant-numeric:tabular-nums}
    .bg-last{font-family:var(--font-mono);font-size:10.5px;padding-left:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85}
    .bg-acts{display:flex;gap:1px;opacity:.5}
    .bg-row:hover .bg-acts,.bg-row:focus-within .bg-acts{opacity:1}
    .bg-acts button,.bg-sugg button,.bg-btn{all:unset;cursor:pointer;border-radius:4px}
    .bg-acts button{width:20px;height:20px;display:grid;place-items:center}
    .bg-acts button:hover{background:var(--background);color:var(--foreground)}
    .bg-acts .del:hover{color:var(--destructive)}
    .bg-acts svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
    .bg-hint{margin:4px 3px 2px;padding:8px;border:1px dashed var(--border);border-radius:6px;font-size:11.5px;color:var(--muted-foreground);text-align:center}
    .bg-label{padding:8px 8px 3px;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted-foreground);font-weight:500}
    .bg-sugg{display:flex;align-items:center;gap:6px;padding:3px 3px 3px 8px;font-size:11.5px;color:var(--muted-foreground)}
    .bg-sugg span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .bg-sugg code{font-family:var(--font-mono);font-size:10.5px;color:var(--foreground)}
    .bg-sugg button{font-size:11px;padding:1px 7px;border:1px solid var(--border);color:var(--foreground)}
    .bg-peek{margin:0;font-family:var(--font-mono);font-size:12px;line-height:1.55;white-space:pre-wrap;max-height:360px;overflow:auto;background:var(--term-bg,var(--background));padding:10px;border-radius:6px}
    .bg-foot{display:flex;gap:8px;align-items:center;padding-top:10px}
    .bg-foot small{margin-right:auto;color:var(--muted-foreground)}
    .bg-btn{font-size:12px;font-weight:500;padding:5px 10px;border:1px solid var(--border)}
    .bg-pri{background:var(--primary);border-color:var(--primary);color:var(--primary-foreground)}`;
  doc.head.appendChild(style);
}
