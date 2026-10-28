// Menu kontekstowe zakładki i menu „+” (nowa zakładka). Wspólne dla paska zakładek i okien.
import { app, ui, curWs, newTab, closeTab, splitTab, duplicateTab, findTab, tabKind, notify, type MenuItem } from './state.svelte';
import { tabMenuItems, emit } from './plugins/host.svelte';
import { openSsh, openSftp, openVault } from './hosts.svelte';
import * as sessions from './terminal/sessions.svelte';
import { isTauri, call } from './ipc';

export function openMenu(x: number, y: number, items: MenuItem[]) { ui.menu = { x, y, items }; }

export function newTabItems(): MenuItem[] {
  const kinds: Record<string, { icon: string; c: string }> = {
    ps: { icon: 'ps', c: 'var(--chart-2)' }, ps5: { icon: 'ps', c: 'var(--chart-2)' }, cmd: { icon: 'cmd', c: 'var(--muted-foreground)' },
    wsl: { icon: 'linux', c: 'var(--chart-3)' }, bash: { icon: 'bash', c: 'var(--chart-5)' },
  };
  const kb: Record<string, string> = { pwsh: 'Ctrl+Shift+1', powershell: 'Ctrl+Shift+1', cmd: 'Ctrl+Shift+2' };
  const firstWsl = ui.shells.find((s) => s.kind === 'wsl')?.id;
  const items: MenuItem[] = [{ heading: 'Terminal' }];
  for (const s of ui.shells) {
    items.push({ label: s.name, icon: kinds[s.kind]?.icon || 'bash', c: kinds[s.kind]?.c || 'var(--chart-5)', kbd: s.id === firstWsl ? 'Ctrl+Shift+3' : (s.id === app.settings.defaultShell ? 'Ctrl+T' : kb[s.id]), run: () => newTab(s.id) });
  }
  items.push({ sep: true }, { heading: 'Narzędzia' });
  items.push({ label: 'Workflow', icon: 'flow', c: 'var(--chart-4)', kbd: 'Ctrl+Shift+E', run: () => newTab('flow') });
  if (app.hosts.length) {
    items.push({ sep: true }, { heading: 'SSH' });
    for (const h of [...app.hosts].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)).slice(0, 8)) items.push({ label: h.name, icon: 'ssh', c: 'var(--chart-5)', run: () => openSsh(h.id) });
    items.push({ heading: 'SFTP' });
    for (const h of [...app.hosts].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)).slice(0, 4)) items.push({ label: h.name, icon: 'folder', c: 'var(--chart-5)', run: () => openSftp(h.id) });
  }
  items.push({ sep: true });
  items.push({ label: 'Hosty…', icon: 'hosts', c: 'var(--primary)', run: () => openVault() });
  return items;
}

async function saveScreen(paneId: string, title: string) {
  const text = sessions.fullText(paneId);
  if (!isTauri) { navigator.clipboard.writeText(text).catch(() => {}); notify('Skopiowano ekran do schowka', 'success'); return; }
  const { save } = await import('@tauri-apps/plugin-dialog');
  const path = await save({ defaultPath: `${title.replace(/[\\/:*?"<>|]/g, '_')}.txt`, filters: [{ name: 'Tekst', extensions: ['txt', 'log'] }] });
  if (!path) return;
  await call('fs_write_text', { path, data: text });
  notify('Zapisano ekran do pliku', 'success');
}

export function tabMenu(tabId: string, x: number, y: number) {
  const f = findTab(tabId);
  if (!f) return;
  const t = f.tab;
  const items: MenuItem[] = [{ heading: t.title }];
  items.push({ label: 'Zmień nazwę', icon: 'edit', kbd: 'F2', run: () => (ui.renamingTab = t.id) });
  items.push({ label: 'Duplikuj', icon: 'copy', run: () => duplicateTab(t.id) });
  if (t.kind === 'terminal') {
    items.push({ label: t.panes.length > 1 ? 'Scal panele' : 'Podziel w poziomie', icon: 'split', kbd: 'Ctrl+Shift+D', run: () => splitTab(t.id, 'col') });
    if (t.panes.length === 1) items.push({ label: 'Podziel w pionie', icon: 'splitv', run: () => splitTab(t.id, 'row') });
    items.push({ label: 'Szukaj w terminalu', icon: 'search', kbd: 'Ctrl+Shift+F', run: () => (ui.searchPane = t.panes[0].id) });
    items.push({ label: 'Zapisz ekran do pliku', icon: 'save', run: () => saveScreen(t.panes[0].id, t.title) });
    items.push({ label: 'Uruchom ponownie powłokę', icon: 'refresh', run: () => t.panes.forEach((p) => sessions.restart(p.id)) });
    const subs = app.agents.filter((a) => a.kind === 'sub');
    items.push({ sep: true }, { heading: 'Podagent' });
    items.push({ label: 'Brak', icon: t.subagent ? undefined : 'check', run: () => (t.subagent = null) });
    for (const s of subs) items.push({ label: s.name, icon: t.subagent === s.id ? 'check' : undefined, run: () => (t.subagent = s.id) });
  }
  const plugItems = tabMenuItems(t.kind === 'flow' ? 'flow' : 'terminal');
  if (plugItems.length && f.ws) {
    items.push({ sep: true });
    for (const m of plugItems) items.push({ label: m.title, icon: m.icon || 'puzzle', run: () => emit(m.pluginId, 'tabMenu', { itemId: m.id, tabId: t.id }) });
  }
  if (f.ws) items.push({ sep: true }, { label: 'Zamknij', icon: 'x', kbd: 'Ctrl+Shift+W', run: () => closeTab(t.id) });
  openMenu(x, y, items);
}

export function kindOf(tabId: string) { const f = findTab(tabId); return f ? tabKind(f.tab) : { label: '', c: '' }; }
export { curWs };
