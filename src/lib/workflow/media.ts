// Generowanie grafiki i wideo dla nodów workflow. Każdy provider ma własny adapter;
// klucze dokłada rdzeń (media_request), a wyniki lądują jako pliki w folderze media.
import { call, isTauri } from '../ipc';
import { app } from '../state.svelte';
import { PROVIDER_TYPES, isMedia } from '../defaults';
import { sleep } from '../util';
import { comfyGenerate, presetsFor } from './comfy.svelte';
import type { Media, MediaCfg, MediaOp, Provider } from '../types';

export const MEDIA_DEFAULTS: MediaCfg = { base: '', prompt: '', provider: '', model: '', n: 1, aspect: '1:1', duration: '', seed: '', negative: '', imageKey: '', params: '' };
export const ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4'];
export const isVideoOp = (op: MediaOp) => op === 'video' || op === 'i2v';
export const needsImage = (op: MediaOp) => op === 'edit' || op === 'i2v' || op === 'upscale' || op === 'rmbg';

export function mediaProviders() { return app.providers.filter(isMedia); }
export function modelHints(p: Provider | undefined, op: MediaOp) {
  if (p?.type === 'comfy') return presetsFor(op).map((x) => x.id);
  return (p && PROVIDER_TYPES[p.type].media?.[op]) || [];
}
/** Provider gotowy do pracy: ma klucz albo (ComfyUI) jest skonfigurowany. */
const ready = (p: Provider) => p.hasKey || (p.type === 'comfy' && (!!app.local.comfyDir || !/127\.0\.0\.1|localhost/.test(p.url)));

/** Domyślny provider mediów: pierwszy z zapisanym kluczem, który obsługuje operację. */
export function pickProvider(cfg: MediaCfg, op: MediaOp): Provider {
  const list = mediaProviders();
  const p = (cfg.provider && list.find((x) => x.id === cfg.provider)) || list.find((x) => ready(x) && modelHints(x, op).length) || list.find((x) => modelHints(x, op).length);
  if (!p) throw new Error('Brak providera grafiki i wideo. Dodaj fal.ai, Replicate, OpenAI albo Google w Ustawienia → Providerzy albo modele lokalne w Ustawienia → Lokalne AI.');
  return p;
}

const ref = (p: Provider) => ({ type: p.type, url: p.url, keyRef: p.keyRef });
const req = (p: Provider, method: string, url: string, body?: unknown, multipart?: { name: string; value?: string; file?: string }[]) =>
  call<any>('media_request', { provider: ref(p), method, url, body: body ?? null, multipart: multipart ?? null, headers: null });
const save = (p: Provider | null, url: string, ext?: string) => call<string>('media_download', { provider: p ? ref(p) : null, url, ext: ext ?? null });
const saveB64 = (data: string, mime: string) => call<string>('media_save_b64', { data, ext: mime.split('/')[1]?.replace('jpeg', 'jpg') || 'png' });

const mimeOf = (path: string) => /\.png$/i.test(path) ? 'image/png' : /\.webp$/i.test(path) ? 'image/webp' : /\.gif$/i.test(path) ? 'image/gif' : 'image/jpeg';
export const kindOf = (path: string): Media['kind'] => /\.(mp4|webm|mov|m4v)$/i.test(path) ? 'video' : 'image';
export async function dataUri(path: string) { return `data:${mimeOf(path)};base64,${await call<string>('fs_read_b64', { path })}`; }

/** Adres do pokazania pliku w WebView (protokół asset). */
let convert: ((p: string) => string) | null = null;
if (isTauri) import('@tauri-apps/api/core').then((m) => (convert = m.convertFileSrc));
export const mediaSrc = (path: string) => (convert ? convert(path) : path);

/** Krótki stan zadania i (ComfyUI) podgląd generowanego obrazu jako data URI. */
export type Progress = (note: string, preview?: string) => void;

function extraParams(cfg: MediaCfg): Record<string, unknown> {
  if (!cfg.params?.trim()) return {};
  try { return JSON.parse(cfg.params); } catch { throw new Error('Parametry dodatkowe muszą być poprawnym JSON-em, np. {"guidance_scale": 4}'); }
}

/** Wszystkie adresy plików w odpowiedzi (images[].url, video.url, output…). */
function urlsIn(v: any, out: string[] = []): string[] {
  if (typeof v === 'string') { if (/^(https?:|data:)/.test(v)) out.push(v); }
  else if (Array.isArray(v)) v.forEach((x) => urlsIn(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (!/^(logs|metrics|urls|input|request|thumbnail)/i.test(k)) urlsIn(x, out); }
  return out;
}

const SIZE: Record<string, string> = { '1:1': 'square_hd', '16:9': 'landscape_16_9', '9:16': 'portrait_16_9', '4:3': 'landscape_4_3', '3:4': 'portrait_4_3' };

/** Nazwa pola obrazu wejściowego; „[]” na końcu oznacza listę. */
function imageKey(p: Provider, model: string, cfg: MediaCfg) {
  if (cfg.imageKey.trim()) return cfg.imageKey.trim();
  if (p.type === 'fal') return /nano-banana|seedream|\/edit$/.test(model) && !/kontext/.test(model) ? 'image_urls[]' : 'image_url';
  const map: Record<string, string> = { 'black-forest-labs/flux-kontext-pro': 'input_image', 'google/nano-banana': 'image_input[]', 'kwaivgi/kling-v2.1': 'start_image', 'minimax/hailuo-02': 'first_frame_image' };
  return map[model.split(':')[0]] || 'image';
}

async function commonInput(p: Provider, op: MediaOp, model: string, cfg: MediaCfg, prompt: string, images: string[]) {
  const input: Record<string, unknown> = {};
  if (prompt && op !== 'upscale' && op !== 'rmbg') input.prompt = prompt;
  if (!isVideoOp(op) && op !== 'upscale' && op !== 'rmbg') { input.aspect_ratio = cfg.aspect; if (p.type === 'fal') input.image_size = SIZE[cfg.aspect] || 'square_hd'; }
  if (isVideoOp(op) && cfg.aspect !== '1:1') input.aspect_ratio = cfg.aspect;
  if (cfg.duration) input.duration = p.type === 'fal' ? String(cfg.duration) : +cfg.duration;
  if (cfg.seed) input.seed = +cfg.seed;
  if (cfg.negative) input.negative_prompt = cfg.negative;
  if (images.length) {
    const key = imageKey(p, model, cfg);
    const uris = await Promise.all(images.map(dataUri));
    if (key.endsWith('[]')) input[key.slice(0, -2)] = uris; else input[key] = uris[0];
  }
  return { ...input, ...extraParams(cfg) };
}

async function poll<T>(check: () => Promise<T | null>, progress: Progress, label: string, maxMin = 20): Promise<T> {
  const start = Date.now();
  for (let i = 0; Date.now() - start < maxMin * 60_000; i++) {
    const r = await check();
    if (r) return r;
    progress(`${label} · ${Math.round((Date.now() - start) / 1000)} s`);
    await sleep(i < 5 ? 2000 : 4000);
  }
  throw new Error(`Provider nie skończył w ${maxMin} min`);
}

/* ---------- fal.ai: kolejka (queue.fal.run) ---------- */
async function fal(p: Provider, op: MediaOp, model: string, cfg: MediaCfg, prompt: string, images: string[], progress: Progress) {
  const base = p.url.replace(/\/$/, '');
  const sub = await req(p, 'POST', `${base}/${model}`, await commonInput(p, op, model, cfg, prompt, images));
  if (!sub.status_url) return urlsIn(sub);
  const result = await poll(async () => {
    const st = await req(p, 'GET', sub.status_url);
    if (st.status === 'COMPLETED') return req(p, 'GET', sub.response_url);
    if (st.status === 'IN_QUEUE') progress(`w kolejce${st.queue_position != null ? ` (${st.queue_position})` : ''}`);
    if (st.status === 'FAILED' || st.error) throw new Error(st.error || 'fal.ai: zadanie nie powiodło się');
    return null;
  }, progress, 'generuję');
  return urlsIn(result);
}

/* ---------- Replicate: predictions ---------- */
async function replicate(p: Provider, op: MediaOp, model: string, cfg: MediaCfg, prompt: string, images: string[], progress: Progress) {
  const base = p.url.replace(/\/$/, '');
  const input = await commonInput(p, op, model, cfg, prompt, images);
  const [name, version] = model.split(':');
  let pr = version ? await req(p, 'POST', `${base}/predictions`, { version, input }) : await req(p, 'POST', `${base}/models/${name}/predictions`, { input });
  pr = await poll(async () => {
    if (pr.status === 'succeeded') return pr;
    if (pr.status === 'failed' || pr.status === 'canceled') throw new Error(`Replicate: ${pr.error || pr.status}`);
    pr = await req(p, 'GET', pr.urls?.get || `${base}/predictions/${pr.id}`);
    return pr.status === 'succeeded' ? pr : null;
  }, progress, 'generuję');
  return urlsIn(pr.output);
}

/* ---------- OpenAI: gpt-image-1 i Sora ---------- */
const OA_SIZE = (a: string) => (a === '16:9' || a === '4:3' ? '1536x1024' : a === '9:16' || a === '3:4' ? '1024x1536' : '1024x1024');
const SORA_SIZE = (a: string) => (a === '9:16' || a === '3:4' ? '720x1280' : '1280x720');
async function openai(p: Provider, op: MediaOp, model: string, cfg: MediaCfg, prompt: string, images: string[], progress: Progress): Promise<Media[]> {
  const base = p.url.replace(/\/$/, '');
  const extra = extraParams(cfg);
  if (op === 'image' || op === 'edit') {
    const r = op === 'edit'
      ? await req(p, 'POST', `${base}/images/edits`, null, [{ name: 'model', value: model }, { name: 'prompt', value: prompt }, { name: 'size', value: OA_SIZE(cfg.aspect) },
          ...Object.entries(extra).map(([k, v]) => ({ name: k, value: String(v) })), ...images.map((f) => ({ name: 'image[]', file: f }))])
      : await req(p, 'POST', `${base}/images/generations`, { model, prompt, size: OA_SIZE(cfg.aspect), n: 1, ...extra });
    return Promise.all((r.data || []).map(async (d: any) => ({ kind: 'image' as const, path: d.b64_json ? await saveB64(d.b64_json, 'image/png') : await save(null, d.url) })));
  }
  if (isVideoOp(op)) {
    const parts = [{ name: 'model', value: model }, { name: 'prompt', value: prompt }, { name: 'size', value: SORA_SIZE(cfg.aspect) }];
    if (cfg.duration) parts.push({ name: 'seconds', value: String(cfg.duration) });
    for (const [k, v] of Object.entries(extra)) parts.push({ name: k, value: String(v) });
    const job = await req(p, 'POST', `${base}/videos`, null, [...parts, ...(images[0] ? [{ name: 'input_reference', file: images[0] }] : [])]);
    await poll(async () => {
      const st = await req(p, 'GET', `${base}/videos/${job.id}`);
      if (st.status === 'completed') return st;
      if (st.status === 'failed') throw new Error(`Sora: ${st.error?.message || 'nie powiodło się'}`);
      if (st.progress != null) progress(`generuję · ${st.progress}%`);
      return null;
    }, progress, 'generuję');
    return [{ kind: 'video', path: await save(p, `${base}/videos/${job.id}/content`, 'mp4') }];
  }
  throw new Error('OpenAI nie obsługuje tej operacji. Wybierz fal.ai albo Replicate.');
}

/* ---------- Google: Gemini (obrazy), Imagen, Veo ---------- */
async function google(p: Provider, op: MediaOp, model: string, cfg: MediaCfg, prompt: string, images: string[], progress: Progress): Promise<Media[]> {
  const base = `${p.url.replace(/\/$/, '')}/v1beta`;
  const extra = extraParams(cfg);
  const inline = await Promise.all(images.map(async (f) => ({ mimeType: mimeOf(f), data: await call<string>('fs_read_b64', { path: f }) })));
  if (op === 'image' && /^imagen/.test(model)) {
    const r = await req(p, 'POST', `${base}/models/${model}:predict`, { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: cfg.aspect, ...extra } });
    return Promise.all((r.predictions || []).map(async (x: any) => ({ kind: 'image' as const, path: await saveB64(x.bytesBase64Encoded, x.mimeType || 'image/png') })));
  }
  if (op === 'image' || op === 'edit') {
    const r = await req(p, 'POST', `${base}/models/${model}:generateContent`, {
      contents: [{ parts: [{ text: prompt }, ...inline.map((d) => ({ inlineData: d }))] }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: { aspectRatio: cfg.aspect }, ...extra },
    });
    const parts = r.candidates?.[0]?.content?.parts || [];
    const out = await Promise.all(parts.filter((x: any) => x.inlineData).map(async (x: any) => ({ kind: 'image' as const, path: await saveB64(x.inlineData.data, x.inlineData.mimeType) })));
    if (!out.length) throw new Error(parts.map((x: any) => x.text).filter(Boolean).join(' ') || 'Gemini nie zwrócił obrazu');
    return out;
  }
  if (isVideoOp(op)) {
    const inst: Record<string, unknown> = { prompt };
    if (inline[0]) inst.image = { bytesBase64Encoded: inline[0].data, mimeType: inline[0].mimeType };
    const params: Record<string, unknown> = { aspectRatio: cfg.aspect === '9:16' ? '9:16' : '16:9', ...extra };
    if (cfg.negative) params.negativePrompt = cfg.negative;
    if (cfg.seed) params.seed = +cfg.seed;
    const opn = await req(p, 'POST', `${base}/models/${model}:predictLongRunning`, { instances: [inst], parameters: params });
    const done = await poll(async () => {
      const st = await req(p, 'GET', `${base}/${opn.name}`);
      if (st.error) throw new Error(`Veo: ${st.error.message}`);
      return st.done ? st : null;
    }, progress, 'generuję');
    const uris: string[] = (done.response?.generateVideoResponse?.generatedSamples || []).map((s: any) => s.video?.uri).filter(Boolean);
    if (!uris.length) throw new Error('Veo nie zwrócił wideo (możliwa blokada treści)');
    return Promise.all(uris.map(async (u) => ({ kind: 'video' as const, path: await save(p, u, 'mp4') })));
  }
  throw new Error('Google nie obsługuje tej operacji. Wybierz fal.ai albo Replicate.');
}

/** Jedno wywołanie modelu → lista plików. */
export async function generateOnce(op: MediaOp, cfg: MediaCfg, prompt: string, images: string[], progress: Progress): Promise<Media[]> {
  const p = pickProvider(cfg, op);
  if (p.type === 'comfy') return comfyGenerate(p, op, cfg.model, cfg, prompt, images, progress);
  const model = cfg.model || modelHints(p, op)[0];
  if (!model) throw new Error(`Wybierz model dla „${p.name}”.`);
  if (needsImage(op) && !images.length) throw new Error('Ten node potrzebuje obrazu na wejściu (np. z „Generuj obraz” albo „Plik z dysku”).');
  if (p.type === 'openai') return openai(p, op, model, cfg, prompt, images, progress);
  if (p.type === 'google') return google(p, op, model, cfg, prompt, images, progress);
  const urls = p.type === 'fal' ? await fal(p, op, model, cfg, prompt, images, progress) : await replicate(p, op, model, cfg, prompt, images, progress);
  if (!urls.length) throw new Error('Provider nie zwrócił żadnego pliku');
  progress('pobieram');
  return Promise.all([...new Set(urls)].map(async (u) => { const path = await save(p, u); return { kind: kindOf(path), path }; }));
}

/** Plik wynikowy w folderze media (dla ffmpeg). */
export async function mediaFile(ext: string) {
  const dir = await call<string>('media_dir');
  return `${dir}\\${Date.now()}-${Math.random().toString(16).slice(2, 10)}.${ext}`;
}

/** ffmpeg z PATH; czytelny błąd, gdy go nie ma. */
export async function ffmpeg(args: string[]) {
  const r: any = await call('sys_exec', { cmd: 'ffmpeg', args: ['-hide_banner', '-loglevel', 'error', '-y', ...args], cwd: null, timeoutMs: 600000 }).catch((e) => {
    throw new Error(/not found|nie można|cannot find|program not found|os error 2/i.test(String(e)) ? 'Brak ffmpeg. Zainstaluj go (winget install Gyan.FFmpeg) i uruchom aplikację ponownie.' : String(e));
  });
  if (r.code !== 0) throw new Error(`ffmpeg: ${(r.stderr || '').trim().slice(0, 300)}`);
}
