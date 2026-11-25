// Workspace'y telefonu: zakładki Termux, SSH, notatki, agent, pliki (SFTP), workflow i terminale z komputera.
// Zapisane w localStorage (bez sekretów). Workspace'y połączonego komputera pokazuje ekran Workspace obok tych,
// z innym podświetleniem; ich dane są w store.svelte.ts (S.workspaces) i zostają na komputerze.
import type { Flow } from '../../../src/lib/types';
import { WS_COLOR_LIST } from '../../../src/lib/defaults';
import { nid } from '../../../src/lib/util';
import { SSH, hostById, type SshHost } from './ssh.svelte';
import { TERMUX_ID } from './termux.svelte';
import { execOn, dropChat, type ToolSet } from './agent.svelte';
import { tail, inputs } from './termbus';

export type TabKind = 'termux' | 'ssh' | 'agent' | 'notes' | 'sftp' | 'flow' | 'remote';
export interface LTab {
  id: string;
  kind: TabKind;
  title: string;
  /** ssh i sftp: id serwera (Termux: „termux”). */
  host?: string;
  /** remote: komputer (id urządzenia) i zakładka na nim. */
  device?: string;
  rtab?: string;
  note?: string;
  flow?: Flow;
}
export interface LWs { id: string; name: string; color: string; tabs: LTab[]; active: string | null }

export const KIND_ICON: Record<TabKind, string> = { termux: 'term', ssh: 'ssh', agent: 'bot', notes: 'note', sftp: 'folder', flow: 'flow', remote: 'monitor' };
export const KIND_NAME: Record<TabKind, string> = { termux: 'Termux', ssh: 'SSH', agent: 'Agent AI', notes: 'Notatki', sftp: 'Pliki', flow: 'Workflow', remote: 'Z komputera' };

const KEY = 'hermitty-mobile:ws';
function load(): LWs[] {
  try { const v = localStorage.getItem(KEY); if (v) return JSON.parse(v); } catch { /* domyślne */ }
  return [{ id: 'w-phone', name: 'Telefon', color: WS_COLOR_LIST[0][0], tabs: [], active: null }];
}

export const WS = $state({
  open: false,
  list: load(),
  /** Wybrany workspace: id lokalnego albo `pc:<id>` workspace'u z komputera. */
  cur: '',
  /** Widok workspace'u z komputera: terminal, agent albo workflow. */
  pcView: 'term' as 'term' | 'agent' | 'flows',
  sheet: null as null | 'addTab' | 'ws' | 'tab',
  /** Edytowany workspace albo zakładka w arkuszu. */
  edit: '',
});

let timer = 0;
/** Zapis z opóźnieniem (notatki i workflow zmieniają się przy każdym znaku i przesunięciu). */
export function saveWs(now = false) {
  clearTimeout(timer);
  const go = () => { try { localStorage.setItem(KEY, JSON.stringify(WS.list)); } catch { /* brak miejsca */ } };
  if (now) go(); else timer = window.setTimeout(go, 400);
}

export const curLocal = () => WS.list.find((w) => w.id === WS.cur) || null;
export const wsOfTab = (tabId: string) => WS.list.find((w) => w.tabs.some((t) => t.id === tabId)) || null;
export const findTab = (tabId: string) => { for (const w of WS.list) { const t = w.tabs.find((x) => x.id === tabId); if (t) return t; } return null; };
export const tabHost = (t: LTab): SshHost | null => (t.kind === 'termux' ? hostById(TERMUX_ID) : t.host ? hostById(t.host) : null);

export function addWs(name: string) {
  const used = new Set(WS.list.map((w) => w.color));
  const color = WS_COLOR_LIST.find(([c]) => !used.has(c))?.[0] || WS_COLOR_LIST[WS.list.length % WS_COLOR_LIST.length][0];
  const w: LWs = { id: nid('w'), name: name.trim().slice(0, 30) || 'Nowy', color, tabs: [], active: null };
  WS.list.push(w); WS.cur = w.id; saveWs(true);
  return w;
}

export function removeWs(id: string) {
  const w = WS.list.find((x) => x.id === id);
  if (!w) return;
  for (const t of w.tabs) if (t.kind === 'agent') dropChat(`ws:${w.id}`);
  WS.list = WS.list.filter((x) => x.id !== id);
  if (!WS.list.length) WS.list.push({ id: nid('w'), name: 'Telefon', color: WS_COLOR_LIST[0][0], tabs: [], active: null });
  if (WS.cur === id) WS.cur = WS.list[0].id;
  saveWs(true);
}

export function addTab(w: LWs, t: Omit<LTab, 'id'>) {
  const tab: LTab = { id: nid('t'), ...t };
  w.tabs.push(tab); w.active = tab.id; saveWs(true);
  return tab;
}

export function closeTab(w: LWs, id: string) {
  const i = w.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  w.tabs.splice(i, 1);
  if (w.active === id) w.active = w.tabs[Math.max(0, i - 1)]?.id || null;
  if (!w.tabs.some((t) => t.kind === 'agent')) dropChat(`ws:${w.id}`);
  saveWs(true);
}

/* ---------- agent workspace'u: narzędzia na jego zakładkach ---------- */

const termTabs = (w: LWs) => w.tabs.filter((t) => t.kind === 'termux' || t.kind === 'ssh');
const byRef = (w: LWs, ref: string) => w.tabs.find((t) => t.id === ref) || w.tabs.find((t) => t.title.toLowerCase() === String(ref).toLowerCase()) || null;

export function wsTools(wsId: string): ToolSet {
  const w = () => WS.list.find((x) => x.id === wsId)!;
  return {
    system: `Jesteś agentem Hermitty na telefonie z Androidem, przypisanym do workspace'u „${w()?.name}”.
Masz dostęp do jego zakładek: terminale (Termux na tym telefonie i serwery SSH), notatki i workflow.
Komendy wykonujesz narzędziem run_command (osobna, nieinteraktywna sesja; użytkownik zatwierdza każdą).
Do otwartego terminala piszesz narzędziem type_in_terminal (też za zgodą), a jego ekran czytasz read_terminal.
W Termuxie działa pkg, a termux-* z Termux:API (jeśli zainstalowany) daje dostęp do funkcji telefonu.
Odpowiadaj po polsku, zwięźle: to mały ekran.`,
    tools: [
      { name: 'list_tabs', description: 'Zakładki workspace\'u: id, rodzaj, nazwa, cel (Termux albo serwer).', input_schema: { type: 'object', properties: {} } },
      { name: 'read_terminal', description: 'Ostatnie wyjście terminala zakładki (do 4000 znaków, bez kolorów).', input_schema: { type: 'object', properties: { tab: { type: 'string', description: 'id albo nazwa zakładki' } }, required: ['tab'] } },
      { name: 'run_command', description: 'Wykonuje komendę na celu zakładki (Termux albo serwer SSH) w osobnej sesji i zwraca wyjście i kod. Wymaga zgody użytkownika.', input_schema: { type: 'object', properties: { tab: { type: 'string' }, command: { type: 'string' }, timeout_secs: { type: 'number' } }, required: ['tab', 'command'] } },
      { name: 'type_in_terminal', description: 'Wpisuje tekst do otwartego terminala zakładki (dodaj \\n, by zatwierdzić). Wymaga zgody użytkownika.', input_schema: { type: 'object', properties: { tab: { type: 'string' }, text: { type: 'string' } }, required: ['tab', 'text'] } },
      { name: 'read_note', description: 'Treść zakładki z notatkami.', input_schema: { type: 'object', properties: { tab: { type: 'string' } }, required: ['tab'] } },
      { name: 'write_note', description: 'Dopisuje tekst na końcu notatki (albo zastępuje całą przy replace=true).', input_schema: { type: 'object', properties: { tab: { type: 'string' }, text: { type: 'string' }, replace: { type: 'boolean' } }, required: ['tab', 'text'] } },
    ],
    async run(name, input, ctx) {
      const ws = w();
      if (!ws) return 'Workspace nie istnieje.';
      if (name === 'list_tabs') return JSON.stringify(ws.tabs.map((t) => ({ id: t.id, kind: t.kind, title: t.title, target: t.kind === 'termux' ? 'Termux (ten telefon)' : t.host ? `${tabHost(t)?.user}@${tabHost(t)?.host}` : undefined })));
      const t = byRef(ws, String(input.tab || ''));
      if (!t) return `Nie ma zakładki „${input.tab}”. Użyj list_tabs.`;
      switch (name) {
        case 'read_terminal': return tail(t.id) || '(pusto albo zakładka nie była jeszcze otwarta)';
        case 'run_command': {
          const h = tabHost(t);
          if (!h) return 'Ta zakładka nie jest terminalem Termuxa ani SSH.';
          return execOn(h, String(input.command || ''), Number(input.timeout_secs) || 120, ctx, t.title);
        }
        case 'type_in_terminal': {
          if (!termTabs(ws).includes(t)) return 'To nie jest terminal.';
          if (!inputs.has(t.id)) return 'Terminal tej zakładki nie jest otwarty. Poproś użytkownika, by go otworzył.';
          const text = String(input.text || '');
          const item = await ctx.approve(`${t.title} (wpisz)`, text);
          if (!item) return 'Użytkownik odrzucił.';
          inputs.emit(t.id, text.replace(/\n/g, '\r'));
          await new Promise((r) => setTimeout(r, 1500));
          const out = tail(t.id, 2000);
          ctx.done(item, null, out);
          return `Wpisano. Ekran:\n${out}`;
        }
        case 'read_note': return t.kind === 'notes' ? t.note || '(pusta)' : 'To nie są notatki.';
        case 'write_note': {
          if (t.kind !== 'notes') return 'To nie są notatki.';
          t.note = input.replace ? String(input.text || '') : `${t.note ? t.note.replace(/\n*$/, '\n\n') : ''}${input.text || ''}`;
          saveWs();
          return 'Zapisano.';
        }
      }
      return `Nieznane narzędzie ${name}`;
    },
  };
}

export const sshHostsForTabs = () => SSH.hosts.filter((h) => !h.termux);
