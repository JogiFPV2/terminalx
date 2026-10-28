// Porty: lista nasłuchujących portów TCP z nazwą procesu.
// Windows: netstat + tasklist. Linux: ss. macOS: lsof.

/** @type {import('../sdk/terminalx-plugin').TxApi} */
let tx;
let root = null;
let timer = null;
let ports = [];

export function activate(api) {
  tx = api;
  tx.ui.sidebar.registerSection({
    id: 'ports',
    title: 'Porty',
    icon: 'plug',
    actions: [{ id: 'refresh', icon: 'refresh-cw', title: 'Odśwież', run: () => refresh() }],
    render(el) {
      root = el;
      injectStyles(el.ownerDocument);
      el.addEventListener('click', onClick);
      schedule();
    },
  });
  tx.config.onChange(schedule);
}

export function deactivate() {
  clearInterval(timer);
  root = null;
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(refresh, Math.max(2, tx.config.get('refreshSec')) * 1000);
  refresh();
}

async function refresh() {
  if (!root) return;
  try {
    ports = await listPorts();
    if (tx.config.get('hideSystemPorts')) ports = ports.filter((p) => p.port >= 1024);
    draw();
  } catch (err) {
    root.innerHTML = `<div class="pt-empty">Nie udało się odczytać portów: ${escapeHtml(err.message)}</div>`;
  }
}

async function listPorts() {
  const os = tx.platform.os;
  if (os === 'windows') {
    const net = await tx.shell.exec('netstat', ['-ano', '-p', 'TCP']);
    const names = new Map();
    const tl = await tx.shell.exec('tasklist', ['/FO', 'CSV', '/NH']);
    for (const line of tl.stdout.split(/\r?\n/)) {
      const m = /^"([^"]+)","(\d+)"/.exec(line);
      if (m) names.set(+m[2], m[1]);
    }
    return dedupe(net.stdout.split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c[0] === 'TCP' && c[3] === 'LISTENING')
      .map((c) => ({ port: +c[1].slice(c[1].lastIndexOf(':') + 1), pid: +c[4], name: names.get(+c[4]) || `PID ${c[4]}` })));
  }
  if (os === 'linux') {
    const r = await tx.shell.exec('ss', ['-ltnpH']);
    return dedupe(r.stdout.split('\n').filter(Boolean).map((l) => {
      const c = l.trim().split(/\s+/);
      const proc = /users:\(\("([^"]+)",pid=(\d+)/.exec(l);
      return { port: +c[3].slice(c[3].lastIndexOf(':') + 1), pid: proc ? +proc[2] : 0, name: proc ? proc[1] : '?' };
    }));
  }
  const r = await tx.shell.exec('lsof', ['-iTCP', '-sTCP:LISTEN', '-n', '-P']);
  return dedupe(r.stdout.split('\n').slice(1).filter(Boolean).map((l) => {
    const c = l.trim().split(/\s+/);
    return { port: +c[8].slice(c[8].lastIndexOf(':') + 1), pid: +c[1], name: c[0] };
  }));
}

function dedupe(list) {
  const seen = new Map();
  list.forEach((p) => { if (p.port && !seen.has(p.port)) seen.set(p.port, p); });
  return [...seen.values()].sort((a, b) => a.port - b.port);
}

async function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const p = ports.find((x) => x.port === +btn.dataset.port);
  if (!p) return;
  if (btn.dataset.act === 'open') tx.ui.openExternal(`http://localhost:${p.port}`);
  if (btn.dataset.act === 'kill') {
    if (tx.config.get('confirmKill')) {
      const ok = await tx.ui.dialog.confirm({
        title: `Zatrzymać ${p.name}?`,
        message: `Proces ${p.pid} nasłuchuje na porcie ${p.port}. Niezapisane dane tego procesu zostaną utracone.`,
        confirmLabel: 'Zatrzymaj',
        danger: true,
      });
      if (!ok) return;
    }
    const r = tx.platform.os === 'windows'
      ? await tx.shell.exec('taskkill', ['/PID', String(p.pid), '/F'])
      : await tx.shell.exec('kill', [String(p.pid)]);
    if (r.code !== 0) tx.ui.notify({ title: 'Nie zatrzymano procesu', body: r.stderr.trim(), level: 'error' });
    refresh();
  }
}

function draw() {
  root.innerHTML = ports.length
    ? ports.map((p) => `<div class="pt">
        <code>:${p.port}</code><span title="PID ${p.pid}">${escapeHtml(p.name)}</span>
        <span class="acts">
          <button data-act="open" data-port="${p.port}" title="Otwórz w przeglądarce"><svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4 10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></button>
          <button data-act="kill" data-port="${p.port}" title="Zatrzymaj proces"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        </span></div>`).join('')
    : '<div class="pt-empty">Nic nie nasłuchuje.</div>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function injectStyles(doc) {
  if (doc.getElementById('tx-ports-css')) return;
  const style = doc.createElement('style');
  style.id = 'tx-ports-css';
  style.textContent = `
    .pt{display:flex;align-items:center;gap:8px;height:26px;padding:0 3px 0 8px;border-radius:5px;color:var(--muted-foreground);font-variant-numeric:tabular-nums}
    .pt:hover{background:var(--accent);color:var(--foreground)}
    .pt code{font-family:var(--font-mono);font-size:11.5px;color:var(--foreground);width:3.6em}
    .pt > span:not(.acts){flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pt .acts{display:flex;opacity:.45}.pt:hover .acts{opacity:1}
    .pt button{all:unset;cursor:pointer;width:20px;height:20px;display:grid;place-items:center;border-radius:4px}
    .pt button:hover{background:var(--background);color:var(--foreground)}
    .pt svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
    .pt-empty{padding:4px 8px;color:var(--muted-foreground);font-size:12px}`;
  doc.head.appendChild(style);
}
