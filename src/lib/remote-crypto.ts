// Kanał zdalnego dostępu po stronie telefonu (aplikacja Hermitty na Androida). Ten sam algorytm co
// src-tauri/src/remote_crypto.rs i klient w src-tauri/remote/index.html: klucz kierunku =
// HMAC-SHA512(klucz urządzenia, etykieta ‖ wyzwanie komputera ‖ wyzwanie telefonu)[0..32],
// nonce = licznik ramek (big-endian w ostatnich 8 bajtach), szyfr XSalsa20-Poly1305 (nacl.secretbox).
// Testy zgodności: tests/remote-crypto.test.ts
import nacl from 'tweetnacl';

const te = new TextEncoder(), td = new TextDecoder();

export const b64 = (u: Uint8Array) => { let s = ''; u.forEach((x) => (s += String.fromCharCode(x))); return btoa(s); };
export const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

const cat = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

export function hmac512(key: Uint8Array, msg: Uint8Array) {
  const kp = new Uint8Array(128);
  kp.set(key.length > 128 ? nacl.hash(key) : key);
  return nacl.hash(cat(kp.map((x) => x ^ 0x5c), nacl.hash(cat(kp.map((x) => x ^ 0x36), msg))));
}

export const sessionKey = (base: Uint8Array, label: string, cs: Uint8Array, cc: Uint8Array) => hmac512(base, cat(cat(te.encode(label), cs), cc)).slice(0, 32);

function nonceOf(n: number) {
  const b = new Uint8Array(24);
  for (let i = 23; i >= 16; i--) { b[i] = n % 256; n = Math.floor(n / 256); }
  return b;
}

/** Jeden kierunek kanału: klucz i licznik ramek. */
export class Dir {
  n = 0;
  private k: Uint8Array;
  constructor(k: Uint8Array) { this.k = k; }
  seal(text: string) { return b64(nacl.secretbox(te.encode(text), nonceOf(this.n++), this.k)); }
  /** Ramka o oczekiwanym numerze albo null (powtórzona, przestawiona, podrobiona); licznik rośnie tylko po sukcesie. */
  open(frame: string): string | null {
    let raw: Uint8Array;
    try { raw = unb64(frame); } catch { return null; }
    const p = nacl.secretbox.open(raw, nonceOf(this.n), this.k);
    if (!p) return null;
    this.n++;
    return td.decode(p);
  }
}

export const randomBytes = (n: number) => nacl.randomBytes(n);

/** Link z kodu QR na komputerze: http://adres:port/#p=<para>&k=<klucz>. */
/** Link z kodu QR: adres główny, id parowania, klucz i adresy zapasowe komputera (`a=ip:port,…`). */
export function parsePairLink(text: string): { url: string; pair: string; key: string; alts: string[] } | null {
  const m = text.trim().match(/^(https?):\/\/([^/#\s]+)\/?#(.+)$/);
  if (!m) return null;
  const h = new URLSearchParams(m[3]);
  const pair = h.get('p'), key = h.get('k');
  if (!pair || !key) return null;
  try { if (unb64(key).length !== 32) return null; } catch { return null; }
  const alts = (h.get('a') || '').split(',').map((x) => x.trim()).filter((x) => /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(x) && x !== m[2]).slice(0, 8).map((x) => `${m[1]}://${x}`);
  return { url: `${m[1]}://${m[2]}`, pair, key, alts };
}
