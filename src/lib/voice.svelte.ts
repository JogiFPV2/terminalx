// Głos: dyktowanie i czytanie odpowiedzi.
// Nagranie z mikrofonu (MediaRecorder, opus ~32 kb/s) idzie do `/audio/transcriptions` providera zgodnego
// z OpenAI (OpenAI, Groq, lokalny Whisper). Odpowiedzi czytają głosy systemu (speechSynthesis, offline)
// albo `/audio/speech` providera. Nic nie działa w tle, dopóki użytkownik nie nagrywa ani nie słucha.
import { call } from './ipc';
import { app, notify } from './state.svelte';
import { currentLang } from './i18n';
import { b64 } from './attach';
import type { ChatMsg, Provider, Workspace } from './types';

/** Typy providerów z API audio w formacie OpenAI. */
const AUDIO_TYPES = ['openai', 'compat'];
const MAX_SEC = 600;

export const voice = $state({
  /** Workspace, w którym trwa nagranie ('' = nie nagrywa). */
  rec: '',
  secs: 0,
  level: 0,
  /** Trwa zamiana nagrania na tekst. */
  busy: false,
  /** Id czytanej wiadomości. */
  speaking: '',
});

export const audioProviders = () => app.providers.filter((p) => AUDIO_TYPES.includes(p.type) && p.hasKey);
const pick = (id: string) => app.providers.find((p) => p.id === id && AUDIO_TYPES.includes(p.type)) || audioProviders()[0];
export const sttProvider = () => pick(app.voice.sttProvider);
export const ttsProvider = () => pick(app.voice.ttsProvider);
export const defaultSttModel = (p?: Provider) => (!p ? '' : /groq\.com/.test(p.url) ? 'whisper-large-v3-turbo' : p.type === 'openai' ? 'gpt-4o-mini-transcribe' : 'whisper-1');
const ref = (p: Provider) => ({ type: p.type, url: p.url, keyRef: p.keyRef });
const langCode = () => (app.voice.lang === 'auto' ? '' : app.voice.lang || currentLang());

/* ---------- nagrywanie ---------- */

let rec: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let actx: AudioContext | null = null;
let chunks: Blob[] = [];
let tick = 0, raf = 0;
let done: ((b: Blob | null) => void) | null = null;

function release() {
  clearInterval(tick); cancelAnimationFrame(raf);
  stream?.getTracks().forEach((t) => t.stop());
  actx?.close().catch(() => {});
  rec = null; stream = null; actx = null;
  voice.rec = ''; voice.level = 0;
}

export async function startRec(wsId: string) {
  if (rec) return;
  stopSpeaking();
  if (!sttProvider()) {
    notify('Dyktowanie potrzebuje providera OpenAI albo zgodnego z OpenAI (np. Groq) z kluczem API. Ustaw go w Ustawienia → Głos.', 'warning', 7000);
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    notify(`Brak dostępu do mikrofonu: ${(e as Error).message || e}`, 'error');
    return;
  }
  const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
  rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 });
  chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    const blob = chunks.length ? new Blob(chunks, { type: rec?.mimeType || mime || 'audio/webm' }) : null;
    chunks = [];
    release();
    done?.(blob); done = null;
  };
  rec.start(1000);
  voice.rec = wsId; voice.secs = 0;
  const t0 = Date.now();
  tick = window.setInterval(() => {
    voice.secs = Math.floor((Date.now() - t0) / 1000);
    if (voice.secs >= MAX_SEC) { notify('Nagranie ma limit 10 minut.', 'info'); rec?.stop(); }
  }, 250);
  // Poziom głośności dla wskaźnika przy przycisku.
  actx = new AudioContext();
  const an = actx.createAnalyser();
  an.fftSize = 512;
  actx.createMediaStreamSource(stream).connect(an);
  const buf = new Uint8Array(an.fftSize);
  const loop = () => {
    an.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    voice.level = Math.min(1, peak / 64);
    raf = requestAnimationFrame(loop);
  };
  loop();
}

/** Kończy nagrywanie i zwraca nagranie (null przy pustym). */
export function stopRec(): Promise<Blob | null> {
  if (!rec) return Promise.resolve(null);
  return new Promise((res) => { done = res; rec!.stop(); });
}

export function cancelRec() {
  if (!rec) return;
  done = null;
  rec.onstop = () => { chunks = []; release(); };
  rec.stop();
}

export interface Dictation { text: string; blob: Blob; data: string }

/** Nagranie → tekst u wybranego providera. */
export async function transcribe(blob: Blob): Promise<Dictation> {
  const p = sttProvider();
  if (!p) throw new Error('Brak providera do dyktowania. Ustaw go w Ustawienia → Głos.');
  voice.busy = true;
  try {
    const data = await b64(blob);
    const text = await call<string>('ai_transcribe', { provider: ref(p), model: app.voice.sttModel || defaultSttModel(p), data, mime: blob.type, lang: langCode() || null });
    return { text, blob, data };
  } finally { voice.busy = false; }
}

/** Zamiana na tekst gotowego nagrania (base64), np. z dyktafonu telefonu. */
export async function transcribeData(data: string, mime: string): Promise<string> {
  const p = sttProvider();
  if (!p) throw new Error('Brak providera do dyktowania. Ustaw go w Ustawienia → Głos.');
  return call<string>('ai_transcribe', { provider: ref(p), model: app.voice.sttModel || defaultSttModel(p), data, mime, lang: langCode() || null });
}

/* ---------- czytanie ---------- */

/** Tekst do przeczytania: bez bloków kodu, znaczników markdown i adresów. */
export function speakable(s: string) {
  return s.replace(/```[\s\S]*?```/g, ' (kod pominięty) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~]{1,3}([^*_~\n]+)[*_~]{1,3}/g, '$1')
    .replace(/[ \t]{2,}/g, ' ').replace(/\s+\n/g, '\n').trim()
    .slice(0, 6000);
}

/** Kawałki do ~`max` znaków, cięte na końcach zdań (limit /audio/speech to 4096). */
function chunked(s: string, max: number) {
  const out: string[] = [];
  let cur = '';
  for (const part of s.split(/(?<=[.!?…:;])\s+|\n+/)) {
    if (cur && cur.length + part.length + 1 > max) { out.push(cur); cur = ''; }
    cur = cur ? `${cur} ${part}` : part;
    while (cur.length > max) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

let queue: { id: string; text: string }[] = [];
let player: HTMLAudioElement | null = null;
/** Numer odtwarzania: zatrzymanie unieważnia zaległe pobrania z providera. */
let gen = 0;

export function systemVoices() {
  return typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices();
}
function sysVoice() {
  const all = systemVoices();
  const lang = langCode() || currentLang();
  return all.find((v) => v.name === app.voice.sysVoice) || all.find((v) => v.lang.toLowerCase().startsWith(lang)) || null;
}

function sayOnSystem(text: string, my: number): Promise<void> {
  return new Promise((res) => {
    const parts = chunked(text, 600);
    const v = sysVoice();
    let left = parts.length;
    if (!left) return res();
    for (const p of parts) {
      const u = new SpeechSynthesisUtterance(p);
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = langCode() || currentLang();
      u.rate = app.voice.rate || 1;
      u.onend = u.onerror = () => { if (--left === 0 || my !== gen) res(); };
      speechSynthesis.speak(u);
    }
  });
}

async function sayOnProvider(text: string, my: number) {
  const p = ttsProvider();
  if (!p) throw new Error('Brak providera do czytania. Ustaw go w Ustawienia → Głos albo wybierz głosy systemu.');
  const parts = chunked(text, 3800);
  // Następny kawałek pobiera się w trakcie odtwarzania poprzedniego.
  const fetchPart = (s: string) => call<string>('ai_speech', { provider: ref(p), model: app.voice.ttsModel || 'gpt-4o-mini-tts', voice: app.voice.ttsVoice || 'coral', input: s, instructions: app.voice.ttsStyle || null });
  let next = parts.length ? fetchPart(parts[0]) : null;
  for (let i = 0; i < parts.length && my === gen; i++) {
    const data = await next!;
    next = i + 1 < parts.length ? fetchPart(parts[i + 1]) : null;
    if (my !== gen) return;
    await new Promise<void>((res) => {
      player = new Audio(`data:audio/mpeg;base64,${data}`);
      player.playbackRate = 1;
      player.onended = player.onerror = () => res();
      player.play().catch(() => res());
    });
  }
}

async function drain() {
  if (voice.speaking) return;
  const my = gen;
  while (queue.length && my === gen) {
    const item = queue.shift()!;
    voice.speaking = item.id;
    try {
      if (app.voice.engine === 'provider') await sayOnProvider(item.text, my);
      else await sayOnSystem(item.text, my);
    } catch (e) {
      notify(String(e).replace(/^Error: /, ''), 'error');
      queue = [];
    }
  }
  if (my === gen) voice.speaking = '';
}

/** Czyta tekst (kolejka: kolejne odpowiedzi czekają na swoją kolej). */
export function speak(id: string, text: string) {
  const t = speakable(text);
  if (!t) return;
  queue.push({ id, text: t });
  drain();
}

export function stopSpeaking() {
  gen++;
  queue = [];
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  if (player) { player.pause(); player = null; }
  voice.speaking = '';
}

/** Czyta lub zatrzymuje wiadomość (przycisk przy wiadomości). */
export function toggleSpeak(m: ChatMsg) {
  if (voice.speaking === m.id) stopSpeaking();
  else { stopSpeaking(); speak(m.id, m.text); }
}

/** Nowa odpowiedź w rozmowie: czytana, gdy włączono czytanie i workspace jest na wierzchu. */
export function autoSpeak(ws: Workspace, m: ChatMsg) {
  const mode = app.voice?.speak;
  if (!mode || mode === 'off' || ws.id !== app.activeWs || !m.text) return;
  // Zlecenia agenta dla podagentów („Agent → podagent …”) to nie odpowiedź dla użytkownika.
  if ((m.role === 'agent' && !m.who.includes('→')) || (m.role === 'sub' && mode === 'all')) speak(m.id, m.text);
}
