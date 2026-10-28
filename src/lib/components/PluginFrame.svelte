<script lang="ts">
  import { onMount } from 'svelte';
  import { mountFrame, unmountFrame, plug } from '../plugins/host.svelte';

  // Iframe pluginu nigdy nie jest przenoszony w DOM (to przeładowałoby plugin); zwijanie sekcji tylko go ukrywa.
  let { pluginId, hidden = false }: { pluginId: string; hidden?: boolean } = $props();
  let host: HTMLDivElement;

  onMount(() => {
    const frame = document.createElement('iframe');
    frame.className = 'pframe';
    host.appendChild(frame);
    mountFrame(pluginId, frame);
    return () => { unmountFrame(pluginId, frame); frame.remove(); };
  });
</script>

<div class="frame-host" class:dialog={plug.dialogOpen[pluginId]} class:hidden style:--h="{plug.heights[pluginId] ?? 0}px" bind:this={host}></div>

<style>
  .frame-host :global(iframe.pframe) { display: block; width: 100%; height: var(--h); border: 0; background: transparent; }
  .frame-host.hidden :global(iframe.pframe) { position: fixed; left: 0; top: 0; width: 0; height: 0; }
  .frame-host.dialog :global(iframe.pframe) { position: fixed; inset: 0; width: 100vw; height: 100vh; z-index: 70; }
</style>
