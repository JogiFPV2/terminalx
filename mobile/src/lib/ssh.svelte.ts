// SSH prosto z telefonu: lista serwerów (bez sekretów) w localStorage, hasła i klucze w sejfie (secrets.ts / Keystore),
// połączenie w Ruście (src-tauri/src/ssh.rs). Klucz serwera przy pierwszym połączeniu potwierdza użytkownik.
import { invoke, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { setSecret, deleteSecret } from './secrets.ts';

export interface SshHost { id: string; name: string; host: string; port: number; user: string; auth: 'password' | 'key'; added: number; lastUsed?: number; /** Termux na tym telefonie (127.0.0.1:8022), konfigurowany automatycznie. */ termux?: boolean }
export interface HostKeyPrompt { reqId: number; host: string; port: number; fingerprint: string; algorithm: string; changed: boolean }
export type ShellEvent = { type: 'data'; data: string } | { type: 'exit'; code: number | null; error: string | null };

const KEY = 'hermitty-mobile:sshHosts';
const load = (): SshHost[] => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };

export const SSH = $state({
  hosts: load(),
  /** Otwarty terminal SSH (id serwera) albo null. */
  open: null as string | null,
  /** Edytowany serwer w arkuszu („new” dla nowego). */
  edit: null as string | null,
  prompts: [] as HostKeyPrompt[],
});

export const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const saveHosts = () => { try { localStorage.setItem(KEY, JSON.stringify(SSH.hosts)); } catch { /* brak miejsca */ } };
export const hostById = (id: string | null) => SSH.hosts.find((h) => h.id === id) || null;

/** Ta sama nazwa sekretu co secret_name w ssh.rs. */
export const sshSecret = (id: string, what: 'pass' | 'key' | 'keypass') => `ssh.${id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60)}.${what}`;

export function upsertHost(h: SshHost) {
  SSH.hosts = [...SSH.hosts.filter((x) => x.id !== h.id), h].sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  saveHosts();
}

export async function removeHost(id: string) {
  SSH.hosts = SSH.hosts.filter((h) => h.id !== id); saveHosts();
  await Promise.all((['pass', 'key', 'keypass'] as const).map((w) => deleteSecret(sshSecret(id, w)).catch(() => {})));
}

export const setPassword = (id: string, pass: string) => setSecret(sshSecret(id, 'pass'), pass);
export const keygen = (id: string, comment: string) => invoke<string>('ssh_keygen', { id, comment });
export const pubkey = (id: string) => invoke<string | null>('ssh_pubkey', { id });
export const importKey = (id: string, pem: string, pass: string) => invoke<string>('ssh_import_key', { id, pem, pass });
export const forgetHostKey = (host: string, port: number) => invoke('ssh_forget_hostkey', { host, port });

/** Konfiguracja hosta dla Rusta (bez nazw i dat). */
export const hostCfg = (h: SshHost) => ({ id: h.id, host: h.host, port: h.port, user: h.user, auth: h.auth, trustLocal: !!h.termux });

/** Serwery widoczne na liście (Termux ma własną zakładkę). */
export const userHosts = () => SSH.hosts.filter((h) => !h.termux);

export async function shell(h: SshHost, cols: number, rows: number, on: (e: ShellEvent) => void): Promise<number> {
  if (!inTauri()) throw new Error('SSH z telefonu działa tylko w aplikacji na Androidzie.');
  const ch = new Channel<ShellEvent>();
  ch.onmessage = on;
  return invoke<number>('ssh_shell', { host: hostCfg(h), cols, rows, onEvent: ch });
}
export const write = (id: number, data: string) => invoke('ssh_write', { id, data });
export const resize = (id: number, cols: number, rows: number) => invoke('ssh_resize', { id, cols, rows });
export const close = (id: number) => invoke('ssh_close', { id });

export function answerHostKey(reqId: number, ok: boolean) {
  SSH.prompts = SSH.prompts.filter((p) => p.reqId !== reqId);
  invoke('ssh_hostkey_answer', { reqId, ok }).catch(() => {});
}

if (inTauri()) listen<HostKeyPrompt>('ssh:hostkey', (e) => { SSH.prompts = [...SSH.prompts, e.payload]; }).catch(() => {});
