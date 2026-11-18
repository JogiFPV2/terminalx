// Agent AI na telefonie (bez komputera): czat z dostawcą AI, który może wykonywać komendy na serwerach SSH
// zapisanych w telefonie. Każdą komendę zatwierdza użytkownik. Klucz API jest w sejfie (ai.<id>.key), zapytania wysyła Rust.
import { invoke } from '@tauri-apps/api/core';
import { SSH, hostById, inTauri } from './ssh.svelte';
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
  cmd?: { server: string; serverName: string; command: string; state: 'pending' | 'approved' | 'rejected' | 'done'; code?: number | null };
}

const LS = 'hermitty-mobile:agent';
const PROVIDER_ID = 'main';
const keyName = `ai.${PROVIDER_ID}.key`;
const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(`${LS}:${k}`); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(`${LS}:${k}`, JSON.stringify(v)); } catch { /* brak miejsca */ } };

export const AG = $state({
  cfg: load('cfg', { kind: 'anthropic' as Kind, url: KINDS[0].url, model: '' }),
  hasKey: false,
  open: false,
  settings: false,
  busy: false,
  items: load<ChatItem[]>('items', []),
});

/** Historia dla modelu (z blokami narzędzi); trzymana w pamięci i w localStorage. */
let history: AMsg[] = load<AMsg[]>('history', []);
const persist = () => { save('items', AG.items.slice(-120)); save('history', history.slice(-60)); };

getSecret(keyName).then((k) => (AG.hasKey = !!k)).catch(() => {});

export function saveCfg() { save('cfg', AG.cfg); }
export async function setKey(key: string) {
  if (key) await setSecret(keyName, key.trim()); else await deleteSecret(keyName);
  AG.hasKey = !!key;
}

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

const TOOLS = [
  { name: 'list_servers', description: 'Lista serwerów SSH zapisanych w telefonie (id, nazwa, użytkownik@adres).', input_schema: { type: 'object', properties: {} } },
  {
    name: 'run_command',
    description: 'Wykonuje jedną komendę powłoki na serwerze SSH i zwraca wyjście (stdout+stderr, do 60 kB) oraz kod wyjścia. Użytkownik musi zatwierdzić każdą komendę. Komenda nie jest interaktywna: unikaj programów czekających na wejście.',
    input_schema: { type: 'object', properties: { server: { type: 'string', description: 'id serwera z list_servers' }, command: { type: 'string' }, timeout_secs: { type: 'number', description: 'limit czasu, domyślnie 120' } }, required: ['server', 'command'] },
  },
];

const SYSTEM = `Jesteś agentem Hermitty na telefonie z Androidem. Pomagasz administrować serwerami przez SSH.
Masz narzędzia list_servers i run_command. Każdą komendę użytkownik zatwierdza na telefonie, więc proponuj komendy konkretne i bezpieczne,
a przed zmianami (usuwanie, restart, instalacja) powiedz krótko, co zrobią. Odpowiadaj po polsku, zwięźle: to mały ekran.`;

interface Result { text: string; calls: { id: string; name: string; input: any }[]; content: Block[] }

async function complete(): Promise<Result> {
  if (!AG.cfg.model) throw new Error('Wybierz model w ustawieniach agenta.');
  if (isAnthropic()) {
    const r = await request('POST', '/v1/messages', { model: AG.cfg.model, max_tokens: 8000, system: SYSTEM, messages: history, tools: TOOLS });
    const content: Block[] = r.content || [];
    return { text: content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(), calls: content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input || {} })), content };
  }
  const msgs: any[] = [{ role: 'system', content: SYSTEM }];
  for (const m of history) {
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
  const r = await request('POST', chatPath(), { model: AG.cfg.model, messages: msgs, max_tokens: 4096, tools: TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) });
  const msg = r.choices?.[0]?.message || {};
  const text = String(msg.content || '').trim();
  const calls = (msg.tool_calls || []).map((c: any) => { let input = {}; try { input = JSON.parse(c.function?.arguments || '{}'); } catch { /* puste */ } return { id: c.id || `call_${Math.random().toString(36).slice(2)}`, name: c.function?.name, input }; });
  const content: Block[] = [];
  if (text) content.push({ type: 'text', text });
  for (const c of calls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
  return { text, calls, content };
}

const uid = () => Math.random().toString(36).slice(2, 10);
const waiting = new Map<string, (ok: boolean) => void>();

export function decide(itemId: string, ok: boolean) {
  const it = AG.items.find((i) => i.id === itemId);
  if (it?.cmd && it.cmd.state === 'pending') it.cmd.state = ok ? 'approved' : 'rejected';
  waiting.get(itemId)?.(ok); waiting.delete(itemId);
  persist();
}

async function runTool(name: string, input: any): Promise<string> {
  if (name === 'list_servers') {
    return JSON.stringify(SSH.hosts.map((h) => ({ id: h.id, name: h.name, target: `${h.user}@${h.host}:${h.port}` })));
  }
  if (name === 'run_command') {
    const h = hostById(String(input.server || '')) || SSH.hosts.find((x) => x.name === input.server);
    if (!h) return `Nie ma serwera „${input.server}”. Użyj list_servers.`;
    const command = String(input.command || '').trim();
    if (!command) return 'Pusta komenda.';
    const item: ChatItem = { id: uid(), role: 'tool', text: '', cmd: { server: h.id, serverName: h.name, command, state: 'pending' } };
    AG.items.push(item); persist();
    const ok = await new Promise<boolean>((res) => waiting.set(item.id, res));
    if (!ok) return 'Użytkownik odrzucił tę komendę. Zapytaj, co zrobić zamiast niej.';
    try {
      const r = await invoke<{ code: number | null; output: string; truncated: boolean }>('ssh_exec', { host: { id: h.id, host: h.host, port: h.port, user: h.user, auth: h.auth }, command, timeoutSecs: Number(input.timeout_secs) || 120 });
      const live = AG.items.find((i) => i.id === item.id);
      if (live?.cmd) { live.cmd.state = 'done'; live.cmd.code = r.code; live.text = r.output.slice(-4000); }
      persist();
      return `kod wyjścia: ${r.code ?? 'brak'}${r.truncated ? ' (wyjście ucięte)' : ''}\n${r.output}`;
    } catch (e) {
      const live = AG.items.find((i) => i.id === item.id);
      if (live?.cmd) { live.cmd.state = 'done'; live.text = String((e as Error)?.message || e); }
      persist();
      return `Błąd: ${String((e as Error)?.message || e)}`;
    }
  }
  return `Nieznane narzędzie ${name}`;
}

let stopFlag = false;
export function stop() { stopFlag = true; for (const id of [...waiting.keys()]) decide(id, false); }

export async function send(text: string) {
  if (AG.busy || !text.trim()) return;
  AG.busy = true; stopFlag = false;
  AG.items.push({ id: uid(), role: 'user', text: text.trim() });
  history.push({ role: 'user', content: text.trim() });
  persist();
  try {
    for (let step = 0; step < 25 && !stopFlag; step++) {
      const r = await complete();
      history.push({ role: 'assistant', content: r.content.length ? r.content : r.text || '…' });
      if (r.text) AG.items.push({ id: uid(), role: 'assistant', text: r.text });
      persist();
      if (!r.calls.length) break;
      const results: Block[] = [];
      for (const c of r.calls) results.push({ type: 'tool_result', tool_use_id: c.id, content: stopFlag ? 'Przerwano.' : await runTool(c.name, c.input) });
      history.push({ role: 'user', content: results });
      persist();
    }
  } catch (e) {
    AG.items.push({ id: uid(), role: 'error', text: String((e as Error)?.message || e).replace(/^Error: /, '') });
    // Ostatnie zapytanie bez odpowiedzi psułoby kolejne: historia kończy się na odpowiedzi albo wyniku narzędzia.
    while (history.length && history[history.length - 1].role === 'user' && typeof history[history.length - 1].content === 'string') history.pop();
    persist();
  } finally { AG.busy = false; }
}

export function clearChat() { if (AG.busy) return; AG.items = []; history = []; persist(); }
