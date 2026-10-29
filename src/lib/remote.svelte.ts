// Zdalny dostęp: interfejs obsługuje zapytania telefonu przekazane przez bramkę w rdzeniu (remote.rs)
// i wysyła zdarzenia (wyjście terminali, stan zakładek, czat agenta). Uprawnienia sprawdza też rdzeń.
import { call, isTauri } from './ipc';
import { app, ui, findTab, tabKind, parkTab, unparkTab, newTab, closeTab, notify } from './state.svelte';
import * as sessions from './terminal/sessions.svelte';
import { sendToAgent, resolveApproval } from './agent.svelte';
import { toHex } from './theme';
import type { RemoteDevice } from './types';

export const remote = $state({
  running: false,
  addrs: [] as string[],
  clients: [] as [number, string][],
  devices: [] as (RemoteDevice & { lastSeen?: number })[],
  pair: null as null | { urls: string[]; expires: number },
  error: '',
});

const subs = new Map<number, Map<string, () => void>>();

const send = (conn: number | null, obj: unknown) => call('remote_send', { conn, msg: JSON.stringify(obj) }).catch(() => {});

function color(v: string) {
  const m = v.match(/var\((--[\w-]+)\)/);
  return toHex(m ? getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() : v, '#888888');
}

function snapshot() {
  return {
    activeWs: app.activeWs,
    workspaces: app.workspaces.map((w) => ({
      id: w.id, name: w.name, color: color(w.color), activeTab: w.activeTab,
      tabs: w.tabs.map((t) => { const k = tabKind(t); return { id: t.id, title: t.title, kind: t.kind, label: k.label, color: color(k.c) }; }),
    })),
    parked: app.parked.map((p) => ({ id: p.tab.id, title: p.tab.title, ws: p.wsName })),
  };
}

const chatOf = (wsId: string) => (app.workspaces.find((w) => w.id === wsId)?.chat || []).slice(-60).map((m) => ({ id: m.id, role: m.role, who: m.who, text: m.text, approve: m.approve }));

function paneOf(tabId: string) {
  const f = findTab(tabId);
  const pane = f?.tab.panes[0];
  if (!f || f.tab.kind !== 'terminal' || !pane) throw new Error('To nie jest zakładka terminala.');
  return pane;
}

async function handle(r: { conn: number; device: string; perm: string; id: number; m: string; p: any }) {
  const p = r.p || {};
  const ok = (v: unknown = null) => send(r.conn, { t: 'res', id: r.id, ok: true, r: v });
  try {
    switch (r.m) {
      case 'ping': return ok('pong');
      case 'state': return ok(snapshot());
      case 'tail': return ok(sessions.tail(paneOf(p.tab).id, Math.min(500, p.lines || 50)).join('\n'));
      case 'subscribe': {
        const pane = paneOf(p.tab);
        const map = subs.get(r.conn) || new Map<string, () => void>();
        subs.set(r.conn, map);
        map.get(p.tab)?.();
        // Paczkujemy wyjście co 50 ms, żeby nie zalać połączenia drobnymi ramkami.
        let buf = '', timer = 0;
        const off = sessions.onOutput((id, data) => {
          if (id !== pane.id) return;
          buf += data;
          if (!timer) timer = window.setTimeout(() => { send(r.conn, { t: 'ev', e: 'out', d: { tab: p.tab, data: buf } }); buf = ''; timer = 0; }, 50);
        });
        map.set(p.tab, () => { off(); clearTimeout(timer); });
        const { cols, rows } = sessions.size(pane.id);
        return ok({ cols, rows, screen: sessions.tail(pane.id, rows * 4).join('\n') });
      }
      case 'unsubscribe': { const map = subs.get(r.conn); map?.get(p.tab)?.(); map?.delete(p.tab); return ok(); }
      case 'write': await sessions.write(paneOf(p.tab).id, String(p.data ?? '')); return ok();
      case 'chat': return ok(chatOf(p.ws));
      case 'approve': {
        const ws = app.workspaces.find((w) => w.id === p.ws);
        if (!ws) throw new Error('Nie ma takiego workspace\'u.');
        resolveApproval(ws, String(p.msg), !!p.ok);
        return ok();
      }
      case 'agent': {
        const ws = app.workspaces.find((w) => w.id === p.ws);
        if (!ws) throw new Error('Nie ma takiego workspace\'u.');
        ok();
        await sendToAgent(ws, String(p.text || ''));
        return;
      }
      case 'park': parkTab(p.tab); return ok();
      case 'unpark': unparkTab(p.tab, false); return ok();
      case 'newTab': newTab(String(p.shell || app.settings.defaultShell)); return ok();
      case 'closeTab': closeTab(p.tab); return ok();
      default: throw new Error(`Nieznana operacja ${r.m}`);
    }
  } catch (e) {
    send(r.conn, { t: 'res', id: r.id, ok: false, error: String(e).replace(/^Error: /, '') });
  }
}

export async function refreshStatus() {
  if (!isTauri) return;
  try {
    const s = await call<{ running: boolean; addrs: string[]; clients: [number, string][] }>('remote_status');
    remote.running = s.running; remote.addrs = s.addrs; remote.clients = s.clients;
    remote.devices = await call('remote_devices');
  } catch { /* ignore */ }
}

export async function startRemote() {
  remote.error = '';
  try {
    remote.addrs = await call<string[]>('remote_start', { port: app.remote.port, mode: app.remote.mode });
    app.remote.enabled = true;
    if (!remote.addrs.length) remote.error = app.remote.mode === 'lan' ? 'Nie znaleziono adresu w sieci lokalnej. Czy komputer jest podłączony do Wi-Fi lub kabla?' : '';
  } catch (e) {
    remote.error = String(e).replace(/^Error: /, '');
    app.remote.enabled = false;
  }
  refreshStatus();
}

export async function stopRemote() {
  await call('remote_stop').catch(() => {});
  app.remote.enabled = false;
  remote.pair = null;
  for (const m of subs.values()) for (const off of m.values()) off();
  subs.clear();
  refreshStatus();
}

export async function beginPair() {
  const r = await call<{ urls: string[]; expiresIn: number }>('remote_pair_begin');
  remote.pair = { urls: r.urls, expires: Date.now() + r.expiresIn * 1000 };
}

export async function setPerm(id: string, perm: string) { await call('remote_set_perm', { deviceId: id, perm }); refreshStatus(); }
export async function revoke(id: string) { await call('remote_revoke', { deviceId: id }); refreshStatus(); }

let started = false;
export function initRemote() {
  if (started || !isTauri) return;
  started = true;
  import('@tauri-apps/api/event').then(({ listen }) => {
    listen<any>('remote:req', (e) => handle(e.payload));
    listen('remote:clients', () => refreshStatus());
    listen('remote:devices', () => refreshStatus());
    listen<{ conn: number }>('remote:closed', (e) => { const m = subs.get(e.payload.conn); m?.forEach((off) => off()); subs.delete(e.payload.conn); });
    listen<{ pairId: string; name: string; addr: string }>('remote:pair-request', (e) => {
      const p = e.payload;
      remote.pair = null;
      ui.confirm = {
        title: 'Nowe urządzenie',
        message: `„${p.name}” (${p.addr}) chce sterować tą aplikacją. Zezwól tylko, jeśli to Twój telefon i właśnie zeskanowałeś kod.\n\nUrządzenie dostanie uprawnienie „Sterowanie”; zmienisz je w Ustawienia → Zdalny dostęp.`,
        confirmLabel: 'Zezwól',
        resolve: (ok) => {
          call('remote_pair_decision', { pairId: p.pairId, ok: !!ok, perm: 'control' });
          if (ok) notify(`Sparowano „${p.name}”`, 'success');
        },
      };
    });
  });
  // Stan zakładek i czat agenta trafiają do telefonów na bieżąco.
  $effect.root(() => {
    // Bez podłączonego telefonu efekty nic nie czytają (i nie liczą), więc nie kosztują.
    $effect(() => {
      if (!remote.clients.length) return;
      send(null, { t: 'ev', e: 'state', d: snapshot() });
    });
    $effect(() => {
      if (!remote.clients.length) return;
      for (const w of app.workspaces) {
        void w.chat.length; void w.chat.map((m) => m.approve?.state).join();
        send(null, { t: 'ev', e: 'chat', d: { ws: w.id, messages: chatOf(w.id) } });
      }
    });
  });
  if (app.remote.enabled) startRemote();
}
