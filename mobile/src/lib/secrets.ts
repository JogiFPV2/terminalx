// Sejf na sekrety telefonu: klucze sparowanych komputerów, później klucz API AI i hasła SSH.
// Na Androidzie wtyczka `secret` (src-tauri/src/secret.rs + KeystorePlugin.kt) szyfruje je kluczem z Android Keystore.
// W przeglądarce (podgląd interfejsu, npm run mobile:dev) zostaje localStorage: to tylko wersja do pracy nad wyglądem.
import { invoke } from '@tauri-apps/api/core';

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const LS = 'hermitty-mobile:secret:';

export async function getSecret(name: string): Promise<string | null> {
  if (inTauri()) return (await invoke<string | null>('plugin:secret|get', { name })) ?? null;
  try { return localStorage.getItem(LS + name); } catch { return null; }
}

export async function setSecret(name: string, value: string): Promise<void> {
  if (inTauri()) return invoke('plugin:secret|set', { name, value });
  try { localStorage.setItem(LS + name, value); } catch { /* brak miejsca */ }
}

export async function deleteSecret(name: string): Promise<void> {
  if (inTauri()) return invoke('plugin:secret|delete', { name });
  try { localStorage.removeItem(LS + name); } catch { /* nic */ }
}

/** Nazwa sekretu z kluczem urządzenia dla sparowanego komputera. */
export const pcKeyName = (device: string) => `pc.${device.replace(/[^A-Za-z0-9._:-]/g, '_')}`;
