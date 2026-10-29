// Licznik tokenów i limity z nagłówków providerów (plugin Quota). Uruchomienie: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokensOf, addUsage, emptyUsage, parseLimits, resetAt } from '../src/lib/usage.ts';

test('tokeny z odpowiedzi Anthropic (z cache) i OpenAI', () => {
  assert.deepEqual(tokensOf({ input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 20 }), { input: 160, output: 20 });
  assert.deepEqual(tokensOf({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }), { input: 7, output: 3 });
  assert.equal(tokensOf(undefined), null);
  assert.equal(tokensOf({ foo: 1 }), null);
});

test('licznik dzienny i miesięczny zeruje się z nowym okresem', () => {
  const d1 = Date.parse('2026-10-30T12:00:00'), d2 = Date.parse('2026-10-31T12:00:00'), d3 = Date.parse('2026-11-01T12:00:00');
  const u = emptyUsage(d1);
  addUsage(u, { input: 10, output: 5 }, d1);
  addUsage(u, { input: 1, output: 1 }, d2);
  assert.equal(u.dayIn + u.dayOut, 2);
  assert.equal(u.monthIn + u.monthOut, 17);
  addUsage(u, { input: 3, output: 0 }, d3);
  assert.equal(u.monthIn + u.monthOut, 3);
  assert.equal(u.totalIn + u.totalOut, 20);
  assert.equal(u.calls, 3);
});

test('limity Anthropic z nagłówków', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  const l = parseLimits({
    'anthropic-ratelimit-input-tokens-limit': '2000000', 'anthropic-ratelimit-input-tokens-remaining': '1990000', 'anthropic-ratelimit-input-tokens-reset': '2026-10-30T12:00:30Z',
    'anthropic-ratelimit-output-tokens-limit': '400000', 'anthropic-ratelimit-output-tokens-remaining': '399000', 'anthropic-ratelimit-output-tokens-reset': '2026-10-30T12:00:10Z',
    'anthropic-ratelimit-requests-limit': '4000', 'anthropic-ratelimit-requests-remaining': '3999', 'anthropic-ratelimit-requests-reset': '2026-10-30T12:00:01Z',
  }, now)!;
  assert.deepEqual(l.input, { limit: 2000000, remaining: 1990000, reset: now + 30000 });
  assert.equal(l.output!.remaining, 399000);
  assert.equal(l.requests!.limit, 4000);
  assert.equal(l.tokens, undefined);
});

test('limity OpenAI z nagłówków i czas resetu', () => {
  const now = 1_000_000;
  const l = parseLimits({ 'x-ratelimit-limit-tokens': '30000', 'x-ratelimit-remaining-tokens': '29000', 'x-ratelimit-reset-tokens': '2s', 'x-ratelimit-limit-requests': '500', 'x-ratelimit-remaining-requests': '499', 'x-ratelimit-reset-requests': '120ms' }, now)!;
  assert.deepEqual(l.tokens, { limit: 30000, remaining: 29000, reset: now + 2000 });
  assert.equal(l.requests!.reset, now + 120);
  assert.equal(resetAt('6m0s', 0), 360000);
  assert.equal(resetAt('1h2m', 0), 3720000);
  assert.equal(parseLimits({}, now), null);
  assert.equal(parseLimits({ 'x-ratelimit-limit-tokens': '10' }, now), null);
});
