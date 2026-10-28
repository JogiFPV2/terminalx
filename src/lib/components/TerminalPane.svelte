<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../Icon.svelte';
  import * as sessions from '../terminal/sessions.svelte';
  import { ui } from '../state.svelte';
  import type { Pane } from '../types';

  let { pane, autofocus = false }: { pane: Pane; autofocus?: boolean } = $props();
  let host: HTMLDivElement;
  let q = $state('');
  let found = $state(true);

  onMount(() => {
    sessions.ensureSession(pane);
    sessions.attach(pane.id, host, autofocus);
    return () => sessions.detach(pane.id, host);
  });

  function search(back = false) { found = q ? sessions.find(pane.id, q, back) : true; }
  function closeSearch() { ui.searchPane = null; sessions.clearFind(pane.id); sessions.focus(pane.id); }
  function focusEl(el: HTMLInputElement) { el.focus(); el.select(); }
</script>

<div class="pane" role="presentation" onpointerdown={() => (ui.focusedPane = pane.id)} class:focused={ui.focusedPane === pane.id}>
  <div class="host" bind:this={host}></div>
  {#if sessions.termStatus[pane.id]?.exited}
    <button class="restart" onclick={() => sessions.restart(pane.id)}><Icon name="refresh" size={13} />Uruchom ponownie</button>
  {/if}
  {#if ui.searchPane === pane.id}
    <div class="search" class:miss={!found}>
      <Icon name="search" size={13} />
      <input bind:value={q} use:focusEl placeholder="Szukaj…" aria-label="Szukaj w terminalu"
        oninput={() => search()} onkeydown={(e) => { if (e.key === 'Enter') search(e.shiftKey); if (e.key === 'Escape') closeSearch(); }} />
      <button class="icobtn" title="Poprzedni (Shift+Enter)" onclick={() => search(true)}><Icon name="chev" size={12} /></button>
      <button class="icobtn" title="Zamknij (Esc)" onclick={closeSearch}><Icon name="x" size={12} /></button>
    </div>
  {/if}
</div>

<style>
  .pane { position: relative; min-width: 0; min-height: 0; height: 100%; background: var(--term-bg); }
  .host { position: absolute; inset: 6px 4px 4px 10px; }
  .host :global(.xterm) { height: 100%; }
  .host :global(.xterm-viewport) { background: transparent !important; }
  .host :global(.xterm .xterm-viewport::-webkit-scrollbar) { width: 8px; }
  .restart { position: absolute; right: 14px; bottom: 12px; display: flex; gap: 6px; align-items: center; padding: 5px 10px; border-radius: 6px; background: var(--card); border: 1px solid var(--border); font-size: 12px; z-index: 2; }
  .search { position: absolute; right: 14px; top: 8px; z-index: 3; display: flex; align-items: center; gap: 4px; padding: 3px 3px 3px 8px; background: var(--card); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 8px 20px -10px rgb(0 0 0 / .5); color: var(--muted-foreground); }
  .search.miss { border-color: color-mix(in oklab, var(--destructive) 60%, var(--border)); }
  .search input { background: none; border: 0; outline: none; color: var(--foreground); font: inherit; width: 180px; }
  .search .icobtn { width: 22px; height: 22px; }
  .search .icobtn:first-of-type :global(svg) { transform: rotate(-90deg); }
</style>
