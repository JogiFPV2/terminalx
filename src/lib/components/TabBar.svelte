<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../Icon.svelte';
  import { app, curWs, curTab, activateTab, closeTab, tabKind, splitTab, unparkTab, ui } from '../state.svelte';
  import { agentState } from '../agent.svelte';
  import { sortable } from '../sortable';
  import { moveItem } from '../util';
  import { openMenu, newTabItems, tabMenu } from '../menus';
  import { dropTabOnSection } from '../plugins/host.svelte';
  import { layoutTiles } from './desk';

  let strip: HTMLDivElement;
  let addBtn: HTMLButtonElement;
  const ws = $derived(curWs());
  // Zakładki zaparkowane w Procesach w tle zostają na pasku swojego workspace'u, przyklejone z prawej.
  const parked = $derived(app.parked.filter((p) => p.wsId === ws.id).map((p) => p.tab));
  const peek = $derived(parked.find((t) => t.id === ui.peek));
  const tab = $derived(peek || curTab());
  const localTerm = $derived(tab?.kind === 'terminal' && !tab.panes[0]?.shell.startsWith('ssh:'));

  onMount(() => {
    const s = sortable(strip, '.tab', {
      onMove: (a, b) => moveItem(curWs().tabs, a, b),
      onClick: (i, e) => { if (!(e.target as HTMLElement).closest('.x')) activateTab(curWs().tabs[i].id); },
      onDetach: (i, zone) => { const t = curWs().tabs[i]; const pid = zone.dataset.tabdrop; if (t && pid) dropTabOnSection(pid, t.id); },
      skip: (t) => !!t.closest('.x, input'),
    });
    return () => s.destroy();
  });

  function plusMenu() {
    const r = addBtn.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, newTabItems());
  }
  function commit(t: { title: string }, el: HTMLInputElement) { t.title = el.value.trim() || t.title; ui.renamingTab = null; }
  function focusSelect(el: HTMLInputElement) { el.focus(); el.select(); }
</script>

<div class="tabbar">
  <div class="tabs sortable" bind:this={strip} role="tablist">
    {#each ws.tabs as t (t.id)}
      {@const k = tabKind(t)}
      <div class="tab" class:on={t.id === ws.activeTab && !peek} role="tab" tabindex="0" aria-selected={t.id === ws.activeTab} title={t.title}
        onauxclick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } }}
        oncontextmenu={(e) => { e.preventDefault(); tabMenu(t.id, e.clientX, e.clientY); }}
        ondblclick={() => (ui.renamingTab = t.id)}
        onkeydown={(e) => { if (e.key === 'Enter') activateTab(t.id); if (e.key === 'F2') ui.renamingTab = t.id; }}>
        <span class="ki" style:color={k.c} title={k.label}><Icon name={k.icon} size={14} /></span>
        {#if ui.renamingTab === t.id}
          <input class="rename" value={t.title} use:focusSelect aria-label="Nazwa zakładki"
            onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commit(t, e.currentTarget); if (e.key === 'Escape') ui.renamingTab = null; }}
            onblur={(e) => commit(t, e.currentTarget)} />
        {:else}
          <span class="tt">{t.title}</span>
        {/if}
        {#if agentState.subBusy[t.id]}<span class="sdot busy" title="Podagent: {agentState.subBusy[t.id]}"></span>
        {:else if t.subagent}<span class="sdot" title="Podagent przypisany"></span>{/if}
        <button class="x" title="Zamknij (Ctrl+Shift+W)" onclick={(e) => { e.stopPropagation(); closeTab(t.id); }}><Icon name="x" size={12} /></button>
      </div>
    {/each}
  </div>
  <button class="icobtn" bind:this={addBtn} title="Nowa zakładka" aria-haspopup="menu" onclick={plusMenu}><Icon name="plus" /></button>
  <div class="spacer"></div>
  {#if parked.length}
    <div class="parked" role="tablist" aria-label="Procesy w tle">
      {#each parked as t (t.id)}
        {@const k = tabKind(t)}
        <div class="tab bg" class:on={t.id === ui.peek} role="tab" tabindex="0" aria-selected={t.id === ui.peek} title="{t.title} · w tle (dwuklik przywraca)"
          onclick={() => (ui.peek = ui.peek === t.id ? null : t.id)}
          ondblclick={() => unparkTab(t.id)}
          oncontextmenu={(e) => { e.preventDefault(); tabMenu(t.id, e.clientX, e.clientY); }}
          onkeydown={(e) => { if (e.key === 'Enter') ui.peek = t.id; }}>
          <span class="ki" style:color={k.c}><Icon name={k.icon} size={14} /></span>
          <span class="tt">{t.title}</span>
        </div>
      {/each}
    </div>
  {/if}
  {#if localTerm && (ws.mode === 'tabs' || peek)}
    <button class="icobtn" class:on={tab?.files} title={tab?.files ? 'Ukryj pliki' : 'Pliki w bieżącym katalogu'} aria-pressed={!!tab?.files} onclick={() => tab && (tab.files = !tab.files)}><Icon name="folder" /></button>
  {/if}
  {#if ws.mode === 'windows' && !peek}
    <button class="icobtn" title="Rozmieść okna kafelkowo" onclick={() => layoutTiles(ws)}><Icon name="tile" /></button>
  {:else if tab?.kind === 'terminal' && !peek}
    <button class="icobtn" title={tab.panes.length > 1 ? 'Scal panele' : 'Podziel panel (Ctrl+Shift+D)'} onclick={() => splitTab(tab.id)}><Icon name="split" /></button>
  {/if}
  <div class="seg" role="group" aria-label="Układ workspace'u">
    <button class:on={ws.mode === 'tabs'} onclick={() => (ws.mode = 'tabs')} title="Układ: zakładki" aria-label="Zakładki"><Icon name="tabs" /></button>
    <button class:on={ws.mode === 'windows'} onclick={() => (ws.mode = 'windows')} title="Układ: okna" aria-label="Okna"><Icon name="wins" /></button>
  </div>
</div>

<style>
  .tabbar { display: flex; align-items: center; gap: 6px; padding: 0 6px; height: 34px; border-bottom: 1px solid var(--border); min-width: 0; }
  .tabs { display: flex; align-items: center; gap: 2px; overflow-x: auto; scrollbar-width: none; min-width: 0; user-select: none; }
  .tab { display: flex; align-items: center; gap: 7px; height: 26px; padding: 0 6px 0 8px; border-radius: 6px; color: var(--muted-foreground); white-space: nowrap; cursor: default; transition: transform .16s ease; max-width: 220px; }
  .tab:hover { background: var(--muted); color: var(--foreground); }
  .tab.on { background: var(--muted); color: var(--foreground); }
  .tab:global(.dragging) { transition: none; z-index: 3; position: relative; background: var(--accent); }
  .tt { overflow: hidden; text-overflow: ellipsis; }
  .x { display: grid; place-items: center; width: 16px; height: 16px; border-radius: 4px; opacity: 0; flex: none; }
  .tab:hover .x, .tab.on .x { opacity: .6; }
  .x:hover { opacity: 1; background: var(--accent); }
  .rename { font: inherit; width: 110px; background: var(--background); border: 1px solid var(--primary-ink); border-radius: 4px; color: inherit; padding: 1px 5px; outline: none; }
  .ki { display: grid; flex: none; opacity: .9; }
  .parked { display: flex; align-items: center; gap: 2px; flex: none; max-width: 40%; overflow-x: auto; scrollbar-width: none; user-select: none; }
  .tab.bg { background: color-mix(in oklab, var(--chart-3) 12%, transparent); box-shadow: inset 0 -2px 0 color-mix(in oklab, var(--chart-3) 55%, transparent); padding-right: 8px; }
  .tab.bg:hover { background: color-mix(in oklab, var(--chart-3) 20%, transparent); }
  .tab.bg.on { background: color-mix(in oklab, var(--chart-3) 26%, transparent); color: var(--foreground); }
  .icobtn.on { color: var(--primary-ink); }
  .seg button { padding: 3px 7px; }
</style>
