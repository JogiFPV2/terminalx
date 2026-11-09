// Sesje terminali: xterm.js + proces w PTY. Sesja żyje niezależnie od komponentów:
// niewidoczny terminal czeka w ukrytym „parkingu” w DOM i dalej przyjmuje wyjście,
// więc przełączanie zakładek, tryb okien i Procesy w tle niczego nie przerywają.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { call, ptySpawn, sshSpawn, isTauri } from '../ipc';
import { terminalTheme, toHex } from '../theme';
import type { Pane, Settings } from '../types';
import { parseOsc7 } from './osc';

interface Session {
  pane: Pane;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  el: HTMLDivElement;
  ptyId: number | null;
  started: number;
  ro: ResizeObserver | null;
  scanned: number;
  ssh: boolean;
  /** Spełnia się, gdy proces w PTY wystartował (albo start się nie udał). */
  ready: Promise<void>;
}

/** Konfiguracja hosta SSH dla `ssh:<id>`; ustawia ją warstwa stanu (Vault). */
let hostResolver: ((id: string) => Record<string, unknown> | null) | null = null;
let sshConnected: ((hostId: string) => void) | null = null;
export function setSshHooks(resolve: typeof hostResolver, connected: typeof sshConnected) { hostResolver = resolve; sshConnected = connected; }

/** Panel po id; daje uruchomić powłokę zakładki, której jeszcze nikt nie otworzył (patrz write). */
let paneResolver: ((id: string) => Pane | null) | null = null;
export function setPaneResolver(f: typeof paneResolver) { paneResolver = f; }

const cmd = (s: Session, op: 'write' | 'resize' | 'kill') =>
  s.ssh ? ({ write: 'ssh_write', resize: 'ssh_resize', kill: 'ssh_close' } as const)[op] : ({ write: 'pty_write', resize: 'pty_resize', kill: 'pty_kill' } as const)[op];

/** cwd: katalog tak, jak widzi go powłoka (w WSL ścieżka Linuksa); dir: ta sama ścieżka do odczytu z Windows. */
export const termStatus = $state<Record<string, { exited: boolean; code: number | null; title: string; cwd: string; dir: string; seq: number }>>({});

const sessions = new Map<string, Session>();
let park: HTMLDivElement | null = null;
let settingsRef: Settings | null = null;
const listeners = new Set<(paneId: string, data: string) => void>();

function parking() {
  if (!park) {
    park = document.createElement('div');
    park.setAttribute('aria-hidden', 'true');
    Object.assign(park.style, { position: 'fixed', left: '-10000px', top: '0', width: '900px', height: '500px', overflow: 'hidden', visibility: 'hidden' });
    document.body.appendChild(park);
  }
  return park;
}

async function openExternal(url: string) {
  if (isTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    openUrl(url).catch(() => {});
  } else window.open(url, '_blank');
}

export function configure(s: Settings) { settingsRef = s; }

export function onOutput(cb: (paneId: string, data: string) => void) { listeners.add(cb); return () => listeners.delete(cb); }

/* Koniec komendy zgłaszany przez powłokę (OSC 133;D;kod, integracja w pty.rs). Wyjście komendy trafia do słuchaczy
 * onOutput wcześniej niż ten znacznik, bo xterm parsuje dane po ich rozesłaniu. */
const doneListeners = new Set<(paneId: string, code: number | null) => void>();
const integrated = new Set<string>();
export function onCommandDone(cb: (paneId: string, code: number | null) => void) { doneListeners.add(cb); return () => doneListeners.delete(cb); }
/** Czy powłoka w panelu zgłasza koniec komend (lokalne powłoki tak; SSH i powłoki z własnym PROMPT_COMMAND nie). */
export const hasShellIntegration = (paneId: string) => integrated.has(paneId);

export function has(paneId: string) { return sessions.has(paneId); }

export function ensureSession(pane: Pane): Session {
  const existing = sessions.get(pane.id);
  if (existing) return existing;
  const s = settingsRef;
  const term = new Terminal({
    fontFamily: s?.fontFamily || 'Consolas, monospace',
    fontSize: s?.fontSize || 13,
    lineHeight: s?.lineHeight || 1.2,
    scrollback: s?.scrollback || 5000,
    cursorBlink: s?.cursorBlink ?? true,
    allowProposedApi: true,
    theme: terminalTheme(),
    windowsPty: { backend: 'conpty' },
    macOptionIsMeta: true,
    rightClickSelectsWord: false,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((_e, uri) => openExternal(uri)));
  const uni = new Unicode11Addon();
  term.loadAddon(uni);
  term.unicode.activeVersion = '11';

  const el = document.createElement('div');
  el.className = 'term-el';
  el.style.cssText = 'width:100%;height:100%;';
  parking().appendChild(el);
  term.open(el);
  if (s && s.lightMode === false) {
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    } catch { /* zostaje renderer DOM */ }
  }

  const session: Session = { pane, term, fit, search, el, ptyId: null, started: Date.now(), ro: null, scanned: 0, ssh: pane.shell.startsWith('ssh:'), ready: Promise.resolve() };
  sessions.set(pane.id, session);
  termStatus[pane.id] = { exited: false, code: null, title: '', cwd: pane.cwd || '', dir: '', seq: 0 };

  term.onData((d) => {
    const st = termStatus[pane.id];
    if (st?.exited) { if (d === '\r') restart(pane.id); return; }
    if (session.ptyId != null) call(cmd(session, 'write'), { id: session.ptyId, data: d }).catch(() => {});
  });
  term.onResize(({ cols, rows }) => { if (session.ptyId != null) call(cmd(session, 'resize'), { id: session.ptyId, cols, rows }).catch(() => {}); });
  term.onTitleChange((t) => { if (termStatus[pane.id]) termStatus[pane.id].title = t; });
  // Bieżący katalog zgłaszany przez powłokę (integracja ustawiana w pty.rs): OSC 7 i OSC 9;9.
  const setDir = (d: { cwd: string; dir: string } | null) => { const st = termStatus[pane.id]; if (d && st) { st.cwd = d.cwd; st.dir = d.dir; st.seq++; } };
  term.parser.registerOscHandler(7, (data) => { setDir(parseOsc7(data)); return true; });
  term.parser.registerOscHandler(133, (data) => {
    if (data !== 'D' && !data.startsWith('D;')) return false;
    integrated.add(pane.id);
    const code = parseInt(data.slice(2), 10);
    for (const cb of doneListeners) cb(pane.id, Number.isFinite(code) ? code : null);
    return true;
  });
  term.parser.registerOscHandler(9, (data) => {
    if (!data.startsWith('9;')) return false;
    const p = data.slice(2).replace(/^"|"$/g, '');
    if (p) setDir({ cwd: p, dir: p });
    return true;
  });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && (k === 'c') && (e.shiftKey || term.hasSelection())) {
      const sel = term.getSelection();
      if (sel) { navigator.clipboard.writeText(sel).catch(() => {}); term.clearSelection(); }
      return false;
    }
    if (e.ctrlKey && k === 'v') {
      navigator.clipboard.readText().then((t) => t && term.paste(t)).catch(() => {});
      e.preventDefault();
      return false;
    }
    // Skróty aplikacji nie trafiają do powłoki.
    if (e.ctrlKey && e.shiftKey && ['t', 'w', 'f', 'k', 'p', 'd', 'e'].includes(k)) return false;
    if (e.ctrlKey && (k === 'tab' || k === ',')) return false;
    return true;
  });
  term.onWriteParsed(() => highlight(session));
  el.addEventListener('contextmenu', (e) => {
    // PPM w terminalu: z zaznaczeniem kopiuje, bez zaznaczenia wkleja (jak Windows Terminal).
    e.preventDefault();
    e.stopPropagation();
    if (term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()).catch(() => {}); term.clearSelection(); }
    else navigator.clipboard.readText().then((t) => t && term.paste(t)).catch(() => {});
  });

  spawn(session);
  return session;
}

function spawn(session: Session) {
  const { pane, term } = session;
  // Bajty z lokalnego PTY: xterm sam składa znaki wielobajtowe, a potwierdzenie (ack) wraca po
  // przetworzeniu paczki, więc szybki program w powłoce czeka na interfejs zamiast zapychać pamięć.
  // Tekst dla słuchaczy (agent, pluginy, telefon) dekodujemy tylko, gdy ktoś słucha.
  const dec = new TextDecoder();
  let pendingAck = 0, ackTimer = 0;
  const ack = (n: number) => {
    pendingAck += n;
    const flush = () => { clearTimeout(ackTimer); ackTimer = 0; if (session.ptyId != null && pendingAck) call('pty_ack', { id: session.ptyId, bytes: pendingAck }).catch(() => {}); pendingAck = 0; };
    if (pendingAck >= 256 * 1024) flush(); else if (!ackTimer) ackTimer = window.setTimeout(flush, 50);
  };
  const onEvent = (ev: import('../ipc').PtyEvent) => {
    if (ev instanceof ArrayBuffer) {
      const bytes = new Uint8Array(ev);
      term.write(bytes, () => ack(bytes.length));
      if (listeners.size) { const text = dec.decode(bytes, { stream: true }); for (const cb of listeners) cb(pane.id, text); }
    } else if (ev.type === 'data') {
      term.write(ev.data);
      for (const cb of listeners) cb(pane.id, ev.data);
    } else {
      session.ptyId = null;
      if (termStatus[pane.id]) { termStatus[pane.id].exited = true; termStatus[pane.id].code = ev.code; }
      term.write(`\r\n\x1b[2m[${session.ssh ? 'połączenie zakończone' : 'proces zakończony'}${ev.code != null ? `, kod ${ev.code}` : ''} · Enter ${session.ssh ? 'łączy' : 'uruchamia'} ponownie]\x1b[0m\r\n`);
    }
  };
  let start: Promise<number>;
  if (session.ssh) {
    const host = hostResolver?.(pane.shell.slice(4));
    if (!host) start = Promise.reject(new Error('Tego hosta nie ma już w Vault.'));
    else {
      term.write(`\x1b[2mŁączenie z ${host.user}@${host.host}:${host.port}…\x1b[0m\r\n`);
      start = sshSpawn(host, term.cols, term.rows, onEvent).then((id) => { sshConnected?.(pane.shell.slice(4)); return id; });
    }
  } else start = ptySpawn(pane.shell, pane.cwd, term.cols, term.rows, onEvent, pane.accounts);
  session.ready = start.then((id) => { session.ptyId = id; session.started = Date.now(); })
    .catch((err) => {
      if (termStatus[pane.id]) termStatus[pane.id].exited = true;
      term.write(`\x1b[31m${String(err).replace(/^Error: /, '')}\x1b[0m\r\n\x1b[2mEnter: spróbuj ponownie\x1b[0m\r\n`);
    });
}

export function restart(paneId: string) {
  const s = sessions.get(paneId);
  if (!s) return;
  if (s.ptyId != null) call(cmd(s, 'kill'), { id: s.ptyId }).catch(() => {});
  if (termStatus[paneId]) { termStatus[paneId].exited = false; termStatus[paneId].code = null; }
  s.term.write('\r\n');
  spawn(s);
}

/* ---------- keyword highlighting ---------- */

// Reguły podświetlania skompilowane raz (na zmianę listy albo motywu), nie przy każdej paczce wyjścia.
let compiled: { key: string; theme: number; list: { re: RegExp; color: string }[] } = { key: '', theme: -1, list: [] };
let themeGen = 0;
function rulesNow() {
  const rules = settingsRef?.keywords || [];
  const key = rules.map((r) => r.pattern + '' + r.color).join('');
  if (compiled.key !== key || compiled.theme !== themeGen) {
    const cs = getComputedStyle(document.documentElement);
    const list: { re: RegExp; color: string }[] = [];
    for (const r of rules) { try { list.push({ re: new RegExp(r.pattern, 'g'), color: toHex(cs.getPropertyValue('--' + r.color).trim() || r.color, '#ff5555') }); } catch { /* zła reguła */ } }
    compiled = { key, theme: themeGen, list };
  }
  return compiled.list;
}

function highlight(s: Session) {
  const rules = rulesNow();
  if (!rules.length) return;
  const buf = s.term.buffer.active;
  const end = buf.baseY + buf.cursorY;
  if (end < s.scanned) s.scanned = end; // po wyczyszczeniu ekranu (cls/clear)
  // Tylko linie zakończone (powyżej kursora): są już ostateczne, więc każdą dekorujemy raz.
  const start = Math.max(s.scanned, end - 200);
  if (start >= end) return;
  for (let y = start; y < end; y++) {
    const line = buf.getLine(y)?.translateToString(true);
    if (!line) continue;
    for (const r of rules) {
      for (const m of line.matchAll(r.re)) {
        if (!m[0]) continue;
        const marker = s.term.registerMarker(y - (buf.baseY + buf.cursorY));
        if (!marker) continue;
        s.term.registerDecoration({ marker, x: m.index!, width: m[0].length, foregroundColor: r.color, layer: 'top' });
      }
    }
  }
  s.scanned = end;
}

/* ---------- attach / detach ---------- */

export function attach(paneId: string, host: HTMLElement, focus = false) {
  const s = sessions.get(paneId);
  if (!s) return;
  host.appendChild(s.el);
  const doFit = () => { try { if (host.clientWidth > 20 && host.clientHeight > 20) s.fit.fit(); } catch { /* ignore */ } };
  requestAnimationFrame(doFit);
  s.ro?.disconnect();
  let t: number | undefined;
  s.ro = new ResizeObserver(() => { clearTimeout(t); t = window.setTimeout(doFit, 30); });
  s.ro.observe(host);
  if (focus) setTimeout(() => s.term.focus(), 0);
}

export function detach(paneId: string, host?: HTMLElement) {
  const s = sessions.get(paneId);
  if (!s) return;
  if (host && s.el.parentElement !== host) return; // ktoś inny już go przejął
  s.ro?.disconnect();
  s.ro = null;
  parking().appendChild(s.el);
}

export function focus(paneId: string) { sessions.get(paneId)?.term.focus(); }

export function dispose(paneId: string) {
  const s = sessions.get(paneId);
  if (!s) return;
  if (s.ptyId != null) call(cmd(s, 'kill'), { id: s.ptyId }).catch(() => {});
  integrated.delete(paneId);
  s.ro?.disconnect();
  s.term.dispose();
  s.el.remove();
  sessions.delete(paneId);
  delete termStatus[paneId];
}

/** Zapis do powłoki. Zakładka przywrócona po restarcie, której jeszcze nikt nie otworzył, nie ma
 *  procesu (oszczędność pamięci); pierwszy zapis (agent, telefon, workflow, plugin) go uruchamia. */
export async function write(paneId: string, text: string) {
  let s = sessions.get(paneId);
  if (!s) { const pane = paneResolver?.(paneId); if (pane) s = ensureSession(pane); }
  if (s && s.ptyId == null) await s.ready;
  if (s?.ptyId != null) return call(cmd(s, 'write'), { id: s.ptyId, data: text });
  throw new Error('Terminal nie działa');
}

/** Wpisuje w powłoce `cd` do podkatalogu (albo `..`). Najpierw czyści niedokończoną linię:
 *  Esc w cmd i PowerShell, Ctrl+U w bashu (tam Esc to prefiks Meta). */
export function changeDir(paneId: string, name: string) {
  const s = sessions.get(paneId);
  if (!s) return Promise.reject(new Error('Terminal nie działa'));
  const sh = s.pane.shell;
  if (sh === 'cmd') return clearThen(paneId, `cd "${name}"\r`);
  if (sh === 'pwsh' || sh === 'powershell') return clearThen(paneId, `${/[[\]*?`]/.test(name) ? 'cd -LiteralPath' : 'cd'} '${name.replace(/'/g, "''")}'\r`);
  return write(paneId, `\x15cd '${name.replace(/'/g, `'\\''`)}'\r`);
}
// Samotny Esc musi dojść osobno, inaczej ConPTY sklei go z następną literą w Alt+litera.
async function clearThen(paneId: string, text: string) {
  await write(paneId, '\x1b');
  await new Promise((r) => setTimeout(r, 60));
  return write(paneId, text);
}

export function paste(paneId: string, text: string) { sessions.get(paneId)?.term.paste(text); }

/** Ostatnie linie bufora (bez pustych na końcu). */
export function tail(paneId: string, lines = 50): string[] {
  const s = sessions.get(paneId);
  if (!s) return [];
  const buf = s.term.buffer.active;
  const out: string[] = [];
  const last = buf.baseY + buf.cursorY;
  for (let y = Math.max(0, last - lines * 3); y <= last; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && out.length) out[out.length - 1] += text; else out.push(text);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.slice(-lines);
}

export function fullText(paneId: string) {
  const s = sessions.get(paneId);
  if (!s) return '';
  const buf = s.term.buffer.active;
  const out: string[] = [];
  for (let y = 0; y < buf.length; y++) out.push(buf.getLine(y)?.translateToString(true) || '');
  return out.join('\n').replace(/\n+$/, '\n');
}

export function selection(paneId: string) { return sessions.get(paneId)?.term.getSelection() || ''; }

export function find(paneId: string, q: string, back = false) {
  const s = sessions.get(paneId);
  if (!s || !q) return false;
  const opts = { decorations: { matchOverviewRuler: '#888888', activeMatchColorOverviewRuler: '#ffaa00', matchBackground: '#55555566', activeMatchBackground: '#ffaa0088' } };
  return back ? s.search.findPrevious(q, opts) : s.search.findNext(q, opts);
}

export function clearFind(paneId: string) { sessions.get(paneId)?.search.clearDecorations(); }

export async function info(paneId: string) {
  const s = sessions.get(paneId);
  if (!s || s.ptyId == null || s.ssh) return null;
  try {
    const r = await call<{ pid: number | null; shell: string; started: number; children: string[] }>('pty_info', { id: s.ptyId });
    return { ...r, started: s.started };
  } catch { return null; }
}

export function startedAt(paneId: string) { return sessions.get(paneId)?.started || Date.now(); }

/** Po zmianie motywu albo ustawień terminala. */
export function refreshAll() {
  themeGen++;
  const theme = terminalTheme();
  for (const s of sessions.values()) {
    s.term.options.theme = theme;
    if (settingsRef) {
      s.term.options.fontFamily = settingsRef.fontFamily;
      s.term.options.fontSize = settingsRef.fontSize;
      s.term.options.lineHeight = settingsRef.lineHeight;
      s.term.options.cursorBlink = settingsRef.cursorBlink;
      s.term.options.scrollback = settingsRef.scrollback;
    }
    try { s.fit.fit(); } catch { /* ignore */ }
  }
}

export function killAll() { for (const id of [...sessions.keys()]) dispose(id); }

export function size(paneId: string) {
  const s = sessions.get(paneId);
  return s ? { cols: s.term.cols, rows: s.term.rows } : { cols: 80, rows: 24 };
}
