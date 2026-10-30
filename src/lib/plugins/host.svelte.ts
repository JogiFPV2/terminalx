// Host pluginów: wczytuje wbudowane i zaimportowane pluginy, uruchamia je w izolowanych iframe
// i obsługuje ich wywołania, sprawdzając uprawnienia z plugin.json przy każdym z nich.
import { call, isTauri } from '../ipc';
import { app, ui, notify, findTab, parkTab, unparkTab, stopParked, closeTab, deferClose, activateTab, shellName } from '../state.svelte';
import * as sessions from '../terminal/sessions.svelte';
import { complete, onUsage, balanceOf } from '../ai';
import { isChat } from '../defaults';
import { BRAND } from '../defaults';
import type { PluginManifest, PluginRecord } from '../types';
import shimCode from './shim.js?raw';

export const KNOWN_PERMS: Record<string, { label: string; risk: 0 | 1 | 2 }> = {
  'storage': { label: 'Własne pliki pluginu', risk: 0 },
  'ui:sidebar': { label: 'Sekcja w pasku bocznym', risk: 0 },
  'ui:statusbar': { label: 'Element paska statusu', risk: 0 },
  'ui:tab': { label: 'Własny typ zakładki', risk: 0 },
  'ui:commands': { label: 'Komendy w palecie', risk: 0 },
  'ui:tabmenu': { label: 'Pozycja w menu zakładki', risk: 0 },
  'notifications': { label: 'Powiadomienia', risk: 0 },
  'system:info': { label: 'Odczyt CPU/RAM/dysku', risk: 0 },
  'terminal:read': { label: 'Odczyt wyjścia terminali', risk: 1 },
  'tabs:manage': { label: 'Przenoszenie zakładek', risk: 1 },
  'ai:invoke': { label: 'Wywołania AI (przez providerów)', risk: 1 },
  'ai:usage': { label: 'Zużycie tokenów i limity providerów (bez kluczy i treści)', risk: 0 },
  'ai:plans': { label: 'Limity planów subskrypcji z logowań narzędzi (tylko wbudowane)', risk: 2 },
  'net:localhost': { label: 'Sieć: tylko localhost', risk: 1 },
  'terminal:write': { label: 'Pisanie do terminali', risk: 2 },
  'net:*': { label: 'Sieć: dowolne adresy', risk: 2 },
  'fs:read': { label: 'Odczyt plików użytkownika', risk: 2 },
  'fs:write': { label: 'Zapis plików użytkownika', risk: 2 },
  'shell:exec': { label: 'Uruchamianie procesów', risk: 2 },
  'vault:keys': { label: 'Sejf kluczy API (tylko wbudowane)', risk: 2 },
};
export const FORBIDDEN = ['secrets', 'keychain', 'credentials', 'keystrokes', 'clipboard:read', 'providers:keys', 'vault:', 'ai:plans'];

export interface LoadedPlugin { manifest: PluginManifest; code: string; builtin: boolean }
export interface SectionReg { pluginId: string; id: string; title: string; icon: string; actions: { id: string; icon: string; title: string }[]; badge: number | null; acceptsTabs: boolean }
export interface StatusReg { pluginId: string; id: string; text: string; tooltip: string; icon: string; variant: string; visible: boolean; clickable: boolean; priority: number; place: 'top' | 'bottom' }
export interface CommandReg { pluginId: string; id: string; title: string; keybinding: string }

export const plug = $state({
  loaded: [] as LoadedPlugin[],
  sections: [] as SectionReg[],
  status: [] as StatusReg[],
  commands: [] as CommandReg[],
  crashed: {} as Record<string, string>,
  dialogOpen: {} as Record<string, boolean>,
  heights: {} as Record<string, number>,
});

interface Runtime { frame: HTMLIFrameElement; ready: boolean; subs: Map<string, () => void> }
const runtimes = new Map<string, Runtime>();

/* ---------- loading ---------- */

const builtinManifests = import.meta.glob('../../../plugins/*/plugin.json', { eager: true, import: 'default' }) as Record<string, PluginManifest>;
const builtinCode = import.meta.glob('../../../plugins/*/main.js', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

export async function loadPlugins() {
  const list: LoadedPlugin[] = [];
  for (const [path, manifest] of Object.entries(builtinManifests)) {
    const code = builtinCode[path.replace('plugin.json', 'main.js')];
    if (code) list.push({ manifest, code, builtin: true });
  }
  const installed = await call<{ manifest: string; code: string }[]>('plugins_installed').catch(() => []);
  for (const p of installed) {
    try {
      const m = JSON.parse(p.manifest) as PluginManifest;
      const i = list.findIndex((x) => x.manifest.id === m.id);
      const entry = { manifest: m, code: p.code, builtin: false };
      if (i >= 0) list[i] = entry; else list.push(entry);
    } catch { /* uszkodzony manifest pomijamy */ }
  }
  // Kolejność: jak w zapisanym stanie, nowe na końcu; wbudowane domyślnie włączone (oprócz Portów i Pomodoro).
  const order = app.plugins.length ? app.plugins.map((r) => r.id) : ['tx.notes', 'tx.keys', 'tx.bcgrnd_process', 'tx.quota', 'tx.sysmon', 'tx.ports', 'tx.pomodoro'];
  list.sort((a, b) => (order.indexOf(a.manifest.id) + 1 || 999) - (order.indexOf(b.manifest.id) + 1 || 999));
  for (const p of list) {
    if (!app.plugins.some((r) => r.id === p.manifest.id)) {
      app.plugins.push({ id: p.manifest.id, enabled: p.builtin && !['tx.ports', 'tx.pomodoro'].includes(p.manifest.id), config: {}, builtin: p.builtin });
    }
  }
  plug.loaded = list;
}

export const record = (id: string): PluginRecord | undefined => app.plugins.find((r) => r.id === id);
export const loaded = (id: string) => plug.loaded.find((p) => p.manifest.id === id);
export const isEnabled = (id: string) => !!record(id)?.enabled && !!loaded(id);
export const configOf = (id: string) => ({ ...(loaded(id)?.manifest.config || {}), ...(record(id)?.config || {}) });
export const enabledPlugins = () => plug.loaded.filter((p) => isEnabled(p.manifest.id));
export const sidebarPlugins = () => enabledPlugins().filter((p) => p.manifest.contributes?.sidebar?.length);

/* ---------- frames ---------- */

function themeCss() {
  const cs = getComputedStyle(document.documentElement);
  const vars = ['background', 'foreground', 'card', 'muted', 'muted-foreground', 'primary', 'primary-foreground', 'accent', 'border', 'destructive', 'sidebar', 'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'term-bg', 'font-sans', 'font-mono', 'radius'];
  return `:root{${vars.map((v) => `--${v}:${cs.getPropertyValue('--' + v).trim()}`).join(';')};color-scheme:${document.documentElement.classList.contains('dark') ? 'dark' : 'light'}}`;
}

function srcdoc() {
  return `<!doctype html><html><head><meta charset="utf-8"><style id="tx-theme">${themeCss()}</style><style>
html,body{margin:0;padding:0;background:transparent;color:var(--foreground);font:13px/1.4 var(--font-sans);overflow:hidden}
*{box-sizing:border-box} button{font:inherit;color:inherit}
#tx-dialog-layer{display:none;position:fixed;inset:0;background:rgb(0 0 0 / .45);align-items:center;justify-content:center;padding:24px}
.tx-dialog{background:var(--card);color:var(--foreground);border:1px solid var(--border);border-radius:12px;width:min(560px,calc(100vw - 48px));max-height:calc(100vh - 48px);overflow:auto;display:flex;flex-direction:column;box-shadow:0 24px 60px -20px rgb(0 0 0 / .6)}
.tx-dialog>header{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border)}
.tx-dialog>header b{flex:1;font-weight:600}
.tx-x{background:none;border:0;cursor:pointer;color:var(--muted-foreground);width:26px;height:24px;border-radius:6px}
.tx-x:hover{background:var(--accent);color:var(--foreground)}
.tx-body{padding:14px;display:flex;flex-direction:column;gap:10px}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:color-mix(in oklab,var(--muted-foreground) 30%,transparent);border-radius:8px}
</style></head><body><div id="tx-section"></div><div id="tx-dialog-layer"></div><script>${shimCode}<\/script></body></html>`;
}

/** Komponent ramki woła to po zamontowaniu iframe w stałym miejscu DOM. */
export function mountFrame(pluginId: string, frame: HTMLIFrameElement) {
  const rt: Runtime = { frame, ready: false, subs: new Map() };
  runtimes.set(pluginId, rt);
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('title', `Plugin ${pluginId}`);
  frame.srcdoc = srcdoc();
}

export function unmountFrame(pluginId: string, frame: HTMLIFrameElement) {
  const rt = runtimes.get(pluginId);
  if (rt && rt.frame === frame) cleanup(pluginId);
}

function cleanup(pluginId: string) {
  const rt = runtimes.get(pluginId);
  rt?.subs.forEach((off) => off());
  runtimes.delete(pluginId);
  plug.sections = plug.sections.filter((s) => s.pluginId !== pluginId);
  plug.status = plug.status.filter((s) => s.pluginId !== pluginId);
  plug.commands = plug.commands.filter((s) => s.pluginId !== pluginId);
  delete plug.dialogOpen[pluginId];
}

function send(pluginId: string, msg: Record<string, unknown>) {
  runtimes.get(pluginId)?.frame.contentWindow?.postMessage({ __tx: true, ...msg }, '*');
}
export function emit(pluginId: string, name: string, payload: unknown = null) { send(pluginId, { kind: 'event', name, payload }); }
export function emitAll(name: string, payload: unknown = null, perm?: string) {
  for (const id of runtimes.keys()) if (!perm || hasPerm(id, perm)) emit(id, name, payload);
}
export function emitStorageChange(pluginId: string, paths: string[]) { emit(pluginId, 'storage', paths); }
export function broadcastTheme() { const css = themeCss(); for (const id of runtimes.keys()) send(id, { kind: 'theme', css }); }

function hasPerm(pluginId: string, perm: string) {
  const lp = loaded(pluginId), perms = lp?.manifest.permissions || [];
  // Sejf kluczy: tylko pluginy dostarczone z aplikacją (import .zip i tak odrzuca to uprawnienie).
  if (perm === 'vault:keys' || perm === 'ai:plans') return !!lp?.builtin && perms.includes(perm);
  if (perm === 'net:localhost') return perms.includes('net:localhost') || perms.includes('net:*');
  return perms.includes(perm);
}

/* ---------- RPC ---------- */

async function tabInfo(tabId: string) {
  const f = findTab(tabId);
  if (!f) return null;
  const t = f.tab;
  const parked = app.parked.find((p) => p.tab.id === t.id);
  const pane = t.panes[0];
  let process: any = undefined;
  if (pane) {
    const inf = await sessions.info(pane.id);
    if (inf) {
      const kids = inf.children.filter((n) => !/^(cmd|conhost|openconsole|wslhost|wsl)\.exe$/i.test(n));
      process = kids.length
        ? { command: kids.slice(0, 3).join(' › '), pid: inf.pid || 0, startedAt: sessions.startedAt(pane.id), idleShell: false }
        : { command: shellName(pane.shell), pid: inf.pid || 0, startedAt: sessions.startedAt(pane.id), idleShell: true };
    }
  }
  const ws = f.ws || app.workspaces.find((w) => w.id === parked?.wsId);
  return { id: t.id, title: t.title, kind: t.kind === 'flow' ? 'workflow' : 'terminal', shell: pane?.shell, workspaceId: ws?.id || parked?.wsId || '', workspaceName: ws?.name || parked?.wsName || '', process, parked: !!parked };
}

async function allTabs() {
  const ids = [...app.workspaces.flatMap((w) => w.tabs.map((t) => t.id)), ...app.parked.map((p) => p.tab.id)];
  return (await Promise.all(ids.map(tabInfo))).filter(Boolean);
}

const isLocal = (url: string) => { try { const h = new URL(url).hostname; return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'; } catch { return false; } };

const NEEDS: Record<string, string | null> = {
  'storage': 'storage', 'trash': 'storage',
  'sidebar.register': 'ui:sidebar', 'sidebar.badge': 'ui:sidebar', 'sidebar.reveal': 'ui:sidebar', 'sidebar.remove': 'ui:sidebar',
  'status.create': 'ui:statusbar', 'status.update': 'ui:statusbar', 'status.remove': 'ui:statusbar',
  'command.register': 'ui:commands', 'command.remove': 'ui:commands',
  'confirm': null, 'notify': null, 'openExternal': null,
  'system.stats': 'system:info', 'shell.exec': 'shell:exec', 'net.fetch': 'net:localhost',
  'terminal.list': 'terminal:read', 'terminal.subscribe': 'terminal:read', 'terminal.unsubscribe': 'terminal:read', 'terminal.write': 'terminal:write',
  'tabs.list': 'tabs:manage', 'tabs.get': 'tabs:manage', 'tabs.park': 'tabs:manage', 'tabs.unpark': 'tabs:manage', 'tabs.close': 'tabs:manage', 'tabs.tail': 'terminal:read',
  'ai.complete': 'ai:invoke', 'ai.usage': 'ai:usage', 'ai.balance': 'ai:usage', 'ai.plan': 'ai:plans', 'ai.accounts': 'ai:plans',
  'keys.add': 'vault:keys', 'keys.masked': 'vault:keys', 'keys.copy': 'vault:keys', 'keys.delete': 'vault:keys',
};

/** Klucz w sejfie: przestrzeń pluginu + jego własny identyfikator. */
function vaultRef(pluginId: string, id: unknown) {
  const s = String(id ?? '');
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(s)) throw new Error('Niepoprawny identyfikator klucza');
  return `keyvault:${pluginId}:${s}`;
}

let clipTimer = 0;
/** Kopiuje klucz z sejfu do schowka (plugin go nie widzi) i czyści schowek po 45 s, jeśli nadal tam jest. */
async function copyKey(ref: string, label: string) {
  const key = await call<string>('keyvault_get', { keyRef: ref });
  await navigator.clipboard.writeText(key);
  notify(`Skopiowano ${label || 'klucz'}. Schowek wyczyści się za 45 s.`, 'success');
  clearTimeout(clipTimer);
  clipTimer = window.setTimeout(async () => {
    try { if ((await navigator.clipboard.readText()) === key) await navigator.clipboard.writeText(''); } catch { /* brak dostępu do schowka */ }
  }, 45_000);
}

// Linie po monicie o hasło nie trafiają do pluginów (tylko do 1. znaku nowej linii po monicie).
const SECRET_PROMPT = /(password|passphrase|hasło|haslo|pin)\s*[:：]?\s*$/i;

async function handle(pluginId: string, method: string, a: any): Promise<unknown> {
  if (!(method in NEEDS)) throw new Error(`Nieznana metoda ${method}`);
  const need = NEEDS[method];
  if (need && !hasPerm(pluginId, need)) throw new Error(`Brak uprawnienia „${need}” w plugin.json`);
  switch (method) {
    case 'storage': return call('plugin_fs', { plugin: pluginId, op: a.op, path: a.path, data: a.data ?? null, to: a.to ?? null });
    case 'trash': {
      const stamp = Date.now();
      const trashPath = `.trash/${stamp}/${a.path}`;
      await call('plugin_fs', { plugin: pluginId, op: 'move', path: a.path, to: trashPath, data: null });
      deferClose(String(a.label || a.path), () => {}, () => {
        call('plugin_fs', { plugin: pluginId, op: 'move', path: trashPath, to: a.path, data: null }).then(() => emit(pluginId, 'storage', [a.path]));
      }, () => { call('plugin_fs', { plugin: pluginId, op: 'remove', path: `.trash/${stamp}`, data: null, to: null }).catch(() => {}); });
      return null;
    }
    case 'sidebar.register': {
      const m = loaded(pluginId)!.manifest;
      plug.sections = plug.sections.filter((s) => !(s.pluginId === pluginId && s.id === a.id));
      plug.sections.push({ pluginId, id: a.id, title: a.title || m.name, icon: a.icon || m.icon || 'puzzle', actions: a.actions || [], badge: a.badge ?? null, acceptsTabs: !!a.acceptsTabs && hasPerm(pluginId, 'tabs:manage') });
      return null;
    }
    case 'sidebar.badge': { const s = plug.sections.find((x) => x.pluginId === pluginId && x.id === a.id); if (s) s.badge = a.badge; return null; }
    case 'sidebar.reveal': { delete app.layout.collapsed[pluginId]; if (app.layout.side < 140) app.layout.side = 240; return null; }
    case 'sidebar.remove': plug.sections = plug.sections.filter((s) => !(s.pluginId === pluginId && s.id === a.id)); return null;
    case 'status.create':
      if (!plug.status.some((s) => s.pluginId === pluginId && s.id === a.id)) plug.status.push({ pluginId, id: a.id, text: '', tooltip: '', icon: '', variant: 'default', visible: false, clickable: false, priority: a.priority || 0, place: 'bottom' });
      return null;
    case 'status.update': { const s = plug.status.find((x) => x.pluginId === pluginId && x.id === a.id); if (s) Object.assign(s, { text: a.text, tooltip: a.tooltip, icon: a.icon, variant: a.variant, visible: a.visible, clickable: a.clickable, place: a.place === 'top' ? 'top' : 'bottom' }); return null; }
    case 'status.remove': plug.status = plug.status.filter((s) => !(s.pluginId === pluginId && s.id === a.id)); return null;
    case 'command.register':
      plug.commands = plug.commands.filter((c) => !(c.pluginId === pluginId && c.id === a.id));
      plug.commands.push({ pluginId, id: a.id, title: a.title, keybinding: a.keybinding || '' });
      return null;
    case 'command.remove': plug.commands = plug.commands.filter((c) => !(c.pluginId === pluginId && c.id === a.id)); return null;
    case 'confirm':
      return new Promise((resolve) => { ui.confirm = { title: String(a.title || ''), message: String(a.message || ''), confirmLabel: a.confirmLabel, danger: !!a.danger, resolve: (v) => resolve(!!v) }; });
    case 'notify': notify(`${a.title}${a.body ? ': ' + a.body : ''}`, a.level || 'info'); return null;
    case 'openExternal': {
      const url = String(a.url);
      if (!/^https?:\/\//.test(url)) throw new Error('Tylko adresy http(s)');
      if (isTauri) { const { openUrl } = await import('@tauri-apps/plugin-opener'); await openUrl(url); } else window.open(url, '_blank');
      return null;
    }
    case 'system.stats': {
      const s: any = await call('sys_stats');
      return { cpu: s.cpu, memUsed: s.memUsed, memTotal: s.memTotal };
    }
    case 'shell.exec': return call('sys_exec', { cmd: String(a.cmd), args: (a.args || []).map(String), cwd: a.cwd, timeoutMs: a.timeoutMs });
    case 'net.fetch': {
      if (!hasPerm(pluginId, 'net:*') && !isLocal(a.url)) throw new Error('Plugin ma dostęp tylko do localhost');
      return call('http_request', { method: a.method, url: a.url, headers: a.headers, body: a.body });
    }
    case 'terminal.list': return (await allTabs()).filter((t: any) => t.kind === 'terminal');
    case 'terminal.subscribe': {
      const rt = runtimes.get(pluginId)!;
      const f = findTab(a.id);
      const pane = f?.tab.panes[0];
      if (!pane || rt.subs.has(a.id)) return null;
      let hide = false;
      rt.subs.set(a.id, sessions.onOutput((pid, data) => {
        if (pid !== pane.id) return;
        let text = '';
        for (const ch of data.split(/(\n)/)) {
          if (hide) { if (ch === '\n') hide = false; continue; }
          text += ch;
          if (SECRET_PROMPT.test(ch.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ''))) hide = true;
        }
        if (text) emit(pluginId, 'termOutput', { id: a.id, data: text });
      }) as () => void);
      return null;
    }
    case 'terminal.unsubscribe': { const rt = runtimes.get(pluginId); rt?.subs.get(a.id)?.(); rt?.subs.delete(a.id); return null; }
    case 'terminal.write': { const f = findTab(a.id); if (!f?.tab.panes[0]) throw new Error('Nie ma takiego terminala'); await sessions.write(f.tab.panes[0].id, String(a.text)); return null; }
    case 'tabs.list': return allTabs();
    case 'tabs.get': return tabInfo(a.id);
    case 'tabs.park': {
      const f = findTab(a.id);
      if (!f) throw new Error('Nie ma takiej zakładki');
      if (f.tab.kind !== 'terminal') return null;
      parkTab(a.id, pluginId);
      return null;
    }
    case 'tabs.unpark': {
      const p = app.parked.find((x) => x.tab.id === a.id);
      if (!p) return null;
      if (p.by !== pluginId) throw new Error('Tę zakładkę zaparkował inny plugin');
      unparkTab(a.id, a.focus !== false);
      if (a.focus !== false) activateTab(a.id);
      return null;
    }
    case 'tabs.close': {
      const label = String(a.label || 'Zamknięto zakładkę');
      if (app.parked.some((x) => x.tab.id === a.id)) stopParked(a.id, label); else closeTab(a.id);
      return null;
    }
    case 'tabs.tail': { const f = findTab(a.id); return f?.tab.panes[0] ? sessions.tail(f.tab.panes[0].id, Math.min(500, a.lines || 20)) : []; }
    case 'keys.add': {
      // Klucz wpisuje się w oknie hosta, nie pluginu: plugin dostaje tylko wersję zamaskowaną.
      const ref = vaultRef(pluginId, a.id);
      const value = await new Promise<string | null>((resolve) => {
        ui.confirm = { title: String(a.title || 'Nowy klucz API'), message: String(a.message || ''), confirmLabel: 'Zapisz', input: { label: 'Klucz API', value: '', secret: true }, resolve };
      });
      if (!value?.trim()) return null;
      return { masked: await call<string>('keyvault_set', { keyRef: ref, value }) };
    }
    case 'keys.masked': {
      const ids = (Array.isArray(a.ids) ? a.ids : []).slice(0, 500);
      const map = await call<Record<string, string>>('keyvault_masked', { refs: ids.map((id: unknown) => vaultRef(pluginId, id)) });
      return Object.fromEntries(ids.map((id: string) => [id, map[vaultRef(pluginId, id)] ?? null]));
    }
    case 'keys.copy': await copyKey(vaultRef(pluginId, a.id), String(a.label || '')); return null;
    case 'keys.delete': await call('keyvault_delete', { keyRef: vaultRef(pluginId, a.id) }); return null;
    case 'ai.usage':
      return { providers: app.providers.filter(isChat).map((p) => ({ id: p.id, name: p.name, type: p.type, host: p.url.replace(/^https?:\/\//, '').replace(/\/.*$/, '') })), usage: app.usage };
    case 'ai.plan': {
      // Logowanie narzędzia czyta rdzeń; tu wracają tylko procenty i czasy resetu.
      const svc = String(a.service || '');
      if (svc === 'openrouter') {
        const p = app.providers.find((x) => /openrouter\.ai/.test(x.url));
        if (!p) throw new Error('Dodaj providera OpenRouter z kluczem w Ustawienia → Konta i providerzy.');
        const b = await balanceOf(p);
        if (!b) throw new Error('OpenRouter nie zwrócił salda.');
        return { plan: b.limit != null ? `limit $${b.limit}` : 'kredyty', text: b.text, windows: b.limit ? [{ label: 'kredyty', usedPercent: Math.min(100, Math.max(0, (1 - (b.remaining ?? 0) / b.limit) * 100)), resetsAt: 0 }] : [] };
      }
      const z = svc === 'zai' ? app.providers.find((x) => /z\.ai|bigmodel\.cn/.test(x.url)) : undefined;
      return call('plan_usage', { service: svc, keyRef: z?.keyRef || null, url: z?.url || null, account: a.account ? String(a.account) : null });
    }
    case 'ai.accounts':
      return app.accounts.map((x) => ({ id: x.id, service: x.service, name: x.name }));
    case 'ai.balance': {
      const p = app.providers.find((x) => x.id === a.id);
      return p ? balanceOf(p) : null;
    }
    case 'ai.complete': {
      const r = await complete({ providerId: a.provider || null, model: a.model || null, system: a.system, messages: [{ role: 'user', content: String(a.prompt || '') }], maxTokens: a.maxTokens || 4000 });
      return r.text;
    }
  }
  return null;
}

let listening = false;
let usageTimer = 0;
export function startHost() {
  if (listening) return;
  listening = true;
  // Zmiana licznika tokenów: jedno zdarzenie na pół sekundy, tylko dla pluginów z ai:usage.
  onUsage(() => { if (!usageTimer) usageTimer = window.setTimeout(() => { usageTimer = 0; emitAll('usage', null, 'ai:usage'); }, 500); });
  window.addEventListener('message', async (ev) => {
    const msg = ev.data;
    if (!msg || !msg.__tx) return;
    let pluginId = '';
    for (const [id, rt] of runtimes) if (rt.frame.contentWindow === ev.source) { pluginId = id; break; }
    if (!pluginId) return;
    const rt = runtimes.get(pluginId)!;
    switch (msg.kind) {
      case 'boot': {
        const lp = loaded(pluginId);
        if (!lp) return;
        send(pluginId, { kind: 'init', code: lp.code, manifest: JSON.parse(JSON.stringify(lp.manifest)), config: configOf(pluginId), platform: { os: /Mac/.test(navigator.userAgent) ? 'macos' : /Linux/.test(navigator.userAgent) ? 'linux' : 'windows', appVersion: BRAND.version } });
        return;
      }
      case 'ready': rt.ready = true; delete plug.crashed[pluginId]; return;
      case 'crash': plug.crashed[pluginId] = msg.error; console.error(`[plugin ${pluginId}]`, msg.error); return;
      case 'log': console.warn(`[plugin ${pluginId}]`, msg.text); return;
      case 'height': plug.heights[pluginId] = msg.height; return;
      case 'dialog': plug.dialogOpen[pluginId] = !!msg.open; return;
      case 'deactivated': return;
      case 'call': {
        try {
          const value = await handle(pluginId, msg.method, msg.args || {});
          send(pluginId, { kind: 'result', id: msg.id, ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) });
        } catch (e) {
          send(pluginId, { kind: 'result', id: msg.id, ok: false, error: String(e).replace(/^Error: /, '') });
        }
      }
    }
  });
}

/* ---------- enable / disable / config ---------- */

export function setEnabled(id: string, on: boolean) {
  const r = record(id);
  if (!r) return;
  if (!on) {
    emit(id, 'deactivate');
    // Zakładki zaparkowane przez wyłączany plugin wracają na swoje miejsca.
    for (const p of [...app.parked]) if (p.by === id) unparkTab(p.tab.id, false);
  }
  r.enabled = on;
}

export function setConfig(id: string, key: string, value: string | number | boolean) {
  const r = record(id);
  if (!r) return;
  r.config[key] = value;
  emit(id, 'config', { key, config: configOf(id) });
}

export function resetConfig(id: string) {
  const r = record(id);
  if (!r) return;
  r.config = {};
  for (const k of Object.keys(loaded(id)?.manifest.config || {})) emit(id, 'config', { key: k, config: configOf(id) });
}

export function runCommand(c: CommandReg) { emit(c.pluginId, 'command', { id: c.id }); }

export function tabMenuItems(kind: 'terminal' | 'flow') {
  return enabledPlugins().flatMap((p) => (p.manifest.contributes?.tabMenu || [])
    .filter((m) => m.when !== 'terminal' || kind === 'terminal')
    .map((m) => ({ pluginId: p.manifest.id, ...m })));
}

export function dropTabOnSection(pluginId: string, tabId: string) { emit(pluginId, 'tabDrop', { tabId }); }

/* ---------- import ---------- */

export interface ImportReview { path: string; manifest: PluginManifest; files: number }

export function validateManifest(m: any, hasMain: boolean): string | null {
  const missing = ['id', 'name', 'version', 'main'].filter((k) => !m?.[k]);
  if (missing.length) return `W plugin.json brakuje pól: ${missing.join(', ')}.`;
  if (!/^[A-Za-z0-9._-]+$/.test(m.id)) return 'Identyfikator może zawierać tylko litery, cyfry, kropki, myślniki i podkreślenia.';
  if (!hasMain) return `Plik wejściowy „${m.main}” wskazany w plugin.json nie istnieje w archiwum.`;
  const perms: string[] = Array.isArray(m.permissions) ? m.permissions : [];
  const bad = perms.filter((p) => FORBIDDEN.some((f) => p.startsWith(f)));
  if (bad.length) return `Plugin prosi o zabronione uprawnienia: ${bad.join(', ')}. Pluginy nie mogą czytać haseł, kluczy ani wpisywanych znaków.`;
  const unknown = perms.filter((p) => !KNOWN_PERMS[p]);
  if (unknown.length) return `Nieznane uprawnienia: ${unknown.join(', ')}.`;
  return null;
}

export async function pickAndInspect(): Promise<ImportReview> {
  if (!isTauri) throw new Error('Import pluginów działa w aplikacji.');
  const { open } = await import('@tauri-apps/plugin-dialog');
  const path = await open({ multiple: false, filters: [{ name: 'Plugin Hermitty', extensions: ['zip'] }] });
  if (!path || Array.isArray(path)) throw new Error('');
  const r = await call<{ manifest: string; files: number; hasMain: boolean }>('plugin_inspect', { path });
  let m: any;
  try { m = JSON.parse(r.manifest); } catch (e) { throw new Error(`plugin.json nie jest poprawnym JSON-em: ${e}`); }
  const err = validateManifest(m, r.hasMain);
  if (err) throw new Error(err);
  m.permissions ||= [];
  return { path: String(path), manifest: m, files: r.files };
}

export async function install(review: ImportReview) {
  const id = review.manifest.id;
  const wasEnabled = isEnabled(id);
  if (wasEnabled) setEnabled(id, false);
  await call('plugin_install', { path: review.path, id });
  await loadPlugins();
  const r = record(id);
  if (r) { r.builtin = false; r.enabled = wasEnabled; }
}

export async function uninstall(id: string) {
  setEnabled(id, false);
  await call('plugin_uninstall', { id, keepData: true });
  const i = app.plugins.findIndex((r) => r.id === id);
  if (i >= 0) app.plugins.splice(i, 1);
  await loadPlugins();
}
