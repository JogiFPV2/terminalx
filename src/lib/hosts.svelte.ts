// Vault hostów SSH: konfiguracja połączeń, wykrywanie dystrybucji, przekierowania portów, klucze.
import { call, isTauri } from './ipc';
import { app, ui, curWs, notify, activateTab } from './state.svelte';
import * as sessions from './terminal/sessions.svelte';
import { nid } from './util';
import type { Host, Forward, Tab } from './types';

export const sshState = $state({ forwards: [] as string[], connected: [] as string[] });

export const DISTROS: Record<string, { label: string; c: string; name: string }> = {
  ubuntu: { label: 'UB', c: '#e95420', name: 'Ubuntu' }, debian: { label: 'DEB', c: '#d70a53', name: 'Debian' },
  centos: { label: 'CEN', c: '#932279', name: 'CentOS' }, fedora: { label: 'FED', c: '#51a2da', name: 'Fedora' },
  arch: { label: 'ARCH', c: '#1793d1', name: 'Arch Linux' }, alpine: { label: 'ALP', c: '#0d597f', name: 'Alpine' },
  amzn: { label: 'AWS', c: '#ff9900', name: 'Amazon Linux' }, rhel: { label: 'RHEL', c: '#ee0000', name: 'Red Hat' },
  rocky: { label: 'ROCK', c: '#10b981', name: 'Rocky Linux' }, opensuse: { label: 'SUSE', c: '#73ba25', name: 'openSUSE' },
  ol: { label: 'ORA', c: '#c74634', name: 'Oracle Linux' }, kali: { label: 'KALI', c: '#367bf0', name: 'Kali Linux' },
  almalinux: { label: 'ALMA', c: '#0f4266', name: 'AlmaLinux' },
};

export const hostById = (id: string) => app.hosts.find((h) => h.id === id);
export const hostCfg = (h: Host) => ({ id: h.id, host: h.host, port: h.port, user: h.user, auth: h.auth, keyPath: h.keyPath || null, secretRef: h.secretRef || null });

export function newHost(): Host {
  const id = nid('h');
  return { id, name: '', host: '', port: 22, user: 'root', auth: 'password', keyPath: '~/.ssh/id_ed25519', secretRef: `host:${id}`, hasSecret: false, group: '', tags: [], forwards: [] };
}

async function detectDistro(h: Host) {
  try {
    const r = await call<{ stdout: string }>('ssh_exec', { host: hostCfg(h), command: 'cat /etc/os-release 2>/dev/null || uname -s' });
    const id = r.stdout.match(/^ID="?([\w.-]+)"?/m)?.[1]?.toLowerCase();
    const live = hostById(h.id);
    if (live) live.distro = id || (/darwin/i.test(r.stdout) ? 'macos' : 'linux');
  } catch { /* wykrycie dystrybucji jest opcjonalne */ }
}

async function onConnected(hostId: string) {
  const h = hostById(hostId);
  if (!h) return;
  h.lastUsed = Date.now();
  if (!h.distro) detectDistro(h);
  for (const f of h.forwards.filter((f) => f.auto)) await startForward(h, f, true);
  refresh();
}

export function initHosts() {
  sessions.setSshHooks((id) => { const h = hostById(id); return h ? hostCfg(h) : null; }, onConnected);
  if (!isTauri) return;
  import('@tauri-apps/api/event').then(({ listen }) => {
    listen<{ reqId: number; host: string; port: number; fingerprint: string; algorithm: string; changed: boolean }>('ssh:hostkey', (e) => {
      const p = e.payload;
      ui.confirm = {
        title: p.changed ? 'Klucz hosta się zmienił' : 'Nowy host SSH',
        message: p.changed
          ? `UWAGA: klucz ${p.host}:${p.port} jest inny niż przy poprzednim połączeniu. To może oznaczać przechwycenie połączenia. Nowy odcisk (${p.algorithm}):\n${p.fingerprint}\n\nZaakceptuj tylko, jeśli wiesz, że klucz serwera został zmieniony.`
          : `Pierwsze połączenie z ${p.host}:${p.port}. Odcisk klucza (${p.algorithm}):\n${p.fingerprint}\n\nPorównaj go z odciskiem serwera i zaakceptuj, żeby zapamiętać.`,
        confirmLabel: p.changed ? 'Zaakceptuj nowy klucz' : 'Zaufaj i połącz',
        danger: p.changed,
        resolve: (ok) => call('ssh_hostkey_answer', { reqId: p.reqId, ok: !!ok }),
      };
    });
  });
  setInterval(refresh, 5000);
}

export async function refresh() {
  if (!isTauri) return;
  try {
    sshState.forwards = await call<string[]>('ssh_forwards');
    sshState.connected = (await call<{ hostId: string }[]>('ssh_connections')).map((c) => c.hostId);
  } catch { /* ignore */ }
}

/* ---------- tabs ---------- */

function addTab(tab: Tab) {
  const ws = curWs();
  ws.tabs.push(tab);
  ws.z.push(tab.id);
  ws.activeTab = tab.id;
  return tab;
}

export function openSsh(hostId: string) {
  const h = hostById(hostId);
  if (!h) return;
  const pane = { id: nid('p'), shell: `ssh:${h.id}` };
  sessions.ensureSession(pane);
  return addTab({ id: nid('t'), kind: 'terminal', title: h.name || h.host, panes: [pane], split: 0.5, splitDir: 'col', subagent: curWs().subDefault, win: null, hostId: h.id });
}

export function openSftp(hostId: string) {
  const h = hostById(hostId);
  if (!h) return;
  return addTab({ id: nid('t'), kind: 'sftp', title: `SFTP · ${h.name || h.host}`, panes: [], split: 0.5, splitDir: 'col', subagent: null, win: null, hostId: h.id });
}

export function openVault() {
  const ws = curWs();
  const existing = ws.tabs.find((t) => t.kind === 'vault');
  if (existing) { activateTab(existing.id); return existing; }
  return addTab({ id: nid('t'), kind: 'vault', title: 'Hosty', panes: [], split: 0.5, splitDir: 'col', subagent: null, win: null });
}

/** Zakładki narzędzi (monitoring, galeria): jedna na workspace. */
function openTool(kind: 'monitor' | 'gallery', title: string) {
  const ws = curWs();
  const existing = ws.tabs.find((t) => t.kind === kind);
  if (existing) { activateTab(existing.id); return existing; }
  return addTab({ id: nid('t'), kind, title, panes: [], split: 0.5, splitDir: 'col', subagent: null, win: null });
}
export const openMonitor = () => openTool('monitor', 'Monitoring');
export const openGallery = () => openTool('gallery', 'Galeria');

/* ---------- secrets & keys ---------- */

export async function saveSecret(h: Host, value: string) {
  if (!value) return;
  await call('secret_set', { keyRef: h.secretRef, value });
  h.hasSecret = true;
}

export async function generateKey(): Promise<{ path: string; pub: string } | null> {
  const home = (await call<[string, unknown[]]>('fs_list_detail', { dir: '' }))[0];
  let path = `${home}\\.ssh\\id_ed25519_terminalx`;
  const exists = (p: string) => call('fs_read_text', { path: p }).then(() => true, () => false);
  for (let i = 2; await exists(path); i++) path = `${home}\\.ssh\\id_ed25519_terminalx_${i}`;
  await call('sys_exec', { cmd: 'cmd', args: ['/C', 'mkdir', `${home}\\.ssh`], cwd: null, timeoutMs: 5000 }).catch(() => {});
  const r = await call<{ code: number; stdout: string; stderr: string }>('sys_exec', { cmd: 'ssh-keygen', args: ['-t', 'ed25519', '-f', path, '-N', '', '-C', 'terminalx'], cwd: null, timeoutMs: 20000 });
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || 'ssh-keygen zakończył się błędem');
  const pub = await call<string>('fs_read_text', { path: path + '.pub' });
  return { path, pub: pub.trim() };
}

/* ---------- port forwarding ---------- */

export const forwardId = (h: Host, f: Forward) => `${h.id}:${f.kind}:${f.bindPort}`;

export async function startForward(h: Host, f: Forward, quiet = false) {
  try {
    await call('ssh_forward_start', { host: hostCfg(h), fwd: { kind: f.kind, bindPort: f.bindPort, targetHost: f.targetHost || null, targetPort: f.targetPort || null } });
    if (!quiet) notify(`Przekierowanie ${describe(f)} działa`, 'success');
  } catch (e) { notify(`Przekierowanie ${describe(f)}: ${String(e).replace(/^Error: /, '')}`, 'error', 8000); }
  refresh();
}
export async function stopForward(h: Host, f: Forward) { await call('ssh_forward_stop', { id: forwardId(h, f) }).catch(() => {}); refresh(); }

export function describe(f: Forward) {
  if (f.kind === 'dynamic') return `SOCKS 127.0.0.1:${f.bindPort}`;
  if (f.kind === 'local') return `127.0.0.1:${f.bindPort} → ${f.targetHost}:${f.targetPort}`;
  return `zdalny :${f.bindPort} → ${f.targetHost || '127.0.0.1'}:${f.targetPort}`;
}

export async function disconnect(hostId: string) { await call('ssh_disconnect', { hostId }).catch(() => {}); refresh(); }
