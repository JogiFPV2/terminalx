// Wspólna logika nodów workflow (komputer i telefon).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evalCond, jsonPath, topoOrder, htmlText } from '../src/lib/workflow/logic.ts';

test('warunki noda „Warunek”', () => {
  assert.equal(evalCond('exit == 0', '', 0), true);
  assert.equal(evalCond('exit != 0', '', 0), false);
  assert.equal(evalCond('contains: ERROR', 'build ERROR x', undefined), true);
  assert.equal(evalCond('!contains: ERROR', 'ok', undefined), true);
  assert.equal(evalCond('matches: \\d+ failed', '3 failed', undefined), true);
  assert.equal(evalCond('matches: (', 'x', undefined), false, 'zły regex to fałsz');
  assert.equal(evalCond('empty', '  ', undefined), true);
  assert.equal(evalCond('!empty', 'a', undefined), true);
});

test('JSON path', () => {
  assert.equal(jsonPath('{"items":[{"name":"a"},{"name":"b"}]}', 'items.1.name'), 'b');
  assert.equal(jsonPath('{"a":[1,{"b":2}]}', '$.a[1].b'), '2');
});

test('kolejność topologiczna i cykle', () => {
  const r = topoOrder(['a', 'b', 'c', 'x', 'y'], [['a', 'b'], ['b', 'c'], ['x', 'y'], ['y', 'x']]);
  assert.deepEqual(r.order, ['a', 'b', 'c']);
  assert.deepEqual(r.cyclic, ['x', 'y']);
});

test('tekst ze strony', () => {
  assert.equal(htmlText('<html><style>p{}</style><p>Ala&nbsp;ma <b>kota</b></p><script>x()</script></html>'), 'Ala ma kota');
});
