<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from '../Icon.svelte';
  import { app, ui, addWorkspace, closeWorkspace } from '../state.svelte';
  import { sortable } from '../sortable';
  import { moveItem } from '../util';
  import { isTauri } from '../ipc';
  import { BRAND, WS_COLOR_LIST } from '../defaults';
  import { upd, installUpdate } from '../update.svelte';
  import { plug } from '../plugins/host.svelte';
  import PluginStatus from './PluginStatus.svelte';

  let strip: HTMLDivElement;
  let maximized = $state(false);

  async function win() {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow();
  }
  const minimize = async () => isTauri && (await win()).minimize();
  const toggleMax = async () => { if (!isTauri) return; const w = await win(); await w.toggleMaximize(); maximized = await w.isMaximized(); };
  const close = async () => isTauri && (await win()).close();

  onMount(() => {
    const s = sortable(strip, '.wstab', {
      onMove: (a, b) => moveItem(app.workspaces, a, b),
      onClick: (i, e) => { if (!(e.target as HTMLElement).closest('.x')) app.activeWs = app.workspaces[i].id; },
      skip: (t) => !!t.closest('.x, input'),
    });
    let off: (() => void) | undefined;
    if (isTauri) win().then(async (w) => { maximized = await w.isMaximized(); off = await w.onResized(async () => { maximized = await w.isMaximized(); }); });
    return () => { s.destroy(); off?.(); };
  });

  function commitRename(ws: { name: string }, el: HTMLInputElement) { ws.name = el.value.trim() || ws.name; ui.renamingWs = null; }

  // Paleta kolorów pod zakładką na czas zmiany nazwy (dwuklik albo nowy workspace). Pozycja stała względem okna,
  // bo pasek zakładek przewija się w poziomie i przycinałby rozwijaną listę.
  let pal = $state<{ x: number; y: number } | null>(null);
  const renaming = $derived(app.workspaces.find((w) => w.id === ui.renamingWs) || null);
  $effect(() => {
    const id = ui.renamingWs;
    if (!id) { pal = null; return; }
    tick().then(() => {
      const el = strip?.querySelector<HTMLElement>(`[data-ws="${CSS.escape(id)}"]`);
      if (el && ui.renamingWs === id) { const r = el.getBoundingClientRect(); pal = { x: Math.max(4, Math.min(r.left, innerWidth - 196)), y: r.bottom + 4 }; }
    });
  });
  function focusSelect(el: HTMLInputElement) { el.focus(); el.select(); }
</script>

<header class="titlebar" data-tauri-drag-region ondblclick={(e) => { if ((e.target as HTMLElement).hasAttribute('data-tauri-drag-region')) toggleMax(); }}>
  <div class="logo" title={BRAND.name} data-tauri-drag-region><Icon name="logo" /></div>
  <div class="wstabs sortable" bind:this={strip}>
    {#each app.workspaces as ws (ws.id)}
      <div class="wstab" class:on={ws.id === app.activeWs} role="tab" tabindex="0" aria-selected={ws.id === app.activeWs} data-ws={ws.id} style:--wc={ws.color}
        ondblclick={() => (ui.renamingWs = ws.id)} onkeydown={(e) => e.key === 'Enter' && (app.activeWs = ws.id)}>
        <span class="dot" style:background={ws.color}></span>
        {#if ui.renamingWs === ws.id}
          <input class="rename" value={ws.name} use:focusSelect aria-label="Nazwa workspace'u"
            onkeydown={(e) => { if (e.key === 'Enter') commitRename(ws, e.currentTarget); if (e.key === 'Escape') ui.renamingWs = null; }}
            onblur={(e) => commitRename(ws, e.currentTarget)} />
        {:else}
          <span class="nm">{ws.name}</span>
        {/if}
        <button class="x" title="Zamknij workspace" onclick={(e) => { e.stopPropagation(); closeWorkspace(ws.id); }}><Icon name="x" size={12} /></button>
      </div>
    {/each}
  </div>
  {#if pal && renaming}
    <!-- Kliknięcie koloru nie zabiera fokusu polu nazwy (mousedown bez domyślnej akcji), więc nazwa nadal się edytuje. -->
    <div class="wspal" style:left="{pal.x}px" style:top="{pal.y}px" role="radiogroup" aria-label="Kolor workspace'u">
      {#each WS_COLOR_LIST as [c, label] (c)}
        <button class="sw" class:on={renaming.color === c} style:--c={c} title={label} aria-label={label} role="radio" aria-checked={renaming.color === c}
          onmousedown={(e) => e.preventDefault()} onclick={() => (renaming.color = c)}></button>
      {/each}
    </div>
  {/if}
  <button class="icobtn" title="Nowy workspace (Ctrl+Shift+N)" onclick={addWorkspace}><Icon name="plus" /></button>
  <div class="spacer" data-tauri-drag-region></div>
  {#if upd.version}
    <button class="icobtn upd" disabled={upd.busy} title={upd.busy ? `Pobieram aktualizację… ${upd.pct}%` : `Dostępna wersja ${upd.version} – kliknij, aby zaktualizować`} onclick={installUpdate}>
      {#if upd.busy}<span class="pct">{upd.pct}</span>{:else}<Icon name="download" />{/if}
    </button>
  {/if}
  {#each plug.status.filter((s) => s.visible && s.place === 'top').sort((a, b) => b.priority - a.priority) as s (s.pluginId + s.id)}
    <PluginStatus {s} />
  {/each}
  <button class="icobtn" title="Paleta komend (Ctrl+K)" onclick={() => (ui.palette = true)}><Icon name="search" /></button>
  <button class="icobtn" class:on={app.layout.agentOpen} title="Panel agenta (Ctrl+Shift+A)" onclick={() => (app.layout.agentOpen = !app.layout.agentOpen)}><Icon name="sparks" /></button>
  <button class="icobtn" title="Ustawienia (Ctrl+,)" onclick={() => (ui.settingsOpen = true)}><Icon name="sliders" /></button>
  {#if isTauri}
    <div class="winctl">
      <button onclick={minimize} title="Minimalizuj" aria-label="Minimalizuj"><Icon name="minus" size={14} /></button>
      <button onclick={toggleMax} title={maximized ? 'Przywróć' : 'Maksymalizuj'} aria-label="Maksymalizuj"><Icon name={maximized ? 'restore' : 'max'} size={13} /></button>
      <button class="close" onclick={close} title="Zamknij" aria-label="Zamknij"><Icon name="x" size={14} /></button>
    </div>
  {/if}
</header>

<style>
  .titlebar { display: flex; align-items: center; height: 36px; background: var(--sidebar); border-bottom: 1px solid var(--border); min-width: 0; user-select: none; }
  .logo { width: 44px; display: grid; place-items: center; color: var(--primary-ink); flex: none; height: 100%; }
  .wstabs { display: flex; gap: 2px; min-width: 0; overflow-x: auto; scrollbar-width: none; padding-right: 4px; }
  .wstab { display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 6px 0 10px; border-radius: 6px; color: var(--muted-foreground); white-space: nowrap; font-weight: 500; cursor: default; transition: transform .16s ease; }
  /* Tło w kolorze workspace'u: nieaktywna lekko, aktywna mocniej i z obramowaniem w tym kolorze. */
  .wstab { background: color-mix(in oklab, var(--wc, transparent) 12%, transparent); }
  .wstab:hover { background: color-mix(in oklab, var(--wc, var(--accent)) 22%, var(--accent)); color: var(--foreground); }
  .wstab.on { background: color-mix(in oklab, var(--wc, transparent) 26%, var(--background)); color: var(--foreground); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--wc, var(--border)) 55%, var(--border)); }
  .wstab:global(.dragging) { transition: none; z-index: 3; position: relative; background: var(--accent); }
  .x { opacity: 0; display: grid; place-items: center; width: 16px; height: 16px; border-radius: 4px; }
  .wstab:hover .x, .wstab.on .x { opacity: .6; }
  .x:hover { opacity: 1; background: var(--accent); }
  .rename { font: inherit; width: 120px; background: var(--background); border: 1px solid var(--primary-ink); border-radius: 4px; color: inherit; padding: 1px 5px; outline: none; }
  .upd { color: var(--primary-ink); }
  .wspal { position: fixed; z-index: 60; display: grid; grid-template-columns: repeat(7, 18px); gap: 6px; padding: 8px; background: var(--popover, var(--card)); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 10px 28px -12px rgb(0 0 0 / .45); }
  .sw { width: 18px; height: 18px; border-radius: 50%; background: var(--c); border: 0; padding: 0; cursor: pointer; box-shadow: inset 0 0 0 1px rgb(0 0 0 / .12); }
  .sw:hover { transform: scale(1.15); }
  .sw.on { box-shadow: 0 0 0 2px var(--card), 0 0 0 3.5px var(--foreground); }
  @media (prefers-reduced-motion: reduce) { .sw:hover { transform: none; } }
  .pct { font-size: 10px; font-variant-numeric: tabular-nums; }
  .winctl { display: flex; height: 100%; }
  .winctl button { width: 46px; display: grid; place-items: center; color: var(--muted-foreground); }
  .winctl button:hover { background: var(--accent); color: var(--foreground); }
  .winctl .close:hover { background: #e81123; color: #fff; }
  .titlebar :global(.pitem) { display: flex; align-items: center; gap: 5px; height: 24px; padding: 0 7px; border-radius: 6px; font-size: 11.5px; color: var(--muted-foreground); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .titlebar :global(.pitem:hover:not(:disabled)) { background: var(--accent); color: var(--foreground); }
  .titlebar :global(.pitem:disabled) { cursor: default; }
  .titlebar :global(.pitem.warning:not(.hasbar)) { color: var(--chart-3); }
  .titlebar :global(.pitem.error:not(.hasbar)) { color: var(--destructive); }
</style>
