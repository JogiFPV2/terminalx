import { call } from './ipc';
import { initialState, WS_COLORS } from './defaults';
import { nid } from './util';
import * as sessions from './terminal/sessions.svelte';
import type { AppState, Tab, Workspace, Pane, Flow } from './types';

export interface ShellInfo { id: string; name: string; kind: string }
export interface Toast { id: string; text: string; kind: 'info' | 'success' | 'warning' | 'error' }
export interface Pending { id: string; label: string; start: number; ms: number; restore: () => void; finalize: () => void; timer: number }
export interface MenuItem { label?: string; icon?: string; c?: string; badge?: { text: string; c: string }; kbd?: string; disabled?: boolean; soon?: string; sep?: boolean; heading?: string; run?: () => void }
export interface MenuSpec { x: number; y: number; items: MenuItem[] }
export interface ConfirmSpec { title: string; message: string; confirmLabel?: string; danger?: boolean; input?: { label: string; value: string; secret?: boolean }; resolve: (v: any) => void }

export const app = $state<AppState>(initialState('powershell'));

export const ui = $state({
  ready: false,
  shells: [] as ShellInfo[],
  settingsOpen: false,
  settingsPage: 'appearance',
  menu: null as MenuSpec | null,
  toasts: [] as Toast[],
  pending: [] as Pending[],
  palette: false,
  confirm: null as ConfirmSpec | null,
  stats: { cpu: 0, memUsed: 0, memTotal: 1, appMem: 0 },
  searchPane: null as string | null,
  renamingTab: null as string | null,
  renamingWs: null as string | null,
  focusedPane: null as string | null,
  dragTab: null as string | null,
  /** Zaparkowana zakładka (Procesy w tle) podejrzana w głównym widoku bez zdejmowania z panelu. */
  peek: null as string | null,
});

/* ---------- lookups ---------- */

export const curWs = (): Workspace => app.workspaces.find((w) => w.id === app.activeWs) || app.workspaces[0];
export const curTab = (): Tab | undefined => { const w = curWs(); return w?.tabs.find((t) => t.id === w.activeTab); };
export function findTab(id: string): { tab: Tab; ws: Workspace | null } | null {
  for (const ws of app.workspaces) { const tab = ws.tabs.find((t) => t.id === id); if (tab) return { tab, ws }; }
  const p = app.parked.find((p) => p.tab.id === id);
  return p ? { tab: p.tab, ws: null } : null;
}
export const shellName = (id: string) => {
  if (id.startsWith('ssh:')) { const h = app.hosts.find((x) => x.id === id.slice(4)); return h ? `SSH · ${h.user}@${h.host}` : 'SSH'; }
  return ui.shells.find((s) => s.id === id)?.name || (id.startsWith('wsl:') ? `WSL · ${id.slice(4)}` : id);
};

export function tabKind(t: Tab): { label: string; c: string; icon: string } {
  if (t.kind === 'flow') return { label: 'FLOW', c: 'var(--chart-4)', icon: 'flow' };
  if (t.kind === 'sftp') return { label: 'SFTP', c: 'var(--chart-5)', icon: 'folder' };
  if (t.kind === 'vault') return { label: 'HOST', c: 'var(--primary)', icon: 'hosts' };
  if (t.kind === 'monitor') return { label: 'MON', c: 'var(--chart-1)', icon: 'activity' };
  if (t.kind === 'gallery') return { label: 'IMG', c: 'var(--chart-4)', icon: 'image' };
  const sh = t.panes[0]?.shell || '';
  if (sh.startsWith('ssh:')) return { label: 'SSH', c: 'var(--chart-5)', icon: 'ssh' };
  if (sh === 'pwsh') return { label: 'PS', c: 'var(--chart-2)', icon: 'ps' };
  if (sh === 'powershell') return { label: 'PS5', c: 'var(--chart-2)', icon: 'ps' };
  if (sh === 'cmd') return { label: 'CMD', c: 'var(--muted-foreground)', icon: 'cmd' };
  if (sh.startsWith('wsl')) return { label: 'WSL', c: 'var(--chart-3)', icon: 'linux' };
  return { label: 'SH', c: 'var(--chart-5)', icon: 'bash' };
}
const defaultTitle = (shell: string) => shell === 'pwsh' ? 'pwsh' : shell === 'powershell' ? 'powershell' : shell === 'cmd' ? 'cmd' : shell.startsWith('wsl:') ? shell.slice(4).toLowerCase() : shell === 'gitbash' ? 'bash' : 'terminal';

/* ---------- toasts & deferred close ---------- */

export function notify(text: string, kind: Toast['kind'] = 'info', ms = 4000) {
  const t = { id: nid('n'), text, kind };
  ui.toasts.push(t);
  setTimeout(() => { const i = ui.toasts.findIndex((x) => x.id === t.id); if (i >= 0) ui.toasts.splice(i, 1); }, ms);
}

export function deferClose(label: string, remove: () => void, restore: () => void, finalize: () => void = () => {}) {
  remove();
  const ms = Math.max(1, app.settings.undoSec) * 1000;
  const p: Pending = { id: nid('u'), label, start: Date.now(), ms, restore, finalize, timer: 0 };
  p.timer = window.setTimeout(() => { dropPending(p.id); finalize(); }, ms);
  ui.pending.push(p);
}
function dropPending(id: string) {
  const i = ui.pending.findIndex((p) => p.id === id);
  if (i >= 0) { clearTimeout(ui.pending[i].timer); ui.pending.splice(i, 1); }
}
export function undo(id?: string) {
  const p = id ? ui.pending.find((x) => x.id === id) : ui.pending[ui.pending.length - 1];
  if (!p) return;
  dropPending(p.id);
  p.restore();
}
/** Przy zamykaniu aplikacji wszystko, co czeka na cofnięcie, jest finalizowane. */
export function finalizeAll() { for (const p of [...ui.pending]) { dropPending(p.id); p.finalize(); } }

/* ---------- tabs ---------- */

export function makePane(shell: string, cwd?: string): Pane { return { id: nid('p'), shell, cwd }; }

export function newTab(kind: string, wsId = app.activeWs, cwd?: string): Tab {
  const ws = app.workspaces.find((w) => w.id === wsId) || curWs();
  let tab: Tab;
  if (kind === 'flow') {
    const flowId = nid('f');
    app.flows[flowId] = { id: flowId, nodes: [{ id: nid('n'), type: 'manual', x: 40, y: 60, label: '', cfg: {} }], edges: [] } as Flow;
    tab = { id: nid('t'), kind: 'flow', title: 'Workflow', panes: [], split: 0.5, splitDir: 'col', subagent: null, win: null, flowId };
  } else {
    const pane = makePane(kind, cwd);
    tab = { id: nid('t'), kind: 'terminal', title: cwd ? cwd.replace(/[\/]+$/, '').split(/[\/]/).pop() || defaultTitle(kind) : defaultTitle(kind), panes: [pane], split: 0.5, splitDir: 'col', subagent: ws.subDefault, win: null };
    sessions.ensureSession(pane);
  }
  ws.tabs.push(tab);
  ws.z.push(tab.id);
  ws.activeTab = tab.id;
  app.activeWs = ws.id;
  return tab;
}

export function activateTab(id: string) {
  const f = findTab(id);
  if (!f || !f.ws) return;
  ui.peek = null;
  f.ws.activeTab = id;
  f.ws.z = f.ws.z.filter((x) => x !== id).concat(id);
  app.activeWs = f.ws.id;
  const p = f.tab.panes[0];
  if (p) setTimeout(() => sessions.focus(ui.focusedPane && f.tab.panes.some((x) => x.id === ui.focusedPane) ? ui.focusedPane : p.id), 0);
}

function pickNext(ws: Workspace, index: number) {
  ws.activeTab = ws.z.filter((id) => ws.tabs.some((t) => t.id === id)).pop() || ws.tabs[Math.min(index, ws.tabs.length - 1)]?.id || null;
}

export function closeTab(id: string) {
  const f = findTab(id);
  if (!f || !f.ws) return;
  const ws = f.ws, i = ws.tabs.findIndex((t) => t.id === id), tab = ws.tabs[i], wasActive = ws.activeTab === id;
  deferClose(`Zamknięto zakładkę „${tab.title}”`, () => {
    ws.tabs.splice(i, 1);
    ws.z = ws.z.filter((x) => x !== id);
    if (wasActive) pickNext(ws, i);
  }, () => {
    const w = app.workspaces.find((x) => x.id === ws.id) || curWs();
    w.tabs.splice(Math.min(i, w.tabs.length), 0, tab);
    w.z.push(tab.id);
    w.activeTab = tab.id;
    app.activeWs = w.id;
  }, () => {
    tab.panes.forEach((p) => sessions.dispose(p.id));
    if (tab.flowId && !app.workspaces.some((w) => w.tabs.some((t) => t.flowId === tab.flowId))) delete app.flows[tab.flowId];
  });
}

export function closeWorkspace(id: string) {
  if (app.workspaces.length < 2) { notify('To ostatni workspace. Utwórz nowy, zanim zamkniesz ten.', 'warning'); return; }
  const i = app.workspaces.findIndex((w) => w.id === id), ws = app.workspaces[i], wasActive = app.activeWs === id;
  deferClose(`Zamknięto workspace „${ws.name}” (${ws.tabs.length} zakł.)`, () => {
    app.workspaces.splice(i, 1);
    if (wasActive) app.activeWs = app.workspaces[Math.min(i, app.workspaces.length - 1)].id;
  }, () => {
    app.workspaces.splice(Math.min(i, app.workspaces.length), 0, ws);
    app.activeWs = ws.id;
  }, () => ws.tabs.forEach((t) => t.panes.forEach((p) => sessions.dispose(p.id))));
}

export function addWorkspace() {
  const n = app.workspaces.length + 1;
  const ws: Workspace = { id: nid('w'), name: `Workspace ${n}`, color: WS_COLORS[(n - 1) % WS_COLORS.length], mode: 'tabs', agentId: app.agents.find((a) => a.kind === 'agent')?.id || 'boss', subDefault: null, tabs: [], activeTab: null, z: [], chat: [] };
  app.workspaces.push(ws);
  app.activeWs = ws.id;
  newTab(app.settings.defaultShell, ws.id);
  ui.renamingWs = ws.id;
}

export function splitTab(id: string, dir: 'row' | 'col' = 'col') {
  const f = findTab(id);
  if (!f || f.tab.kind !== 'terminal') return;
  const t = f.tab;
  if (t.panes.length > 1) {
    const [, second] = t.panes;
    t.panes = [t.panes[0]];
    sessions.dispose(second.id);
    return;
  }
  const pane = makePane(t.panes[0].shell, sessions.termStatus[t.panes[0].id]?.cwd || t.panes[0].cwd);
  sessions.ensureSession(pane);
  t.splitDir = dir;
  t.split = 0.5;
  t.panes.push(pane);
  ui.focusedPane = pane.id;
}

export function duplicateTab(id: string) {
  const f = findTab(id);
  if (!f || !f.ws) return;
  const t = f.tab;
  if (t.kind === 'flow') {
    const src = app.flows[t.flowId!];
    const flowId = nid('f');
    app.flows[flowId] = JSON.parse(JSON.stringify({ ...src, id: flowId }));
    const copy: Tab = { ...JSON.parse(JSON.stringify(t)), id: nid('t'), title: t.title + ' (kopia)', flowId, win: null };
    f.ws.tabs.splice(f.ws.tabs.indexOf(t) + 1, 0, copy);
    f.ws.z.push(copy.id); f.ws.activeTab = copy.id;
    return;
  }
  if (t.kind !== 'terminal') {
    const copy: Tab = { ...JSON.parse(JSON.stringify(t)), id: nid('t'), win: null };
    f.ws.tabs.splice(f.ws.tabs.indexOf(t) + 1, 0, copy);
    f.ws.z.push(copy.id); f.ws.activeTab = copy.id;
    return;
  }
  const pane = makePane(t.panes[0].shell, sessions.termStatus[t.panes[0].id]?.cwd || t.panes[0].cwd);
  sessions.ensureSession(pane);
  const copy: Tab = { id: nid('t'), kind: 'terminal', title: t.title, panes: [pane], split: 0.5, splitDir: 'col', subagent: t.subagent, win: null, hostId: t.hostId };
  f.ws.tabs.splice(f.ws.tabs.indexOf(t) + 1, 0, copy);
  f.ws.z.push(copy.id);
  f.ws.activeTab = copy.id;
}

/* ---------- parking (Procesy w tle) ---------- */

export function parkTab(id: string, by = 'tx.bcgrnd_process') {
  const f = findTab(id);
  if (!f || !f.ws || f.tab.kind !== 'terminal') return false;
  const ws = f.ws, i = ws.tabs.indexOf(f.tab);
  ws.tabs.splice(i, 1);
  ws.z = ws.z.filter((x) => x !== id);
  if (ws.activeTab === id) pickNext(ws, i);
  app.parked.push({ tab: f.tab, wsId: ws.id, wsName: ws.name, index: i, by });
  return true;
}

export function unparkTab(id: string, focus = true) {
  const i = app.parked.findIndex((p) => p.tab.id === id);
  if (i < 0) return;
  const p = app.parked.splice(i, 1)[0];
  const ws = app.workspaces.find((w) => w.id === p.wsId) || curWs();
  ws.tabs.splice(Math.min(p.index, ws.tabs.length), 0, p.tab);
  ws.z.push(p.tab.id);
  if (focus) { ws.activeTab = p.tab.id; app.activeWs = ws.id; }
}

export function stopParked(id: string, label: string) {
  const i = app.parked.findIndex((p) => p.tab.id === id);
  if (i < 0) return;
  const p = app.parked[i];
  deferClose(label, () => { app.parked.splice(app.parked.indexOf(p), 1); }, () => { app.parked.splice(Math.min(i, app.parked.length), 0, p); },
    () => p.tab.panes.forEach((x) => sessions.dispose(x.id)));
}

/* ---------- persistence ---------- */

const TRANSIENT_CHAT = 200;

export function snapshot(): string {
  const copy = JSON.parse(JSON.stringify(app)) as AppState;
  // Zaparkowane zakładki wracają do workspace'ów: po restarcie i tak startują nowe powłoki.
  for (const p of copy.parked) {
    const ws = copy.workspaces.find((w) => w.id === p.wsId) || copy.workspaces[0];
    ws.tabs.splice(Math.min(p.index, ws.tabs.length), 0, p.tab);
    ws.z.push(p.tab.id);
  }
  copy.parked = [];
  for (const ws of copy.workspaces) {
    ws.chat = ws.chat.slice(-TRANSIENT_CHAT).map((m) => (m.approve?.state === 'pending' ? { ...m, approve: { ...m.approve, state: 'rejected' as const } } : m));
    for (const t of ws.tabs) for (const p of t.panes) { const cwd = sessions.termStatus[p.id]?.cwd; if (cwd) p.cwd = cwd; }
  }
  return JSON.stringify(copy);
}

let saveTimer = 0;
export function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    call('state_save', { json: snapshot() }).catch((e) => console.error('zapis stanu', e));
    rearm();
  }, 700);
}
export async function saveNow() { clearTimeout(saveTimer); const json = snapshot(); rearm(); await call('state_save', { json }).catch(() => {}); }

// Autozapis. Śledzenie zmian wymaga odczytania całego stanu, co przy długim czacie trwa kilka ms,
// więc robimy to najwyżej raz na cykl zapisu, a nie przy każdej zmianie (np. każdym tokenie agenta):
// pierwsza zmiana planuje zapis i „rozbraja” efekt; zapis i tak bierze cały aktualny stan, potem
// efekt znów się uzbraja i czyta stan raz.
let armed = $state(true);
let arming = true;
function rearm() { if (!armed) { arming = true; armed = true; } }
export function watchSave() {
  $effect.root(() => {
    $effect(() => {
      if (!armed) return;
      if (arming) { arming = false; JSON.stringify(app); return; }
      armed = false;
      scheduleSave();
    });
  });
}

export async function loadState() {
  ui.shells = await call<ShellInfo[]>('sys_shells').catch(() => [] as ShellInfo[]);
  const def = ui.shells.find((s) => s.id === 'pwsh')?.id || 'powershell';
  const fresh = initialState(def);
  let raw: string | null = null;
  try { raw = await call<string | null>('state_load'); } catch { raw = null; }
  let saved: Partial<AppState> = {};
  if (raw) { try { saved = JSON.parse(raw); } catch { saved = {}; } }
  const merged: AppState = {
    ...fresh, ...saved,
    layout: { ...fresh.layout, ...(saved.layout || {}) },
    settings: { ...fresh.settings, ...(saved.settings || {}) },
    flows: saved.flows || {},
    parked: [],
    usage: saved.usage || {},
    starred: saved.starred || [],
    mcp: saved.mcp || [],
    hosts: saved.hosts || [],
    remote: { ...fresh.remote, ...(saved.remote || {}) },
    local: { ...fresh.local, ...(saved.local || {}) },
    monitor: { ...fresh.monitor, ...(saved.monitor || {}) },
  } as AppState;
  if (!merged.workspaces?.length) merged.workspaces = fresh.workspaces;
  if (!merged.workspaces.some((w) => w.id === merged.activeWs)) merged.activeWs = merged.workspaces[0].id;
  // Zakładki z powłoką, której już nie ma (np. odinstalowana dystrybucja WSL), dostają domyślną.
  const known = new Set(ui.shells.map((s) => s.id));
  for (const ws of merged.workspaces) {
    for (const t of ws.tabs) for (const p of t.panes) if (known.size && !p.shell.startsWith('ssh:') && !known.has(p.shell)) p.shell = def;
    if (!ws.tabs.some((t) => t.id === ws.activeTab)) ws.activeTab = ws.tabs[0]?.id || null;
  }
  Object.assign(app, merged);
  sessions.configure(app.settings);
  // Po przeładowaniu strony (zmiana języka, awaria WebView) w rdzeniu mogą żyć powłoki poprzedniej strony.
  await call('pty_reset').catch(() => {});
  // Powłoki przywróconych zakładek startują dopiero przy pierwszym pokazaniu (TerminalPane) albo zapisie
  // (sessions.write): i tak byłyby świeże i puste, a 20 zakładek PowerShell to około 1 GB pamięci.
  sessions.setPaneResolver((id) => {
    for (const ws of app.workspaces) for (const t of ws.tabs) { const p = t.panes.find((x) => x.id === id); if (p) return p; }
    for (const k of app.parked) { const p = k.tab.panes.find((x) => x.id === id); if (p) return p; }
    return null;
  });
  ui.ready = true;
}
