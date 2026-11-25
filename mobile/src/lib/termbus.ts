// Szyna terminali zakładek telefonu: wyjście (dla agenta i nodów „Czekaj na wyjście”) i wejście (wpisywanie do zakładki).
// Ostatnie 64 kB wyjścia każdej zakładki zostaje w pamięci do odczytu przez agenta.

type Cb = (data: string) => void;

function bus() {
  const subs = new Map<string, Set<Cb>>();
  return {
    on(id: string, cb: Cb) { let s = subs.get(id); if (!s) subs.set(id, (s = new Set())); s.add(cb); return () => { s!.delete(cb); }; },
    emit(id: string, data: string) { subs.get(id)?.forEach((cb) => cb(data)); },
    has(id: string) { return (subs.get(id)?.size || 0) > 0; },
  };
}

export const outputs = bus();
export const inputs = bus();

const tails = new Map<string, string>();
const MAX = 64 * 1024;
const record = (id: string, d: string) => { const t = (tails.get(id) || '') + d; tails.set(id, t.length > MAX ? t.slice(-MAX) : t); };
const origEmit = outputs.emit;
outputs.emit = (id: string, data: string) => { record(id, data); origEmit(id, data); };

/** Ostatnie wyjście zakładki bez kodów ANSI. */
export const tail = (id: string, n = 4000) => stripAnsi(tails.get(id) || '').slice(-n);

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\r/g, '');
