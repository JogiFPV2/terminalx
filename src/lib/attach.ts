// Załączniki wiadomości do agentów: obrazy (zmniejszane), wideo (klatki), PDF, pliki tekstowe i inne pliki.
// Na dysk trafia kopia w `attachments/<rozmowa>/`; w historii rozmowy zostaje tylko blok `attachment`
// ze ścieżką, a treść (base64) jest wczytywana dopiero przy wysyłce do providera.
import { call } from './ipc';
import type { Att } from './types';
import type { Block, AMsg } from './ai';

const IMG_MAX = 1568;            // dłuższy bok obrazu (powyżej modele i tak zmniejszają)
const FRAME_MAX = 768;
const TEXT_MAX = 150_000;        // znaków pliku tekstowego w treści wiadomości
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonc|ya?ml|toml|ini|cfg|conf|env|log|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|svelte|vue|py|rb|go|rs|java|kt|kts|scala|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|psm1|bat|cmd|sql|graphql|proto|lua|r|swift|dart|ex|exs|erl|hs|ml|clj|tf|hcl|gradle|properties|dockerfile|gitignore|editorconfig|srt|vtt)$/i;

export const fmtSize = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

export function b64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

const save = async (chat: string, name: string, blob: Blob) => call<string>('att_save', { chat, name, data: await b64(blob) });

function canvasBlob(src: CanvasImageSource, w: number, h: number, max: number, q = 0.85): Promise<Blob> {
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);   // JPEG nie ma przezroczystości
  g.drawImage(src, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Nie udało się zapisać obrazu'))), 'image/jpeg', q));
}

async function image(file: File, chat: string): Promise<Att> {
  const bmp = await createImageBitmap(file);
  const ok = /^image\/(png|jpeg|gif|webp)$/.test(file.type) && Math.max(bmp.width, bmp.height) <= IMG_MAX && file.size < 3_500_000;
  const blob = ok ? file : await canvasBlob(bmp, bmp.width, bmp.height, IMG_MAX);
  bmp.close();
  const name = ok ? file.name || 'obraz.png' : (file.name || 'obraz').replace(/\.[^.]+$/, '') + '.jpg';
  return { kind: 'image', name, path: await save(chat, name, blob), size: blob.size, mime: ok ? file.type : 'image/jpeg' };
}

/** Wideo: kilka klatek rozłożonych równo w czasie (modele czatu nie przyjmują plików wideo). */
async function video(file: File, chat: string): Promise<Att> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.src = url;
  const once = (ev: string, ms: number) => new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('Nie mogę odczytać tego wideo (kodek?)')), ms);
    v.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true });
    v.addEventListener('error', () => { clearTimeout(t); rej(new Error('Nie mogę odczytać tego wideo (kodek?)')); }, { once: true });
  });
  try {
    await once('loadeddata', 15000);
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    const n = dur ? Math.max(1, Math.min(8, Math.round(dur / 3))) : 1;
    const frames: { path: string; t: number }[] = [];
    const base = (file.name || 'wideo').replace(/\.[^.]+$/, '');
    for (let i = 0; i < n; i++) {
      const t = dur ? ((i + 0.5) * dur) / n : 0;
      if (t) { v.currentTime = t; await once('seeked', 10000); }
      const blob = await canvasBlob(v, v.videoWidth, v.videoHeight, FRAME_MAX, 0.8);
      frames.push({ path: await save(chat, `${base}-klatka-${i + 1}.jpg`, blob), t: Math.round(t * 10) / 10 });
    }
    return { kind: 'video', name: file.name || 'wideo', path: frames[0].path, size: file.size, mime: file.type, frames, duration: Math.round(dur * 10) / 10 };
  } finally { URL.revokeObjectURL(url); v.removeAttribute('src'); }
}

async function looksText(file: File) {
  if (file.size > 2_000_000) return false;
  if (file.type.startsWith('text/') || /json|xml|javascript|typescript|yaml|toml|x-sh|sql/.test(file.type) || TEXT_EXT.test(file.name)) return true;
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  return head.length > 0 && !head.includes(0);
}

/** Zapisuje plik jako załącznik rozmowy `chat` i rozpoznaje jego rodzaj. */
export async function prepare(file: File, chat: string): Promise<Att> {
  const name = file.name || 'plik';
  if (file.type.startsWith('image/') && !/svg/.test(file.type)) return image(file, chat);
  if (file.type.startsWith('video/')) {
    try { return await video(file, chat); } catch { /* nieobsługiwany kodek: zostaje jako zwykły plik */ }
  }
  if (file.type === 'application/pdf' || /\.pdf$/i.test(name)) {
    if (file.size > 30_000_000) throw new Error(`${name}: PDF jest za duży (limit 30 MB)`);
    return { kind: 'pdf', name, path: await save(chat, name, file), size: file.size, mime: 'application/pdf' };
  }
  if (await looksText(file)) return { kind: 'text', name, path: await save(chat, name, file), size: file.size, mime: file.type || 'text/plain' };
  if (file.size > 100 * 1048576) return { kind: 'file', name, path: '', size: file.size, mime: file.type };
  return { kind: 'file', name, path: await save(chat, name, file), size: file.size, mime: file.type };
}

/** Nagranie z dyktowania jako załącznik rozmowy (`data` to base64, już policzone do transkrypcji). */
export async function saveAudio(chat: string, blob: Blob, data: string): Promise<Att> {
  const d = new Date(), two = (n: number) => String(n).padStart(2, '0');
  const ext = /ogg/.test(blob.type) ? 'ogg' : /mp4/.test(blob.type) ? 'm4a' : 'webm';
  const name = `glos-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}.${ext}`;
  return { kind: 'audio', name, path: await call<string>('att_save', { chat, name, data }), size: blob.size, mime: blob.type };
}

/* ---------- wysyłka do providera ---------- */

// Ostatnio wczytane pliki: pętla narzędzi wysyła tę samą historię wiele razy.
const cache = new Map<string, string>();
let cached = 0;
async function read64(path: string) {
  const hit = cache.get(path);
  if (hit) return hit;
  const d = await call<string>('fs_read_b64', { path });
  cache.set(path, d); cached += d.length;
  for (const [k, v] of cache) { if (cached < 40_000_000) break; cache.delete(k); cached -= v.length; }
  return d;
}

const KIND = { image: 'obraz', video: 'wideo', pdf: 'PDF', text: 'plik tekstowy', file: 'plik', audio: 'nagranie głosowe' } as const;

/** Opis załącznika dla modelu: nazwa, rodzaj, rozmiar i ścieżka (agent może użyć jej w terminalu). */
export function describe(a: Att) {
  const where = a.path ? (a.kind === 'video' ? ` Klatki zapisane obok: ${a.path.replace(/[^\\/]+$/, '')}` : ` Zapisany w: ${a.path}`) : ' (nie skopiowano: za duży)';
  return `[Załącznik: ${a.name} · ${KIND[a.kind]} · ${fmtSize(a.size)}${a.duration ? ` · ${a.duration} s` : ''}.${where}]`;
}

async function blocksOf(a: Att): Promise<Block[]> {
  const note: Block = { type: 'text', text: describe(a) };
  try {
    if (a.kind === 'image') return [note, { type: 'image', source: { type: 'base64', media_type: a.mime || 'image/jpeg', data: await read64(a.path) } }];
    if (a.kind === 'video') {
      const out: Block[] = [{ type: 'text', text: `${describe(a)} Poniżej ${a.frames?.length || 0} klatek w kolejności (czas w sekundach: ${(a.frames || []).map((f) => f.t).join(', ')}).` }];
      for (const f of a.frames || []) out.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await read64(f.path) } });
      return out;
    }
    if (a.kind === 'pdf') return [note, { type: 'document', title: a.name, source: { type: 'base64', media_type: 'application/pdf', data: await read64(a.path) } }];
    if (a.kind === 'text') {
      let t = await call<string>('fs_read_text', { path: a.path });
      if (t.length > TEXT_MAX) t = t.slice(0, TEXT_MAX) + `\n… (ucięto, plik ma ${t.length} znaków)`;
      return [{ type: 'text', text: `<plik nazwa="${a.name}" ścieżka="${a.path}">\n${t}\n</plik>` }];
    }
  } catch (e) {
    return [{ type: 'text', text: `${describe(a)} (nie udało się wczytać: ${e})` }];
  }
  return [note];
}

/** Zamienia bloki `attachment` na treść dla providera (obrazy, dokumenty, tekst). */
export async function expandAttachments(messages: AMsg[]): Promise<AMsg[]> {
  if (!messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'attachment'))) return messages;
  return Promise.all(messages.map(async (m) => {
    if (!Array.isArray(m.content) || !m.content.some((b) => b.type === 'attachment')) return m;
    const out: Block[] = [];
    for (const b of m.content) {
      if (b.type === 'attachment') out.push(...(await blocksOf(b.att)));
      else out.push(b);
    }
    return { ...m, content: out };
  }));
}

/** Treść wiadomości użytkownika: tekst i bloki załączników. */
export function userContent(text: string, att: Att[]): string | Block[] {
  if (!att.length) return text;
  return [...att.map((a) => ({ type: 'attachment', att: a })), { type: 'text', text: text || 'Zobacz załączniki.' }];
}
