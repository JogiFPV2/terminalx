// Konta narzędzi z planami subskrypcji. Dodatkowe konto Claude Code albo Codex to osobny folder
// logowania w danych aplikacji; zakładka przypięta do konta dostaje go w CLAUDE_CONFIG_DIR / CODEX_HOME.
// Logowanie robi samo narzędzie (oficjalne `claude` / `codex login`), aplikacja nie widzi tokenów.
// Konta nie przełączają się same: regulaminy usług nie pozwalają obchodzić limitów planu kilkoma kontami.
import { app, ui, newTab, notify, findTab } from './state.svelte';
import { call } from './ipc';
import { nid } from './util';
import * as sessions from './terminal/sessions.svelte';
import type { AccountService, Tab, ToolAccount } from './types';

export const ACCOUNT_SERVICES: Record<AccountService, { name: string; login: string; home: string }> = {
  claude: { name: 'Claude Code', login: 'claude', home: '~/.claude' },
  codex: { name: 'Codex', login: 'codex login', home: '~/.codex' },
};

/** Usługi z limitami planu pokazywane na liście kont (tylko Claude Code i Codex mają kilka kont). */
export const PLAN_SERVICES: { id: string; name: string; from: string }[] = [
  { id: 'claude', name: 'Claude', from: 'Claude Code na tym komputerze' },
  { id: 'codex', name: 'Codex', from: 'Codex CLI na tym komputerze' },
  { id: 'gemini', name: 'Gemini', from: 'Gemini CLI (konto Google)' },
  { id: 'cursor', name: 'Cursor', from: 'aplikacja Cursor (jedno konto na komputer)' },
  { id: 'opencode', name: 'OpenCode Go', from: 'logowanie OpenCode' },
];

export interface PlanUsage { plan: string; text?: string; windows: { label: string; usedPercent: number; resetsAt: number }[] }

export function accountName(service: string, id?: string | null) {
  if (!id) return 'domyślne';
  return app.accounts.find((a) => a.id === id && a.service === service)?.name || 'usunięte konto';
}

export function planUsage(service: string, account?: string | null) {
  return call<PlanUsage>('plan_usage', { service, keyRef: null, url: null, account: account || null });
}

/** Powłoka do logowania: zmienna konta nie przechodzi do WSL, więc zawsze powłoka Windows. */
function loginShell() {
  const d = app.settings.defaultShell;
  return d.startsWith('wsl') || d.startsWith('ssh:') ? ui.shells.find((s) => s.kind === 'ps')?.id || 'powershell' : d;
}

/** Nowa zakładka z kontem i uruchomionym logowaniem narzędzia. */
export async function loginAccount(service: AccountService, id: string | null) {
  const tab = newTab(loginShell(), undefined, undefined, id ? { [service]: id } : undefined);
  tab.title = `Logowanie · ${ACCOUNT_SERVICES[service].name} · ${accountName(service, id)}`;
  await sessions.write(tab.panes[0].id, ACCOUNT_SERVICES[service].login + '\r');
}

export function addAccount(service: AccountService, name: string): ToolAccount {
  const acc: ToolAccount = { id: nid('acc').toLowerCase().replace(/[^a-z0-9_-]/g, ''), service, name: name.trim() || `${ACCOUNT_SERVICES[service].name} ${app.accounts.filter((a) => a.service === service).length + 2}` };
  app.accounts.push(acc);
  return acc;
}

/** Usuwa konto razem z jego logowaniem; zakładki, które go używały, wracają do konta domyślnego. */
export async function removeAccount(acc: ToolAccount) {
  app.accounts.splice(app.accounts.findIndex((a) => a.id === acc.id), 1);
  for (const ws of app.workspaces) for (const t of ws.tabs) for (const p of t.panes) if (p.accounts?.[acc.service] === acc.id) delete p.accounts[acc.service];
  await call('account_remove', { id: acc.id }).catch(() => {});
}

/** Konto dla zakładki. Działająca powłoka ma już swoje zmienne, więc zmiana zadziała po restarcie powłoki. */
export function setTabAccount(tabId: string, service: AccountService, id: string | null) {
  const t: Tab | undefined = findTab(tabId)?.tab;
  if (!t) return;
  for (const p of t.panes) {
    if (id) p.accounts = { ...(p.accounts || {}), [service]: id };
    else if (p.accounts) { delete p.accounts[service]; if (!Object.keys(p.accounts).length) delete p.accounts; }
  }
  const running = t.panes.some((p) => sessions.termStatus[p.id] && !sessions.termStatus[p.id].exited);
  if (running) notify(`${ACCOUNT_SERVICES[service].name}: konto „${accountName(service, id)}” zadziała po ponownym uruchomieniu powłoki (menu zakładki).`, 'info');
}

/** Czy powłoka może dostać konto (zmienne środowiska nie przechodzą do WSL ani SSH). */
export const accountsApply = (shell: string) => !shell.startsWith('wsl') && !shell.startsWith('ssh:');
