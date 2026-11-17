<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from '../../../src/lib/Icon.svelte';
  let { title, onclose, children }: { title: string; onclose: () => void; children: Snippet } = $props();
</script>

<!-- Arkusz od dołu ekranu; tło zamyka, Esc też. -->
<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />
<div class="back" role="presentation" onclick={onclose}></div>
<div class="sheet" role="dialog" aria-modal="true" aria-label={title}>
  <div class="grip" aria-hidden="true"></div>
  <header><h2>{title}</h2><button class="ib" aria-label="Zamknij" onclick={onclose}><Icon name="x" size={20} /></button></header>
  <div class="body">{@render children()}</div>
</div>

<style>
  .back { position: fixed; inset: 0; background: rgb(0 0 0 / .4); z-index: 60; animation: fade .2s ease; }
  .sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 61; max-height: 88vh; display: flex; flex-direction: column; background: var(--card); border-radius: 24px 24px 0 0; padding: 6px 16px calc(16px + var(--safe-b)); animation: rise .28s cubic-bezier(.2,.7,.2,1); }
  .grip { width: 40px; height: 4px; border-radius: 4px; background: var(--border); margin: 4px auto 2px; }
  header { display: flex; align-items: center; justify-content: space-between; }
  h2 { margin: 0; font: 500 20px var(--font-mono); letter-spacing: -0.03em; }
  .body { overflow: auto; padding-top: 6px; }
  @keyframes rise { from { transform: translateY(40px); opacity: 0; } }
  @keyframes fade { from { opacity: 0; } }
</style>
