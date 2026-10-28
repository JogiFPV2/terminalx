// Słownik tłumaczeń: poprawny JSON, te same znaczniki {n} po obu stronach wzorców, brak pustych tłumaczeń.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../src/lib/i18n/', import.meta.url);
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  test(`słownik ${file}`, () => {
    const d = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    for (const [k, v] of Object.entries<string>(d.exact)) assert.ok(v.trim(), `puste tłumaczenie: ${k}`);
    for (const [from, to] of d.patterns as [string, string][]) {
      const marks = (s: string) => (s.match(/\{\d\}/g) || []).sort().join();
      assert.equal(marks(from), marks(to), `znaczniki we wzorcu: ${from}`);
      assert.ok(/\{\d\}/.test(from), `wzorzec bez znacznika (powinien być w exact): ${from}`);
    }
  });
}
