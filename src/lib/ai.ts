// Wspólny klient dla providerów: Anthropic (Messages API) i zgodnych z OpenAI (OpenAI, OpenRouter, LM Studio, Ollama /v1).
// Historia rozmowy jest trzymana w formacie bloków Anthropic; dla OpenAI konwertujemy w locie.
import { call } from './ipc';
import { app } from './state.svelte';
import { isChat } from './defaults';
import { onGpu } from './gpu';
import type { Provider } from './types';
import { emptyUsage, addUsage, tokensOf, parseLimits } from './usage';

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
  signal?: { aborted: boolean };
}
export interface CompleteResult { text: string; toolCalls: ToolCall[]; content: Block[]; stop: string; model: string }

export function resolveModel(providerId?: string | null, model?: string | null): { p: Provider; model: string } {
  // Bez wskazanego providera obowiązuje para „domyślny provider + domyślny model” z ustawień.
  const explicit = providerId ? app.providers.find((x) => x.id === providerId && isChat(x)) : undefined;
  const p = explicit || app.providers.find((x) => x.id === app.defModel.provider) || app.providers.find(isChat);
  if (!p) throw new Error('Brak skonfigurowanych providerów. Dodaj providera w Ustawienia → Providerzy.');
  const m = explicit ? (model || p.models[0] || app.defModel.model) : (p.id === app.defModel.provider ? app.defModel.model : p.models[0]);
  return { p, model: m };
}

const ref = (p: Provider) => ({ type: p.type, url: p.url, keyRef: p.keyRef });

function openaiPath(p: Provider) { return p.type === 'ollama' ? '/v1/chat/completions' : p.type === 'google' ? '/v1beta/openai/chat/completions' : '/chat/completions'; }

/* ---------- Anthropic ---------- */

async function anthropic(p: Provider, model: string, o: CompleteOpts): Promise<CompleteResult> {
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
      provider: ref(p), method: 'POST', path: '/v1/messages',
      body: useFallback ? { ...body, fallbacks: 'default' } : body,
      headers: useFallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : null,
    });
  } catch (e) {
    if (useFallback && /fallback|beta/i.test(String(e))) {
      res = await call('ai_request', { provider: ref(p), method: 'POST', path: '/v1/messages', body, headers: null });
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

function toOpenAi(messages: AMsg[], system?: string) {
  const out: any[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      for (const b of m.content.filter((b) => b.type === 'tool_result')) {
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
      }
      const imgs = m.content.filter((b) => b.type === 'image' && b.source?.type === 'base64');
      if (imgs.length) out.push({ role: 'user', content: [...imgs.map((b) => ({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } })), { type: 'text', text }] });
      else if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

async function openai(p: Provider, model: string, o: CompleteOpts): Promise<CompleteResult> {
  const body: Record<string, unknown> = { model, messages: toOpenAi(o.messages, o.system), max_tokens: o.maxTokens || 4096 };
  if (o.temperature != null) body.temperature = o.temperature;
  if (o.topP != null) body.top_p = o.topP;
  if (o.json) body.response_format = { type: 'json_object' };
  if (o.tools?.length) body.tools = o.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const res: any = await call('ai_request', { provider: ref(p), method: 'POST', path: openaiPath(p), body, headers: null });
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

export async function complete(o: CompleteOpts): Promise<CompleteResult> {
  const { p, model } = resolveModel(o.providerId, o.model);
  // Ollama liczy na tej samej karcie co ComfyUI: przez wspólną kolejkę GPU (agenci, nody, snippety).
  return onGpu(p.type === 'ollama' ? `ollama:${model}` : '', () => (p.type === 'anthropic' ? anthropic(p, model, o) : openai(p, model, o)));
}

/** Jedno pytanie, jedna odpowiedź tekstowa. */
export async function ask(prompt: string, opts: Omit<CompleteOpts, 'messages'> = {}) {
  const r = await complete({ ...opts, messages: [{ role: 'user', content: prompt }] });
  return r.text;
}

export async function listModels(p: Provider): Promise<string[]> {
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
