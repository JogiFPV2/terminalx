// Lokalna grafika i wideo przez ComfyUI. Aplikacja uruchamia ComfyUI dopiero, gdy workflow go potrzebuje,
// i zatrzymuje po bezczynności. Na karcie graficznej jest zawsze jeden model: zadania lokalne (ComfyUI i Ollama)
// idą przez wspólną kolejkę, a przy zmianie modelu poprzedni jest zwalniany.
import { call, isTauri } from '../ipc';
import { app } from '../state.svelte';
import { nid, sleep } from '../util';
import type { ComfyCustom, Media, MediaCfg, MediaOp, Provider } from '../types';

/* ---------- przepisy modeli ---------- */

export interface ModelFile { dir: string; name: string; url: string; size: number }
interface P { prompt: string; negative: string; seed: number; width: number; height: number; frames: number; fps: number; image: string; x: Record<string, any> }
export interface Preset {
  id: string;
  name: string;
  desc: string;
  ops: MediaOp[];
  /** Zalecana pamięć karty i RAM (GB) do pracy bez dużego spowolnienia. */
  vram: number;
  ram: number;
  files: ModelFile[];
  /** Liczba pikseli kadru (proporcje wybiera node) i wielokrotność wymiarów. */
  area: number;
  mult: number;
  fps?: number;
  /** Długość klipu: klatki = step·k + 1 (Wan 4, LTX 8). */
  step?: number;
  dur?: number;
  build: (op: MediaOp, p: P) => Graph;
}
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

const HF = 'https://huggingface.co/';
const f = (dir: string, name: string, path: string, size: number): ModelFile => ({ dir, name, url: HF + path, size });
const F = {
  sdxl: f('checkpoints', 'sd_xl_base_1.0.safetensors', 'stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors', 6938078334),
  qwen4b: f('text_encoders', 'qwen_3_4b_fp8_mixed.safetensors', 'Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b_fp8_mixed.safetensors', 5631994051),
  zimage: f('diffusion_models', 'z_image_turbo_int8_convrot.safetensors', 'Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_int8_convrot.safetensors', 6201001296),
  ae: f('vae', 'ae.safetensors', 'Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors', 335304388),
  klein: f('diffusion_models', 'flux-2-klein-4b-fp8.safetensors', 'black-forest-labs/FLUX.2-klein-4b-fp8/resolve/main/flux-2-klein-4b-fp8.safetensors', 4070624520),
  f2vae: f('vae', 'flux2-vae.safetensors', 'Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors', 336213556),
  umt5: f('text_encoders', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', 'Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors', 6735906897),
  wanvae: f('vae', 'wan_2.1_vae.safetensors', 'Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors', 253815318),
  wan13: f('diffusion_models', 'wan2.1_t2v_1.3B_fp16.safetensors', 'Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors', 2838303560),
  wan5: f('diffusion_models', 'wan2.2_ti2v_5B_fp16.safetensors', 'Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors', 9999658848),
  wan22vae: f('vae', 'wan2.2_vae.safetensors', 'Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors', 1409400960),
  ltxv: f('checkpoints', 'ltx-video-2b-v0.9.5.safetensors', 'Lightricks/LTX-Video/resolve/main/ltx-video-2b-v0.9.5.safetensors', 6340729500),
  t5: f('text_encoders', 't5xxl_fp8_e4m3fn_scaled.safetensors', 'comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn_scaled.safetensors', 5157348688),
  birefnet: f('background_removal', 'birefnet.safetensors', 'Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors', 444473596),
  svr: f('diffusion_models', 'seedvr2_3b_int8_convrot.safetensors', 'Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_3b_int8_convrot.safetensors', 3458259704),
  svrvae: f('vae', 'seedvr2_ema_vae_fp16.safetensors', 'Comfy-Org/SeedVR2/resolve/main/vae/seedvr2_ema_vae_fp16.safetensors', 501324814),
  qimg: f('diffusion_models', 'qwen_image_2512_fp8_e4m3fn.safetensors', 'Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors', 20430679144),
  qvl: f('text_encoders', 'qwen_2.5_vl_7b_fp8_scaled.safetensors', 'Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors', 9384670680),
  qvae: f('vae', 'qwen_image_vae.safetensors', 'Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors', 253806246),
  qlight: f('loras', 'Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors', 'lightx2v/Qwen-Image-2512-Lightning/resolve/main/Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors', 1698951104),
};
const W22 = 'Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/';
const wan14 = (kind: 't2v' | 'i2v') => {
  const size = kind === 't2v' ? 14293923632 : 14294742832;
  const lora = kind === 't2v' ? 'v1.1' : 'v1';
  return ['high', 'low'].flatMap((n) => [
    f('diffusion_models', `wan2.2_${kind}_${n}_noise_14B_fp8_scaled.safetensors`, `${W22}diffusion_models/wan2.2_${kind}_${n}_noise_14B_fp8_scaled.safetensors`, size),
    f('loras', `wan2.2_${kind}_lightx2v_4steps_lora_${lora}_${n}_noise.safetensors`, `${W22}loras/wan2.2_${kind}_lightx2v_4steps_lora_${lora}_${n}_noise.safetensors`, 1226977424),
  ]);
};

/** Budowa grafu w formacie API ComfyUI. */
function graph() {
  const g: Graph = {};
  let i = 0;
  const add = (class_type: string, inputs: Record<string, unknown>) => { const id = String(++i); g[id] = { class_type, inputs }; return id; };
  return { g, add };
}
const o = (id: string, slot = 0) => [id, slot];
const SAVE_IMG = (add: ReturnType<typeof graph>['add'], img: unknown[]) => add('SaveImage', { filename_prefix: 'TerminalX/img', images: img });
const SAVE_VID = (add: ReturnType<typeof graph>['add'], frames: unknown[], fps: number) =>
  add('SaveVideo', { filename_prefix: 'TerminalX/vid', format: 'auto', 'format.codec': 'auto', video: o(add('CreateVideo', { fps, images: frames })) });
const NEG_WAN = '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走';
const NEG_LTX = 'low quality, worst quality, deformed, distorted, disfigured, motion smear, motion artifacts, fused fingers, bad anatomy, weird hand, ugly';

export const PRESETS: Preset[] = [
  {
    id: 'zimage', name: 'Z-Image Turbo', desc: 'Szybkie, realistyczne obrazy w 8 krokach. Dobry wybór na 8–12 GB.',
    ops: ['image'], vram: 8, ram: 16, files: [F.zimage, F.qwen4b, F.ae], area: 1024 * 1024, mult: 16,
    build: (_, p) => {
      const { g, add } = graph();
      const clip = add('CLIPLoader', { clip_name: F.qwen4b.name, type: 'lumina2', device: 'default' });
      const unet = add('UNETLoader', { unet_name: F.zimage.name, weight_dtype: 'default' });
      const ms = add('ModelSamplingAuraFlow', { shift: p.x.shift ?? 3, model: o(unet) });
      const pos = add('CLIPTextEncode', { text: p.prompt, clip: o(clip) });
      const lat = add('EmptySD3LatentImage', { width: p.width, height: p.height, batch_size: 1 });
      const ks = add('KSampler', { seed: p.seed, steps: p.x.steps ?? 8, cfg: p.x.cfg ?? 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1, model: o(ms), positive: o(pos), negative: o(add('ConditioningZeroOut', { conditioning: o(pos) })), latent_image: o(lat) });
      SAVE_IMG(add, o(add('VAEDecode', { samples: o(ks), vae: o(add('VAELoader', { vae_name: F.ae.name })) })));
      return g;
    },
  },
  {
    id: 'klein4b', name: 'FLUX.2 Klein 4B', desc: 'Obrazy i edycja obrazu poleceniem („zmień kolor torby na niebieski”). 4 kroki.',
    ops: ['image', 'edit'], vram: 8, ram: 16, files: [F.klein, F.qwen4b, F.f2vae], area: 1024 * 1024, mult: 16,
    build: (op, p) => {
      const { g, add } = graph();
      const unet = add('UNETLoader', { unet_name: F.klein.name, weight_dtype: 'default' });
      const clip = add('CLIPLoader', { clip_name: F.qwen4b.name, type: 'flux2', device: 'default' });
      const vae = add('VAELoader', { vae_name: F.f2vae.name });
      let pos = add('CLIPTextEncode', { text: p.prompt, clip: o(clip) });
      let neg = add('ConditioningZeroOut', { conditioning: o(pos) });
      let w: unknown = p.width, h: unknown = p.height;
      if (op === 'edit') {
        const img = add('ImageScaleToTotalPixels', { upscale_method: 'lanczos', megapixels: p.x.megapixels ?? 1, resolution_steps: 1, image: o(add('LoadImage', { image: p.image })) });
        const size = add('GetImageSize', { image: o(img) });
        w = o(size, 0); h = o(size, 1);
        const ref = add('VAEEncode', { pixels: o(img), vae: o(vae) });
        pos = add('ReferenceLatent', { conditioning: o(pos), latent: o(ref) });
        neg = add('ReferenceLatent', { conditioning: o(neg), latent: o(ref) });
      }
      const s = add('SamplerCustomAdvanced', {
        noise: o(add('RandomNoise', { noise_seed: p.seed })),
        guider: o(add('CFGGuider', { cfg: p.x.cfg ?? 1, model: o(unet), positive: o(pos), negative: o(neg) })),
        sampler: o(add('KSamplerSelect', { sampler_name: 'euler' })),
        sigmas: o(add('Flux2Scheduler', { steps: p.x.steps ?? 4, width: w, height: h })),
        latent_image: o(add('EmptyFlux2LatentImage', { width: w, height: h, batch_size: 1 })),
      });
      SAVE_IMG(add, o(add('VAEDecode', { samples: o(s), vae: o(vae) })));
      return g;
    },
  },
  {
    id: 'sdxl', name: 'SDXL', desc: 'Klasyczny, lekki model obrazów z ogromną liczbą dodatków.',
    ops: ['image'], vram: 6, ram: 12, files: [F.sdxl], area: 1024 * 1024, mult: 64,
    build: (_, p) => {
      const { g, add } = graph();
      const ck = add('CheckpointLoaderSimple', { ckpt_name: F.sdxl.name });
      const ks = add('KSampler', {
        seed: p.seed, steps: p.x.steps ?? 25, cfg: p.x.cfg ?? 7, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1, model: o(ck),
        positive: o(add('CLIPTextEncode', { text: p.prompt, clip: o(ck, 1) })),
        negative: o(add('CLIPTextEncode', { text: p.negative || 'lowres, blurry, watermark, text, deformed', clip: o(ck, 1) })),
        latent_image: o(add('EmptyLatentImage', { width: p.width, height: p.height, batch_size: 1 })),
      });
      SAVE_IMG(add, o(add('VAEDecode', { samples: o(ks), vae: o(ck, 2) })));
      return g;
    },
  },
  {
    id: 'ltxv', name: 'LTX-Video 2B', desc: 'Szybkie klipy wideo z tekstu albo obrazu (768×512, do ok. 5 s).',
    ops: ['video', 'i2v'], vram: 8, ram: 16, files: [F.ltxv, F.t5], area: 768 * 512, mult: 32, fps: 24, step: 8, dur: 4,
    build: (op, p) => {
      const { g, add } = graph();
      const clip = add('CLIPLoader', { clip_name: F.t5.name, type: 'ltxv', device: 'default' });
      const ck = add('CheckpointLoaderSimple', { ckpt_name: F.ltxv.name });
      const pos = add('CLIPTextEncode', { text: p.prompt, clip: o(clip) });
      const neg = add('CLIPTextEncode', { text: p.negative || NEG_LTX, clip: o(clip) });
      let cp = o(pos), cn = o(neg), lat: unknown[];
      if (op === 'i2v') {
        const i2v = add('LTXVImgToVideo', { positive: cp, negative: cn, vae: o(ck, 2), image: o(add('LoadImage', { image: p.image })), width: p.width, height: p.height, length: p.frames, batch_size: 1, strength: p.x.strength ?? 1 });
        cp = o(i2v, 0); cn = o(i2v, 1); lat = o(i2v, 2);
      } else lat = o(add('EmptyLTXVLatentVideo', { width: p.width, height: p.height, length: p.frames, batch_size: 1 }));
      const cond = add('LTXVConditioning', { frame_rate: p.fps, positive: cp, negative: cn });
      const sc = add('SamplerCustom', {
        add_noise: true, noise_seed: p.seed, cfg: p.x.cfg ?? 3, model: o(ck), positive: o(cond, 0), negative: o(cond, 1),
        sampler: o(add('KSamplerSelect', { sampler_name: 'euler' })),
        sigmas: o(add('LTXVScheduler', { steps: p.x.steps ?? 30, max_shift: 2.05, base_shift: 0.95, stretch: true, terminal: 0.1, latent: lat })),
        latent_image: lat,
      });
      SAVE_VID(add, o(add('VAEDecode', { samples: o(sc), vae: o(ck, 2) })), p.fps);
      return g;
    },
  },
  {
    id: 'wan21', name: 'Wan 2.1 1.3B', desc: 'Lekki model wideo z tekstu, 480p. Dobry ruch, wolniejszy niż LTX.',
    ops: ['video'], vram: 8, ram: 16, files: [F.wan13, F.umt5, F.wanvae], area: 832 * 480, mult: 16, fps: 16, step: 4, dur: 3,
    build: (_, p) => {
      const { g, add } = graph();
      const clip = add('CLIPLoader', { clip_name: F.umt5.name, type: 'wan', device: 'default' });
      const ms = add('ModelSamplingSD3', { shift: p.x.shift ?? 8, model: o(add('UNETLoader', { unet_name: F.wan13.name, weight_dtype: 'default' })) });
      const ks = add('KSampler', {
        seed: p.seed, steps: p.x.steps ?? 30, cfg: p.x.cfg ?? 6, sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1, model: o(ms),
        positive: o(add('CLIPTextEncode', { text: p.prompt, clip: o(clip) })),
        negative: o(add('CLIPTextEncode', { text: p.negative || NEG_WAN, clip: o(clip) })),
        latent_image: o(add('EmptyHunyuanLatentVideo', { width: p.width, height: p.height, length: p.frames, batch_size: 1 })),
      });
      SAVE_VID(add, o(add('VAEDecode', { samples: o(ks), vae: o(add('VAELoader', { vae_name: F.wanvae.name })) })), p.fps);
      return g;
    },
  },
  {
    id: 'wan22_5b', name: 'Wan 2.2 5B', desc: 'Wideo 720p z tekstu albo obrazu. Przy 12 GB działa z odciążaniem pamięci, wolniej.',
    ops: ['video', 'i2v'], vram: 12, ram: 24, files: [F.wan5, F.umt5, F.wan22vae], area: 1280 * 704, mult: 32, fps: 24, step: 4, dur: 3,
    build: (op, p) => {
      const { g, add } = graph();
      const clip = add('CLIPLoader', { clip_name: F.umt5.name, type: 'wan', device: 'default' });
      const vae = add('VAELoader', { vae_name: F.wan22vae.name });
      const ms = add('ModelSamplingSD3', { shift: p.x.shift ?? 8, model: o(add('UNETLoader', { unet_name: F.wan5.name, weight_dtype: 'default' })) });
      const lat = add('Wan22ImageToVideoLatent', { vae: o(vae), width: p.width, height: p.height, length: p.frames, batch_size: 1, ...(op === 'i2v' ? { start_image: o(add('LoadImage', { image: p.image })) } : {}) });
      const ks = add('KSampler', {
        seed: p.seed, steps: p.x.steps ?? 20, cfg: p.x.cfg ?? 5, sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1, model: o(ms),
        positive: o(add('CLIPTextEncode', { text: p.prompt, clip: o(clip) })),
        negative: o(add('CLIPTextEncode', { text: p.negative || NEG_WAN, clip: o(clip) })),
        latent_image: o(lat),
      });
      SAVE_VID(add, o(add('VAEDecode', { samples: o(ks), vae: o(vae) })), p.fps);
      return g;
    },
  },
  {
    id: 'birefnet', name: 'BiRefNet', desc: 'Usuwanie tła (przezroczyste PNG). Bardzo lekki.',
    ops: ['rmbg'], vram: 2, ram: 8, files: [F.birefnet], area: 0, mult: 1,
    build: (_, p) => {
      const { g, add } = graph();
      const img = add('LoadImage', { image: p.image });
      const mask = add('RemoveBackground', { bg_removal_model: o(add('LoadBackgroundRemovalModel', { bg_removal_name: F.birefnet.name })), image: o(img) });
      SAVE_IMG(add, o(add('JoinImageWithAlpha', { image: o(img), alpha: o(add('InvertMask', { mask: o(mask) })) })));
      return g;
    },
  },
  {
    id: 'seedvr2', name: 'SeedVR2 3B', desc: 'Powiększenie obrazu (domyślnie 2×) z odtworzeniem detali.',
    ops: ['upscale'], vram: 6, ram: 12, files: [F.svr, F.svrvae], area: 0, mult: 1,
    build: (_, p) => {
      const { g, add } = graph();
      const vae = add('VAELoader', { vae_name: F.svrvae.name });
      const unet = add('UNETLoader', { unet_name: F.svr.name, weight_dtype: 'default' });
      const rz = add('ResizeImageMaskNode', { input: o(add('LoadImage', { image: p.image })), resize_type: 'scale by multiplier', 'resize_type.multiplier': p.x.scale ?? 2, scale_method: 'lanczos' });
      const tile = { tile_size: 512, overlap: 128, temporal_size: 4096, temporal_overlap: 8 };
      const enc = add('VAEEncodeTiled', { pixels: o(add('SeedVR2Preprocess', { resized_images: o(rz) })), vae: o(vae), ...tile });
      const cond = add('SeedVR2Conditioning', { model: o(unet), vae_conditioning: o(enc) });
      const ks = add('KSampler', { seed: p.seed, steps: 1, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: o(unet), positive: o(cond, 0), negative: o(cond, 1), latent_image: o(enc) });
      SAVE_IMG(add, o(add('SeedVR2PostProcessing', { images: o(add('VAEDecodeTiled', { samples: o(ks), vae: o(vae), ...tile })), original_resized_images: o(rz), color_correction_method: p.x.color ?? 'lab' })));
      return g;
    },
  },
  {
    id: 'qwen_image', name: 'Qwen-Image 2512', desc: 'Najwyższa jakość obrazów i napisów w obrazie. 4 kroki (Lightning). Mocny komputer.',
    ops: ['image'], vram: 24, ram: 48, files: [F.qimg, F.qvl, F.qvae, F.qlight], area: 1328 * 1328, mult: 16,
    build: (_, p) => {
      const { g, add } = graph();
      const clip = add('CLIPLoader', { clip_name: F.qvl.name, type: 'qwen_image', device: 'default' });
      const lora = add('LoraLoaderModelOnly', { lora_name: F.qlight.name, strength_model: 1, model: o(add('UNETLoader', { unet_name: F.qimg.name, weight_dtype: 'default' })) });
      const ks = add('KSampler', {
        seed: p.seed, steps: p.x.steps ?? 4, cfg: p.x.cfg ?? 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
        model: o(add('ModelSamplingAuraFlow', { shift: p.x.shift ?? 3.1, model: o(lora) })),
        positive: o(add('CLIPTextEncode', { text: p.prompt, clip: o(clip) })),
        negative: o(add('CLIPTextEncode', { text: p.negative || 'low resolution, low quality, deformed limbs, deformed fingers, oversaturated, waxy skin, blurry text', clip: o(clip) })),
        latent_image: o(add('EmptySD3LatentImage', { width: p.width, height: p.height, batch_size: 1 })),
      });
      SAVE_IMG(add, o(add('VAEDecode', { samples: o(ks), vae: o(add('VAELoader', { vae_name: F.qvae.name })) })));
      return g;
    },
  },
  ...(['t2v', 'i2v'] as const).map((kind): Preset => ({
    id: `wan22_14b_${kind}`, name: `Wan 2.2 14B ${kind === 't2v' ? 'tekst → wideo' : 'obraz → wideo'}`,
    desc: 'Najlepszy otwarty model wideo, 4 kroki (lightx2v). Karta 24 GB i 64 GB RAM.',
    ops: [kind === 't2v' ? 'video' : 'i2v'], vram: 24, ram: 64, files: [...wan14(kind), F.umt5, F.wanvae], area: 832 * 480, mult: 16, fps: 16, step: 4, dur: 5,
    build: (_, p) => {
      const { g, add } = graph();
      const clip = add('CLIPLoader', { clip_name: F.umt5.name, type: 'wan', device: 'default' });
      const vae = add('VAELoader', { vae_name: F.wanvae.name });
      const [hiU, hiL, loU, loL] = wan14(kind).map((x) => x.name);
      const model = (unet: string, lora: string) => o(add('ModelSamplingSD3', { shift: p.x.shift ?? 5, model: o(add('LoraLoaderModelOnly', { lora_name: lora, strength_model: 1, model: o(add('UNETLoader', { unet_name: unet, weight_dtype: 'default' })) })) }));
      let pos = o(add('CLIPTextEncode', { text: p.prompt, clip: o(clip) }));
      let neg = o(add('CLIPTextEncode', { text: p.negative || NEG_WAN, clip: o(clip) }));
      let lat: unknown[];
      if (kind === 'i2v') {
        const w = add('WanImageToVideo', { positive: pos, negative: neg, vae: o(vae), start_image: o(add('LoadImage', { image: p.image })), width: p.width, height: p.height, length: p.frames, batch_size: 1 });
        pos = o(w, 0); neg = o(w, 1); lat = o(w, 2);
      } else lat = o(add('EmptyHunyuanLatentVideo', { width: p.width, height: p.height, length: p.frames, batch_size: 1 }));
      const steps = p.x.steps ?? 4, half = Math.max(1, Math.floor(steps / 2));
      const common = { steps, cfg: p.x.cfg ?? 1, sampler_name: 'euler', scheduler: 'simple', positive: pos, negative: neg };
      const k1 = add('KSamplerAdvanced', { ...common, add_noise: 'enable', noise_seed: p.seed, start_at_step: 0, end_at_step: half, return_with_leftover_noise: 'enable', model: model(hiU, hiL), latent_image: lat });
      const k2 = add('KSamplerAdvanced', { ...common, add_noise: 'disable', noise_seed: 0, start_at_step: half, end_at_step: 10000, return_with_leftover_noise: 'disable', model: model(loU, loL), latent_image: o(k1) });
      SAVE_VID(add, o(add('VAEDecode', { samples: o(k2), vae: o(vae) })), p.fps);
      return g;
    },
  })),
];

/* ---------- własne workflow (format API) ---------- */

/** Sprawdza zaimportowany JSON i opisuje, co aplikacja w nim podmieni. */
export function inspectCustom(graph: Record<string, any>) {
  if (Array.isArray(graph?.nodes)) throw new Error('To jest workflow w formacie edytora. W ComfyUI wybierz Workflow → Export (API) i zaimportuj ten plik.');
  const nodes = Object.entries(graph || {}).filter(([, n]) => n && typeof n === 'object' && n.class_type);
  if (!nodes.length) throw new Error('To nie jest workflow ComfyUI w formacie API.');
  const texts = nodes.filter(([, n]) => typeof n.inputs?.text === 'string');
  // Prompt pozytywny i negatywny: po tym, do którego wejścia samplera prowadzi node.
  const feeds = (id: string, name: string, depth = 0): boolean => depth < 4 && nodes.some(([nid, n]) => Object.entries(n.inputs || {}).some(([k, v]) =>
    Array.isArray(v) && v[0] === id && (k === name || feeds(nid, name, depth + 1))));
  const pos = texts.find(([id]) => feeds(id, 'positive')) || texts[0];
  const neg = texts.find(([id]) => id !== pos?.[0] && feeds(id, 'negative'));
  const images = nodes.filter(([, n]) => n.class_type === 'LoadImage');
  const seeds = nodes.filter(([, n]) => ['seed', 'noise_seed'].some((k) => typeof n.inputs?.[k] === 'number'));
  const size = nodes.filter(([, n]) => typeof n.inputs?.width === 'number' && typeof n.inputs?.height === 'number');
  const video = nodes.some(([, n]) => /Video/.test(n.class_type) && /^Save|^VHS_VideoCombine/.test(n.class_type));
  const saves = nodes.filter(([, n]) => /^Save|VideoCombine|PreviewImage/.test(n.class_type));
  if (!saves.length) throw new Error('Workflow nie ma noda zapisującego wynik (np. Save Image albo Save Video).');
  return { pos: pos?.[0], neg: neg?.[0], images: images.map(([id]) => id), seeds: seeds.map(([id]) => id), size: size.map(([id]) => id), video };
}

function customPreset(c: ComfyCustom): Preset {
  const info = inspectCustom(c.graph);
  return {
    id: c.id, name: c.name, desc: 'Zaimportowany workflow', ops: [c.op], vram: 0, ram: 0, files: [], area: 0, mult: 8, fps: 16, step: 4,
    build: (_, p) => {
      const g: Graph = JSON.parse(JSON.stringify(c.graph));
      if (info.pos && p.prompt) g[info.pos].inputs.text = p.prompt;
      if (info.neg && p.negative) g[info.neg].inputs.text = p.negative;
      if (p.image) for (const id of info.images) g[id].inputs.image = p.image;
      for (const id of info.seeds) for (const k of ['seed', 'noise_seed']) if (typeof g[id].inputs[k] === 'number') g[id].inputs[k] = p.seed;
      for (const id of info.size) {
        // Proporcje z noda, ta sama liczba pikseli co w oryginale.
        const inp = g[id].inputs as Record<string, number>;
        if (p.width && p.height) { const area = inp.width * inp.height, r = p.width / p.height; inp.width = snap(Math.sqrt(area * r), 16); inp.height = snap(Math.sqrt(area / r), 16); }
        if (typeof inp.length === 'number' && p.frames) inp.length = p.frames;
      }
      for (const [k, v] of Object.entries(p.x)) for (const n of Object.values(g)) if (k in n.inputs && typeof n.inputs[k] !== 'object') n.inputs[k] = v;
      return g;
    },
  };
}

export function allPresets(): Preset[] {
  const out = [...PRESETS];
  for (const c of app.local.custom) { try { out.push(customPreset(c)); } catch { /* uszkodzony wpis */ } }
  return out;
}
export const presetById = (id: string) => allPresets().find((p) => p.id === id);
export const presetsFor = (op: MediaOp) => allPresets().filter((p) => p.ops.includes(op));

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

export async function download(id: string, url: string, dest: string) {
  await listenDl();
  local.dl[id] = { done: 0, total: 0 };
  const done = new Promise<void>((ok, fail) => dlWaiters.set(id, { ok, fail }));
  await call('dl_start', { id, url, dest });
  return done;
}

/** Pobiera brakujące pliki modelu (po kolei, żeby nie dzielić łącza). Wspólne pliki pobierają się raz. */
export async function downloadPreset(p: Preset) {
  if (!local.inst) throw new Error('Najpierw zainstaluj ComfyUI albo wskaż jego folder.');
  for (const m of missingFiles(p)) {
    const key = fileKey(m);
    if (local.dl[key] && !local.dl[key].error) continue;
    await download(key, m.url, `${local.inst.models}/${m.dir}/${m.name}`);
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

/** Instaluje przenośną wersję ComfyUI dla Windows z najnowszego wydania na GitHubie. */
export async function installComfy(progress: (s: string) => void) {
  const dir = app.local.comfyDir || await call<string>('comfy_default_dir');
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

async function alive(p: Provider) {
  try { await req(p, 'GET', `${p.url.replace(/\/$/, '')}/system_stats`); return true; } catch { return false; }
}

let idleTimer = 0;
function armIdle() {
  clearTimeout(idleTimer);
  const min = +app.local.idleMin;
  if (min > 0) idleTimer = window.setTimeout(() => { stopComfy(); }, min * 60_000);
}

export async function stopComfy() {
  clearTimeout(idleTimer);
  await call('comfy_stop').catch(() => {});
  local.running = false;
  gpuKey = '';
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

/* ---------- kolejka GPU: jeden model naraz ---------- */

let chain: Promise<unknown> = Promise.resolve();
let gpuKey = '';
let gpuComfy: Provider | null = null;

/** Zadania lokalnych modeli wykonują się po kolei, nawet z kilku workflow naraz. */
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

async function freeComfy() {
  if (gpuComfy && local.running) await req(gpuComfy, 'POST', `${gpuComfy.url.replace(/\/$/, '')}/free`, { unload_models: true, free_memory: true }).catch(() => {});
}

/** Przed zadaniem: zwalnia poprzedni model, jeśli jest inny (ComfyUI ↔ Ollama albo inny przepis). */
export async function gpuSwitch(key: string, comfy?: Provider) {
  if (key === gpuKey) return;
  if (gpuKey.startsWith('comfy:')) await freeComfy();
  if (key.startsWith('comfy:') && !gpuKey.startsWith('comfy:')) await unloadOllama();
  gpuKey = key;
  if (comfy) gpuComfy = comfy;
}

/** Klucz modelu lokalnego dla noda (do grupowania kolejności i kolejki), albo '' dla chmury. */
export function localKey(cfg: { provider?: string; model?: string }, media: boolean): string {
  const p = app.providers.find((x) => x.id === cfg.provider);
  if (media && p?.type === 'comfy') return `comfy:${cfg.model || ''}`;
  if (!media && (p?.type === 'ollama' || (!cfg.provider && app.providers.find((x) => x.id === app.defModel.provider)?.type === 'ollama'))) return `ollama:${cfg.model || app.defModel.model}`;
  return '';
}

/* ---------- generowanie ---------- */

const snap = (v: number, m: number) => Math.max(m, Math.round(v / m) * m);

function params(pr: Preset, op: MediaOp, cfg: MediaCfg, prompt: string, image: string): P {
  let x: Record<string, any> = {};
  if (cfg.params?.trim()) { try { x = JSON.parse(cfg.params); } catch { throw new Error('Parametry modelu muszą być poprawnym JSON-em, np. {"steps": 20}'); } }
  const [a, b] = (cfg.aspect || '1:1').split(':').map(Number);
  const area = pr.area || 1024 * 1024, r = (a || 1) / (b || 1);
  const fps = +(x.fps ?? pr.fps ?? 16), step = pr.step || 4;
  const dur = +cfg.duration || pr.dur || 3;
  const p: P = {
    prompt, negative: cfg.negative || '', seed: cfg.seed ? +cfg.seed : Math.floor(Math.random() * 2 ** 48), image, fps,
    width: +(x.width ?? snap(Math.sqrt(area * r), pr.mult)), height: +(x.height ?? snap(Math.sqrt(area / r), pr.mult)),
    frames: +(x.frames ?? Math.round((dur * fps) / step) * step + 1), x,
  };
  for (const k of ['fps', 'width', 'height', 'frames']) delete x[k];
  if (!pr.ops.includes(op)) throw new Error(`„${pr.name}” nie obsługuje tej operacji`);
  return p;
}

type Ev = { type: string; data: any };
let wsListening: Promise<void> | null = null;
const wsHandlers = new Map<string, { msg: (e: Ev) => void; preview: (d: string) => void }>();
function listenWs() {
  wsListening ??= (async () => {
    const { listen } = await import('@tauri-apps/api/event');
    await listen<{ id: string; msg: Ev }>('comfy-ws', (e) => wsHandlers.get(e.payload.id)?.msg(e.payload.msg));
    await listen<{ id: string; data: string }>('comfy-preview', (e) => wsHandlers.get(e.payload.id)?.preview(e.payload.data));
  })();
  return wsListening;
}

/** Jedno uruchomienie lokalnego modelu → pliki w folderze media. */
export async function comfyGenerate(p: Provider, op: MediaOp, model: string, cfg: MediaCfg, prompt: string, images: string[], progress: (s: string, preview?: string) => void): Promise<Media[]> {
  const pr = presetById(model) || presetsFor(op).find(installed) || presetsFor(op)[0];
  if (!pr) throw new Error('Brak lokalnego modelu dla tej operacji. Pobierz go w Ustawienia → Lokalne AI.');
  if (!isTauri) throw new Error('Lokalne modele działają tylko w aplikacji');
  return withGpu(async () => {
    clearTimeout(idleTimer);
    const base = p.url.replace(/\/$/, '');
    if (isLocalUrl(base)) await startComfy(progress);
    else if (!(await alive(p))) throw new Error(`ComfyUI nie odpowiada pod ${base}`);
    if (pr.files.length && app.local.comfyDir && isLocalUrl(base)) {
      if (!local.inst) await refreshLocal();
      const miss = missingFiles(pr);
      if (miss.length) throw new Error(`Brakuje plików modelu „${pr.name}” (${miss.map((m) => m.name).join(', ')}). Pobierz go w Ustawienia → Lokalne AI.`);
    }
    await gpuSwitch(`comfy:${pr.id}`, p);
    let image = '';
    if (images[0]) {
      progress('wysyłam obraz');
      const up = await req(p, 'POST', `${base}/upload/image`, null, [{ name: 'image', file: images[0] }, { name: 'overwrite', value: 'true' }]);
      image = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
    }
    const graph = pr.build(op, params(pr, op, cfg, prompt, image));
    const client = nid('c');
    await listenWs();
    let finish!: (e?: Error) => void;
    const done = new Promise<void>((ok, fail) => { finish = (e) => (e ? fail(e) : ok()); });
    let promptId = '';
    let over = false;
    const t0 = Date.now();
    wsHandlers.set(client, {
      msg: ({ type, data }) => {
        if (data?.prompt_id && promptId && data.prompt_id !== promptId) return;
        if (type === 'progress') progress(`krok ${data.value}/${data.max}`);
        else if (type === 'execution_start') progress('ładuję model');
        else if (type === 'execution_error') finish(new Error(`${data.node_type || 'ComfyUI'}: ${String(data.exception_message || 'błąd').trim().slice(0, 400)}`));
        else if (type === 'execution_interrupted') finish(new Error('Przerwano w ComfyUI'));
        else if (type === 'execution_success' || (type === 'executing' && data?.node === null && data?.prompt_id === promptId)) finish();
        else if (type === 'tx_closed') finish(new Error('Połączenie z ComfyUI zostało zerwane'));
      },
      preview: (d) => progress(`generuję · ${Math.round((Date.now() - t0) / 1000)} s`, d),
    });
    try {
      await call('comfy_ws', { url: `${base.replace(/^http/, 'ws')}/ws?clientId=${client}`, id: client });
      progress('w kolejce');
      const r = await req(p, 'POST', `${base}/prompt`, { prompt: graph, client_id: client });
      promptId = r.prompt_id;
      // Zapasowo co 5 s sprawdzamy historię (gdyby komunikat o końcu zaginął).
      void (async () => {
        while (!over) {
          await sleep(5000);
          if (over) return;
          const h = await req(p, 'GET', `${base}/history/${promptId}`).catch(() => null);
          const st = h?.[promptId]?.status;
          if (st?.completed) return finish();
          if (st?.status_str === 'error') return finish(new Error('ComfyUI zgłosił błąd wykonania'));
        }
      })();
      await done;
      const h = await req(p, 'GET', `${base}/history/${promptId}`);
      const outs: { filename: string; subfolder: string; type: string }[] = [];
      for (const n of Object.values<any>(h?.[promptId]?.outputs || {})) for (const v of Object.values<any>(n)) if (Array.isArray(v)) for (const f of v) if (f?.filename) outs.push(f);
      const files = outs.some((x) => x.type === 'output') ? outs.filter((x) => x.type === 'output') : outs;
      if (!files.length) throw new Error('ComfyUI nie zwrócił plików');
      progress('pobieram');
      return await Promise.all(files.map(async (x) => {
        const path = await call<string>('media_download', { provider: ref(p), url: `${base}/view?filename=${encodeURIComponent(x.filename)}&subfolder=${encodeURIComponent(x.subfolder || '')}&type=${x.type}`, ext: null });
        return { kind: /\.(mp4|webm|mov|mkv)$/i.test(x.filename) ? 'video' as const : 'image' as const, path };
      }));
    } finally {
      over = true;
      wsHandlers.delete(client);
      call('comfy_ws_close', { id: client }).catch(() => {});
      finish?.();
      armIdle();
    }
  });
}
