// Agent workspace'u („szef”) i podagenci zakładek. Pętla narzędzi po stronie aplikacji:
// agent czyta zakładki, deleguje zadania podagentom, uruchamia komendy po zatwierdzeniu i korzysta z serwerów MCP.
// Rozmowy trafiają do historii (chats/<id>.json) razem z kontekstem modelu, więc można do nich wrócić.
import { complete, stripAnsi, type AMsg, type Block, type ToolCall, type ToolDef } from './ai';
import { app, ui, findTab, curWs, notify, shellName } from './state.svelte';
import * as sessions from './terminal/sessions.svelte';
import { nid, sleep, fill } from './util';
import { call } from './ipc';
import { userContent } from './attach';
import { toolsFor, invoke as mcpInvoke, type Bound } from './mcp.svelte';
import { autoSpeak } from './voice.svelte';
import type { AgentProfile, Att, ChatMsg, Skill, Snippet, Tab, Workspace } from './types';

export const agentState = $state({ busy: {} as Record<string, boolean>, subBusy: {} as Record<string, string> });
const histories = new Map<string, AMsg[]>();
/** Bezpośrednie rozmowy z podagentami: workspace → zakładka → historia. */
const subHistories = new Map<string, Record<string, AMsg[]>>();
/** Załączniki ostatniej wiadomości użytkownika (agent może je przekazać podagentowi). */
const lastAtt = new Map<string, Att[]>();
const aborts = new Map<string, { aborted: boolean }>();
const approvals = new Map<string, (ok: boolean) => void>();

const profile = (id: string | null | undefined, kind: 'agent' | 'sub') =>
  app.agents.find((a) => a.id === id) || app.agents.find((a) => a.kind === kind) || app.agents[0];

function post(ws: Workspace, m: Omit<ChatMsg, 'id'>) {
  const msg: ChatMsg = { id: nid('m'), ...m };
  ws.chat.push(msg);
  persistChat(ws);
  autoSpeak(ws, msg);
  return ws.chat[ws.chat.length - 1];
}

export function stopAgent(wsId: string) { const a = aborts.get(wsId); if (a) a.aborted = true; }

export function resolveApproval(ws: Workspace, msgId: string, ok: boolean) {
  const m = ws.chat.find((x) => x.id === msgId);
  if (m?.approve) m.approve.state = ok ? 'approved' : 'rejected';
  approvals.get(msgId)?.(ok);
  approvals.delete(msgId);
  persistChat(ws);
}

function needsApproval(p: AgentProfile, command: string) {
  if (p.perm === 'ask') return true;
  const c = command.toLowerCase();
  return app.settings.alwaysAsk.some((s) => s && c.includes(s.toLowerCase()));
}

async function askUser(ws: Workspace, p: AgentProfile, who: string, text: string, approve: { tabId?: string; label?: string; command: string }) {
  const msg = post(ws, { role: p.kind === 'agent' ? 'agent' : 'sub', who, text, approve: { ...approve, state: 'pending' } });
  app.layout.agentOpen = true;
  return new Promise<boolean>((res) => approvals.set(msg.id, res));
}

/** Uruchamia komendę w zakładce (po zgodzie, jeśli trzeba) i zwraca wyjście po ustaniu. */
const cap = (s: string, max = 256 * 1024) => (s.length > max ? s.slice(-max) : s);

async function runInTab(ws: Workspace, p: AgentProfile, tab: Tab, command: string, who: string, signal: { aborted: boolean }) {
  if (p.perm === 'read') return 'Odmowa: ten profil ma uprawnienia tylko do odczytu.';
  const pane = tab.panes[0];
  if (!pane) return 'Ta zakładka nie jest terminalem.';
  if (needsApproval(p, command) && !(await askUser(ws, p, who, `Chcę uruchomić w „${tab.title}”:`, { tabId: tab.id, command }))) {
    return 'Użytkownik odrzucił tę komendę. Nie ponawiaj jej; zaproponuj coś innego albo zapytaj.';
  }
  if (signal.aborted) return 'Przerwano.';
  let out = '';
  let last = Date.now();
  // Do modelu i tak trafia koniec wyjścia; limit chroni pamięć przy komendzie, która sypie megabajtami.
  const off = sessions.onOutput((id, data) => { if (id === pane.id) { out = cap(out + data); last = Date.now(); } });
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

/** Narzędzie MCP: zgoda jak przy komendach (w trybie „pytaj” poza narzędziami tylko do odczytu). */
async function runMcp(ws: Workspace, p: AgentProfile, who: string, b: Bound, input: unknown, signal: { aborted: boolean }): Promise<string | Block[]> {
  const args = JSON.stringify(input || {}, null, 1);
  const command = `${b.tool.name} ${args.length > 1500 ? args.slice(0, 1500) + '…' : args}`;
  const ask = p.perm === 'ask' ? !b.tool.annotations?.readOnlyHint : needsApproval(p, `${b.server.name} ${command}`);
  if (ask && !(await askUser(ws, p, who, 'Chcę użyć narzędzia MCP:', { label: `MCP · ${b.server.name}`, command }))) {
    return 'Użytkownik nie zgodził się na to wywołanie. Nie ponawiaj go bez pytania.';
  }
  if (signal.aborted) return 'Przerwano.';
  return mcpInvoke(b, input);
}

/** Narzędzia MCP profilu; serwery, które nie wstały, są zgłaszane w czacie raz na rozmowę. */
const mcpWarned = new Map<string, string>();
async function mcpTools(ws: Workspace, p: AgentProfile) {
  const r = await toolsFor(p).catch(() => ({ defs: [] as ToolDef[], bound: new Map<string, Bound>(), errors: [] as string[] }));
  const key = r.errors.join('\n');
  if (key && mcpWarned.get(ws.id) !== key) post(ws, { role: 'system', who: 'MCP', text: `Niedostępne serwery MCP (agent działa bez nich): ${r.errors.join('; ')}` });
  mcpWarned.set(ws.id, key);
  return r;
}

/* ---------- skille ---------- */
// Model widzi tylko nazwy i opisy przypiętych skilli; treść i pliki wczytuje narzędziem, gdy ich potrzebuje.

function skillsOf(p: AgentProfile): Skill[] {
  return (p.skills || []).map((id) => app.skills.find((s) => s.id === id)).filter((s): s is Skill => !!s);
}

function skillPrompt(list: Skill[]) {
  if (!list.length) return '';
  return `\n\nSkille (instrukcje do konkretnych rodzajów zadań). Zanim zaczniesz zadanie, którego dotyczy skill, wczytaj go narzędziem use_skill i postępuj według niego:\n${list.map((s) => `- ${s.name}: ${s.description || '(bez opisu)'}`).join('\n')}`;
}

function skillDefs(list: Skill[]): ToolDef[] {
  if (!list.length) return [];
  const defs: ToolDef[] = [{ name: 'use_skill', description: 'Zwraca pełne instrukcje skilla i listę jego plików pomocniczych.', input_schema: { type: 'object', properties: { name: { type: 'string', enum: list.map((s) => s.name) } }, required: ['name'] } }];
  if (list.some((s) => s.files)) defs.push({ name: 'read_skill_file', description: 'Treść pliku pomocniczego skilla (ścieżka z listy zwróconej przez use_skill).', input_schema: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' } }, required: ['name', 'path'] } });
  return defs;
}

/** Wynik narzędzia skilla albo null, gdy to inne narzędzie. */
function runSkillTool(list: Skill[], c: ToolCall): string | null {
  if (c.name !== 'use_skill' && c.name !== 'read_skill_file') return null;
  const s = list.find((x) => x.name === c.input.name);
  if (!s) return `Nie ma skilla „${c.input.name}”. Dostępne: ${list.map((x) => x.name).join(', ') || 'brak'}.`;
  if (c.name === 'use_skill') {
    const files = Object.keys(s.files || {});
    return s.body + (files.length ? `\n\nPliki skilla (read_skill_file): ${files.join(', ')}` : '');
  }
  return s.files?.[String(c.input.path)] ?? `Skill „${s.name}” nie ma pliku ${c.input.path}.`;
}

function tabsSummary(ws: Workspace) {
  return ws.tabs.map((t) => {
    const sub = t.subagent ? profile(t.subagent, 'sub').name : 'brak';
    return `- id: ${t.id} · „${t.title}” · ${t.kind === 'flow' ? 'workflow' : shellName(t.panes[0]?.shell || '')} · podagent: ${sub}`;
  }).join('\n') || '(brak zakładek)';
}

/** Wiadomość użytkownika (tekst albo z załącznikami), a nie wyniki narzędzi. */
const isUserTurn = (m: AMsg) => m.role === 'user' && (typeof m.content === 'string' || !m.content.some((b) => b.type === 'tool_result'));

/** Długa rozmowa: zostaje ostatnie `max` wpisów, zaczynając od wiadomości użytkownika. */
function trim(history: AMsg[], max = 40) {
  if (history.length <= max) return;
  let cut = history.length - max;
  while (cut < history.length && !isUserTurn(history[cut])) cut++;
  history.splice(0, cut);
}

/** Po błędzie historia kończy się zapytaniem bez odpowiedzi; cofamy ją do ostatniej pełnej wymiany. */
function rollback(history: AMsg[]) {
  while (history.length && history[history.length - 1].role === 'user' && !isUserTurn(history[history.length - 1])) history.pop();
  if (history.length && history[history.length - 1].role === 'user') history.pop();
}

/* ---------- sub-agent ---------- */

async function runSub(ws: Workspace, tab: Tab, content: string | Block[], signal: { aborted: boolean }, messages: AMsg[] = [], direct = false): Promise<string> {
  const p = profile(tab.subagent || ws.subDefault, 'sub');
  const who = `Podagent „${tab.title}”`;
  const tools: ToolDef[] = [];
  if (p.tools.includes('read_buffer')) tools.push({ name: 'read_buffer', description: 'Ostatnie linie wyjścia terminala tej zakładki.', input_schema: { type: 'object', properties: { lines: { type: 'integer', description: 'Liczba linii, domyślnie 60' } } } });
  if (p.tools.includes('run_command') && p.perm !== 'read') tools.push({ name: 'run_command', description: 'Wpisuje komendę do terminala tej zakładki i zwraca wyjście, gdy przestanie przybywać.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } });
  if (p.tools.includes('wait_for_output')) tools.push({ name: 'wait_for_output', description: 'Czeka podaną liczbę sekund (maks. 120) albo aż w wyjściu pojawi się wzorzec, potem zwraca nowe wyjście.', input_schema: { type: 'object', properties: { seconds: { type: 'integer' }, pattern: { type: 'string' } }, required: ['seconds'] } });
  tools.push({ name: 'report', description: direct ? 'Kończy pracę i odpowiada użytkownikowi.' : 'Kończy pracę i przekazuje raport agentowi.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } });
  const mcp = await mcpTools(ws, p);
  tools.push(...mcp.defs);
  const skills = skillsOf(p);
  tools.push(...skillDefs(skills));

  const system = `${p.prompt}${skillPrompt(skills)}\n\nPracujesz w zakładce „${tab.title}” (${shellName(tab.panes[0]?.shell || '')}, system Windows). ${direct ? 'Użytkownik pisze do ciebie bezpośrednio; odpowiadaj jemu.' : 'Zadanie zleca ci agent workspace\'u.'} Gdy skończysz, wywołaj narzędzie report.`;
  messages.push({ role: 'user', content });
  agentState.subBusy[tab.id] = 'pracuje';
  try {
    for (let step = 0; step < 12 && !signal.aborted; step++) {
      const r = await complete({ providerId: p.provider, model: p.model, keyId: p.key, system, messages, tools, maxTokens: 8000, signal });
      messages.push({ role: 'assistant', content: r.content });
      if (r.text) post(ws, { role: 'sub', who, text: r.text });
      if (!r.toolCalls.length) return r.text || '(podagent zakończył bez raportu)';
      const results: Block[] = [];
      let report: string | null = null;
      for (const c of r.toolCalls) {
        let out: string | Block[] = '';
        if (c.name === 'report') { report = String(c.input.text || ''); out = 'Przekazano.'; }
        else if (c.name === 'read_buffer') out = sessions.tail(tab.panes[0]?.id, Math.min(400, c.input.lines || 60)).join('\n');
        else if (c.name === 'run_command') { agentState.subBusy[tab.id] = 'uruchamia'; out = await runInTab(ws, p, tab, String(c.input.command || ''), who, signal); agentState.subBusy[tab.id] = 'pracuje'; }
        else if (c.name === 'wait_for_output') out = await waitFor(tab, Math.min(120, c.input.seconds || 5), c.input.pattern, signal);
        else if (runSkillTool(skills, c) !== null) out = runSkillTool(skills, c)!;
        else if (mcp.bound.has(c.name)) { agentState.subBusy[tab.id] = 'MCP'; out = await runMcp(ws, p, who, mcp.bound.get(c.name)!, c.input, signal).catch((e) => `Błąd: ${e}`); agentState.subBusy[tab.id] = 'pracuje'; }
        else out = `Nieznane narzędzie ${c.name}`;
        results.push({ type: 'tool_result', tool_use_id: c.id, content: out || '(pusto)' });
      }
      // Wyniki zostają w historii, żeby rozmowa bezpośrednia z podagentem dała się kontynuować.
      messages.push({ role: 'user', content: results });
      if (report !== null) {
        post(ws, { role: 'sub', who, text: report });
        if (direct) messages.push({ role: 'assistant', content: [{ type: 'text', text: report }] });
        return report;
      }
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
  const off = sessions.onOutput((id, d) => { if (id === pane.id) out = cap(out + d); });
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

/** Wiadomość wprost do podagenta zakładki (z panelu czatu). */
export async function sendToSub(ws: Workspace, tabId: string, text: string, att: Att[] = []) {
  if (agentState.busy[ws.id]) { notify('Agent jeszcze pracuje. Poczekaj albo zatrzymaj go.', 'warning'); return; }
  const tab = ws.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  await loadContext(ws);
  post(ws, { role: 'user', who: `Ty → podagent „${tab.title}”`, text, att: att.length ? att : undefined });
  const subs = subHistories.get(ws.id) || {};
  subHistories.set(ws.id, subs);
  const history = (subs[tab.id] ||= []);
  const signal = { aborted: false };
  aborts.set(ws.id, signal);
  agentState.busy[ws.id] = true;
  try {
    // Pętla narzędzi dopisuje do kopii; do historii trafia dopiero udana wymiana.
    const work = [...history];
    await runSub(ws, tab, userContent(text, att), signal, work, true);
    history.splice(0, history.length, ...work);
    trim(history);
    if (signal.aborted) post(ws, { role: 'system', who: 'System', text: 'Zatrzymano podagenta.' });
  } catch (e) {
    post(ws, { role: 'error', who: 'Błąd', text: String(e).replace(/^Error: /, '') });
  } finally {
    agentState.busy[ws.id] = false;
    aborts.delete(ws.id);
    persistChat(ws, true);
  }
}

/* ---------- workspace agent ---------- */

export async function sendToAgent(ws: Workspace, text: string, att: Att[] = []) {
  if (agentState.busy[ws.id]) { notify('Agent jeszcze pracuje. Poczekaj albo zatrzymaj go.', 'warning'); return; }
  const p = profile(ws.agentId, 'agent');
  await loadContext(ws);
  post(ws, { role: 'user', who: 'Ty', text, att: att.length ? att : undefined });
  const history = histories.get(ws.id) || [];
  histories.set(ws.id, history);
  history.push({ role: 'user', content: userContent(text, att) });
  lastAtt.set(ws.id, att);

  const tools: ToolDef[] = [{ name: 'list_tabs', description: 'Lista zakładek tego workspace\'u z identyfikatorami.', input_schema: { type: 'object', properties: {} } }];
  if (p.tools.includes('read_all')) tools.push({ name: 'read_tab', description: 'Ostatnie linie wyjścia terminala w zakładce.', input_schema: { type: 'object', properties: { tab_id: { type: 'string' }, lines: { type: 'integer' } }, required: ['tab_id'] } });
  if (p.tools.includes('run_command') && p.perm !== 'read') tools.push({ name: 'run_command', description: 'Uruchamia komendę w terminalu zakładki i zwraca wyjście.', input_schema: { type: 'object', properties: { tab_id: { type: 'string' }, command: { type: 'string' } }, required: ['tab_id', 'command'] } });
  if (p.tools.includes('delegate')) tools.push({ name: 'delegate', description: 'Zleca zadanie podagentowi zakładki terminala. Podagent sam czyta wyjście i uruchamia komendy, potem zwraca raport. Kilka wywołań w jednej odpowiedzi działa równolegle.', input_schema: { type: 'object', properties: { tab_id: { type: 'string' }, task: { type: 'string' }, attachments: { type: 'boolean', description: 'Przekaż podagentowi załączniki z ostatniej wiadomości użytkownika' } }, required: ['tab_id', 'task'] } });
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
    const mcp = await mcpTools(ws, p);
    tools.push(...mcp.defs);
    const skills = skillsOf(p);
    tools.push(...skillDefs(skills));
    for (let step = 0; step < 16 && !signal.aborted; step++) {
      const system = `${p.prompt}${skillPrompt(skills)}\n\nSystem: Windows. Workspace „${ws.name}”. Zakładki:\n${tabsSummary(ws)}\n\nUżywaj identyfikatorów zakładek z listy. Pracę w konkretnym terminalu deleguj podagentom, gdy zakładka ma podagenta albo zadanie wymaga kilku kroków.${mcp.defs.length ? ' Narzędzia z prefiksem serwera (np. github__…) pochodzą z serwerów MCP.' : ''}`;
      const r = await complete({ providerId: ws.chatModel?.provider || p.provider, model: ws.chatModel?.model || p.model, keyId: ws.chatModel ? ws.chatModel.key : p.key, system, messages: history, tools, maxTokens: 16000, signal });
      history.push({ role: 'assistant', content: r.content });
      if (r.text) post(ws, { role: 'agent', who: p.name, text: r.text });
      if (!r.toolCalls.length) break;
      const results = await Promise.all(r.toolCalls.map(async (c): Promise<Block> => {
        let out: string | Block[] = '';
        try {
          const t = c.input.tab_id ? findTab(String(c.input.tab_id))?.tab : undefined;
          const sk = runSkillTool(skills, c);
          if (sk !== null) out = sk;
          else if (mcp.bound.has(c.name)) out = await runMcp(ws, p, p.name, mcp.bound.get(c.name)!, c.input, signal);
          else if (c.name === 'list_tabs') out = tabsSummary(ws);
          else if (c.name === 'list_node_types') out = (await import('./workflow/builder')).nodeCatalog();
          else if (c.name === 'build_workflow') {
            const r = (await import('./workflow/builder')).buildFlow(c.input);
            post(ws, { role: 'agent', who: p.name, text: r.summary });
            out = r.summary;
          } else if (!t) out = `Nie ma zakładki o id ${c.input.tab_id}. Użyj list_tabs.`;
          else if (c.name === 'read_tab') out = sessions.tail(t!.panes[0]?.id, Math.min(400, c.input.lines || 60)).join('\n') || '(pusto)';
          else if (c.name === 'run_command') out = await runInTab(ws, p, t!, String(c.input.command || ''), p.name, signal);
          else if (c.name === 'delegate') {
            const task = String(c.input.task || '');
            const att = c.input.attachments ? lastAtt.get(ws.id) || [] : [];
            post(ws, { role: 'agent', who: `${p.name} → podagent „${t!.title}”`, text: task, att: att.length ? att : undefined });
            out = await runSub(ws, t!, userContent(`Zadanie od agenta: ${task}`, att), signal);
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
    rollback(history);
  } finally {
    agentState.busy[ws.id] = false;
    aborts.delete(ws.id);
    trim(history);
    persistChat(ws, true);
  }
}

/* ---------- historia rozmów ---------- */

export interface ChatMeta { id: string; title: string; ws: string; wsId: string; who: string[]; created: number; updated: number; count: number; preview: string }
interface SavedChat { v: 1; id: string; title: string; wsId: string; wsName: string; created: number; msgs: ChatMsg[]; history: AMsg[]; subs: Record<string, AMsg[]> }

/** Id rozmowy (potrzebne też do zapisu załączników przed wysłaniem). */
export function ensureChatId(ws: Workspace) {
  if (!ws.chatId) { ws.chatId = nid('c'); ws.chatCreated = Date.now(); }
  return ws.chatId;
}

const saveTimers = new Map<string, number>();
/** Zapis rozmowy z opóźnieniem (seria wiadomości daje jeden zapis); `now` zapisuje od razu. */
export function persistChat(ws: Workspace, now = false) {
  clearTimeout(saveTimers.get(ws.id));
  if (now) return writeChat(ws);
  saveTimers.set(ws.id, window.setTimeout(() => writeChat(ws), 1500));
}

function participants(ws: Workspace) {
  const who = new Set<string>();
  for (const m of ws.chat) {
    if (m.role === 'agent') who.add(m.who.split(' → ')[0]);
    else if (m.role === 'sub') who.add(m.who);
  }
  return [...who].slice(0, 8);
}

async function writeChat(ws: Workspace) {
  saveTimers.delete(ws.id);
  if (!ws.chat.some((m) => m.role === 'user')) return;
  const id = ensureChatId(ws);
  const first = ws.chat.find((m) => m.role === 'user');
  const title = (first?.text.trim() || first?.att?.map((a) => a.name).join(', ') || 'Rozmowa').replace(/\s+/g, ' ').slice(0, 80);
  const last = [...ws.chat].reverse().find((m) => m.role !== 'system');
  const msgs = ws.chat.map((m) => (m.approve?.state === 'pending' ? { ...m, approve: { ...m.approve, state: 'rejected' as const } } : m));
  const meta = { title, ws: ws.name, wsId: ws.id, who: participants(ws), created: ws.chatCreated || Date.now(), updated: Date.now(), count: ws.chat.length, preview: (last?.text || '').replace(/\s+/g, ' ').slice(0, 140) };
  const data: SavedChat = { v: 1, id, title, wsId: ws.id, wsName: ws.name, created: meta.created, msgs: JSON.parse(JSON.stringify(msgs)), history: histories.get(ws.id) || [], subs: subHistories.get(ws.id) || {} };
  await call('chat_save', { id, meta, json: JSON.stringify(data) }).catch((e) => console.error('zapis rozmowy', e));
}

/** Po restarcie aplikacji kontekst modelu bieżącej rozmowy wraca z pliku przy pierwszej wiadomości. */
async function loadContext(ws: Workspace) {
  if (histories.has(ws.id) || !ws.chatId) return;
  try {
    const d: SavedChat = JSON.parse(await call<string>('chat_load', { id: ws.chatId }));
    histories.set(ws.id, d.history || []);
    subHistories.set(ws.id, d.subs || {});
  } catch { histories.set(ws.id, []); }
}

function reset(ws: Workspace) {
  ws.chat.splice(0);
  ws.chatId = undefined;
  ws.chatCreated = undefined;
  histories.delete(ws.id);
  subHistories.delete(ws.id);
  lastAtt.delete(ws.id);
  mcpWarned.delete(ws.id);
}

/** Nowa rozmowa; poprzednia zostaje w historii. */
export async function newChat(ws: Workspace) {
  if (agentState.busy[ws.id]) { notify('Agent jeszcze pracuje. Zatrzymaj go przed nową rozmową.', 'warning'); return; }
  await persistChat(ws, true);
  reset(ws);
}

export const listChats = (query = '') => call<ChatMeta[]>('chat_list', { query: query.trim() || null });

/** Otwiera rozmowę z historii w workspace (z kontekstem modelu, więc można ją kontynuować). */
export async function openChat(ws: Workspace, id: string) {
  const holder = app.workspaces.find((w) => w.chatId === id);
  if (holder) { app.activeWs = holder.id; return; }
  if (agentState.busy[ws.id]) { notify('Agent jeszcze pracuje. Zatrzymaj go przed zmianą rozmowy.', 'warning'); return; }
  const d: SavedChat = JSON.parse(await call<string>('chat_load', { id }));
  await persistChat(ws, true);
  reset(ws);
  ws.chat.push(...d.msgs);
  ws.chatId = d.id;
  ws.chatCreated = d.created;
  histories.set(ws.id, d.history || []);
  subHistories.set(ws.id, d.subs || {});
}

export async function deleteChat(id: string) {
  const holder = app.workspaces.find((w) => w.chatId === id);
  if (holder) { clearTimeout(saveTimers.get(holder.id)); reset(holder); }
  await call('chat_delete', { id });
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
