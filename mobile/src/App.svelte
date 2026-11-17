<script lang="ts">
  import { onMount } from 'svelte';
  import { S, theme } from './lib/store.svelte';
  import Pcs from './components/Pcs.svelte';
  import Session from './components/Session.svelte';
  import Sheet from './components/Sheet.svelte';
  import Pair from './components/Pair.svelte';
  import Settings from './components/Settings.svelte';

  onMount(() => {
    theme();
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => S.settings.mode === 'system' && theme();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  });
</script>

{#if S.cur}<Session />{:else}<Pcs />{/if}

{#if S.sheet === 'pair'}<Sheet title="Dodaj komputer" onclose={() => (S.sheet = null)}><Pair /></Sheet>{/if}
{#if S.sheet === 'settings'}<Sheet title="Ustawienia" onclose={() => (S.sheet = null)}><Settings /></Sheet>{/if}
{#if S.toast}<div class="toast" role="status">{S.toast}</div>{/if}

<style>
  .toast { position: fixed; left: 16px; right: 16px; bottom: calc(84px + var(--safe-b)); z-index: 90; background: var(--foreground); color: var(--background); padding: 12px 16px; border-radius: 14px; font-size: 14px; animation: up .25s ease; }
  @keyframes up { from { transform: translateY(10px); opacity: 0; } }
</style>
