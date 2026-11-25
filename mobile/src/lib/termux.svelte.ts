// Termux na tym telefonie. Komendy idą przez RUN_COMMAND (TermuxPlugin.kt); tak raz konfigurujemy w Termuxie
// serwer SSH z kluczem Hermitty, a każda zakładka Termuxa to potem interaktywna sesja SSH na 127.0.0.1:8022.
// Zob. github.com/termux/termux-app/issues/804 (RUN_COMMAND) i wiki Termuxa „RUN_COMMAND Intent”.
import { invoke } from '@tauri-apps/api/core';
import { SSH, upsertHost, keygen, inTauri, type SshHost } from './ssh.svelte';

export const TERMUX_ID = 'termux';
export const TERMUX_PORT = 8022;
/** Komenda do wklejenia w Termuxie: pozwala innym aplikacjom (Hermitty) uruchamiać komendy. */
export const ALLOW_CMD = "mkdir -p ~/.termux && grep -q '^allow-external-apps' ~/.termux/termux.properties 2>/dev/null && sed -i 's/^allow-external-apps.*/allow-external-apps=true/' ~/.termux/termux.properties || echo 'allow-external-apps=true' >> ~/.termux/termux.properties; termux-reload-settings";

export const TX = $state({ installed: false, permission: false, checked: false, step: '', error: '' });

export const termuxHost = (): SshHost | null => SSH.hosts.find((h) => h.id === TERMUX_ID) || null;

async function call<T>(m: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!inTauri()) throw new Error('Termux działa tylko w aplikacji na Androidzie.');
  return invoke<T>(`plugin:termux|${m}`, args);
}

export async function refreshTermux() {
  try { const s = await call<{ installed: boolean; permission: boolean }>('status'); TX.installed = s.installed; TX.permission = s.permission; }
  catch { TX.installed = false; TX.permission = false; }
  TX.checked = true;
}
export const askPermission = () => call('permission');
export const openTermux = () => call('open');
export const saveDownload = (name: string, data: string) => call<{ path: string }>('save_download', { name, data });

export interface RunOut { stdout: string; stderr: string; exitCode: number; err: number; errmsg: string }
/** Komenda w bash Termuxa (w tle). Błąd Termuxa (np. brak allow-external-apps) staje się wyjątkiem. */
export async function runTermux(command: string, timeoutMs = 60_000): Promise<RunOut> {
  const r = await call<RunOut>('run', { command, timeoutMs });
  if (r.err && r.err !== -1 && r.errmsg) throw new Error(`Termux: ${r.errmsg}`);
  return r;
}

const portOpen = () => invoke<boolean>('port_open', { port: TERMUX_PORT }).catch(() => false);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Uruchamia sshd w Termuxie, jeśli nie działa (Termux zatrzymuje go, gdy system zamknie aplikację). */
export async function ensureSshd() {
  if (await portOpen()) return;
  // Wynik RUN_COMMAND nie jest potrzebny: sprawdzamy sam port (działa też ze starszym Termuxem bez PendingIntent).
  runTermux('pgrep -x sshd >/dev/null || sshd', 20_000).catch(() => {});
  for (let i = 0; i < 20; i++) { await wait(500); if (await portOpen()) return; }
  throw new Error('Serwer SSH w Termuxie nie wystartował. Otwórz Termux i wpisz: sshd');
}

/**
 * Jednorazowa konfiguracja: klucz ed25519 Hermitty (w sejfie), openssh w Termuxie, klucz w authorized_keys, sshd.
 * `onStep` pokazuje postęp. Zwraca hosta Termuxa gotowego do zakładek.
 */
export async function setupTermux(onStep: (s: string) => void = () => {}): Promise<SshHost> {
  await refreshTermux();
  if (!TX.installed) throw new Error('Termux nie jest zainstalowany (F-Droid albo GitHub; wersja ze Sklepu Play jest przestarzała).');
  if (!TX.permission) throw new Error('Zezwól Hermitty na uruchamianie komend w Termuxie.');
  onStep('Sprawdzam połączenie z Termuxem…');
  const hello = await runTermux('echo hermitty-ok', 20_000).catch((e) => { throw new Error(`${String((e as Error)?.message || e)}\nW Termuxie wklej komendę z kroku 2 i spróbuj ponownie.`); });
  if (!hello.stdout.includes('hermitty-ok')) throw new Error('Termux nie zwrócił wyniku. Wklej w Termuxie komendę z kroku 2 i spróbuj ponownie.');
  onStep('Tworzę klucz Hermitty…');
  const pub = (await keygen(TERMUX_ID, 'hermitty-termux')).trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+/.test(pub)) throw new Error('Nie udało się utworzyć klucza.');
  onStep('Instaluję openssh i dodaję klucz (pierwszy raz może potrwać kilka minut)…');
  const script = [
    'set -e',
    'command -v sshd >/dev/null 2>&1 || (yes | pkg install -y openssh)',
    'mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys',
    `KEY='${pub}'`,
    'grep -qF "$KEY" ~/.ssh/authorized_keys || echo "$KEY" >> ~/.ssh/authorized_keys',
    'chmod 600 ~/.ssh/authorized_keys',
    'pgrep -x sshd >/dev/null || sshd',
    'echo "user=$(whoami)"',
  ].join('\n');
  const r = await runTermux(script, 600_000);
  const user = r.stdout.match(/user=(\S+)/)?.[1];
  if (r.exitCode !== 0 || !user) throw new Error(`Konfiguracja w Termuxie nie powiodła się (kod ${r.exitCode}).\n${(r.stderr || r.stdout).slice(-600)}`);
  const host: SshHost = { id: TERMUX_ID, name: 'Termux', host: '127.0.0.1', port: TERMUX_PORT, user, auth: 'key', added: Date.now(), termux: true };
  upsertHost(host);
  onStep('Uruchamiam serwer SSH…');
  await ensureSshd();
  return host;
}
