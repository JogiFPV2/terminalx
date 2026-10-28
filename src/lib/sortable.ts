// Przeciąganie w poziomie (zmiana kolejności) z opcjonalnym „oderwaniem” w dół na strefę upuszczenia.
import { track } from './util';

export interface SortOpts {
  onMove: (from: number, to: number) => void;
  onDetach?: (index: number, zone: HTMLElement) => void;
  onClick?: (index: number, e: PointerEvent) => void;
  skip?: (target: HTMLElement) => boolean;
}

export function sortable(container: HTMLElement, selector: string, opts: SortOpts) {
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const item = target.closest(selector) as HTMLElement | null;
    if (!item || !container.contains(item) || opts.skip?.(target)) return;
    const items = [...container.querySelectorAll(selector)] as HTMLElement[];
    const from = items.indexOf(item);
    const rects = items.map((el) => el.getBoundingClientRect());
    const gap = rects[1] ? rects[1].left - rects[0].right : 2;
    const sx = e.clientX, sy = e.clientY;
    let dragging = false, to = from, ghost: HTMLElement | null = null, zone: HTMLElement | null = null;
    track((ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!dragging && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      if (!dragging) { dragging = true; item.classList.add('dragging'); }
      if (opts.onDetach && (ghost || Math.abs(dy) > 28)) {
        if (!ghost) {
          items.forEach((el) => (el.style.transform = ''));
          to = from;
          ghost = item.cloneNode(true) as HTMLElement;
          ghost.classList.add('tabghost');
          ghost.classList.remove('dragging');
          document.body.appendChild(ghost);
          item.style.opacity = '.35';
        }
        ghost.style.left = ev.clientX + 12 + 'px';
        ghost.style.top = ev.clientY + 12 + 'px';
        const hit = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const z = hit?.closest('[data-tabdrop]') as HTMLElement | null;
        if (z !== zone) { zone?.classList.remove('drop-ok'); zone = z; zone?.classList.add('drop-ok'); }
        return;
      }
      const cdx = Math.max(rects[0].left - rects[from].left, Math.min(rects[rects.length - 1].right - rects[from].right, dx));
      item.style.transform = `translateX(${cdx}px)`;
      const c = rects[from].left + rects[from].width / 2 + cdx;
      to = from;
      rects.forEach((r, i) => { const m = r.left + r.width / 2; if (i < from && c < m) to = Math.min(to, i); if (i > from && c > m) to = Math.max(to, i); });
      const sh = rects[from].width + gap;
      items.forEach((el, i) => {
        if (i === from) return;
        const s = from < to && i > from && i <= to ? -sh : to < from && i >= to && i < from ? sh : 0;
        el.style.transform = s ? `translateX(${s}px)` : '';
      });
    }, (ev) => {
      item.classList.remove('dragging');
      if (!dragging) { opts.onClick?.(from, ev); return; }
      if (ghost) {
        ghost.remove();
        item.style.opacity = '';
        if (zone) { zone.classList.remove('drop-ok'); opts.onDetach!(from, zone); }
        return;
      }
      items.forEach((el) => { el.style.transition = 'none'; el.style.transform = ''; });
      if (to !== from) opts.onMove(from, to);
      requestAnimationFrame(() => items.forEach((el) => (el.style.transition = '')));
    });
  };
  container.addEventListener('pointerdown', down);
  return { destroy: () => container.removeEventListener('pointerdown', down) };
}
