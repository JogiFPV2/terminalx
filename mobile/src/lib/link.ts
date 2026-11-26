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
  /** Pozostałe adresy komputera (np. druga karta sieciowa); próbowane razem z głównym. */
  alts?: string[];
  added: number;
  lastSeen?: number;
}

export type LinkState = 'idle' | 'connecting' | 'waiting' | 'ready' | 'denied' | 'error' | 'offline';

type PairTarget = { url: string; key: string; pair: string; name: string; alts?: string[] };
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

  private pc: SavedPc | PairTarget;
  private on: Partial<LinkEvents>;
  private deviceName: string;
  constructor(pc: SavedPc | PairTarget, on: Partial<LinkEvents>, deviceName = 'Android') {
    this.pc = pc; this.on = on; this.deviceName = deviceName;
  }

  /** Parowanie z tekstu zeskanowanego z kodu QR albo wklejonego linku. */
  static fromPairLink(text: string, on: Partial<LinkEvents>, deviceName?: string): Link | null {
    const p = parsePairLink(text);
    if (!p) return null;
    return new Link({ url: p.url, key: p.key, pair: p.pair, name: new URL(p.url).hostname, alts: p.alts }, on, deviceName);
  }

  private set(s: LinkState, error = '') {
    this.state = s; this.error = error;
    this.on.state?.(s, { perm: this.perm, error });
  }

  private probes: WebSocket[] = [];
  private hiTimer: ReturnType<typeof setTimeout> | null = null;

  /** Łączy się ze wszystkimi znanymi adresami naraz; zostaje przy pierwszym, który przyśle powitanie. */
  connect() {
    this.closed = false;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.dropProbes();
    this.ws?.close();
    this.ws = null;
    this.tx = this.rx = null;
    this.set('connecting');
    const key = unb64(this.pc.key);
    const pairing = 'pair' in this.pc;
    const urls = [...new Set([this.pc.url, ...(this.pc.alts || [])])];
    let failed = 0;
    const dead = new Set<WebSocket>();
    // Adres, który nie odpowiedział (błąd albo zamknięcie, co pierwsze); gdy żaden nie zostanie, od razu komunikat.
    const lost = (sock: WebSocket) => {
      if (this.ws || dead.has(sock) || this.probes.indexOf(sock) < 0) return;
      dead.add(sock);
      if (++failed >= urls.length) giveUp(unreachable());
    };
    const giveUp = (why: string) => {
      this.dropProbes();
      if (this.hiTimer) { clearTimeout(this.hiTimer); this.hiTimer = null; }
      if (pairing) { this.set('error', why); return; }
      this.set('offline', why);
      this.retry = Math.min(this.retry + 1, 6);
      this.retryTimer = setTimeout(() => this.connect(), 500 * 2 ** this.retry);
    };
    const unreachable = () => `Nie mogę połączyć się z komputerem (${urls.map((u) => u.replace(/^https?:\/\//, '')).join(', ')}). Sprawdź, czy telefon jest w tej samej sieci Wi-Fi, czy aplikacja ma zgodę na sieć lokalną (Android 17: Ustawienia → Aplikacje → Hermitty → Uprawnienia → Urządzenia w pobliżu), czy w Hermitty jest włączony Zdalny dostęp i czy Zapora Windows go nie blokuje (Ustawienia → Zdalny dostęp → „Telefon nie może się połączyć?”).`;
    this.hiTimer = setTimeout(() => { if (!this.ws) giveUp(unreachable()); }, 9000);

    for (const url of urls) {
      let sock: WebSocket;
      try { sock = new WebSocket(wsUrl(url)); } catch { failed++; continue; }
      this.probes.push(sock);
      sock.onmessage = (m) => {
        if (typeof m.data !== 'string') return;
        if (!this.ws) {
          // Pierwszy adres, który odpowiedział, wygrywa; pozostałe zamykamy, a ten zostaje głównym.
          if (this.closed || this.probes.indexOf(sock) < 0) return;
          this.ws = sock;
          this.probes = this.probes.filter((p) => p !== sock);
          this.dropProbes();
          if (this.hiTimer) { clearTimeout(this.hiTimer); this.hiTimer = null; }
          if (url !== this.pc.url) { this.pc.alts = urls.filter((u) => u !== url); this.pc.url = url; }
        }
        if (sock !== this.ws) return;
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
            ? { t: 'pair', v: 2, pair: (this.pc as PairTarget).pair, name: this.deviceName, c: b64(cc) }
            : { t: 'hello', v: 2, device: (this.pc as SavedPc).device, c: b64(cc) };
          sock.send(JSON.stringify(hello));
          sock.send(this.tx.seal(JSON.stringify({ t: 'auth', ts: Date.now() })));
          return;
        }
        if (plain === null && msg.t !== 'error') return;
        this.handle(msg);
      };
      sock.onclose = () => {
        if (sock !== this.ws) { lost(sock); return; }
        this.failAll('Połączenie przerwane');
        const was = this.state;
        this.ws = null;
        if (this.closed || was === 'denied' || was === 'error') return;
        // Ponawianie z rosnącą przerwą (telefon zmienił sieć, komputer uśpiony).
        if ('pair' in this.pc) { this.set('error', 'Połączenie przerwane podczas parowania. Spróbuj jeszcze raz.'); return; }
        giveUp('Połączenie przerwane, ponawiam…');
      };
      sock.onerror = () => { if (sock !== this.ws) lost(sock); };
    }
    if (failed >= urls.length) giveUp(unreachable());
  }

  private dropProbes() {
    for (const p of this.probes) { p.onmessage = p.onclose = p.onerror = null; try { p.close(); } catch { /* nic */ } }
    this.probes = [];
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
        const p = this.pc as PairTarget;
        const saved: SavedPc = { device: m.device, url: p.url, key: p.key, name: p.name, alts: p.alts, added: Date.now(), lastSeen: Date.now() };
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
    if (this.hiTimer) clearTimeout(this.hiTimer);
    this.dropProbes();
    this.failAll('Rozłączono');
    this.ws?.close();
    this.ws = null;
    this.set('idle');
  }
}
