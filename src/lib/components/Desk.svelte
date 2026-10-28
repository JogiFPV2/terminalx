<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../Icon.svelte';
  import TabContent from './TabContent.svelte';
  import { activateTab, closeTab, tabKind, app } from '../state.svelte';
  import { tabMenu } from '../menus';
  import { desk, ensureGeometry, MIN_W, MIN_H } from './desk';
  import { track } from '../util';
  import type { Workspace, Tab } from '../types';

  let { ws }: { ws: Workspace } = $props();
  let el: HTMLDivElement;
  let size = $state({ W: 900, H: 600 });

  onMount(() => {
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      size = { W: Math.max(300, r.width), H: Math.max(200, r.height) };
      Object.assign(desk, size);
      ensureGeometry(ws);
    });
    ro.observe(el);
    return () => ro.disconnect();
  });
  $effect(() => { if (ws.tabs.some((t) => !t.win)) { Object.assign(desk, size); ensureGeometry(ws); } });

  const geom = (t: Tab) => (t.win?.max ? { x: 0, y: 0, w: size.W, h: size.H } : t.win || { x: 0, y: 0, w: 400, h: 300 });

  function focusWin(t: Tab) { if (ws.activeTab !== t.id) activateTab(t.id); }

  function startMove(e: PointerEvent, t: Tab) {
    if ((e.target as HTMLElement).closest('button') || e.button !== 0 || !t.win || t.win.max) return;
    e.preventDefault();
    const s = { ...t.win }, sx = e.clientX, sy = e.clientY;
    track((ev) => {
      t.win!.x = Math.min(size.W - 80, Math.max(-(s.w - 80), s.x + ev.clientX - sx));
      t.win!.y = Math.min(size.H - 28, Math.max(0, s.y + ev.clientY - sy));
    });
  }

  function startResize(e: PointerEvent, t: Tab, dir: string) {
    if (!t.win) return;
    e.preventDefault();
    e.stopPropagation();
    focusWin(t);
    const s = { ...t.win }, sx = e.clientX, sy = e.clientY;
    track((ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy, g = t.win!;
      if (dir.includes('e')) g.w = Math.min(size.W - s.x, Math.max(MIN_W, s.w + dx));
      if (dir.includes('s')) g.h = Math.min(size.H - s.y, Math.max(MIN_H, s.h + dy));
      if (dir.includes('w')) { const nx = Math.max(0, Math.min(s.x + s.w - MIN_W, s.x + dx)); g.w = s.w + (s.x - nx); g.x = nx; }
      if (dir.includes('n')) { const ny = Math.max(0, Math.min(s.y + s.h - MIN_H, s.y + dy)); g.h = s.h + (s.y - ny); g.y = ny; }
    });
  }
</script>

<div class="desk" bind:this={el} style:--inactive={app.settings.inactiveDim}>
  {#each ws.tabs as t (t.id)}
    {@const g = geom(t)}
    {@const k = tabKind(t)}
    <section class="win" class:on={ws.activeTab === t.id} aria-label={t.title}
      style:left="{g.x}px" style:top="{g.y}px" style:width="{g.w}px" style:height="{g.h}px" style:z-index={ws.z.indexOf(t.id) + 1}
      onpointerdowncapture={() => focusWin(t)}>
      <div class="wt" role="toolbar" tabindex="-1" onpointerdown={(e) => startMove(e, t)}
        ondblclick={(e) => { if (!(e.target as HTMLElement).closest('button') && t.win) t.win.max = !t.win.max; }}
        oncontextmenu={(e) => { e.preventDefault(); tabMenu(t.id, e.clientX, e.clientY); }}>
        <span class="ki" style:color={k.c} title={k.label}><Icon name={k.icon} size={13} /></span><b>{t.title}</b>
        <span class="spacer"></span>
        <button class="icobtn" title={t.win?.max ? 'Przywróć' : 'Maksymalizuj'} onclick={() => t.win && (t.win.max = !t.win.max)}><Icon name={t.win?.max ? 'restore' : 'max'} size={12} /></button>
        <button class="icobtn" title="Zamknij" onclick={() => closeTab(t.id)}><Icon name="x" size={12} /></button>
      </div>
      <div class="body"><TabContent tab={t} compact={true} autofocus={ws.activeTab === t.id} /></div>
      {#if !t.win?.max}
        {#each ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'] as d}
          <span class="rh {d}" role="presentation" onpointerdown={(e) => startResize(e, t, d)}></span>
        {/each}
      {/if}
    </section>
  {/each}
  {#if !ws.tabs.length}<div class="empty">Brak okien. Kliknij + na pasku zakładek.</div>{/if}
</div>

<style>
  .desk { position: relative; overflow: hidden; min-height: 0; height: 100%; background-color: var(--background); background-image: radial-gradient(color-mix(in oklab, var(--muted-foreground) 22%, transparent) 1px, transparent 1px); background-size: 18px 18px; }
  .win { position: absolute; display: grid; grid-template-rows: 28px 1fr; background: var(--term-bg); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 8px 24px -14px rgb(0 0 0 / .45); min-width: 0; }
  .win::after { content: ""; position: absolute; inset: 0; border-radius: 8px; background: var(--background); opacity: calc(1 - var(--inactive)); pointer-events: none; transition: opacity .14s; z-index: 1; }
  .win.on::after { opacity: 0; }
  .win:hover:not(.on)::after { opacity: calc((1 - var(--inactive)) * .6); }
  .win.on { border-color: color-mix(in oklab, var(--primary) 55%, var(--border)); box-shadow: 0 18px 44px -16px rgb(0 0 0 / .55); }
  .wt { display: flex; align-items: center; gap: 7px; padding: 0 4px 0 9px; border-bottom: 1px solid var(--border); background: var(--muted); border-radius: 8px 8px 0 0; cursor: grab; user-select: none; min-width: 0; }
  .wt b { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wt .icobtn { width: 22px; height: 20px; }
  .body { min-height: 0; overflow: hidden; border-radius: 0 0 8px 8px; }
  .rh { position: absolute; z-index: 3; touch-action: none; }
  .rh.n { top: -4px; left: 10px; right: 10px; height: 8px; cursor: ns-resize; }
  .rh.s { bottom: -4px; left: 10px; right: 10px; height: 8px; cursor: ns-resize; }
  .rh.e { right: -4px; top: 10px; bottom: 10px; width: 8px; cursor: ew-resize; }
  .rh.w { left: -4px; top: 10px; bottom: 10px; width: 8px; cursor: ew-resize; }
  .rh.nw, .rh.ne, .rh.sw, .rh.se { width: 14px; height: 14px; }
  .rh.nw { top: -5px; left: -5px; cursor: nwse-resize; } .rh.se { bottom: -5px; right: -5px; cursor: nwse-resize; }
  .rh.ne { top: -5px; right: -5px; cursor: nesw-resize; } .rh.sw { bottom: -5px; left: -5px; cursor: nesw-resize; }
  .empty { display: grid; place-items: center; height: 100%; color: var(--muted-foreground); }
</style>
