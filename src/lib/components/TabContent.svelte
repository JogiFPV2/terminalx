<script lang="ts">
  import TerminalPane from './TerminalPane.svelte';
  import FlowEditor from '../workflow/FlowEditor.svelte';
  import Vault from './Vault.svelte';
  import Sftp from './Sftp.svelte';
  import Monitor from './Monitor.svelte';
  import { track, clamp } from '../util';
  import { app } from '../state.svelte';
  import type { Tab } from '../types';

  let { tab, compact = false, autofocus = false }: { tab: Tab; compact?: boolean; autofocus?: boolean } = $props();
  let box: HTMLDivElement;

  function gutter(e: PointerEvent) {
    e.preventDefault();
    const r = box.getBoundingClientRect();
    track((ev) => {
      tab.split = clamp(tab.splitDir === 'col' ? (ev.clientY - r.top) / r.height : (ev.clientX - r.left) / r.width, 0.15, 0.85);
    });
  }
</script>

{#if tab.kind === 'vault'}
  <Vault />
{:else if tab.kind === 'monitor'}
  <Monitor />
{:else if tab.kind === 'sftp'}
  <Sftp {tab} />
{:else if tab.kind === 'flow'}
  {#if tab.flowId && app.flows[tab.flowId]}
    <FlowEditor flow={app.flows[tab.flowId]} {tab} {compact} />
  {:else}
    <div class="empty">Brak danych workflow.</div>
  {/if}
{:else}
  <div class="panes {tab.splitDir}" bind:this={box}>
    {#each tab.panes as pane, i (pane.id)}
      {#if i === 1}
        <div class="gutter" role="separator" aria-label="Podział paneli" onpointerdown={gutter} ondblclick={() => (tab.split = 0.5)}></div>
      {/if}
      <div class="slot" style:flex="{tab.panes.length > 1 ? (i === 0 ? tab.split : 1 - tab.split) : 1} 1 0">
        <TerminalPane {pane} autofocus={autofocus && i === 0} />
      </div>
    {/each}
  </div>
{/if}

<style>
  .panes { display: flex; height: 100%; min-height: 0; min-width: 0; background: var(--term-bg); }
  .panes.col { flex-direction: column; }
  .panes.row { flex-direction: row; }
  .slot { min-width: 0; min-height: 0; position: relative; }
  .gutter { flex: none; position: relative; z-index: 2; touch-action: none; }
  .col .gutter { height: 1px; margin: -3px 0; padding: 3px 0; cursor: row-resize; background: var(--border); background-clip: content-box; }
  .row .gutter { width: 1px; margin: 0 -3px; padding: 0 3px; cursor: col-resize; background: var(--border); background-clip: content-box; }
  .gutter:hover { background-color: var(--primary); }
  .empty { display: grid; place-items: center; height: 100%; color: var(--muted-foreground); }
</style>
