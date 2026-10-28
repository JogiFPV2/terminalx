// Motywy zgodne z tweakcn (zmienne shadcn) i paleta terminala wyprowadzana z motywu.
import { call, isTauri } from './ipc';
import type { ThemeDef, ThemeVars, ThemeMode } from './types';

const PAL = ['background', 'foreground', 'card', 'muted', 'muted-foreground', 'primary', 'primary-foreground', 'accent', 'border', 'destructive', 'sidebar', 'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'];

export const DEFAULT: { light: ThemeVars; dark: ThemeVars } = {
  light: { background: '#fafafa', foreground: '#18181b', card: '#ffffff', muted: '#f1f1f3', 'muted-foreground': '#71717a', primary: '#4f46e5', 'primary-foreground': '#ffffff', accent: '#ececf1', border: '#e4e4e7', destructive: '#dc2626', sidebar: '#f4f4f6', 'chart-1': '#16a34a', 'chart-2': '#2563eb', 'chart-3': '#d97706', 'chart-4': '#9333ea', 'chart-5': '#0891b2', 'term-bg': '#ffffff' },
  dark: { background: '#111114', foreground: '#e7e7ea', card: '#16161a', muted: '#1c1c21', 'muted-foreground': '#8b8b95', primary: '#8b8cf8', 'primary-foreground': '#0f0f14', accent: '#24242b', border: '#26262d', destructive: '#f87171', sidebar: '#0d0d10', 'chart-1': '#4ade80', 'chart-2': '#60a5fa', 'chart-3': '#fbbf24', 'chart-4': '#c084fc', 'chart-5': '#22d3ee', 'term-bg': '#0f0f12' },
};

export const BUILTIN: Record<string, ThemeDef | null> = {
  'Domyślny': null,
  'Nocny grafit': {
    dark: { background: '#0b0d10', foreground: '#d6dde6', card: '#101318', muted: '#151a20', 'muted-foreground': '#7d8794', primary: '#5fb3b3', 'primary-foreground': '#071012', accent: '#1a2028', border: '#1e252e', destructive: '#ec5f67', sidebar: '#080a0d', 'chart-1': '#99c794', 'chart-2': '#6699cc', 'chart-3': '#fac863', 'chart-4': '#c594c5', 'chart-5': '#5fb3b3' },
    light: { background: '#f6f8fa', foreground: '#1f2933', card: '#ffffff', muted: '#eceff3', 'muted-foreground': '#616e7c', primary: '#2b8a8a', 'primary-foreground': '#ffffff', accent: '#e4e8ee', border: '#dce1e7', destructive: '#cf3f48', sidebar: '#eef1f4', 'chart-1': '#3f8f3a', 'chart-2': '#2f6db3', 'chart-3': '#b7811a', 'chart-4': '#9b4f9b', 'chart-5': '#2b8a8a' },
  },
  'Ciepła glina': {
    dark: { background: '#16130f', foreground: '#ece4d8', card: '#1b1813', muted: '#221e18', 'muted-foreground': '#9a8f80', primary: '#e0915a', 'primary-foreground': '#1a0f06', accent: '#2a251e', border: '#2c271f', destructive: '#e5675a', sidebar: '#110f0b', 'chart-1': '#a7c080', 'chart-2': '#7fbbb3', 'chart-3': '#dbbc7f', 'chart-4': '#d699b6', 'chart-5': '#83c092' },
    light: { background: '#fbf8f3', foreground: '#2d2620', card: '#ffffff', muted: '#f2ece3', 'muted-foreground': '#7a6e60', primary: '#c0632b', 'primary-foreground': '#ffffff', accent: '#efe7dc', border: '#e6ddd0', destructive: '#c4443a', sidebar: '#f5f0e8', 'chart-1': '#6a8a3a', 'chart-2': '#3a7d74', 'chart-3': '#a8791f', 'chart-4': '#a4567c', 'chart-5': '#4b8b5c' },
  },
  'Las': {
    dark: { background: '#0f1411', foreground: '#dbe5dc', card: '#131a15', muted: '#18211b', 'muted-foreground': '#81918a', primary: '#6fcf97', 'primary-foreground': '#06140b', accent: '#1d2820', border: '#203026', destructive: '#ef6b6b', sidebar: '#0b0f0c', 'chart-1': '#6fcf97', 'chart-2': '#6cb6d9', 'chart-3': '#e9c46a', 'chart-4': '#b39ddb', 'chart-5': '#4fd1c5' },
    light: { background: '#f5f8f5', foreground: '#1b2a20', card: '#ffffff', muted: '#e9f0ea', 'muted-foreground': '#5d6f63', primary: '#2f8f5b', 'primary-foreground': '#ffffff', accent: '#e1ebe3', border: '#d6e2d9', destructive: '#c94141', sidebar: '#edf3ee', 'chart-1': '#2f8f5b', 'chart-2': '#2a7fa8', 'chart-3': '#a8811f', 'chart-4': '#7356b0', 'chart-5': '#1f8f86' },
  },
  'Ametyst': font(
    '#15121c #e6e1f0 #1b1724 #221d2d #9a90ad #a78bfa #160f24 #2a2337 #2b2538 #f47174 #110e17 #86efac #93c5fd #fcd34d #f0abfc #67e8f9',
    '#f7f5fb #221b30 #ffffff #efebf6 #6e6582 #7c3aed #ffffff #ebe5f5 #e2dcee #dc2626 #f1edf8 #15803d #1d4ed8 #b45309 #a21caf #0e7490', 'Geist', 'Geist Mono', '0.6rem'),
  'Retro CRT': font(
    '#0d0b07 #ffcc66 #14110a #1c170d #b08a3e #ffb000 #120c00 #241d10 #2e2514 #ff5f45 #0a0805 #c6e05a #6fb3d2 #ffb000 #e08ad6 #5fd7c4',
    '#fbf6ea #3a2a08 #fffdf6 #f3ead3 #8a6a2c #b06f00 #ffffff #efe3c4 #e6d8b3 #c2410c #f6eedb #4d7c0f #1d6fa3 #b06f00 #a3369a #0f766e', 'IBM Plex Mono', 'IBM Plex Mono', '0.15rem'),
  'Neon': font(
    '#0b0a14 #e8e6ff #121024 #1a1730 #8b86b5 #ff2bd6 #14001a #221d3d #2a2450 #ff4d6d #08070f #3cffb4 #29b6ff #ffe14d #ff2bd6 #00f0ff',
    '#f8f7ff #1b1640 #ffffff #efedff #625d93 #d4009f #ffffff #e9e5ff #dedaf7 #e11d48 #f2f0ff #059669 #0369a1 #a16207 #c026d3 #0891b2', 'Space Grotesk', 'Space Mono', '0.3rem'),
  'Fiord': font(
    '#20242c #e5e9f0 #262b35 #2e3440 #8f9bb0 #88c0d0 #10181c #333a47 #353c4a #bf616a #1c2027 #a3be8c #81a1c1 #ebcb8b #b48ead #8fbcbb',
    '#eceff4 #2e3440 #f7f8fb #e2e6ee #5e6a80 #5e81ac #ffffff #dde3ec #d3d9e4 #bf616a #e5e9f0 #6a8f4e #4c6d96 #b2862c #8a5f86 #4f8b89', 'Inter', 'JetBrains Mono', '0.5rem'),
  'Papier': font(
    '#1d1913 #e8dcc4 #241f17 #2c261c #a8977a #e0955f #1d120a #332b1f #3a3123 #e06c4e #181510 #a4c26a #7fa8c9 #e0b45a #c98fbe #78c2b4',
    '#f4ecd8 #3b2f22 #faf4e4 #ebe0c6 #7d6b55 #9a4f2a #fff8ec #e6d9bb #dccdab #b3361f #efe5cc #5f7f2e #3e6a8a #a8741a #8a4a7a #2f7d72', 'Lora', 'IBM Plex Mono', '0.35rem'),
  'Pastel': font(
    '#1c1722 #f1e7f3 #231c2a #2b2333 #a594b5 #f49ac1 #2a0f1d #33293d #362c41 #ff7a85 #18131d #7dd3a8 #93b4ff #f6c26b #c9a2f5 #6fd6d6',
    '#fdf8fb #2f2440 #ffffff #f6edf4 #7c6b8c #e5679f #ffffff #f3e6f0 #efdce9 #e5484d #faf1f7 #3fae7a #5b8def #e8a33d #a26be0 #2fb5b5', 'Outfit', 'Fira Code', '0.9rem'),
  'Ocean': font(
    '#0a1418 #d7e9ee #0e1b20 #13242a #7d9ca5 #2dd4bf #04211d #172d34 #1a3139 #f87171 #071014 #4ade80 #38bdf8 #fbbf24 #a78bfa #2dd4bf',
    '#f2f8f9 #0f2a30 #ffffff #e3eff1 #557178 #0d9488 #ffffff #dcecee #d0e3e6 #dc2626 #eaf4f5 #15803d #0369a1 #b45309 #6d28d9 #0d9488', 'Plus Jakarta Sans', 'JetBrains Mono', '0.55rem'),
  'Monochrom': font(
    '#0a0a0a #ededed #111111 #171717 #8a8a8a #ededed #0a0a0a #1f1f1f #222222 #ef4444 #070707 #86efac #93c5fd #fde68a #d8b4fe #a5f3fc',
    '#ffffff #0a0a0a #ffffff #f5f5f5 #737373 #0a0a0a #ffffff #f0f0f0 #e5e5e5 #dc2626 #fafafa #16a34a #2563eb #ca8a04 #9333ea #0891b2', 'Inter', 'Geist Mono', '0.375rem'),
  'Zachód': font(
    '#1a1216 #f5e6e0 #21171c #2a1d23 #b2969c #ff8a5b #2a0e03 #33232a #3a2830 #ff5c7a #150e12 #9be38f #7cb7ff #ffc857 #d68cff #5ee0d0',
    '#fff7f3 #3a1f1a #ffffff #fbebe4 #8a6a62 #e8572a #ffffff #f8e4da #f1d8cd #d6304f #fdf0ea #3f8f3a #2f6fd1 #c7861a #9c4fd1 #1d958a', 'Sora', 'Fira Code', '0.6rem'),
};

/** Motyw z czcionkami Google Fonts (pobieranymi przy pierwszym użyciu). Palety: kolory w kolejności PAL, oddzielone spacjami. */
function font(dark: string, light: string, sans: string, mono: string, radius: string): ThemeDef {
  const f = { 'font-sans': `"${sans}", ui-sans-serif, system-ui, sans-serif`, 'font-mono': `"${mono}", ui-monospace, monospace`, radius };
  const pal = (s: string): ThemeVars => Object.fromEntries(s.split(' ').map((c, i) => [PAL[i], c]));
  return { dark: { ...pal(dark), ...f }, light: { ...pal(light), ...f }, fonts: [...new Set([sans, mono])] };
}

export const VARS = ['background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground', 'muted', 'muted-foreground', 'primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'accent', 'accent-foreground', 'border', 'input', 'ring', 'destructive', 'sidebar', 'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'radius', 'font-sans', 'font-mono', 'font-serif', 'tracking-normal'];
/** Zmienne wspólne dla trybu jasnego i ciemnego (tweakcn trzyma je zwykle tylko w :root). */
const SHARED = ['radius', 'font-sans', 'font-mono', 'font-serif', 'tracking-normal'];

export function isDarkMode(mode: ThemeMode) {
  return mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
}

export function applyTheme(all: Record<string, ThemeDef | null>, name: string, mode: ThemeMode) {
  const dark = isDarkMode(mode);
  const t = all[name];
  const base = DEFAULT[dark ? 'dark' : 'light'];
  const shared = (o?: ThemeVars | null) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => SHARED.includes(k)));
  const set: ThemeVars = t ? { ...shared(t.light), ...shared(t.dark), ...(t[dark ? 'dark' : 'light'] || t.light || t.dark || {}) } : {};
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  for (const [k, v] of Object.entries(base)) root.style.setProperty('--' + k, v);
  for (const k of SHARED) root.style.removeProperty('--' + k);
  for (const [k, v] of Object.entries(set)) root.style.setProperty('--' + k, v);
  if (set.background) root.style.setProperty('--term-bg', set.background);
  if (t) ensureFonts(themeFonts(t));
}

/* ---------- czcionki motywów (Google Fonts, kopia lokalna w folderze fonts) ---------- */

const SYSTEM_FONTS = /^(ui-|system-ui|-apple-system|blinkmacsystemfont|sans-serif|serif|monospace|cursive|fantasy|segoe|arial|helvetica|times|georgia|courier|consolas|menlo|monaco|cascadia|sf |apple|noto color|emoji|verdana|tahoma|trebuchet|lucida|var\()/i;

/** Pierwsza rodzina z listy `font-family`, o ile nie jest systemowa. */
function primary(stack?: string) {
  const f = (stack || '').split(',')[0]?.trim().replace(/^["']|["']$/g, '');
  return f && !SYSTEM_FONTS.test(f) ? f : null;
}

export function themeFonts(t: ThemeDef): string[] {
  const out = new Set(t.fonts || []);
  for (const pal of [t.light, t.dark]) for (const k of ['font-sans', 'font-mono', 'font-serif']) { const f = primary(pal?.[k]); if (f) out.add(f); }
  return [...out];
}

const loaded = new Set<string>();
let fontsDir: string | null = null;
/** Pobiera czcionki (raz, potem z dysku) i dokłada @font-face. Bez sieci zostają czcionki zapasowe. */
export async function ensureFonts(families: string[]) {
  const todo = families.filter((f) => !loaded.has(f));
  if (!todo.length || !isTauri) return;
  todo.forEach((f) => loaded.add(f));
  const { convertFileSrc } = await import('@tauri-apps/api/core');
  fontsDir ??= await call<string>('fonts_dir').catch(() => null);
  if (!fontsDir) return;
  await Promise.all(todo.map(async (family) => {
    try {
      const css = await call<string>('font_fetch', { family });
      const slug = family.split('').map((c) => (/[a-z0-9]/i.test(c) ? c.toLowerCase() : '-')).join('');
      const el = document.createElement('style');
      el.dataset.font = family;
      el.textContent = css.replace(/url\(([^)]+)\)/g, (_, f: string) => `url("${convertFileSrc(`${fontsDir}\\${slug}\\${f.replace(/["']/g, '')}`)}")`);
      document.head.appendChild(el);
    } catch (e) { loaded.delete(family); console.warn('Czcionka motywu', family, e); }
  }));
}

/** layout.tsx z tweakcn: `const x = Font_Name({ variable: "--font-sans" })` → zmienne --font-* i lista czcionek. */
export function parseLayoutFonts(src: string): { vars: ThemeVars; fonts: string[] } {
  const vars: ThemeVars = {}, fonts: string[] = [];
  const imp = src.match(/import\s*\{([^}]*)\}\s*from\s*["']next\/font\/google["']/);
  for (const n of imp ? imp[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean) : []) fonts.push(n.replace(/_/g, ' '));
  for (const m of src.matchAll(/=\s*([A-Z]\w*)\(\s*\{([^}]*)\}/g)) {
    const family = m[1].replace(/_/g, ' ');
    if (imp && !fonts.includes(family)) continue;
    const v = m[2].match(/variable\s*:\s*["']--(font-(?:sans|mono|serif))["']/);
    if (!fonts.includes(family)) fonts.push(family);
    if (v) vars[v[1]] = `"${family}", ${v[1] === 'font-mono' ? 'ui-monospace, monospace' : v[1] === 'font-serif' ? 'ui-serif, serif' : 'ui-sans-serif, system-ui, sans-serif'}`;
  }
  return { vars, fonts };
}

/** CSS `:root{…} .dark{…}` z tweakcn → definicja motywu. */
export function parseTweakcnCss(css: string): ThemeDef | null {
  const block = (sel: string) => {
    const m = css.match(new RegExp(sel.replace('.', '\\.') + '\\s*\\{([^}]*)\\}'));
    if (!m) return null;
    const o: ThemeVars = {};
    m[1].replace(/--([\w-]+)\s*:\s*([^;]+);/g, (_, k, v) => { if (VARS.includes(k)) o[k] = v.trim(); return ''; });
    return Object.keys(o).length ? o : null;
  };
  let light = block(':root'), dark = block('.dark');
  // Plik layout.tsx wklejony razem z CSS dokłada czcionki (next/font/google).
  const lay = parseLayoutFonts(css);
  if (Object.keys(lay.vars).length) { light = { ...(light || {}), ...lay.vars }; if (dark) dark = { ...dark, ...lay.vars }; }
  return light || dark ? { light, dark, imported: true, fonts: lay.fonts.length ? lay.fonts : undefined } : null;
}

/** JSON z rejestru tweakcn (`https://tweakcn.com/r/themes/<nazwa>.json`). */
export function parseTweakcnJson(json: any): ThemeDef | null {
  const cv = json && json.cssVars;
  if (!cv) return null;
  const pick = (o: Record<string, string> | undefined) => {
    if (!o) return null;
    const r: ThemeVars = {};
    for (const [k, v] of Object.entries({ ...(cv.theme || {}), ...o })) if (VARS.includes(k)) r[k] = String(v);
    return Object.keys(r).length ? r : null;
  };
  return { light: pick(cv.light), dark: pick(cv.dark), imported: true };
}

/** Link edytora albo nazwa → adres JSON w rejestrze. */
export function tweakcnUrl(input: string) {
  const s = input.trim();
  if (/^https?:\/\/.*\.json$/.test(s)) return s;
  const m = s.match(/tweakcn\.com\/(?:r\/)?themes\/([\w-]+)/) || s.match(/^([\w-]+)$/);
  return m ? `https://tweakcn.com/r/themes/${m[1]}.json` : null;
}

/* ---------- terminal palette ---------- */

let probe: CanvasRenderingContext2D | null = null;
/** Dowolny kolor CSS (także oklch) → #rrggbb, bo xterm nie rozumie oklch. */
export function toHex(color: string, fallback = '#000000') {
  try {
    probe ||= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
    if (!probe) return fallback;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#000';
    probe.fillStyle = color;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
  } catch { return fallback; }
}

function mix(a: string, b: string, t: number) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

export function terminalTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (k: string, f: string) => toHex(cs.getPropertyValue('--' + k).trim() || f, f);
  const bg = v('term-bg', '#0f0f12'), fg = v('foreground', '#e7e7ea'), dark = document.documentElement.classList.contains('dark');
  const red = v('destructive', '#f87171'), green = v('chart-1', '#4ade80'), yellow = v('chart-3', '#fbbf24'),
    blue = v('chart-2', '#60a5fa'), magenta = v('chart-4', '#c084fc'), cyan = v('chart-5', '#22d3ee'), muted = v('muted-foreground', '#8b8b95');
  const lift = (c: string) => mix(c, dark ? '#ffffff' : '#000000', 0.18);
  return {
    background: bg, foreground: fg, cursor: v('primary', '#8b8cf8'), cursorAccent: bg,
    selectionBackground: mix(bg, v('primary', '#8b8cf8'), 0.35),
    black: dark ? mix(bg, fg, 0.15) : '#1f1f23', red, green, yellow, blue, magenta, cyan, white: dark ? mix(fg, bg, 0.12) : muted,
    brightBlack: muted, brightRed: lift(red), brightGreen: lift(green), brightYellow: lift(yellow), brightBlue: lift(blue),
    brightMagenta: lift(magenta), brightCyan: lift(cyan), brightWhite: dark ? '#ffffff' : '#000000',
  };
}
