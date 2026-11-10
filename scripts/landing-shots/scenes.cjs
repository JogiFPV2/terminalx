const { chromium } = require('playwright'); const fs = require('fs');
const D = __dirname, OUT = process.argv[2] || D + '/out', ONLY = (process.argv[3] || '').split(',').filter(Boolean), MODES = (process.argv[4] || 'light').split(',');
fs.mkdirSync(OUT, { recursive: true });

// Wspólne przygotowanie w stronie: motyw, workspace'y, zakładki, hosty.
const BASE = async (mode) => {
  const S = await import('/src/lib/state.svelte.ts');
  const { app, ui, newTab, addWorkspace } = S;
  await document.fonts.ready;
  Object.assign(app.settings, { themeName: 'Pinsy', themeMode: mode, fontFamily: '"JetBrains Mono", monospace', fontSize: 13, lang: 'pl' });
  for (const id of ['tx.phone', 'tx.sysmon']) { const r = app.plugins.find((p) => p.id === id); if (r) r.enabled = true; }
  const q = app.plugins.find((p) => p.id === 'tx.quota'); if (q) q.enabled = false;
  app.hosts.push(
    { id: 'h1', name: 'prod-web-1', host: '10.0.0.21', port: 22, user: 'deploy', auth: 'key', keyPath: '~/.ssh/id_ed25519', secretRef: '', hasSecret: false, group: 'Produkcja', tags: ['prod', 'web'], distro: 'ubuntu', forwards: [], lastUsed: Date.now() - 6e5 },
    { id: 'h2', name: 'prod-db', host: '10.0.0.30', port: 22, user: 'admin', auth: 'key', keyPath: '~/.ssh/id_ed25519', secretRef: '', hasSecret: false, group: 'Produkcja', tags: ['prod', 'db'], distro: 'debian', forwards: [{ id: 'f1', kind: 'local', bindPort: 5433, targetHost: 'localhost', targetPort: 5432, auto: true }], lastUsed: Date.now() - 864e5 },
    { id: 'h3', name: 'staging', host: 'staging.example.dev', port: 2222, user: 'deploy', auth: 'agent', keyPath: '', secretRef: '', hasSecret: false, group: 'Testy', tags: ['staging'], distro: 'ubuntu', forwards: [] },
    { id: 'h4', name: 'raspberry', host: '192.168.1.50', port: 22, user: 'pi', auth: 'password', keyPath: '', secretRef: 'x', hasSecret: true, group: 'Dom', tags: [], distro: 'raspbian', forwards: [] });
  const ws = app.workspaces[0];
  ws.name = 'api'; ws.color = 'var(--chart-2)';
  ws.tabs[0].title = 'api';
  const wsl = newTab('wsl:Ubuntu', ws.id, '~/app'); wsl.title = 'ubuntu';
  const ssh = newTab('ssh:h1', ws.id); ssh.title = 'deploy@prod-web-1';
  const web = newTab('pwsh', ws.id, 'C:\\dev\\web'); web.title = 'web · dev';
  const cmd = newTab('cmd', ws.id); cmd.title = 'cmd';
  const w2 = addWorkspace(); const infra = app.workspaces[app.workspaces.length - 1]; infra.name = 'Infra'; infra.color = 'color-mix(in oklab, var(--chart-3) 50%, var(--destructive))';
  addWorkspace(); const ai = app.workspaces[app.workspaces.length - 1]; ai.name = 'Projekt AI'; ai.color = 'var(--chart-4)';
  ui.renamingWs = null;
  app.activeWs = ws.id; ws.activeTab = ws.tabs[0].id;
  app.layout.side = 240; app.layout.agentOpen = false;
  window.__T = { ws: ws.id, api: ws.tabs[0].id, wsl: wsl.id, ssh: ssh.id, web: web.id, cmd: cmd.id };
};

// Sceny: nazwa → kod w stronie (przed zrzutem) i opcjonalna akcja Playwright.
const SCENES = {
  /* ---------- terminale ---------- */
  'term-ps': async () => { const { app } = await import('/src/lib/state.svelte.ts'); app.workspaces[0].activeTab = __T.api; },
  'term-wsl': async () => { const { app } = await import('/src/lib/state.svelte.ts'); app.workspaces[0].activeTab = __T.wsl; },
  'term-ssh': async () => { const { app } = await import('/src/lib/state.svelte.ts'); app.workspaces[0].activeTab = __T.ssh; },
  'term-vault': async () => { const { openVault } = await import('/src/lib/hosts.svelte.ts'); openVault(); },
  'term-windows': async () => {
    const { app } = await import('/src/lib/state.svelte.ts'); const ws = app.workspaces[0];
    ws.mode = 'windows'; ws.activeTab = __T.ssh;
  },
  /* ---------- workflow ---------- */
  'flow-canvas': async () => { await window.__flow(false); },
  'flow-node': async () => { await window.__flow(false); },
  'flow-agent': async () => { await window.__flow(true); },
  /* ---------- AI ---------- */
  'ai-agent': async () => { await window.__chat(); },
  'ai-providers': async () => { const { ui } = await import('/src/lib/state.svelte.ts'); ui.settingsPage = 'providers'; ui.settingsOpen = true; },
  'ai-agents': async () => { const { ui } = await import('/src/lib/state.svelte.ts'); ui.settingsPage = 'agents'; ui.settingsOpen = true; },
  'ai-skills': async () => {
    const { app, ui } = await import('/src/lib/state.svelte.ts');
    app.skills.push(
      { id: 'sk1', name: 'tdd', description: 'Test-driven development: najpierw test, potem kod. Gdy użytkownik chce pisać testy albo naprawić błąd testem.', body: '…', files: { 'tests.md': 'x', 'mocking.md': 'x', 'refactoring.md': 'x' } },
      { id: 'sk2', name: 'code-review', description: 'Przegląd zmian od wskazanego commita pod kątem standardów repozytorium i specyfikacji.', body: '…', files: { 'checklist.md': 'x' } },
      { id: 'sk3', name: 'deploy-staging', description: 'Wdrożenie na staging: testy, obraz Dockera, push i restart usługi przez SSH.', body: '…' },
      { id: 'sk4', name: 'diagnosing-bugs', description: 'Pętla diagnozy trudnych błędów i regresji wydajności.', body: '…', files: { 'loop.md': 'x', 'tools.md': 'x' } });
    const boss = app.agents.find((a) => a.id === 'boss'); if (boss) boss.skills = ['sk1', 'sk2', 'sk3'];
    ui.settingsPage = 'skills'; ui.settingsOpen = true;
  },
  /* ---------- pluginy ---------- */
  'plug-sidebar': async () => {
    const { app, parkTab } = await import('/src/lib/state.svelte.ts'); parkTab(__T.web, 'tx.bcgrnd_process'); app.workspaces[0].activeTab = __T.api;
  },
  'plug-settings': async () => { const { ui } = await import('/src/lib/state.svelte.ts'); ui.settingsPage = 'plugins'; ui.settingsOpen = true; },
  'plug-palette': async () => { const { ui } = await import('/src/lib/state.svelte.ts'); ui.palette = true; },
  /* ---------- zdalny dostęp ---------- */
  'remote-settings': async () => {
    const { app, ui } = await import('/src/lib/state.svelte.ts'); app.remote.enabled = true;
    const R = await import('/src/lib/remote.svelte.ts'); await R.startRemote().catch(() => {}); await R.refreshStatus(); await R.beginPair();
    ui.settingsPage = 'remote'; ui.settingsOpen = true;
  },
  'remote-phone': async () => {
    const { app } = await import('/src/lib/state.svelte.ts');
    app.layout.collapsed['tx.notes'] = true; app.layout.collapsed['tx.keys'] = true; app.layout.collapsed['tx.bcgrnd_process'] = true; app.layout.side = 330;
  },
  'remote-sms': async () => {
    const { app } = await import('/src/lib/state.svelte.ts');
    app.layout.collapsed['tx.notes'] = true; app.layout.collapsed['tx.keys'] = true; app.layout.collapsed['tx.bcgrnd_process'] = true; app.layout.side = 330;
  },
};

// Pomocnicze w stronie: workflow i rozmowa z agentem.
const HELPERS = () => {
  window.__flow = async (byAgent) => {
    const { app, ui } = await import('/src/lib/state.svelte.ts');
    const { buildFlow } = await import('/src/lib/workflow/builder.ts');
    const r = buildFlow({ title: 'Raport poranny', nodes: [
      { key: 'cron', type: 'cron', label: 'Codziennie 8:00', cfg: { every: 1440 } },
      { key: 'pull', type: 'run_cmd', label: 'Testy na main', cfg: { command: 'git pull; npm test', shell: 'pwsh', cwd: 'C:\\dev\\api' } },
      { key: 'ok', type: 'if', label: 'Kod wyjścia 0?', cfg: { expr: 'exit == 0' } },
      { key: 'log', type: 'run_cmd', label: 'Commity z wczoraj', cfg: { command: 'git log --since=yesterday --oneline', shell: 'pwsh' } },
      { key: 'sum', type: 'ai_summary', label: 'Streszczenie', cfg: { prompt: 'Streść zmiany z wczoraj dla zespołu: {{input}}' } },
      { key: 'note', type: 'to_note', label: 'Do Notatek', cfg: { folder: 'Raporty', title: 'Raport {{date}}' } },
      { key: 'ntf', type: 'notify', label: 'Powiadomienie', cfg: { title: 'Raport gotowy' } },
    ], edges: [['cron', 'pull'], ['pull', 'ok'], ['ok', 'log'], ['log', 'sum'], ['sum', 'note'], ['sum', 'ntf']] });
    const ws = app.workspaces[0]; const tab = ws.tabs.find((t) => t.id === r.tabId);
    const flow = app.flows[tab.flowId];
    // Dwa rzędy zamiast jednego długiego: pięć nodów w górnym, dwa wyjścia pod streszczeniem.
    const POS = byAgent ? [[30, 200], [240, 200], [450, 200], [660, 200], [240, 420], [450, 360], [450, 490]] : [[40, 210], [260, 210], [480, 210], [700, 210], [260, 430], [480, 370], [480, 500]];
    flow.nodes.forEach((n, i) => { if (POS[i]) { n.x = POS[i][0]; n.y = POS[i][1]; } });
    flow.sx = 0; flow.sy = 0;
    app.layout.palHidden = !!byAgent; app.layout.side = 44;
    if (!byAgent) delete flow.byAgent;
    ws.activeTab = r.tabId;
    if (byAgent) {
      const id = () => Math.random().toString(36).slice(2);
      ws.chat.push(
        { id: id(), role: 'user', who: 'Ty', text: 'Zbuduj workflow: codziennie o 8 puść testy na main, a jeśli przejdą, streść wczorajsze commity do Notatek i daj mi znać.' },
        { id: id(), role: 'agent', who: 'Szef (domyślny)', text: r.summary },
        { id: id(), role: 'agent', who: 'Szef (domyślny)', text: 'Gotowe: 7 nodów. Wyzwalacz „Codziennie 8:00” zadziała, gdy zatwierdzisz workflow na dole kanwy. Chcesz, żebym uruchomił go raz teraz?' });
      app.layout.agentOpen = true; app.layout.agent = 400;
    }
  };
  window.__chat = async () => {
    const { app } = await import('/src/lib/state.svelte.ts');
    const ws = app.workspaces[0]; ws.activeTab = __T.api;
    const id = () => Math.random().toString(36).slice(2);
    ws.chat.push(
      { id: id(), role: 'user', who: 'Ty', text: 'Testy w zakładce api nie przechodzą. Sprawdź dlaczego i napraw.' },
      { id: id(), role: 'agent', who: 'Szef (domyślny) → podagent „api”', text: 'Uruchom testy auth i znajdź przyczynę błędu.' },
      { id: id(), role: 'sub', who: 'Podagent „api”', text: 'Chcę uruchomić w „api”:', approve: { tabId: __T.api, command: 'npm test -- tests/auth.test.ts', state: 'approved' } },
      { id: id(), role: 'sub', who: 'Podagent „api”', text: 'Test czeka 61 s na token ważny 60 s (`tests/auth.test.ts:58`), więc dostaje 401. Skrócę czekanie do 59 s i dodam test samej granicy.' },
      { id: id(), role: 'sub', who: 'Podagent „api”', text: 'Chcę uruchomić w „api”:', approve: { tabId: __T.api, command: 'git apply fix-token-wait.patch; npm test', state: 'pending' } });
    app.layout.agentOpen = true; app.layout.agent = 420;
  };
};

// Kadr (piksele CSS): prostokąt albo selektor; zawsze rozszerzany do 16:10.
const CLIP = {
  'term-ps': [0, 0, 1100, 688], 'term-ssh': [0, 0, 1100, 688], 'term-wsl': [236, 0, 1204, 752], 'term-vault': [236, 0, 1204, 752],
  'ai-agent': [240, 0, 1200, 750], 'plug-sidebar': [0, 0, 1240, 775], 'plug-palette': [240, 0, 960, 600],
  'remote-phone': [0, 300, 960, 600], 'remote-sms': [0, 300, 960, 600],
  'ai-providers': '.modal', 'ai-agents': '.modal', 'ai-skills': '.modal', 'plug-settings': '.modal', 'remote-settings': '.modal',
};
async function clipOf(p, name) {
  let c = CLIP[name];
  if (!c) return undefined;
  if (typeof c === 'string') {
    const r = await p.evaluate((sel) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b && [b.x - 24, b.y - 24, b.width + 48, b.height + 48]; }, c);
    if (!r) return undefined; c = r;
  }
  let [x, y, w, h] = c;
  if (w / h > 1.6) { const nh = w / 1.6; y -= (nh - h) / 2; h = nh; } else { const nw = h * 1.6; x -= (nw - w) / 2; w = nw; }
  w = Math.min(w, 1440); h = Math.min(h, 900);
  x = Math.max(0, Math.min(x, 1440 - w)); y = Math.max(0, Math.min(y, 900 - h));
  return { x, y, width: w, height: h };
}

const ACTIONS = {
  'term-wsl': async (p) => { await p.click('button[title="Nowa zakładka"]'); await p.waitForTimeout(400); },
  'term-windows': async (p) => { await p.click('button[title="Rozmieść okna kafelkowo"]').catch(() => {}); await p.waitForTimeout(600); },
  'flow-node': async (p) => { await p.locator('.node').nth(1).click(); await p.waitForTimeout(500); },
  'plug-palette': async (p) => { await p.keyboard.type('telefon', { delay: 30 }); await p.waitForTimeout(400); },
  'remote-sms': async (p) => {
    for (const f of p.frames()) { const t = f.getByRole('button', { name: /^SMS/ }); if (await t.count().catch(() => 0)) { await t.first().click(); break; } }
    await p.waitForTimeout(800);
  },
};

(async () => {
  const b = await chromium.launch();
  for (const mode of MODES) for (const [name, fn] of Object.entries(SCENES)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: mode });
    const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.addInitScript({ content: fs.readFileSync(D + '/stub.js', 'utf8') });
    await p.addInitScript({ content: fs.readFileSync(D + '/seed.js', 'utf8') });
    await p.goto('http://localhost:1420'); await p.waitForTimeout(1800);
    await p.evaluate(`(${BASE})(${JSON.stringify(mode)})`); await p.evaluate(`(${HELPERS})()`); await p.waitForTimeout(1500);
    await p.evaluate(`(${fn})()`); await p.waitForTimeout(1200);
    if (ACTIONS[name]) await ACTIONS[name](p);
    await p.mouse.move(1, 1);
    await p.screenshot({ path: `${OUT}/${name}-${mode}.png`, clip: await clipOf(p, name) });
    console.log(name, mode, errs.length ? 'BŁĘDY: ' + errs.join(' | ') : 'ok');
    await p.close();
  }
  await b.close();
})();
