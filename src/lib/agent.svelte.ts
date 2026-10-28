// Agent workspace'u („szef”) i podagenci zakładek. Pętla narzędzi po stronie aplikacji:
// agent czyta zakładki, deleguje zadania podagentom i uruchamia komendy po zatwierdzeniu.
import { complete, stripAnsi, type AMsg, type Block, type ToolDef } from './ai';
import { app, ui, findTab, curWs, notify, shellName } from './state.svelte';
import * as sessions from './terminal/sessions.svelte';
import { nid, sleep, fill } from './util';
import { call } from './ipc';
import type { AgentProfile, ChatMsg, Snippet, Tab, Workspace } from './types';

export const agentState = $state({ busy: {} as Record<string, boolean>, subBusy: {} as Record<string, string> });
const histories = new Map<string, AMsg[]>();
const aborts = new Map<string, { aborted: boolean }>();
const approvals = new Map<string, (ok: boolean) => void>();

const profile = (id: string | null | undefined, kind: 'agent' | 'sub') =>
  app.agents.find((a) => a.id === id) || app.agents.find((a) => a.kind === kind) || app.agents[0];

function post(ws: Workspace, m: Omit<ChatMsg, 'id'>) {
  const msg: ChatMsg = { id: nid('m'), ...m };
  ws.chat.push(msg);
  return ws.chat[ws.chat.length - 1];
}

export function stopAgent(wsId: string) { const a = aborts.get(wsId); if (a) a.aborted = true; }
export function clearChat(ws: Workspace) { ws.chat.splice(0); histories.delete(ws.id); }

export function resolveApproval(ws: Workspace, msgId: string, ok: boolean) {
  const m = ws.chat.find((x) => x.id === msgId);
  if (m?.approve) m.approve.state = ok ? 'approved' : 'rejected';
  approvals.get(msgId)?.(ok);
  approvals.delete(msgId);
}

function needsApproval(p: AgentProfile, command: string) {
  if (p.perm === 'ask') return true;
  const c = command.toLowerCase();
  return app.settings.alwaysAsk.some((s) => s && c.includes(s.toLowerCase()));
}

/** Uruchamia komendę w zakładce (po zgodzie, jeśli trzeba) i zwraca wyjście po ustaniu. */
async function runInTab(ws: Workspace, p: AgentProfile, tab: Tab, command: string, who: string, signal: { aborted: boolean }) {
  if (p.perm === 'read') return 'Odmowa: ten profil ma uprawnienia tylko do odczytu.';
  const pane = tab.panes[0];
  if (!pane) return 'Ta zakładka nie jest terminalem.';
  if (needsApproval(p, command)) {
    const msg = post(ws, { role: p.kind === 'agent' ? 'agent' : 'sub', who, text: `Chcę uruchomić w „${tab.title}”:`, approve: { tabId: tab.id, command, state: 'pending' } });
    app.layout.agentOpen = true;
    const ok = await new Promise<boolean>((res) => approvals.set(msg.id, res));
    if (!ok) return 'Użytkownik odrzucił tę komendę. Nie ponawiaj jej; zaproponuj coś innego albo zapytaj.';
  }
  if (signal.aborted) return 'Przerwano.';
  let out = '';
  let last = Date.now();
  const off = sessions.onOutput((id, data) => { if (id === pane.id) { out += data; last = Date.now(); } });
  try {
    await sessions.write(pane.id, command.replace(/\r?\n/g, '\r') + '\r');
    const start = Date.now();
    await sleep(400);
    while (Date.now() - start < 120_000 && !signal.aborted) {
      if (Date.now() - last > 1500 && Date.now() - start > 1200) break;
      await sleep(200);
    }
  } catch (e) {
    return `Nie udało się wysłać komendy: ${e}`;
  } finally { off(); }
  const clean = stripAnsi(out).trim();
  return clean.length > 6000 ? '…' + clean.slice(-6000) : clean || '(brak wyjścia)';
}

function tabsSummary(ws: Workspace) {
  return ws.tabs.map((t) => {
    const sub = t.subagent ? profile(t.subagent, 'sub').name : 'brak';
    return `- id: ${t.id} · „${t.title}” · ${t.kind === 'flow' ? 'workflow' : shellName(t.panes[0]?.shell || '')} · podagent: ${sub}`;
  }).join('\n') || '(brak zakładek)';
}

/* ---------- sub-agent ---------- */

async function runSub(ws: Workspace, tab: Tab, task: string, signal: { aborted: boolean }): Promise<string> {
  const p = profile(tab.subagent || ws.subDefault, 'sub');
  const who = `Podagent „${tab.title}”`;
  const tools: ToolDef[] = [];
  if (p.tools.includes('read_buffer')) tools.push({ name: 'read_buffer', description: 'Ostatnie linie wyjścia terminala tej zakładki.', input_schema: { type: 'object', properties: { lines: { type: 'integer', description: 'Liczba linii, domyślnie 60' } } } });
  if (p.tools.includes('run_command') && p.perm !== 'read') tools.push({ name: 'run_command', description: 'Wpisuje komendę do terminala tej zakładki i zwraca wyjście, gdy przestanie przybywać.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } });
  if (p.tools.includes('wait_for_output')) tools.push({ name: 'wait_for_output', description: 'Czeka podaną liczbę sekund (maks. 120) albo aż w wyjściu pojawi się wzorzec, potem zwraca nowe wyjście.', input_schema: { type: 'object', properties: { seconds: { type: 'integer' }, pattern: { type: 'string' } }, required: ['seconds'] } });
  tools.push({ name: 'report', description: 'Kończy pracę i przekazuje raport agentowi.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } });

  const system = `${p.prompt}\n\nPracujesz w zakładce „${tab.title}” (${shellName(tab.panes[0]?.shell || '')}, system Windows). Gdy skończysz, wywołaj narzędzie report.`;
  const messages: AMsg[] = [{ role: 'user', content: `Zadanie od agenta: ${task}` }];
  agentState.subBusy[tab.id] = 'pracuje';
  try {
    for (let step = 0; step < 12 && !signal.aborted; step++) {
      const r = await complete({ providerId: p.provider, model: p.model, system, messages, tools, maxTokens: 8000, signal });
      messages.push({ role: 'assistant', content: r.content });
      if (r.text) post(ws, { role: 'sub', who, text: r.text });
      if (!r.toolCalls.length) return r.text || '(podagent zakończył bez raportu)';
      const results: Block[] = [];
      for (const c of r.toolCalls) {
        if (c.name === 'report') { post(ws, { role: 'sub', who, text: String(c.input.text || '') }); return String(c.input.text || ''); }
        let out = '';
        if (c.name === 'read_buffer') out = sessions.tail(tab.panes[0]?.id, Math.min(400, c.input.lines || 60)).join('\n');
        else if (c.name === 'run_command') { agentState.subBusy[tab.id] = 'uruchamia'; out = await runInTab(ws, p, tab, String(c.input.command || ''), who, signal); agentState.subBusy[tab.id] = 'pracuje'; }
        else if (c.name === 'wait_for_output') out = await waitFor(tab, Math.min(120, c.input.seconds || 5), c.input.pattern, signal);
        else out = `Nieznane narzędzie ${c.name}`;
        results.push({ type: 'tool_result', tool_use_id: c.id, content: out });
      }
      messages.push({ role: 'user', content: results });
    }
    return signal.aborted ? 'Przerwano.' : 'Podagent przekroczył limit kroków.';
  } finally { delete agentState.subBusy[tab.id]; }
}

async function waitFor(tab: Tab, seconds: number, pattern: string | undefined, signal: { aborted: boolean }) {
  const pane = tab.panes[0];
  if (!pane) return 'Brak terminala.';
  let out = '';
  let re: RegExp | null = null;
  try { re = pattern ? new RegExp(pattern) : null; } catch { re = null; }
  const off = sessions.onOutput((id, d) => { if (id === pane.id) out += d; });
  const start = Date.now();
  try {
    while (Date.now() - start < seconds * 1000 && !signal.aborted) {
      if (re && re.test(stripAnsi(out))) break;
      await sleep(250);
    }
  } finally { off(); }
  const clean = stripAnsi(out).trim();
  return clean ? clean.slice(-6000) : '(brak nowego wyjścia)';
}

/* ---------- workspace agent ---------- */

export async function sendToAgent(ws: Workspace, text: string) {
  if (agentState.busy[ws.id]) { notify('Agent jeszcze pracuje. Poczekaj albo zatrzymaj go.', 'warning'); return; }
  const p = profile(ws.agentId, 'agent');
  post(ws, { role: 'user', who: 'Ty', text });
  const history = histories.get(ws.id) || [];
  histories.set(ws.id, history);
  history.push({ role: 'user', content: text });

  const tools: ToolDef[] = [{ name: 'list_tabs', description: 'Lista zakładek tego workspace\'u z identyfikatorami.', input_schema: { type: 'object', properties: {} } }];
  if (p.tools.includes('read_all')) tools.push({ name: 'read_tab', description: 'Ostatnie linie wyjścia terminala w zakładce.', input_schema: { type: 'object', properties: { tab_id: { type: 'string' }, lines: { type: 'integer' } }, required: ['tab_id'] } });
  if (p.tools.includes('run_command') && p.perm !== 'read') tools.push({ name: 'run_command', description: 'Uruchamia komendę w terminalu zakładki i zwraca wyjście.', input_schema: { type: 'object', properties: { tab_id: { type: 'string' }, command: { type: 'string' } }, required: ['tab_id', 'command'] } });
  if (p.tools.includes('delegate')) tools.push({ name: 'delegate', description: 'Zleca zadanie podagentowi zakładki terminala. Podagent sam czyta wyjście i uruchamia komendy, potem zwraca raport. Kilka wywołań w jednej odpowiedzi działa równolegle.', input_schema: { type: 'object', properties: { tab_id: { type: 'string' }, task: { type: 'string' } }, required: ['tab_id', 'task'] } });
  if (p.tools.includes('workflow')) {
    tools.push({ name: 'run_workflow', description: 'Uruchamia workflow z zakładki typu workflow i zwraca wyniki.', input_schema: { type: 'object', properties: { tab_id: { type: 'string' }, input: { type: 'string' } }, required: ['tab_id'] } });
    tools.push({ name: 'list_node_types', description: 'Typy nodów workflow (id, nazwa, kategoria, pola cfg). Wywołaj przed build_workflow.', input_schema: { type: 'object', properties: {} } });
    tools.push({
      name: 'build_workflow',
      description: 'Tworzy nową zakładkę workflow z nodów i połączeń. Kanwa układa się sama; bez wyzwalacza dodawany jest „Ręczny start”. Wynik noda trafia do następnych jako {{input}}. Zwraca id zakładki (do run_workflow).',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          nodes: { type: 'array', items: { type: 'object', properties: { key: { type: 'string', description: 'Krótki klucz do krawędzi, np. "a"' }, type: { type: 'string', description: 'id typu z list_node_types' }, label: { type: 'string' }, cfg: { type: 'object' } }, required: ['key', 'type'] } },
          edges: { type: 'array', items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 }, description: 'Pary [klucz_z, klucz_do]' },
        },
        required: ['nodes'],
      },
    });
  }

  const signal = { aborted: false };
  aborts.set(ws.id, signal);
  agentState.busy[ws.id] = true;
  try {
    for (let step = 0; step < 16 && !signal.aborted; step++) {
      const system = `${p.prompt}\n\nSystem: Windows. Workspace „${ws.name}”. Zakładki:\n${tabsSummary(ws)}\n\nUżywaj identyfikatorów zakładek z listy. Pracę w konkretnym terminalu deleguj podagentom, gdy zakładka ma podagenta albo zadanie wymaga kilku kroków.`;
      const r = await complete({ providerId: p.provider, model: p.model, system, messages: history, tools, maxTokens: 16000, signal });
      history.push({ role: 'assistant', content: r.content });
      if (r.text) post(ws, { role: 'agent', who: p.name, text: r.text });
      if (!r.toolCalls.length) break;
      const results = await Promise.all(r.toolCalls.map(async (c): Promise<Block> => {
        let out = '';
        try {
          const t = c.input.tab_id ? findTab(String(c.input.tab_id))?.tab : undefined;
          if (c.name === 'list_tabs') out = tabsSummary(ws);
          else if (c.name === 'list_node_types') out = (await import('./workflow/builder')).nodeCatalog();
          else if (c.name === 'build_workflow') {
            const r = (await import('./workflow/builder')).buildFlow(c.input);
            post(ws, { role: 'agent', who: p.name, text: r.summary });
            out = r.summary;
          } else if (!t) out = `Nie ma zakładki o id ${c.input.tab_id}. Użyj list_tabs.`;
          else if (c.name === 'read_tab') out = sessions.tail(t!.panes[0]?.id, Math.min(400, c.input.lines || 60)).join('\n') || '(pusto)';
          else if (c.name === 'run_command') out = await runInTab(ws, p, t!, String(c.input.command || ''), p.name, signal);
          else if (c.name === 'delegate') {
            post(ws, { role: 'agent', who: `${p.name} → podagent „${t!.title}”`, text: String(c.input.task || '') });
            out = await runSub(ws, t!, String(c.input.task || ''), signal);
          } else if (c.name === 'run_workflow') {
            const { runFlow } = await import('./workflow/engine.svelte');
            if (!t!.flowId) out = 'To nie jest zakładka workflow.';
            else out = await runFlow(app.flows[t!.flowId], String(c.input.input || ''));
          } else out = `Nieznane narzędzie ${c.name}`;
        } catch (e) { out = `Błąd: ${e}`; }
        return { type: 'tool_result', tool_use_id: c.id, content: out || '(pusto)' };
      }));
      history.push({ role: 'user', content: results });
    }
    if (signal.aborted) post(ws, { role: 'system', who: 'System', text: 'Zatrzymano agenta.' });
  } catch (e) {
    post(ws, { role: 'error', who: 'Błąd', text: String(e).replace(/^Error: /, '') });
    // Historia kończy się na zapytaniu bez odpowiedzi; przy błędzie cofamy ją do spójnego stanu.
    while (history.length && history[history.length - 1].role === 'user' && typeof history[history.length - 1].content !== 'string') history.pop();
    if (history.length && history[history.length - 1].role === 'user') history.pop();
  } finally {
    agentState.busy[ws.id] = false;
    aborts.delete(ws.id);
    // Długa rozmowa: trzymamy ostatnie 40 wpisów, zaczynając od wiadomości użytkownika z tekstem.
    if (history.length > 40) {
      let cut = history.length - 40;
      while (cut < history.length && !(history[cut].role === 'user' && typeof history[cut].content === 'string')) cut++;
      history.splice(0, cut);
    }
  }
}

/* ---------- snippets ---------- */

async function askVar(name: string): Promise<string | null> {
  return new Promise((resolve) => { ui.confirm = { title: 'Uzupełnij snippet', message: '', input: { label: name, value: '' }, confirmLabel: 'Dalej', resolve }; });
}

export async function expandSnippet(body: string, paneId: string | null): Promise<string | null> {
  const vars: Record<string, string> = {};
  const names = [...new Set([...body.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]))];
  for (const n of names) {
    if (n === 'selection') vars[n] = paneId ? sessions.selection(paneId) : '';
    else if (n === 'cwd') vars[n] = paneId ? sessions.termStatus[paneId]?.cwd || '' : '';
    else if (n.startsWith('last_output')) vars[n] = paneId ? sessions.tail(paneId, parseInt(n.split(':')[1] || '50', 10)).join('\n') : '';
    else if (n.startsWith('cmd:')) {
      const r: any = await call('sys_run_script', { shell: 'pwsh', script: n.slice(4), cwd: (paneId && (sessions.termStatus[paneId]?.dir || sessions.termStatus[paneId]?.cwd)) || null, timeoutMs: 30000 }).catch((e) => ({ stdout: String(e), stderr: '' }));
      vars[n] = `${r.stdout}${r.stderr ? '\n' + r.stderr : ''}`.trim();
    } else {
      const v = await askVar(n);
      if (v === null) return null;
      vars[n] = v;
    }
  }
  return fill(body, vars);
}

export async function runSnippet(s: Snippet) {
  const ws = curWs();
  const tab = ws.tabs.find((t) => t.id === ws.activeTab);
  const paneId = tab?.kind === 'terminal' ? (tab.panes.find((p) => p.id === ui.focusedPane) || tab.panes[0])?.id || null : null;
  const text = await expandSnippet(s.body, paneId);
  if (text === null) return;
  if (s.kind === 'cmd') {
    if (!paneId) { notify('Otwórz zakładkę terminala, żeby wstawić komendę.', 'warning'); return; }
    sessions.paste(paneId, text);
    sessions.focus(paneId);
    return;
  }
  app.layout.agentOpen = true;
  post(ws, { role: 'user', who: `Snippet „${s.name}”`, text });
  agentState.busy[ws.id] = true;
  try {
    const r = await complete({ providerId: s.provider, model: s.model, messages: [{ role: 'user', content: text }], maxTokens: 8000 });
    post(ws, { role: 'agent', who: `${r.model}`, text: r.text });
  } catch (e) {
    post(ws, { role: 'error', who: 'Błąd', text: String(e) });
  } finally { agentState.busy[ws.id] = false; }
}
