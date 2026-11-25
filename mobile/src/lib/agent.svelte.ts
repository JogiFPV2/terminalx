// Agent AI na telefonie (bez komputera). Rozmowy: „global” (serwery SSH z ekranu startowego) i po jednej na każdy
// workspace telefonu (narzędzia na jego zakładkach). Każdą komendę zatwierdza użytkownik. Klucz API jest w sejfie
// (ai.<id>.key), zapytania wysyła Rust. `ask` służy nodom AI w workflow.
import { invoke } from '@tauri-apps/api/core';
import { SSH, hostById, hostCfg, inTauri, userHosts } from './ssh.svelte';
import { setSecret, getSecret, deleteSecret } from './secrets.ts';

export type Kind = 'anthropic' | 'openai' | 'openrouter' | 'google' | 'ollama' | 'custom';
export const KINDS: { id: Kind; name: string; url: string; key: boolean }[] = [
  { id: 'anthropic', name: 'Anthropic', url: 'https://api.anthropic.com', key: true },
  { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1', key: true },
  { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', key: true },
  { id: 'google', name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com', key: true },
  { id: 'ollama', name: 'Ollama', url: 'http://192.168.1.10:11434', key: false },
  { id: 'custom', name: 'Zgodny z OpenAI', url: 'http://192.168.1.10:1234/v1', key: false },
];

type Block = { type: string; [k: string]: any };
interface AMsg { role: 'user' | 'assistant'; content: string | Block[] }
export interface ChatItem {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
  /** Komenda czekająca na zgodę albo już rozstrzygnięta. */
  cmd?: { target: string; command: string; state: 'pending' | 'approved' | 'rejected' | 'done'; code?: number | null };
}
export interface Chat { items: ChatItem[]; busy: boolean }
export interface ToolDef { name: string; description: string; input_schema: Record<string, unknown> }
/** Zestaw narzędzi rozmowy. `approve` pokazuje komendę do zatwierdzenia; `done` wpisuje wynik do tej karty. */
export interface ToolSet {
  system: string;
  tools: ToolDef[];
  run(name: string, input: any, ctx: { approve: (target: string, command: string) => Promise<string | null>; done: (itemId: string, code: number | null, output: string) => void }): Promise<string>;
}

const LS = 'hermitty-mobile:agent';
const PROVIDER_ID = 'main';
const keyName = `ai.${PROVIDER_ID}.key`;
const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(`${LS}:${k}`); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(`${LS}:${k}`, JSON.stringify(v)); } catch { /* brak miejsca */ } };

// Starsza wersja trzymała jedną rozmowę pod „items”/„history”: to teraz rozmowa „global”.
const legacy = load<ChatItem[] | null>('items', null);
if (legacy) { save('chat:global', legacy); save('hist:global', load('history', [])); try { localStorage.removeItem(`${LS}:items`); localStorage.removeItem(`${LS}:history`); } catch { /* nic */ } }

export const AG = $state({
  cfg: load('cfg', { kind: 'anthropic' as Kind, url: KINDS[0].url, model: '' }),
  hasKey: false,
  open: false,
  settings: false,
  chats: {} as Record<string, Chat>,
});

const histories = new Map<string, AMsg[]>();
const hist = (scope: string) => { let h = histories.get(scope); if (!h) histories.set(scope, (h = load<AMsg[]>(`hist:${scope}`, []))); return h; };
/** Rozmowa (tworzona przy pierwszym użyciu, z zapisanej historii). */
export function chat(scope: string): Chat {
  if (!AG.chats[scope]) AG.chats[scope] = { items: load<ChatItem[]>(`chat:${scope}`, []), busy: false };
  return AG.chats[scope];
}
const persist = (scope: string) => { save(`chat:${scope}`, chat(scope).items.slice(-120)); save(`hist:${scope}`, hist(scope).slice(-60)); };
export function dropChat(scope: string) { delete AG.chats[scope]; histories.delete(scope); try { localStorage.removeItem(`${LS}:chat:${scope}`); localStorage.removeItem(`${LS}:hist:${scope}`); } catch { /* nic */ } }

getSecret(keyName).then((k) => (AG.hasKey = !!k)).catch(() => {});

export function saveCfg() { save('cfg', AG.cfg); }
export async function setKey(key: string) {
  if (key) await setSecret(keyName, key.trim()); else await deleteSecret(keyName);
  AG.hasKey = !!key;
}
export const agentReady = () => !!AG.cfg.model && (AG.hasKey || !KINDS.find((k) => k.id === AG.cfg.kind)?.key);

const prov = () => ({ id: PROVIDER_ID, kind: AG.cfg.kind, url: AG.cfg.url });
const request = (method: string, path: string, body?: unknown) => {
  if (!inTauri()) return Promise.reject(new Error('Agent na telefonie działa tylko w aplikacji na Androidzie.'));
  return invoke<any>('ai_request', { provider: prov(), method, path, body: body ?? null });
};
const isAnthropic = () => AG.cfg.kind === 'anthropic';
const chatPath = () => AG.cfg.kind === 'google' ? '/v1beta/openai/chat/completions' : AG.cfg.kind === 'ollama' ? '/v1/chat/completions' : '/chat/completions';
const modelsPath = () => isAnthropic() ? '/v1/models?limit=100' : AG.cfg.kind === 'google' ? '/v1beta/openai/models' : AG.cfg.kind === 'ollama' ? '/v1/models' : '/models';

export async function listModels(): Promise<string[]> {
  const r = await request('GET', modelsPath());
  return ((r.data || r.models || []) as any[]).map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean).sort();
}

interface Result { text: string; calls: { id: string; name: string; input: any }[]; content: Block[] }

async function complete(system: string, messages: AMsg[], tools: ToolDef[], maxTokens = 8000): Promise<Result> {
  if (!AG.cfg.model) throw new Error('Wybierz model w ustawieniach agenta.');
  if (isAnthropic()) {
    const body: Record<string, unknown> = { model: AG.cfg.model, max_tokens: maxTokens, system, messages };
    if (tools.length) body.tools = tools;
    const r = await request('POST', '/v1/messages', body);
    const content: Block[] = r.content || [];
    return { text: content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(), calls: content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input || {} })), content };
  }
  const msgs: any[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') { msgs.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      msgs.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else for (const b of m.content) {
      if (b.type === 'tool_result') msgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content) });
      else if (b.type === 'text') msgs.push({ role: 'user', content: b.text });
    }
  }
  const body: Record<string, unknown> = { model: AG.cfg.model, messages: msgs, max_tokens: Math.min(maxTokens, 4096) };
  if (tools.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const r = await request('POST', chatPath(), body);
  const msg = r.choices?.[0]?.message || {};
  const text = String(msg.content || '').trim();
  const calls = (msg.tool_calls || []).map((c: any) => { let input = {}; try { input = JSON.parse(c.function?.arguments || '{}'); } catch { /* puste */ } return { id: c.id || `call_${Math.random().toString(36).slice(2)}`, name: c.function?.name, input }; });
  const content: Block[] = [];
  if (text) content.push({ type: 'text', text });
  for (const c of calls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
  return { text, calls, content };
}

/** Jedno pytanie bez narzędzi (nody AI w workflow). */
export async function ask(prompt: string, system = 'Odpowiadaj zwięźle, po polsku, bez wstępów.', maxTokens = 2048): Promise<string> {
  return (await complete(system, [{ role: 'user', content: prompt }], [], maxTokens)).text;
}

const uid = () => Math.random().toString(36).slice(2, 10);
const waiting = new Map<string, (ok: boolean) => void>();
const stopFlags = new Set<string>();

export function decide(scope: string, itemId: string, ok: boolean) {
  const it = chat(scope).items.find((i) => i.id === itemId);
  if (it?.cmd && it.cmd.state === 'pending') it.cmd.state = ok ? 'approved' : 'rejected';
  waiting.get(itemId)?.(ok); waiting.delete(itemId);
  persist(scope);
}

export function stop(scope: string) {
  stopFlags.add(scope);
  for (const it of chat(scope).items) if (it.cmd?.state === 'pending') decide(scope, it.id, false);
}

/** Wiadomość do agenta rozmowy `scope` z danym zestawem narzędzi; pętla do 25 kroków. */
export async function send(scope: string, text: string, set: ToolSet) {
  const c = chat(scope);
  if (c.busy || !text.trim()) return;
  c.busy = true; stopFlags.delete(scope);
  const h = hist(scope);
  c.items.push({ id: uid(), role: 'user', text: text.trim() });
  h.push({ role: 'user', content: text.trim() });
  persist(scope);
  const ctx = {
    approve: async (target: string, command: string) => {
      const item: ChatItem = { id: uid(), role: 'tool', text: '', cmd: { target, command, state: 'pending' } };
      c.items.push(item); persist(scope);
      const ok = await new Promise<boolean>((res) => waiting.set(item.id, res));
      return ok ? item.id : null;
    },
    done: (itemId: string, code: number | null, output: string) => {
      const live = c.items.find((i) => i.id === itemId);
      if (live?.cmd) { live.cmd.state = 'done'; live.cmd.code = code; live.text = output.slice(-4000); }
      persist(scope);
    },
  };
  try {
    for (let step = 0; step < 25 && !stopFlags.has(scope); step++) {
      const r = await complete(set.system, h, set.tools);
      h.push({ role: 'assistant', content: r.content.length ? r.content : r.text || '…' });
      if (r.text) c.items.push({ id: uid(), role: 'assistant', text: r.text });
      persist(scope);
      if (!r.calls.length) break;
      const results: Block[] = [];
      for (const call of r.calls) {
        let out: string;
        try { out = stopFlags.has(scope) ? 'Przerwano.' : await set.run(call.name, call.input, ctx); }
        catch (e) { out = `Błąd: ${String((e as Error)?.message || e)}`; }
        results.push({ type: 'tool_result', tool_use_id: call.id, content: out });
      }
      h.push({ role: 'user', content: results });
      persist(scope);
    }
  } catch (e) {
    c.items.push({ id: uid(), role: 'error', text: String((e as Error)?.message || e).replace(/^Error: /, '') });
    // Ostatnie zapytanie bez odpowiedzi psułoby kolejne: historia kończy się na odpowiedzi albo wyniku narzędzia.
    while (h.length && h[h.length - 1].role === 'user' && typeof h[h.length - 1].content === 'string') h.pop();
    persist(scope);
  } finally { c.busy = false; }
}

export function clearChat(scope: string) { const c = chat(scope); if (c.busy) return; c.items = []; histories.set(scope, []); persist(scope); }

/* ---------- rozmowa „global”: serwery SSH z ekranu startowego ---------- */

export const serverTools: ToolSet = {
  system: `Jesteś agentem Hermitty na telefonie z Androidem. Pomagasz administrować serwerami przez SSH.
Masz narzędzia list_servers i run_command. Każdą komendę użytkownik zatwierdza na telefonie, więc proponuj komendy konkretne i bezpieczne,
a przed zmianami (usuwanie, restart, instalacja) powiedz krótko, co zrobią. Odpowiadaj po polsku, zwięźle: to mały ekran.`,
  tools: [
    { name: 'list_servers', description: 'Lista serwerów SSH zapisanych w telefonie (id, nazwa, użytkownik@adres).', input_schema: { type: 'object', properties: {} } },
    {
      name: 'run_command',
      description: 'Wykonuje jedną komendę powłoki na serwerze SSH i zwraca wyjście (stdout+stderr, do 60 kB) oraz kod wyjścia. Użytkownik musi zatwierdzić każdą komendę. Komenda nie jest interaktywna: unikaj programów czekających na wejście.',
      input_schema: { type: 'object', properties: { server: { type: 'string', description: 'id serwera z list_servers' }, command: { type: 'string' }, timeout_secs: { type: 'number', description: 'limit czasu, domyślnie 120' } }, required: ['server', 'command'] },
    },
  ],
  async run(name, input, ctx) {
    if (name === 'list_servers') return JSON.stringify(userHosts().map((h) => ({ id: h.id, name: h.name, target: `${h.user}@${h.host}:${h.port}` })));
    if (name === 'run_command') {
      const h = hostById(String(input.server || '')) || SSH.hosts.find((x) => x.name === input.server);
      if (!h) return `Nie ma serwera „${input.server}”. Użyj list_servers.`;
      return execOn(h, String(input.command || ''), Number(input.timeout_secs) || 120, ctx, h.name);
    }
    return `Nieznane narzędzie ${name}`;
  },
};

/** Komenda (po zgodzie) przez ssh_exec na hoście; wynik dla modelu i do karty w czacie. */
export async function execOn(h: import('./ssh.svelte').SshHost, command: string, timeoutSecs: number, ctx: Parameters<ToolSet['run']>[2], label: string): Promise<string> {
  command = command.trim();
  if (!command) return 'Pusta komenda.';
  const item = await ctx.approve(label, command);
  if (!item) return 'Użytkownik odrzucił tę komendę. Zapytaj, co zrobić zamiast niej.';
  try {
    if (h.termux) await (await import('./termux.svelte')).ensureSshd();
    const r = await invoke<{ code: number | null; output: string; truncated: boolean }>('ssh_exec', { host: hostCfg(h), command, timeoutSecs });
    ctx.done(item, r.code, r.output);
    return `kod wyjścia: ${r.code ?? 'brak'}${r.truncated ? ' (wyjście ucięte)' : ''}\n${r.output}`;
  } catch (e) {
    const m = String((e as Error)?.message || e);
    ctx.done(item, null, m);
    return `Błąd: ${m}`;
  }
}
