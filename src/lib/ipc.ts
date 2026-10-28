// Jedno miejsce na wywołania rdzenia. Poza Tauri (np. `npm run dev` w przeglądarce, testy UI)
// odpowiada atrapa, żeby interfejs dało się uruchomić i przetestować bez kompilacji Rusta.
import { invoke, Channel } from '@tauri-apps/api/core';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export type PtyEvent = { type: 'data'; data: string } | { type: 'exit'; code: number | null };

export function call<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) return mock(cmd, args || {}) as Promise<T>;
  return invoke<T>(cmd, args);
}

export function ptySpawn(shell: string, cwd: string | undefined, cols: number, rows: number, onEvent: (e: PtyEvent) => void): Promise<number> {
  if (!isTauri) return mockSpawn(shell, onEvent);
  const ch = new Channel<PtyEvent>();
  ch.onmessage = onEvent;
  return invoke<number>('pty_spawn', { shell, cwd: cwd || null, cols, rows, onEvent: ch });
}

export function sshSpawn(host: Record<string, unknown>, cols: number, rows: number, onEvent: (e: PtyEvent) => void): Promise<number> {
  if (!isTauri) return Promise.reject(new Error('SSH działa tylko w aplikacji.'));
  const ch = new Channel<PtyEvent>();
  ch.onmessage = onEvent;
  return invoke<number>('ssh_shell', { host, cols, rows, onEvent: ch });
}

/* ---------- browser mock ---------- */

const mockPty = new Map<number, (e: PtyEvent) => void>();
let mockId = 0;
const mockLine = new Map<number, string>();

function mockSpawn(shell: string, onEvent: (e: PtyEvent) => void): Promise<number> {
  const id = ++mockId;
  mockPty.set(id, onEvent);
  const prompt = shell.startsWith('wsl') ? '\x1b[32muser@ubuntu\x1b[0m:\x1b[34m~\x1b[0m$ ' : shell === 'cmd' ? 'C:\\Users\\dev>' : 'PS C:\\Users\\dev> ';
  setTimeout(() => onEvent({ type: 'data', data: `Tryb podglądu w przeglądarce (bez rdzenia).\r\n${prompt}` }), 30);
  mockLine.set(id, prompt);
  return Promise.resolve(id);
}

const mockStore: Record<string, string> = {};

async function mock(cmd: string, a: Record<string, any>): Promise<unknown> {
  switch (cmd) {
    case 'pty_write': {
      const cb = mockPty.get(a.id);
      if (cb) {
        const text = String(a.data).replace(/\r/g, '\r\n' + (mockLine.get(a.id) || ''));
        cb({ type: 'data', data: text });
      }
      return null;
    }
    case 'pty_resize': case 'pty_kill': return null;
    case 'pty_info': return { pid: 1, shell: 'mock', started: Date.now(), children: [] };
    case 'state_load': try { return localStorage.getItem('tx-state'); } catch { return null; }
    case 'state_save': try { localStorage.setItem('tx-state', a.json); } catch { /* ignore */ } return null;
    case 'sys_shells': return [
      { id: 'pwsh', name: 'PowerShell 7', kind: 'ps' }, { id: 'powershell', name: 'Windows PowerShell', kind: 'ps5' },
      { id: 'cmd', name: 'Wiersz poleceń', kind: 'cmd' }, { id: 'wsl:Ubuntu', name: 'WSL · Ubuntu', kind: 'wsl' }];
    case 'sys_stats': return { cpu: 12 + Math.random() * 10, memUsed: 9e9, memTotal: 16e9, appMem: 42e6 };
    case 'plugin_fs': {
      const key = `${a.plugin}:${a.path}`;
      if (a.op === 'read') { if (!(key in mockStore)) throw new Error('ENOENT'); return mockStore[key]; }
      if (a.op === 'write') { mockStore[key] = a.data; return null; }
      if (a.op === 'exists') return key in mockStore || Object.keys(mockStore).some((k) => k.startsWith(key + '/'));
      if (a.op === 'mkdir') { mockStore[key + '/.dir'] = ''; return null; }
      if (a.op === 'remove') { Object.keys(mockStore).forEach((k) => { if (k === key || k.startsWith(key + '/')) delete mockStore[k]; }); return null; }
      if (a.op === 'move') {
        const to = `${a.plugin}:${a.to}`;
        Object.keys(mockStore).forEach((k) => { if (k === key || k.startsWith(key + '/')) { mockStore[to + k.slice(key.length)] = mockStore[k]; delete mockStore[k]; } });
        return null;
      }
      if (a.op === 'list') {
        const pre = key + '/'; const seen = new Map<string, any>();
        Object.keys(mockStore).filter((k) => k.startsWith(pre)).forEach((k) => {
          const rest = k.slice(pre.length); const name = rest.split('/')[0];
          if (name === '.dir') return;
          const isDir = rest.includes('/');
          seen.set(name, { name, path: `${a.path}/${name}`, kind: isDir ? 'dir' : 'file', size: 0, modified: 0 });
        });
        return [...seen.values()];
      }
      return null;
    }
    case 'plugins_installed': return [];
    case 'secret_has': return false;
    case 'secret_set': case 'secret_delete': return null;
    case 'ai_request': throw new Error('Tryb podglądu: AI działa tylko w aplikacji.');
    case 'sys_run_script': case 'sys_exec': return { code: 0, stdout: `(podgląd) ${a.script || a.cmd}`, stderr: '' };
    case 'http_request': throw new Error('Tryb podglądu: brak sieci z rdzenia.');
    default: return null;
  }
}
