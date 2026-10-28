// Kolejka GPU: zadania lokalnych modeli (ComfyUI, Ollama) idą po kolei, nawet z kilku workflow i agentów naraz,
// a przy zmianie modelu poprzedni jest zwalniany z pamięci karty.
import { call } from './ipc';
import { app } from './state.svelte';

let chain: Promise<unknown> = Promise.resolve();
let current = '';
let freeComfy: () => Promise<void> = async () => {};

/** ComfyUI rejestruje tu zwalnianie swojej pamięci (moduł GPU nie zależy od ComfyUI). */
export function onFreeComfy(fn: () => Promise<void>) { freeComfy = fn; }
/** Po zatrzymaniu ComfyUI na karcie nie ma już jego modelu. */
export function gpuForget(prefix: string) { if (current.startsWith(prefix)) current = ''; }

export function withGpu<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function unloadOllama() {
  for (const p of app.providers.filter((x) => x.type === 'ollama')) {
    const base = p.url.replace(/\/$/, '');
    try {
      const r: any = await call('http_request', { method: 'GET', url: `${base}/api/ps`, headers: null, body: null });
      for (const m of JSON.parse(r.body).models || []) await call('http_request', { method: 'POST', url: `${base}/api/generate`, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: m.name, keep_alive: 0 }) });
    } catch { /* Ollama nie działa */ }
  }
}

/** Przed zadaniem: zwalnia poprzedni model, jeśli jest inny (ComfyUI ↔ Ollama albo inny przepis). */
export async function gpuSwitch(key: string) {
  if (key === current) return;
  if (current.startsWith('comfy:')) await freeComfy();
  if (key.startsWith('comfy:') && !current.startsWith('comfy:')) await unloadOllama();
  current = key;
}

/** Wykonuje zadanie modelu lokalnego w kolejce; zadania chmurowe (pusty klucz) idą od razu. */
export const onGpu = <T>(key: string, fn: () => Promise<T>): Promise<T> =>
  key ? withGpu(async () => { await gpuSwitch(key); return fn(); }) : fn();

/** Klucz modelu lokalnego dla noda (do grupowania kolejności i kolejki), albo '' dla chmury. */
export function localKey(cfg: { provider?: string; model?: string }, media: boolean): string {
  const p = app.providers.find((x) => x.id === cfg.provider);
  if (media && p?.type === 'comfy') return `comfy:${cfg.model || ''}`;
  if (!media && (p?.type === 'ollama' || (!cfg.provider && app.providers.find((x) => x.id === app.defModel.provider)?.type === 'ollama'))) return `ollama:${cfg.model || app.defModel.model}`;
  return '';
}
