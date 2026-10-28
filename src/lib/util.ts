let seq = 0;
export const nid = (p = 'i') => `${p}${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const ago = (ms: number) => { const m = Math.floor(ms / 60e3); return m < 1 ? 'teraz' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
export function slug(text: string) {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}
export function moveItem<T>(arr: T[], from: number, to: number) { arr.splice(to, 0, arr.splice(from, 1)[0]); }
/** Wspólne przeciąganie: ruch myszy aż do puszczenia przycisku. */
export function track(move: (e: PointerEvent) => void, done: (e: PointerEvent) => void = () => {}) {
  const up = (e: PointerEvent) => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
    document.documentElement.classList.remove('resizing');
    done(e);
  };
  document.documentElement.classList.add('resizing');
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
}
export function fill(template: string, vars: Record<string, string>) {
  return template.replace(/\{\{\s*([\w.:-]+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}
