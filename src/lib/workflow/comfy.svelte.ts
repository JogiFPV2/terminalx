// Lokalna grafika i wideo przez ComfyUI. Aplikacja uruchamia ComfyUI dopiero, gdy workflow go potrzebuje,
// i zatrzymuje po bezczynności. Zadania idą przez wspólną kolejkę GPU (../gpu.ts): na karcie jest jeden model naraz.
import { Channel } from '@tauri-apps/api/core';
import { call, isTauri } from '../ipc';
import { app } from '../state.svelte';
import { BRAND } from '../defaults';
import { nid, sleep } from '../util';
import { withGpu, gpuSwitch, gpuForget, onFreeComfy } from '../gpu';
import { PRESETS, customPreset, mergeCatalog, params, type Catalog, type ModelFile, type Preset } from './presets';
import type { Media, MediaCfg, MediaOp, Provider } from '../types';

export { PRESETS, inspectCustom, type Preset, type ModelFile } from './presets';

/** Wbudowane przepisy uzupełnione katalogiem online. */
export const catalogPresets = () => mergeCatalog(PRESETS, app.local.catalog?.data as Catalog | undefined);
/** …oraz zaimportowane workflow. */
export function allPresets(): Preset[] {
  const out = catalogPresets();
  for (const c of app.local.custom) { try { out.push(customPreset(c)); } catch { /* uszkodzony wpis */ } }
  return out;
}
export const presetById = (id: string) => allPresets().find((p) => p.id === id);
export const presetsFor = (op: MediaOp) => allPresets().filter((p) => p.ops.includes(op));

/** Katalog modeli z repozytorium aplikacji: nowe modele bez wydawania nowej wersji. Raz na dobę. */
export async function refreshCatalog(force = false) {
  if (!BRAND.repo || !isTauri) return;
  if (!force && Date.now() - (app.local.catalog?.at || 0) < 86_400_000) return;
  try {
    const r: any = await call('http_request', { method: 'GET', url: `https://raw.githubusercontent.com/${BRAND.repo}/main/catalog/models.json`, headers: { 'user-agent': BRAND.name }, body: null });
    if (r.status !== 200) return;
    const data = JSON.parse(r.body);
    if (data?.version === 1 && Array.isArray(data.presets)) app.local.catalog = { at: Date.now(), data };
  } catch { /* offline: zostaje poprzedni katalog */ }
}

/* ---------- sprzęt i dopasowanie ---------- */

export interface Hardware { gpus: { name: string; vramMb: number; vendor: string }[]; ramMb: number; unified: boolean }
export interface Install { comfy: string; python: string; models: string; portable: boolean }

export const local = $state({
  hw: null as Hardware | null,
  inst: null as Install | null,
  running: false,
  starting: false,
  /** Rozmiary pobranych plików modeli: ścieżka względna → bajty. */
  have: {} as Record<string, number>,
  dl: {} as Record<string, { done: number; total: number; error?: string }>,
});

export const GB = 1024 ** 3;
export const fileKey = (m: ModelFile) => `${m.dir}/${m.name}`;
export const presetSize = (p: Preset) => p.files.reduce((s, m) => s + m.size, 0);
export const installed = (p: Preset) => p.files.every((m) => local.have[fileKey(m)] === m.size);
export const missingFiles = (p: Preset) => p.files.filter((m) => local.have[fileKey(m)] !== m.size);

/** ok: płynnie; slow: zadziała z odciążaniem pamięci; no: za mało pamięci. */
export function fit(p: Preset): 'ok' | 'slow' | 'no' | '?' {
  const hw = local.hw;
  if (!hw || !p.vram) return '?';
  const vram = (hw.gpus[0]?.vramMb || 0) / 1024, ram = hw.ramMb / 1024;
  if (!hw.gpus.length) return 'no';
  if (vram >= p.vram && ram >= p.ram * 0.95) return 'ok';
  if (vram >= p.vram * 0.6 && ram >= p.ram * 0.6) return 'slow';
  return 'no';
}

export async function refreshLocal() {
  if (!isTauri) return;
  void refreshCatalog();
  local.hw ??= await call<Hardware>('local_hw').catch(() => null);
  // Instalacja w domyślnym folderze (np. z poprzedniej wersji albo innej kopii aplikacji) podłącza się sama.
  if (!app.local.comfyDir) {
    const d = await call<string>('comfy_default_dir').catch(() => '');
    if (d && (await call('comfy_find', { dir: d }).catch(() => null))) { app.local.comfyDir = d; ensureProvider(); }
  }
  local.inst = app.local.comfyDir ? await call<Install | null>('comfy_find', { dir: app.local.comfyDir }).catch(() => null) : null;
  local.running = (await call<{ running: boolean }>('comfy_status').catch(() => ({ running: false }))).running;
  if (!local.inst) { local.have = {}; return; }
  const files = [...new Map(allPresets().flatMap((p) => p.files).map((m) => [fileKey(m), m])).values()];
  const sizes = await call<(number | null)[]>('fs_sizes', { paths: files.map((m) => `${local.inst!.models}/${m.dir}/${m.name}`) });
  local.have = Object.fromEntries(files.map((m, i) => [fileKey(m), sizes[i] ?? -1]).filter(([, s]) => (s as number) >= 0));
}

/* ---------- pobieranie (modele, instalator) ---------- */

let dlListening = false;
const dlWaiters = new Map<string, { ok: () => void; fail: (e: Error) => void }>();
async function listenDl() {
  if (dlListening || !isTauri) return;
  dlListening = true;
  const { listen } = await import('@tauri-apps/api/event');
  listen<{ id: string; done: number; total: number; state: string; error?: string }>('dl', (e) => {
    const d = e.payload;
    if (d.state === 'run') local.dl[d.id] = { done: d.done, total: d.total };
    else {
      if (d.state === 'error') local.dl[d.id] = { done: 0, total: 0, error: d.error }; else delete local.dl[d.id];
      const w = dlWaiters.get(d.id);
      dlWaiters.delete(d.id);
      if (d.state === 'error') w?.fail(new Error(d.error)); else w?.ok();
    }
  });
}

export async function download(id: string, url: string, dest: string, sha256?: string) {
  await listenDl();
  local.dl[id] = { done: 0, total: 0 };
  const done = new Promise<void>((ok, fail) => dlWaiters.set(id, { ok, fail }));
  await call('dl_start', { id, url, dest, sha256: sha256 ?? null });
  return done;
}

/** Pobiera brakujące pliki modelu (po kolei, żeby nie dzielić łącza). Wspólne pliki pobierają się raz. */
export async function downloadPreset(p: Preset) {
  if (!local.inst) throw new Error('Najpierw zainstaluj ComfyUI albo wskaż jego folder.');
  for (const m of missingFiles(p)) {
    const key = fileKey(m);
    if (local.dl[key] && !local.dl[key].error) continue;
    await download(key, m.url, `${local.inst.models}/${m.dir}/${m.name}`, m.sha256);
    local.have[key] = m.size;
  }
}

export async function removePreset(p: Preset) {
  // Pliki wspólne z innymi pobranymi modelami zostają.
  const used = new Set(allPresets().filter((x) => x.id !== p.id && installed(x)).flatMap((x) => x.files.map(fileKey)));
  for (const m of p.files) if (!used.has(fileKey(m)) && local.have[fileKey(m)] != null) {
    await call('comfy_model_remove', { dir: app.local.comfyDir, rel: `${m.dir}/${m.name}` });
    delete local.have[fileKey(m)];
  }
}

const UA = navigator.userAgent;
const OS = /Windows/.test(UA) ? 'windows' : /Mac/.test(UA) ? 'macos' : 'linux';

/** Instaluje ComfyUI: w Windows wersję przenośną z wydania na GitHubie, w Linux i macOS kod źródłowy
 *  z PyTorch dobranym do karty (przez uv, bez systemowego Pythona). */
export async function installComfy(progress: (s: string) => void) {
  const dir = app.local.comfyDir || await call<string>('comfy_default_dir');
  if (OS !== 'windows') return installWithUv(dir, progress);
  const rel: any = await call('http_request', { method: 'GET', url: 'https://api.github.com/repos/Comfy-Org/ComfyUI/releases/latest', headers: { 'user-agent': 'TerminalX', accept: 'application/vnd.github+json' }, body: null });
  const assets: { name: string; browser_download_url: string }[] = JSON.parse(rel.body).assets || [];
  const vendor = local.hw?.gpus[0]?.vendor || 'nvidia';
  const old = /GTX 10|GTX 9|TITAN X/i.test(local.hw?.gpus[0]?.name || '');
  const want = vendor === 'amd' ? 'portable_amd.7z' : vendor === 'intel' ? 'portable_intel.7z' : old ? 'portable_nvidia_cu126.7z' : 'portable_nvidia.7z';
  const asset = assets.find((a) => a.name.endsWith(want)) || assets.find((a) => a.name.endsWith('portable_nvidia.7z'));
  if (!asset) throw new Error('Nie znalazłem paczki ComfyUI dla Windows. Zainstaluj go ręcznie i wskaż folder.');
  const archive = `${dir}/${asset.name}`;
  progress('pobieram ComfyUI');
  await download('comfyui', asset.browser_download_url, archive);
  progress('rozpakowuję');
  await call('archive_extract', { archive, dest: dir });
  app.local.comfyDir = dir;
  ensureProvider();
  await refreshLocal();
}

const sh = async (cmd: string, args: string[], cwd: string | null, what: string) => {
  const r = await call<{ code: number; stdout: string; stderr: string }>('sys_exec', { cmd, args, cwd, timeoutMs: 3_600_000 });
  if (r.code !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout).trim().split('\n').slice(-4).join(' ').slice(0, 400)}`);
};

async function installWithUv(dir: string, progress: (s: string) => void) {
  const arch = /arm64|aarch64/i.test(UA) || (OS === 'macos' && local.hw?.unified) ? 'aarch64' : 'x86_64';
  const target = OS === 'macos' ? `${arch}-apple-darwin` : `${arch}-unknown-linux-gnu`;
  progress('pobieram uv');
  const uvArchive = `${dir}/uv-${target}.tar.gz`;
  await download('comfyui', `https://github.com/astral-sh/uv/releases/latest/download/uv-${target}.tar.gz`, uvArchive);
  await call('archive_extract', { archive: uvArchive, dest: dir });
  const uv = `${dir}/uv-${target}/uv`;
  progress('pobieram ComfyUI');
  const src = `${dir}/comfyui-src.tar.gz`;
  await download('comfyui', 'https://github.com/Comfy-Org/ComfyUI/archive/refs/heads/master.tar.gz', src);
  await call('archive_extract', { archive: src, dest: dir });
  const root = `${dir}/ComfyUI-master`;
  progress('przygotowuję Pythona 3.12');
  await sh(uv, ['venv', '--python', '3.12', '.venv'], root, 'Środowisko Pythona');
  // PyTorch: CUDA dla NVIDIA, ROCm dla AMD (Linux), Metal (MPS) w macOS ze zwykłego PyPI.
  const vendor = local.hw?.gpus[0]?.vendor;
  const index = OS === 'macos' ? null : vendor === 'nvidia' ? 'https://download.pytorch.org/whl/cu128' : vendor === 'amd' ? 'https://download.pytorch.org/whl/rocm6.4' : 'https://download.pytorch.org/whl/cpu';
  progress('instaluję PyTorch (kilka minut)');
  await sh(uv, ['pip', 'install', '--python', '.venv', 'torch', 'torchvision', 'torchaudio', ...(index ? ['--index-url', index] : [])], root, 'PyTorch');
  progress('instaluję zależności ComfyUI');
  await sh(uv, ['pip', 'install', '--python', '.venv', '-r', 'requirements.txt'], root, 'Zależności ComfyUI');
  app.local.comfyDir = dir;
  ensureProvider();
  await refreshLocal();
}

/** Provider „ComfyUI (lokalnie)” pojawia się, gdy lokalne AI jest skonfigurowane. */
export function ensureProvider() {
  if (app.providers.some((p) => p.type === 'comfy')) return;
  app.providers.push({ id: 'comfy', type: 'comfy', name: 'ComfyUI (lokalnie)', url: `http://127.0.0.1:${app.local.port || 8188}`, keyRef: 'provider:comfy', hasKey: false, models: [] });
}


/* ---------- proces ComfyUI ---------- */

const ref = (p: Provider) => ({ type: p.type, url: p.url, keyRef: p.keyRef });
const req = (p: Provider, method: string, url: string, body?: unknown, multipart?: { name: string; value?: string; file?: string }[]) =>
  call<any>('media_request', { provider: ref(p), method, url, body: body ?? null, multipart: multipart ?? null, headers: null });
const isLocalUrl = (u: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i.test(u);
const baseOf = (p: Provider) => p.url.replace(/\/$/, '');

async function alive(p: Provider) {
  try { await req(p, 'GET', `${baseOf(p)}/system_stats`); return true; } catch { return false; }
}

let idleTimer = 0;
function armIdle() {
  clearTimeout(idleTimer);
  const min = +app.local.idleMin;
  if (min > 0) idleTimer = window.setTimeout(() => { stopComfy(); }, min * 60_000);
}

let lastComfy: Provider | null = null;
onFreeComfy(async () => {
  if (lastComfy && local.running) await req(lastComfy, 'POST', `${baseOf(lastComfy)}/free`, { unload_models: true, free_memory: true }).catch(() => {});
});

export async function stopComfy() {
  clearTimeout(idleTimer);
  await call('comfy_stop').catch(() => {});
  local.running = false;
  gpuForget('comfy:');
}

export async function startComfy(progress: (s: string) => void = () => {}) {
  const p = app.providers.find((x) => x.type === 'comfy');
  if (!p) throw new Error('Brak providera ComfyUI');
  if (await alive(p)) { local.running = true; return; }
  if (!app.local.comfyDir) throw new Error('Ustaw folder ComfyUI w Ustawienia → Lokalne AI.');
  local.starting = true;
  try {
    const port = +(new URL(p.url).port || app.local.port || 8188);
    await call('comfy_start', { dir: app.local.comfyDir, port, args: (app.local.args || '').split(/\s+/).filter(Boolean) });
    progress('uruchamiam ComfyUI');
    const start = Date.now();
    while (Date.now() - start < 300_000) {
      await sleep(1000);
      if (await alive(p)) { local.running = true; return; }
      const st = await call<{ running: boolean; log: string[] }>('comfy_status');
      if (!st.running) throw new Error(`ComfyUI zakończył działanie: ${st.log.slice(-6).join(' ').slice(-400) || 'brak logu'}`);
      progress(`uruchamiam ComfyUI · ${Math.round((Date.now() - start) / 1000)} s`);
    }
    throw new Error('ComfyUI nie wystartował w 5 minut');
  } finally { local.starting = false; }
}

/* ---------- generowanie ---------- */

type Ev = { type: string; data: any };

/** Kanał postępu: komunikaty JSON i podgląd (surowe bajty obrazu → adres blob). */
function openWs(base: string, client: string, onMsg: (e: Ev) => void, onPreview: (url: string) => void) {
  const ch = new Channel<Ev | ArrayBuffer>();
  ch.onmessage = (m) => {
    if (m instanceof ArrayBuffer) onPreview(URL.createObjectURL(new Blob([m])));
    else onMsg(m);
  };
  return call('comfy_ws', { url: `${base.replace(/^http/, 'ws')}/ws?clientId=${client}`, id: client, on: ch });
}

/** Jedno uruchomienie lokalnego modelu → pliki w folderze media. */
export async function comfyGenerate(p: Provider, op: MediaOp, model: string, cfg: MediaCfg, prompt: string, images: string[], progress: (s: string, preview?: string) => void): Promise<Media[]> {
  const pr = presetById(model) || presetsFor(op).find(installed) || presetsFor(op)[0];
  if (!pr) throw new Error('Brak lokalnego modelu dla tej operacji. Pobierz go w Ustawienia → Lokalne AI.');
  if (!isTauri) throw new Error('Lokalne modele działają tylko w aplikacji');
  return withGpu(async () => {
    clearTimeout(idleTimer);
    const base = baseOf(p);
    if (isLocalUrl(base)) await startComfy(progress);
    else if (!(await alive(p))) throw new Error(`ComfyUI nie odpowiada pod ${base}`);
    if (pr.files.length && app.local.comfyDir && isLocalUrl(base)) {
      if (!local.inst) await refreshLocal();
      const miss = missingFiles(pr);
      if (miss.length) throw new Error(`Brakuje plików modelu „${pr.name}” (${miss.map((m) => m.name).join(', ')}). Pobierz go w Ustawienia → Lokalne AI.`);
    }
    lastComfy = p;
    await gpuSwitch(`comfy:${pr.id}`);
    let image = '';
    if (images[0]) {
      progress('wysyłam obraz');
      const up = await req(p, 'POST', `${base}/upload/image`, null, [{ name: 'image', file: images[0] }, { name: 'overwrite', value: 'true' }]);
      image = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
    }
    const pp = params(pr, op, cfg, prompt, image);
    const graph = pr.build(op, pp);
    const client = nid('c');
    let finish!: (e?: Error) => void;
    const done = new Promise<void>((ok, fail) => { finish = (e) => (e ? fail(e) : ok()); });
    let promptId = '';
    let over = false;
    let shown = '';
    const t0 = Date.now();
    const status = async () => {
      const h = await req(p, 'GET', `${base}/history/${promptId}`).catch(() => null);
      const st = h?.[promptId]?.status;
      if (st?.completed) finish();
      else if (st?.status_str === 'error') finish(new Error('ComfyUI zgłosił błąd wykonania'));
    };
    // Zerwane połączenie: wznawiamy z tym samym clientId, a w międzyczasie sprawdzamy historię zadania.
    const reconnect = async () => {
      for (let i = 0; i < 30 && !over; i++) {
        await sleep(2000);
        if (promptId) await status();
        if (over) return;
        if (await connect().then(() => true, () => false)) return;
      }
      finish(new Error('Połączenie z ComfyUI zostało zerwane'));
    };
    const onMsg = ({ type, data }: Ev) => {
      if (data?.prompt_id && promptId && data.prompt_id !== promptId) return;
      if (type === 'progress') progress(`krok ${data.value}/${data.max}`);
      else if (type === 'execution_start') progress('ładuję model');
      else if (type === 'execution_error') finish(new Error(`${data.node_type || 'ComfyUI'}: ${String(data.exception_message || 'błąd').trim().slice(0, 400)}`));
      else if (type === 'execution_interrupted') finish(new Error('Przerwano w ComfyUI'));
      else if (type === 'execution_success' || (type === 'executing' && data?.node === null && data?.prompt_id === promptId)) finish();
      else if (type === 'tx_closed' && !over) void reconnect();
    };
    const onPreview = (url: string) => {
      if (over) return URL.revokeObjectURL(url);
      if (shown) URL.revokeObjectURL(shown);
      shown = url;
      progress(`generuję · ${Math.round((Date.now() - t0) / 1000)} s`, url);
    };
    const connect = () => openWs(base, client, onMsg, onPreview);
    void done.finally(() => { over = true; });
    try {
      await connect();
      progress('w kolejce');
      const r = await req(p, 'POST', `${base}/prompt`, { prompt: graph, client_id: client });
      promptId = r.prompt_id;
      await done;
      const h = await req(p, 'GET', `${base}/history/${promptId}`);
      const outs: { filename: string; subfolder: string; type: string }[] = [];
      for (const n of Object.values<any>(h?.[promptId]?.outputs || {})) for (const v of Object.values<any>(n)) if (Array.isArray(v)) for (const f of v) if (f?.filename) outs.push(f);
      const files = outs.some((x) => x.type === 'output') ? outs.filter((x) => x.type === 'output') : outs;
      if (!files.length) throw new Error('ComfyUI nie zwrócił plików');
      progress('pobieram');
      return await Promise.all(files.map(async (x) => {
        const path = await call<string>('media_download', { provider: ref(p), url: `${base}/view?filename=${encodeURIComponent(x.filename)}&subfolder=${encodeURIComponent(x.subfolder || '')}&type=${x.type}`, ext: null });
        return { kind: /\.(mp4|webm|mov|mkv)$/i.test(x.filename) ? 'video' as const : 'image' as const, path, seed: pp.seed };
      }));
    } finally {
      over = true;
      call('comfy_ws_close', { id: client }).catch(() => {});
      finish?.();
      // Podgląd znika z noda chwilę później (gotowy wynik go zastępuje).
      if (shown) setTimeout(() => URL.revokeObjectURL(shown), 2000);
      armIdle();
    }
  });
}
