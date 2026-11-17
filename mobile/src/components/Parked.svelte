<script lang="ts">
  import Icon from '../../../src/lib/Icon.svelte';
  import { S, req, msg, toast, can } from '../lib/store.svelte';
  async function unpark(id: string) { try { await req('unpark', { tab: id }); toast('Zakładka wróciła na komputerze'); } catch (e) { toast(msg(e)); } }
</script>

<div class="list">
  <p class="muted">Procesy odłożone na komputerze do „Procesów w tle”: działają dalej bez zakładki.</p>
  {#each S.parked as p (p.id)}
    <article class="card"><i><Icon name="layers" size={20} /></i><div class="t"><b>{p.title}</b><small>{p.ws}</small></div>
      {#if can('control')}<button class="btn ghost sm" onclick={() => unpark(p.id)}>Przywróć</button>{/if}</article>
  {:else}<p class="empty muted">Nic nie działa w tle.</p>{/each}
</div>

<style>
  .list { flex: 1; overflow: auto; padding: 0 12px 12px; display: flex; flex-direction: column; gap: 8px; }
  .list > p { margin: 0 4px 4px; font-size: 13.5px; }
  .card { display: flex; align-items: center; gap: 12px; background: var(--card); border-radius: 20px; padding: 12px; }
  .card i { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: var(--muted); flex: none; }
  .t { flex: 1; min-width: 0; display: flex; flex-direction: column; } .t b { font-weight: 600; } .t small { color: var(--muted-foreground); font-size: 12.5px; }
  .empty { text-align: center; margin-top: 24px; }
</style>
