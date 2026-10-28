import type { Workspace } from '../types';

export const MIN_W = 240, MIN_H = 140;
export const desk = { W: 900, H: 600 };

export function layoutTiles(ws: Workspace) {
  const n = ws.tabs.length;
  if (!n) return;
  const { W, H } = desk;
  const cols = Math.max(1, Math.ceil(Math.sqrt((n * W) / H / 1.4))), rows = Math.ceil(n / cols), g = 8;
  const cw = (W - g * (cols + 1)) / cols, ch = (H - g * (rows + 1)) / rows;
  ws.tabs.forEach((t, i) => { t.win = { x: g + (i % cols) * (cw + g), y: g + Math.floor(i / cols) * (ch + g), w: cw, h: ch, max: false }; });
}

export function ensureGeometry(ws: Workspace) {
  if (ws.tabs.length && ws.tabs.every((t) => !t.win)) { layoutTiles(ws); return; }
  const { W, H } = desk;
  ws.tabs.forEach((t, i) => {
    if (!t.win) {
      const w = Math.min(640, Math.max(MIN_W, W * 0.55)), h = Math.min(400, Math.max(MIN_H, H * 0.55));
      t.win = { x: Math.max(0, Math.min(24 + i * 32, W - w)), y: Math.max(0, Math.min(18 + i * 28, H - h)), w, h, max: false };
    }
  });
}
