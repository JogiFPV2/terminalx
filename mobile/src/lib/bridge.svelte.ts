// Mostek z Hermitty na komputerze (wtyczka „Telefon”): powiadomienia, SMS-y, zdalny dyktafon i dzwonek.
// Logika jest w Kotlinie (BridgePlugin.kt + pakiet bridge); tu wywołania i stan dla ekranu.
import { invoke } from '@tauri-apps/api/core';
import { inTauri } from './ssh.svelte';

export interface BridgeLink { code: string; hosts: string[]; port: number }
export interface BridgeStatus {
  paired: boolean; pcName: string; hosts: string[];
  state: 'unpaired' | 'connecting' | 'online' | 'offline'; error: string | null; micReady: boolean;
  perms: { post: boolean; notifications: boolean; sms: boolean; mic: boolean; battery: boolean; lan: boolean };
  showCodes: boolean; autoSend: boolean; recording: boolean; secs: number;
  recordings: { name: string; size: number; date: number; sent: boolean }[];
  link: BridgeLink | null; device: string;
}

export const BR = $state({ open: false, st: null as BridgeStatus | null, error: '' });

async function call<T = unknown>(m: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!inTauri()) throw new Error('Mostek działa tylko w aplikacji na Androidzie.');
  const r = await invoke<{ v: T }>(`plugin:bridge|${m}`, args);
  return r?.v as T;
}

export async function refresh() {
  try { BR.st = await call<BridgeStatus>('status'); BR.error = ''; } catch (e) { BR.error = String((e as Error)?.message || e); }
}
export const discover = () => call<{ id: string; name: string; host: string; port: number }[]>('discover');
export const pairBridge = (hosts: string[], port: number, code: string) => call<string>('pair', { hosts, port, code });
export const unpair = () => call('unpair');
export const kick = () => call('kick');
export const dismissLink = () => call('dismiss');
export const setOpt = (o: { showCodes?: boolean; autoSend?: boolean }) => call('settings', o);
export const askPerm = (kind: string) => call('perm', { kind });
export const rec = (action: 'toggle' | 'send' | 'delete', name = '') => call('rec', { action, name });

/** Link z kodu QR wtyczki Telefon: hermitty://pair?c=KOD&h=ip1,ip2&p=port */
export function parseBridgeLink(text: string): BridgeLink | null {
  const m = text.trim().match(/^hermitty:\/\/pair\?(.+)$/i);
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const code = q.get('c') || '';
  const hosts = (q.get('h') || '').split(',').map((h) => h.trim()).filter((h) => /^[A-Za-z0-9.:-]+$/.test(h));
  if (!code || !hosts.length) return null;
  return { code, hosts, port: Number(q.get('p')) || 47390 };
}

/** Link z kodu, który aplikacja ma sparować po otwarciu ekranu mostka (skaner albo hermitty:// z systemu). */
export const pendingLink = $state({ v: null as BridgeLink | null });

/** Android 17: zgoda na połączenia w sieci lokalnej. Bez niej telefon nie połączy się z komputerem (przekroczenie czasu). */
export async function lanGranted(): Promise<boolean> {
  if (!inTauri()) return true;
  try { return (await call<BridgeStatus>('status')).perms.lan !== false; } catch { return true; }
}
export const askLan = () => call('perm', { kind: 'lan' });

export interface FoundPc { id: string; name: string; host: string; port: number }
/** Komputery z Hermitty (zdalny dostęp) w tej sieci (rozgłoszenie UDP, BridgePlugin.scan). */
export async function scanPcs(port = 7420): Promise<FoundPc[]> {
  if (!inTauri()) return [];
  return (await call<FoundPc[]>('scan', { port })) || [];
}
/** Czy mostek Telefon jest już sparowany (do automatycznego parowania po zdalnym dostępie). */
export async function bridgePaired(): Promise<boolean | null> {
  if (!inTauri()) return null;
  try { return (await call<BridgeStatus>('status')).paired; } catch { return null; }
}
