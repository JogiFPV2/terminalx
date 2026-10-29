// Zużycie tokenów: liczenie z odpowiedzi providerów i odczyt limitów z nagłówków (czyste funkcje, bez stanu).

export interface Limit { limit: number; remaining: number; reset: number }
/** Limity z ostatniej odpowiedzi: okno tokenów (łącznie, wejście, wyjście) i zapytań. */
export interface Limits { tokens?: Limit; input?: Limit; output?: Limit; requests?: Limit; at: number }
export interface ProviderUsage {
  day: string; dayIn: number; dayOut: number;
  month: string; monthIn: number; monthOut: number;
  totalIn: number; totalOut: number; calls: number;
  limits?: Limits;
  last: number;
}

export const dayKey = (t = Date.now()) => new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export const monthKey = (t = Date.now()) => dayKey(t).slice(0, 7);

export function emptyUsage(now = Date.now()): ProviderUsage {
  return { day: dayKey(now), dayIn: 0, dayOut: 0, month: monthKey(now), monthIn: 0, monthOut: 0, totalIn: 0, totalOut: 0, calls: 0, last: 0 };
}

/** Liczba tokenów z pola `usage` odpowiedzi (Anthropic: input/output + cache, OpenAI: prompt/completion). */
export function tokensOf(usage: any): { input: number; output: number } | null {
  if (!usage || typeof usage !== 'object') return null;
  const n = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0);
  if ('input_tokens' in usage || 'output_tokens' in usage) {
    return { input: n(usage.input_tokens) + n(usage.cache_creation_input_tokens) + n(usage.cache_read_input_tokens), output: n(usage.output_tokens) };
  }
  if ('prompt_tokens' in usage || 'completion_tokens' in usage) return { input: n(usage.prompt_tokens), output: n(usage.completion_tokens) };
  return null;
}

/** Dolicza zapytanie; nowy dzień albo miesiąc zeruje odpowiedni licznik. */
export function addUsage(u: ProviderUsage, t: { input: number; output: number }, now = Date.now()): ProviderUsage {
  const d = dayKey(now), m = monthKey(now);
  if (u.day !== d) { u.day = d; u.dayIn = 0; u.dayOut = 0; }
  if (u.month !== m) { u.month = m; u.monthIn = 0; u.monthOut = 0; }
  u.dayIn += t.input; u.dayOut += t.output;
  u.monthIn += t.input; u.monthOut += t.output;
  u.totalIn += t.input; u.totalOut += t.output;
  u.calls++;
  u.last = now;
  return u;
}

/** Czas do resetu z OpenAI („6m0s”, „1.5s”, „20ms”) albo data ISO z Anthropic → znacznik czasu. */
export function resetAt(v: string, now = Date.now()): number {
  if (!v) return 0;
  if (/^\d{4}-\d\d-\d\dT/.test(v)) { const t = Date.parse(v); return isNaN(t) ? 0 : t; }
  let ms = 0, any = false;
  for (const [, num, unit] of v.matchAll(/([\d.]+)(ms|h|m|s)/g)) {
    any = true;
    ms += parseFloat(num) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 } as Record<string, number>)[unit];
  }
  return any ? now + ms : 0;
}

/** Nagłówki rate limit → limity. Brak pełnej pary limit/pozostało pomija dane okno. */
export function parseLimits(h: Record<string, string> | undefined, now = Date.now()): Limits | null {
  if (!h) return null;
  const num = (k: string) => { const v = h[k]; const x = v == null ? NaN : Number(v); return isFinite(x) ? x : null; };
  const one = (limit: string, remaining: string, reset: string): Limit | undefined => {
    const l = num(limit), r = num(remaining);
    return l != null && r != null ? { limit: l, remaining: r, reset: resetAt(h[reset] || '', now) } : undefined;
  };
  const out: Limits = { at: now };
  const a = (w: string) => one(`anthropic-ratelimit-${w}-limit`, `anthropic-ratelimit-${w}-remaining`, `anthropic-ratelimit-${w}-reset`);
  out.tokens = a('tokens') || one('x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens');
  out.input = a('input-tokens');
  out.output = a('output-tokens');
  out.requests = a('requests') || one('x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests');
  for (const k of ['tokens', 'input', 'output', 'requests'] as const) if (!out[k]) delete out[k];
  return Object.keys(out).length > 1 ? out : null;
}
