// Stan aplikacji na Androida: sparowane komputery, bieżące połączenie i dane z komputera (zakładki, czat, workflow).
// Lista komputerów i ustawienia w localStorage WebView; klucze urządzeń w sejfie (Android Keystore, lib/secrets.ts).
import { Link, type LinkState, type SavedPc } from './link.ts';
import { getSecret, setSecret, deleteSecret, pcKeyName } from './secrets.ts';
import { scanPcs, bridgePaired, pairBridge } from './bridge.svelte';
import { applyTheme, BUILTIN } from '../../../src/lib/theme';
import type { ThemeMode } from '../../../src/lib/types';

export interface RTab { id: string; title: string; kind: string; label: string; color: string }
export interface RWs { id: string; name: string; color: string; activeTab: string | null; busy?: boolean; tabs: RTab[] }
export interface RMsg { id: string; role: string; who: string; text: string; approve?: { tabId?: string; label?: string; command: string; state: 'pending' | 'approved' | 'rejected' } }
export interface RFlow { id: string; title: string; ws: string; wsName: string; nodes: number; running: boolean; byAgent: boolean }
export type View = 'term' | 'agent' | 'flows' | 'bg';

const KEY = 'hermitty-mobile';
const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(`${KEY}:${k}`); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(`${KEY}:${k}`, JSON.stringify(v)); } catch { /* prywatny tryb, brak miejsca */ } };

function guessName() {
  const m = navigator.userAgent.match(/Android[^;]*;\s*([^;)]+)/);
  return (m ? m[1].replace(/\s*Build.*$/, '').trim() : '') || 'Telefon z Androidem';
}

export const S = $state({
  pcs: load<SavedPc[]>('pcs', []),
  settings: load('settings', { theme: 'Pinsy', mode: 'system' as ThemeMode, name: guessName() }),
  /** Bieżący komputer (id urządzenia nadane przez komputer). */
  cur: null as string | null,
  state: 'idle' as LinkState,
  perm: 'view',
  error: '',
  workspaces: [] as RWs[],
  parked: [] as { id: string; title: string; ws: string }[],
  ws: '' as string,
  tab: '' as string,
  view: 'term' as View,
  chat: {} as Record<string, RMsg[]>,
  flows: [] as RFlow[],
  flowRes: {} as Record<string, { state: string; result?: string }>,
  shells: null as null | { shells: { id: string; name: string; kind: string }[]; hosts: { id: string; name: string; addr: string; group: string }[] },
  /** Arkusz na dole ekranu: parowanie, nowa zakładka, ustawienia. */
  sheet: null as null | 'pair' | 'newTab' | 'settings',
  toast: '' as string,
  /** Połączenie otwarte dla ekranu workspace'ów (bez przechodzenia do ekranu pilota). */
  quiet: false,
  /** Parowanie bez QR: kod, który musi być taki sam na komputerze. */
  sas: '',
});

let link: Link | null = null;
const outListeners = new Set<(tab: string, data: string) => void>();
export const onOut = (cb: (tab: string, data: string) => void) => { outListeners.add(cb); return () => outListeners.delete(cb); };

export const can = (need: 'control' | 'full') => ({ view: 0, control: 1, full: 2 }[S.perm] ?? 0) >= (need === 'control' ? 1 : 2);
export const curPc = () => S.pcs.find((p) => p.device === S.cur) || null;
export const curWs = () => S.workspaces.find((w) => w.id === S.ws) || S.workspaces[0];

let toastTimer = 0;
export function toast(text: string) { S.toast = text; clearTimeout(toastTimer); toastTimer = window.setTimeout(() => (S.toast = ''), 3200); }

export function theme() {
  applyTheme(BUILTIN, S.settings.theme, S.settings.mode);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--background').trim());
}
export function saveSettings() { save('settings', S.settings); theme(); }
// Klucze trafiają tylko do sejfu. Gdy sejf zawiódł, klucz zostaje w localStorage jak w etapie 1, żeby nie przepadł.
const unsealed = new Set<string>();
const savePcs = () => save('pcs', S.pcs.map(({ key, ...rest }) => (unsealed.has(rest.device) ? { ...rest, key } : rest)));
async function seal(pc: SavedPc) {
  try { await setSecret(pcKeyName(pc.device), pc.key); unsealed.delete(pc.device); }
  catch (e) { console.error('sejf', e); unsealed.add(pc.device); }
}

/** Wczytuje klucze komputerów z sejfu; starsze wpisy z kluczem w localStorage przenosi do sejfu. */
async function loadKeys() {
  const out: SavedPc[] = [];
  let lost = 0, broken = false;
  for (const pc of S.pcs) {
    try {
      if (pc.key) { await seal(pc); out.push(pc); continue; }
      const key = await getSecret(pcKeyName(pc.device));
      if (key) out.push({ ...pc, key }); else lost++;
    } catch (e) {
      // Sejf chwilowo nie działa: komputer zostaje na liście (bez klucza), żeby nie zniknął na stałe.
      console.error('sejf', e); broken = true; out.push({ ...pc, key: '' });
    }
  }
  S.pcs = out; savePcs();
  if (broken) toast('Sejf telefonu nie odpowiada. Uruchom aplikację ponownie.');
  if (lost) toast(lost === 1 ? 'Klucz jednego komputera przepadł. Sparuj go ponownie.' : `Klucze ${lost} komputerów przepadły. Sparuj je ponownie.`);
}
export const keysReady = loadKeys();

function applyState(st: { workspaces: RWs[]; parked: any[]; activeWs: string }) {
  S.workspaces = st.workspaces;
  S.parked = st.parked || [];
  if (!S.workspaces.some((w) => w.id === S.ws)) S.ws = st.activeWs || S.workspaces[0]?.id || '';
  const w = curWs();
  if (w && !w.tabs.some((t) => t.id === S.tab)) S.tab = w.activeTab && w.tabs.some((t) => t.id === w.activeTab) ? w.activeTab : w.tabs.find((t) => t.kind === 'terminal')?.id || '';
}

const handlers = {
  state: (s: LinkState, info: { perm?: string; error?: string }) => {
    S.state = s; S.error = info.error || ''; if (info.perm) S.perm = info.perm;
    if (s === 'ready') { refresh(); if (pairBridgeNext) { pairBridgeNext = false; autoBridge(); } }
  },
  ev: (e: string, d: any) => {
    if (e === 'state') applyState(d);
    else if (e === 'chat') S.chat[d.ws] = d.messages;
    else if (e === 'out') for (const cb of outListeners) cb(d.tab, d.data);
    else if (e === 'flow') { S.flowRes[d.tab] = { state: d.state, result: d.result }; if (d.state !== 'running') refreshFlows(); }
  },
  paired: (pc: SavedPc) => {
    S.pcs = [...S.pcs.filter((p) => p.device !== pc.device), pc];
    unsealed.add(pc.device); savePcs();
    seal(pc).then(savePcs);
    S.cur = pc.device; S.sheet = null; S.sas = '';
    pairBridgeNext = true;
    toast('Sparowano z komputerem');
  },
  forgotten: () => { if (S.cur) forget(S.cur, true); },
  sas: (code: string) => { S.sas = code; },
  // Komputer zmienił adres IP: szukamy go w sieci po stałym id.
  rescue: async (pcId: string) => {
    const port = Number(new URL(curPc()?.url || 'http://x:7420').port) || 7420;
    const found = (await scanPcs(port).catch(() => [])).filter((f) => f.id === pcId);
    return found.map((f) => `http://${f.host}:${f.port}`);
  },
};

/** Jedno parowanie: po sparowaniu zdalnego dostępu telefon sam paruje mostek Telefon kodem od komputera. */
let pairBridgeNext = false;
async function autoBridge() {
  if ((await bridgePaired()) !== false) return;
  try {
    const r = await req<{ code: string; hosts: string[]; port: number }>('bridgePair', {}, 40_000);
    await pairBridge(r.hosts, r.port, r.code);
    toast('Sparowano też mostek: powiadomienia, SMS-y i dyktafon na komputerze');
  } catch (e) { console.warn('mostek', e); }
}

async function refresh() {
  try {
    applyState(await req('state'));
    await Promise.all([loadChat(), refreshFlows(), req('shells').then((s) => (S.shells = s)).catch(() => {})]);
    const pc = curPc(); if (pc) { pc.lastSeen = Date.now(); savePcs(); }
  } catch (e) { toast(msg(e)); }
}
export async function loadChat() { const w = curWs(); if (w) S.chat[w.id] = await req('chat', { ws: w.id }).catch(() => S.chat[w.id] || []); }
export async function refreshFlows() { S.flows = await req('flows').catch(() => S.flows); }

export const msg = (e: unknown) => String((e as Error)?.message || e).replace(/^Error: /, '');

export function req<T = any>(m: string, p: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
  if (!link) return Promise.reject(new Error('Brak połączenia z komputerem'));
  return link.req<T>(m, p, timeoutMs);
}

/** Połączenie z zapisanym komputerem. */
export async function open(device: string, quiet = false) {
  await keysReady;
  S.quiet = quiet;
  const pc = S.pcs.find((p) => p.device === device);
  if (!pc) return;
  if (!pc.key) { toast('Brak klucza tego komputera w sejfie. Uruchom aplikację ponownie albo sparuj go jeszcze raz.'); return; }
  link?.close();
  Object.assign(S, { cur: device, workspaces: [], parked: [], chat: {}, flows: [], flowRes: {}, ws: '', tab: '', view: 'term', perm: 'view' });
  link = new Link(pc, handlers, S.settings.name);
  link.connect();
}

/** Parowanie z linku z kodu QR (zeskanowanego albo wklejonego). */
export function pair(text: string): boolean {
  link?.close();
  const l = Link.fromPairLink(text, handlers, S.settings.name);
  if (!l) return false;
  Object.assign(S, { cur: null, workspaces: [], parked: [], chat: {}, flows: [], ws: '', tab: '' });
  link = l; l.connect();
  return true;
}

/** Parowanie bez QR z komputerem znalezionym w sieci: oba ekrany pokażą ten sam 6-cyfrowy kod. */
export function pairNear(host: string, port: number, name: string, pcId?: string) {
  link?.close();
  Object.assign(S, { cur: null, workspaces: [], parked: [], chat: {}, flows: [], ws: '', tab: '', sas: '' });
  link = Link.near(`http://${host}:${port}`, name, handlers, S.settings.name, pcId);
  link.connect();
}

export function disconnect() { link?.close(); link = null; S.cur = null; S.state = 'idle'; S.quiet = false; }

/** Ostatnio używany sparowany komputer (do automatycznego połączenia na ekranie workspace'ów). */
export const lastPc = () => [...S.pcs].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))[0] || null;

/** Usuwa komputer z listy (`remote`: komputer sam go już nie zna). */
export function forget(device: string, remote = false) {
  if (S.cur === device) disconnect();
  S.pcs = S.pcs.filter((p) => p.device !== device); savePcs();
  deleteSecret(pcKeyName(device)).catch(() => {});
  if (remote) toast('Komputer nie zna już tego telefonu. Sparuj go ponownie.');
}

export function renamePc(device: string, name: string) { const p = S.pcs.find((x) => x.device === device); if (p && name.trim()) { p.name = name.trim().slice(0, 40); savePcs(); } }
