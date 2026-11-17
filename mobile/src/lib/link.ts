// Połączenie aplikacji na Androida z Hermitty na komputerze (protokół z src-tauri/src/remote.rs).
// Powitanie jawne (wyzwania obu stron), potem każda ramka szyfrowana kluczem sesji z licznikiem.
// Parowanie: link z kodu QR (http://adres:port/#p=…&k=…) → komputer pyta użytkownika → „paired” z id urządzenia.
import { Dir, b64, unb64, sessionKey, randomBytes, parsePairLink } from '../../../src/lib/remote-crypto.ts';

export interface SavedPc {
  /** Id urządzenia nadane przez komputer przy parowaniu. */
  device: string;
  /** Adres serwera zdalnego dostępu, np. http://192.168.1.24:7420 */
  url: string;
  /** Klucz urządzenia (base64, 32 bajty). */
  key: string;
  name: string;
  added: number;
  lastSeen?: number;
}

export type LinkState = 'idle' | 'connecting' | 'waiting' | 'ready' | 'denied' | 'error' | 'offline';

type Pending = { res: (v: any) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export interface LinkEvents {
  state: (s: LinkState, info: { perm?: string; error?: string }) => void;
  ev: (name: string, data: any) => void;
  /** Parowanie zakończone: komputer nadał id urządzenia. */
  paired: (pc: SavedPc) => void;
  /** Komputer nie zna już tego urządzenia (odwołane na komputerze). */
  forgotten: () => void;
}

const wsUrl = (url: string) => url.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';

export class Link {
  state: LinkState = 'idle';
  perm = 'view';
  error = '';
  private ws: WebSocket | null = null;
  private tx: Dir | null = null;
  private rx: Dir | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  private pc: SavedPc | { url: string; key: string; pair: string; name: string };
  private on: Partial<LinkEvents>;
  private deviceName: string;
  constructor(pc: SavedPc | { url: string; key: string; pair: string; name: string }, on: Partial<LinkEvents>, deviceName = 'Android') {
    this.pc = pc; this.on = on; this.deviceName = deviceName;
  }

  /** Parowanie z tekstu zeskanowanego z kodu QR albo wklejonego linku. */
  static fromPairLink(text: string, on: Partial<LinkEvents>, deviceName?: string): Link | null {
    const p = parsePairLink(text);
    if (!p) return null;
    return new Link({ url: p.url, key: p.key, pair: p.pair, name: new URL(p.url).hostname }, on, deviceName);
  }

  private set(s: LinkState, error = '') {
    this.state = s; this.error = error;
    this.on.state?.(s, { perm: this.perm, error });
  }

  connect() {
    this.closed = false;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.ws?.close();
    this.tx = this.rx = null;
    this.set('connecting');
    const key = unb64(this.pc.key);
    const pairing = 'pair' in this.pc;
    let sock: WebSocket;
    try { sock = new WebSocket(wsUrl(this.pc.url)); } catch (e) { this.set('error', String(e)); return; }
    this.ws = sock;
    sock.onmessage = (m) => {
      if (sock !== this.ws || typeof m.data !== 'string') return;
      // Po powitaniu wszystko jest szyfrowane; jawne są tylko „hi” i błędy przed uwierzytelnieniem.
      const plain = this.rx ? this.rx.open(m.data) : null;
      let msg: any;
      try { msg = JSON.parse(plain ?? m.data); } catch { return; }
      if (plain === null && msg.t === 'hi' && !this.tx) {
        // Przy parowaniu nazwa komputera z powitania zastępuje adres IP.
        if (pairing && typeof msg.name === 'string' && msg.name.trim()) (this.pc as { name: string }).name = msg.name.trim().slice(0, 40);
        const cs = unb64(msg.c), cc = randomBytes(16);
        this.tx = new Dir(sessionKey(key, 'c2s', cs, cc));
        this.rx = new Dir(sessionKey(key, 's2c', cs, cc));
        const hello = pairing
          ? { t: 'pair', v: 2, pair: (this.pc as { pair: string }).pair, name: this.deviceName, c: b64(cc) }
          : { t: 'hello', v: 2, device: (this.pc as SavedPc).device, c: b64(cc) };
        sock.send(JSON.stringify(hello));
        sock.send(this.tx.seal(JSON.stringify({ t: 'auth', ts: Date.now() })));
        return;
      }
      if (plain === null && msg.t !== 'error') return;
      this.handle(msg);
    };
    sock.onclose = () => {
      if (sock !== this.ws) return;
      this.failAll('Połączenie przerwane');
      const was = this.state;
      if (this.closed || was === 'denied' || was === 'error') return;
      // Ponawianie z rosnącą przerwą (telefon zmienił sieć, komputer uśpiony).
      this.set('offline');
      if ('pair' in this.pc) return;
      this.retry = Math.min(this.retry + 1, 6);
      this.retryTimer = setTimeout(() => this.connect(), 500 * 2 ** this.retry);
    };
    sock.onerror = () => { /* onclose zajmie się resztą */ };
  }

  private handle(m: any) {
    switch (m.t) {
      case 'error':
        if (/Nieznane urządzenie/.test(m.msg)) this.on.forgotten?.();
        this.set('error', m.msg || 'Błąd połączenia');
        this.ws?.close();
        return;
      case 'waiting': this.set('waiting'); return;
      case 'denied': this.set('denied', 'Komputer nie zgodził się na to urządzenie.'); return;
      case 'paired': {
        const p = this.pc as { url: string; key: string; name: string };
        const saved: SavedPc = { device: m.device, url: p.url, key: p.key, name: p.name, added: Date.now(), lastSeen: Date.now() };
        this.pc = saved;
        this.on.paired?.(saved);
        return;
      }
      case 'ready': this.retry = 0; this.perm = m.perm || 'view'; this.set('ready'); return;
      case 'res': {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id); clearTimeout(p.timer);
        m.ok ? p.res(m.r) : p.rej(new Error(m.error || 'Błąd'));
        return;
      }
      case 'ev': this.on.ev?.(m.e, m.d); return;
    }
  }

  /** Zapytanie do komputera; odpowiedź albo błąd (także brak uprawnień urządzenia). */
  req<T = any>(m: string, p: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    return new Promise((res, rej) => {
      if (this.state !== 'ready' || !this.tx || !this.ws) { rej(new Error('Brak połączenia z komputerem')); return; }
      const id = ++this.seq;
      const timer = setTimeout(() => { if (this.pending.delete(id)) rej(new Error('Komputer nie odpowiedział')); }, timeoutMs);
      this.pending.set(id, { res, rej, timer });
      this.ws.send(this.tx.seal(JSON.stringify({ t: 'req', id, m, p })));
    });
  }

  private failAll(why: string) {
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.rej(new Error(why)); this.pending.delete(id); }
  }

  close() {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.failAll('Rozłączono');
    this.ws?.close();
    this.ws = null;
    this.set('idle');
  }
}
