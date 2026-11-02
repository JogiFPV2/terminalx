// Wspólny klient dla providerów: Anthropic (Messages API) i zgodnych z OpenAI (OpenAI, OpenRouter, LM Studio, Ollama /v1).
// Historia rozmowy jest trzymana w formacie bloków Anthropic; dla OpenAI konwertujemy w locie.
import { call } from './ipc';
import { app, notify } from './state.svelte';
import { isChat, CLI_DEFAULT_MODEL } from './defaults';
import { onGpu } from './gpu';
import type { Provider, ProviderKey } from './types';
import { emptyUsage, addUsage, tokensOf, parseLimits } from './usage';
import { expandAttachments } from './attach';

const usageListeners = new Set<(providerId: string) => void>();
export function onUsage(cb: (providerId: string) => void) { usageListeners.add(cb); return () => usageListeners.delete(cb); }

/** Dolicza tokeny z odpowiedzi i zapamiętuje limity z nagłówków (bez treści i kluczy). */
function recordUsage(p: Provider, res: any) {
  const t = tokensOf(res?.usage), lim = parseLimits(res?.__ratelimit);
  if (!t && !lim) return;
  const u = (app.usage[p.id] ||= emptyUsage());
  if (t) addUsage(u, t);
  if (lim) u.limits = lim;
  for (const cb of usageListeners) cb(p.id);
}

export interface ToolDef { name: string; description: string; input_schema: Record<string, unknown> }
export interface ToolCall { id: string; name: string; input: any }
export type Block = { type: string; [k: string]: any };
export interface AMsg { role: 'user' | 'assistant'; content: string | Block[] }
export interface CompleteOpts {
  providerId?: string | null;
  model?: string | null;
  system?: string;
  messages: AMsg[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  json?: boolean;
  /** Klucz providera (id z `providerKeys`); brak = automatycznie, z przełączaniem przy limicie. */
  keyId?: string | null;
  signal?: { aborted: boolean };
}
export interface CompleteResult { text: string; toolCalls: ToolCall[]; content: Block[]; stop: string; model: string }

export function resolveModel(providerId?: string | null, model?: string | null): { p: Provider; model: string } {
  // Bez wskazanego providera obowiązuje para „domyślny provider + domyślny model” z ustawień.
  const explicit = providerId ? app.providers.find((x) => x.id === providerId && isChat(x)) : undefined;
  const p = explicit || app.providers.find((x) => x.id === app.defModel.provider) || app.providers.find(isChat);
  if (!p) throw new Error('Brak skonfigurowanych providerów. Dodaj providera w Ustawienia → Konta i providerzy.');
  const m = explicit ? (model || p.defModel || p.models[0] || app.defModel.model) : (p.id === app.defModel.provider ? app.defModel.model : p.defModel || p.models[0]);
  return { p, model: m };
}

export const MAIN_KEY = 'main';
/** Klucze providera: główny i dodatkowe. */
export function providerKeys(p: Provider): ProviderKey[] {
  return [{ id: MAIN_KEY, name: p.keyName || 'Główny', keyRef: p.keyRef, hasKey: p.hasKey }, ...(p.keys || [])];
}
/** Klucze, których można użyć w czacie (Ollama i lokalne serwery działają też bez klucza). */
export const usableKeys = (p: Provider) => {
  const all = providerKeys(p), withKey = all.filter((k) => k.hasKey);
  return withKey.length ? withKey : all.slice(0, 1);
};

const ref = (p: Provider, keyRef = p.keyRef) => ({ type: p.type, url: p.url, keyRef });

function openaiPath(p: Provider) { return p.type === 'ollama' ? '/v1/chat/completions' : p.type === 'google' ? '/v1beta/openai/chat/completions' : '/chat/completions'; }

/* ---------- Anthropic ---------- */

async function anthropic(p: Provider, model: string, o: CompleteOpts, keyRef = p.keyRef): Promise<CompleteResult> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: o.maxTokens || 16000,
    messages: o.messages,
  };
  if (o.system) body.system = o.system + (o.json ? '\n\nOdpowiedz wyłącznie poprawnym JSON-em, bez komentarzy i bloków kodu.' : '');
  else if (o.json) body.system = 'Odpowiedz wyłącznie poprawnym JSON-em, bez komentarzy i bloków kodu.';
  if (o.tools?.length) body.tools = o.tools;
  // Aktualne modele Claude nie przyjmują temperature/top_p, a myślenie (adaptive) jest domyślne,
  // więc nie wysyłamy tych parametrów. Dla modeli z odmową bezpieczeństwa włączamy fallback po stronie serwera.
  const useFallback = /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-1)$/.test(model);
  let res: any;
  try {
    res = await call('ai_request', {
      provider: ref(p, keyRef), method: 'POST', path: '/v1/messages',
      body: useFallback ? { ...body, fallbacks: 'default' } : body,
      headers: useFallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : null,
    });
  } catch (e) {
    if (useFallback && /fallback|beta/i.test(String(e))) {
      res = await call('ai_request', { provider: ref(p, keyRef), method: 'POST', path: '/v1/messages', body, headers: null });
    } else throw e;
  }
  recordUsage(p, res);
  const content: Block[] = res.content || [];
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const toolCalls = content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));
  if (res.stop_reason === 'refusal') {
    const why = res.stop_details?.explanation ? ` (${res.stop_details.explanation})` : '';
    return { text: text || `Model odmówił wykonania tego zadania${why}.`, toolCalls: [], content, stop: 'refusal', model: res.model || model };
  }
  return { text, toolCalls, content, stop: res.stop_reason || 'end_turn', model: res.model || model };
}

/* ---------- OpenAI-compatible ---------- */

/** Wynik narzędzia jako tekst (OpenAI nie przyjmuje obrazów w wiadomości `tool`). */
const resultText = (c: unknown) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => (b.type === 'text' ? b.text : b.type === 'image' ? '[obraz poniżej]' : '')).join('\n') : JSON.stringify(c);
const dataUrl = (b: Block) => `data:${b.source.media_type};base64,${b.source.data}`;

function toOpenAi(messages: AMsg[], system?: string, pdf = false) {
  const out: any[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      const parts: any[] = [];
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: resultText(b.content) });
          // Obrazy z wyników narzędzi (np. MCP) idą zaraz za nimi jako wiadomość użytkownika.
          if (Array.isArray(b.content)) for (const x of b.content) if (x.type === 'image' && x.source?.type === 'base64') parts.push({ type: 'image_url', image_url: { url: dataUrl(x) } });
        } else if (b.type === 'text') parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image' && b.source?.type === 'base64') parts.push({ type: 'image_url', image_url: { url: dataUrl(b) } });
        else if (b.type === 'document' && b.source?.type === 'base64') {
          parts.push(pdf ? { type: 'file', file: { filename: b.title || 'dokument.pdf', file_data: dataUrl(b) } } : { type: 'text', text: `[PDF „${b.title}” pominięty: ten provider nie przyjmuje plików PDF. Plik leży na dysku, ścieżka powyżej.]` });
        }
      }
      if (parts.some((x) => x.type !== 'text')) out.push({ role: 'user', content: parts });
      else if (parts.length) out.push({ role: 'user', content: parts.map((x) => x.text).join('\n') });
    }
  }
  return out;
}

async function openai(p: Provider, model: string, o: CompleteOpts, keyRef = p.keyRef): Promise<CompleteResult> {
  // PDF jako część `file` przyjmują OpenAI i OpenRouter; lokalne serwery (Ollama, LM Studio) nie.
  const pdf = p.type === 'openai' || /openrouter\.ai/.test(p.url);
  const body: Record<string, unknown> = { model, messages: toOpenAi(o.messages, o.system, pdf), max_tokens: o.maxTokens || 4096 };
  if (o.temperature != null) body.temperature = o.temperature;
  if (o.topP != null) body.top_p = o.topP;
  if (o.json) body.response_format = { type: 'json_object' };
  if (o.tools?.length) body.tools = o.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const res: any = await call('ai_request', { provider: ref(p, keyRef), method: 'POST', path: openaiPath(p), body, headers: null });
  recordUsage(p, res);
  const msg = res.choices?.[0]?.message || {};
  const text = (msg.content || '').trim();
  const toolCalls: ToolCall[] = (msg.tool_calls || []).map((c: any) => {
    let input = {};
    try { input = JSON.parse(c.function?.arguments || '{}'); } catch { input = {}; }
    return { id: c.id || `call_${Math.random().toString(36).slice(2)}`, name: c.function?.name, input };
  });
  const content: Block[] = [];
  if (text) content.push({ type: 'text', text });
  for (const c of toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
  return { text, toolCalls, content, stop: toolCalls.length ? 'tool_use' : (res.choices?.[0]?.finish_reason || 'stop'), model: res.model || model };
}

/* ---------- narzędzia CLI (Claude Code, Codex, Gemini CLI…) ---------- */

/** Treść bloku jako tekst: narzędzie CLI dostaje jedną wiadomość, bez obrazów i narzędzi aplikacji. */
function blockText(b: Block): string {
  if (b.type === 'text') return b.text || '';
  if (b.type === 'tool_use') return `[narzędzie ${b.name}: ${JSON.stringify(b.input || {})}]`;
  if (b.type === 'tool_result') return `[wynik narzędzia: ${typeof b.content === 'string' ? b.content : (b.content || []).map(blockText).join('\n')}]`;
  if (b.type === 'image') return '[obraz pominięty: narzędzie CLI dostaje tylko tekst]';
  if (b.type === 'document') return b.source?.type === 'text' ? b.source.data || '' : '[dokument pominięty]';
  return '';
}
const msgText = (m: AMsg) => (typeof m.content === 'string' ? m.content : m.content.map(blockText).filter(Boolean).join('\n'));

/** Rozmowa jako jeden prompt: przy jednej wiadomości sama treść, przy dłuższej zapis rozmowy. */
export function cliPrompt(messages: AMsg[]) {
  if (messages.length === 1) return msgText(messages[0]);
  const lines = messages.map((m) => `${m.role === 'user' ? 'Użytkownik' : 'Asystent'}:\n${msgText(m)}`);
  return `Rozmowa do tej pory:\n\n${lines.join('\n\n')}\n\nOdpowiedz na ostatnią wiadomość użytkownika (sam tekst odpowiedzi, bez prefiksu „Asystent:”).`;
}

let cliRuns = 0;
async function cli(p: Provider, model: string, o: CompleteOpts): Promise<CompleteResult> {
  const runId = `r${Date.now()}-${++cliRuns}`;
  // Przerwanie czatu kończy też proces narzędzia.
  const watch = o.signal && setInterval(() => { if (o.signal?.aborted) call('aicli_cancel', { runId }).catch(() => {}); }, 400);
  try {
    const r = await call<{ text: string; usage: any }>('aicli_run', {
      id: p.cli, model: model && model !== CLI_DEFAULT_MODEL ? model : null, system: o.system || null,
      prompt: cliPrompt(o.messages), account: p.account || null, runId,
    });
    recordUsage(p, { usage: r.usage });
    return { text: r.text, toolCalls: [], content: [{ type: 'text', text: r.text }], stop: 'end_turn', model };
  } finally { if (watch) clearInterval(watch); }
}

/** Błąd, po którym ma sens inny provider: limit zapytań, brak środków albo przeciążenie (nie zły klucz czy treść). */
export function isLimitError(e: unknown) {
  const s = String(e).replace(/^Error: /, '');
  return /^(429|402|503|529)\b/.test(s) || /rate.?limit|quota|insufficient.?(balance|funds|credit)|credit balance|overloaded/i.test(s);
}

/** Pierwszy wybór, a po nim łańcuch zastępstw z ustawień (bez powtórek i providerów bez czatu). */
export function fallbackChain(first: { p: Provider; model: string }) {
  const out = [first];
  if (!app.fallback?.enabled) return out;
  for (const f of app.fallback.chain) {
    const p = app.providers.find((x) => x.id === f.provider && isChat(x));
    const model = f.model || p?.models[0];
    if (!p || !model || out.some((x) => x.p.id === p.id && x.model === model)) continue;
    out.push({ p, model });
  }
  return out;
}

const fallbackNoted = new Map<string, number>();
/** Klucz (albo provider) z limitem odpoczywa minutę: kolejne kroki agenta idą od razu do następnego. */
const limitedUntil = new Map<string, number>();
const COOLDOWN = 60_000;
/** Do kiedy klucz odpoczywa po limicie (0 = dostępny); pokazuje to strona providerów. */
export function keyLimitedUntil(providerId: string, keyId: string) {
  let t = 0;
  for (const [k, v] of limitedUntil) if (k.startsWith(`${providerId}|${keyId}|`) && v > Date.now()) t = Math.max(t, v);
  return t;
}

interface Step { p: Provider; model: string; k: ProviderKey }

/** Kolejność prób: klucze pierwszego providera (wskazany albo wszystkie), potem zastępstwa z ich kluczami. */
function attempts(first: { p: Provider; model: string }, keyId?: string | null): Step[] {
  const out: Step[] = [];
  for (const [i, x] of fallbackChain(first).entries()) {
    const keys = usableKeys(x.p);
    const chosen = i === 0 && keyId ? keys.filter((k) => k.id === keyId) : [];
    for (const k of chosen.length ? chosen : keys) out.push({ ...x, k });
  }
  return out;
}

export async function complete(o: CompleteOpts): Promise<CompleteResult> {
  const first = resolveModel(o.providerId, o.model);
  o = { ...o, messages: await expandAttachments(o.messages) };
  // Ollama liczy na tej samej karcie co ComfyUI: przez wspólną kolejkę GPU (agenci, nody, snippety).
  const run = (s: Step) => onGpu(s.p.type === 'ollama' ? `ollama:${s.model}` : '', () => (s.p.type === 'cli' ? cli(s.p, s.model, o) : s.p.type === 'anthropic' ? anthropic(s.p, s.model, o, s.k.keyRef) : openai(s.p, s.model, o, s.k.keyRef)));
  const all = attempts(first, o.keyId);
  const id = (s: Step) => `${s.p.id}|${s.k.id}|${s.model}`;
  const resting = (s: Step) => (limitedUntil.get(id(s)) || 0) > Date.now();
  // Odpoczywający idą na koniec (nie wypadają: gdy wszyscy mają limit, i tak trzeba kogoś zapytać).
  const chain = all.length > 1 ? [...all.filter((s) => !resting(s)), ...all.filter(resting)] : all;
  const label = (s: Step) => `${s.p.name}${usableKeys(s.p).length > 1 ? ` (${s.k.name})` : ''} · ${s.model}`;
  let lastErr: unknown;
  for (const [i, s] of chain.entries()) {
    if (i > 0 && o.signal?.aborted) break;
    try {
      const r = await run(s);
      limitedUntil.delete(id(s));
      if (s !== all[0]) {
        // Raz na minutę na parę, żeby pętla agenta nie zasypała powiadomieniami.
        const k = `${id(all[0])}>${id(s)}`;
        if (Date.now() - (fallbackNoted.get(k) || 0) > 60_000) {
          fallbackNoted.set(k, Date.now());
          const sameProvider = s.p.id === all[0].p.id && s.model === all[0].model;
          notify(sameProvider
            ? `${all[0].p.name}: klucz „${all[0].k.name}” ma limit albo brak środków. Odpowiada klucz „${s.k.name}”.`
            : `${label(all[0])}: limit albo brak środków. Odpowiada zastępstwo ${label(s)}.`, 'warning', 6000);
        }
      }
      return r;
    } catch (e) {
      if (!isLimitError(e)) throw e;
      if (all.length > 1) limitedUntil.set(id(s), Date.now() + COOLDOWN);
      if (i === chain.length - 1) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Jedno pytanie, jedna odpowiedź tekstowa. */
export async function ask(prompt: string, opts: Omit<CompleteOpts, 'messages'> = {}) {
  const r = await complete({ ...opts, messages: [{ role: 'user', content: prompt }] });
  return r.text;
}

export async function listModels(p: Provider): Promise<string[]> {
  if (p.type === 'cli') return [CLI_DEFAULT_MODEL, ...(await call<string[]>('aicli_models', { id: p.cli })).filter((m) => m !== CLI_DEFAULT_MODEL)];
  if (p.type === 'anthropic') {
    const r: any = await call('ai_request', { provider: ref(p), method: 'GET', path: '/v1/models?limit=100', body: null, headers: null });
    return (r.data || []).map((m: any) => m.id);
  }
  if (p.type === 'ollama') {
    const r: any = await call('ai_request', { provider: ref(p), method: 'GET', path: '/api/tags', body: null, headers: null });
    return (r.models || []).map((m: any) => m.name);
  }
  if (p.type === 'fal') return [];
  if (p.type === 'comfy') {
    // Lokalny ComfyUI może być wyłączony: uruchomi się sam przy pierwszym nodzie, który go potrzebuje.
    try { await call('media_request', { provider: ref(p), method: 'GET', url: `${p.url.replace(/\/$/, '')}/system_stats`, body: null, multipart: null, headers: null }); }
    catch (e) { if (!app.local.comfyDir) throw e; }
    return [];
  }
  if (p.type === 'replicate') {
    await call('media_request', { provider: ref(p), method: 'GET', url: `${p.url.replace(/\/$/, '')}/account`, body: null, multipart: null, headers: null });
    return [];
  }
  if (p.type === 'google') {
    const r: any = await call('media_request', { provider: ref(p), method: 'GET', url: `${p.url.replace(/\/$/, '')}/v1beta/models?pageSize=200`, body: null, multipart: null, headers: null });
    return (r.models || []).filter((m: any) => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/.test(m.name)).map((m: any) => m.name.replace(/^models\//, '')).sort();
  }
  const r: any = await call('ai_request', { provider: ref(p), method: 'GET', path: '/models', body: null, headers: null });
  return (r.data || []).map((m: any) => m.id).sort();
}

/** Saldo konta tam, gdzie provider je udostępnia (OpenRouter: kredyty klucza, DeepSeek: saldo). */
export async function balanceOf(p: Provider): Promise<{ text: string; remaining: number | null; limit: number | null; currency: string } | null> {
  if (/openrouter\.ai/.test(p.url)) {
    const r: any = await call('ai_request', { provider: ref(p), method: 'GET', path: '/key', body: null, headers: null });
    const d = r.data || {};
    const rem = d.limit_remaining ?? (d.limit != null ? d.limit - (d.usage || 0) : null);
    return { text: rem != null ? `$${Number(rem).toFixed(2)}` : `zużyto $${Number(d.usage || 0).toFixed(2)}`, remaining: rem, limit: d.limit ?? null, currency: 'USD' };
  }
  if (/deepseek\.com/.test(p.url)) {
    const r: any = await call('ai_request', { provider: ref(p), method: 'GET', path: '/user/balance', body: null, headers: null });
    const b = (r.balance_infos || [])[0];
    return b ? { text: `${Number(b.total_balance).toFixed(2)} ${b.currency}`, remaining: Number(b.total_balance), limit: null, currency: b.currency } : null;
  }
  return null;
}

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\r/g, '');
