// Klient zdalnego dostępu (src-tauri/remote/index.html) i rdzeń (remote_crypto.rs) muszą liczyć te same klucze sesji
// i ramki. Test wyciąga kod kryptografii ze strony (między znacznikami remote-crypto) i sprawdza go z tweetnacl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import nacl from 'tweetnacl';

const html = readFileSync(new URL('../src-tauri/remote/index.html', import.meta.url), 'utf8');
const src = html.match(/\/\/ remote-crypto:start[^\n]*\n([\s\S]*?)\/\/ remote-crypto:end/)![1];
const te = new TextEncoder(), td = new TextDecoder();
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const c = new Function('nacl', 'te', 'td', 'b64', 'unb64', `${src}; return { sessionKey, sealDir, openDir };`)(nacl, te, td, b64, unb64);
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

test('klucz sesji klienta = wektor z testu Rusta (HMAC-SHA512)', () => {
  const k = c.sessionKey(new Uint8Array(32).fill(7), 'c2s', new Uint8Array(16).fill(1), new Uint8Array(16).fill(2));
  assert.equal(hex(k), readFileSync(new URL('./remote-crypto.c2s.hex', import.meta.url), 'utf8').trim());
});

test('HMAC klienta zgadza się z node:crypto dla różnych danych', () => {
  for (const n of [0, 5, 31, 100]) {
    const base = nacl.randomBytes(32), cs = nacl.randomBytes(16), cc = nacl.randomBytes(16);
    const label = 's2c'.repeat(n % 3 + 1);
    const want = createHmac('sha512', base).update(Buffer.concat([Buffer.from(label), cs, cc])).digest().subarray(0, 32);
    assert.equal(hex(c.sessionKey(base, label, cs, cc)), want.toString('hex'));
  }
});

test('ramki z licznikiem: kolejność, powtórzenie i liczniki powyżej 255', () => {
  const k = nacl.randomBytes(32);
  const a = { k, n: 0 }, b = { k, n: 0 };
  const frames = Array.from({ length: 300 }, (_, i) => c.sealDir(a, `ramka ${i}`));
  assert.equal(c.openDir(b, frames[1]), null, 'przestawiona ramka');
  for (let i = 0; i < 300; i++) assert.equal(c.openDir(b, frames[i]), `ramka ${i}`);
  assert.equal(c.openDir(b, frames[299]), null, 'powtórzona ramka');
  assert.equal(c.openDir(b, 'to nie jest base64!'), null);
});

test('nonce: licznik big-endian w ostatnich 8 bajtach (jak w Ruście)', () => {
  const k = nacl.randomBytes(32);
  const frame = c.sealDir({ k, n: 258 }, 'x');
  const nonce = new Uint8Array(24); nonce[22] = 1; nonce[23] = 2;
  assert.equal(td.decode(nacl.secretbox.open(unb64(frame), nonce, k)!), 'x');
});
