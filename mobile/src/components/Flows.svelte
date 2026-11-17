<script lang="ts">
  import Icon from '../../../src/lib/Icon.svelte';
  import { S, req, msg, toast, can, refreshFlows } from '../lib/store.svelte';

  async function run(id: string) {
    S.flowRes[id] = { state: 'running' };
    try { await req('runFlow', { tab: id }); } catch (e) { S.flowRes[id] = { state: 'error', result: msg(e) }; }
  }
</script>

<div class="list">
  <div class="head"><p class="muted">Workflow z komputera. Uruchamiają się na komputerze, wynik wraca tutaj.</p><button class="ib" aria-label="Odśwież" onclick={refreshFlows}><Icon name="refresh" size={18} /></button></div>
  {#each S.flows as f (f.id)}
    {@const r = S.flowRes[f.id]}
    <article class="card">
      <div class="row">
        <i><Icon name="flow" size={20} /></i>
        <div class="t"><b>{f.title}</b><small>{f.wsName} · nodów: {f.nodes}{f.byAgent ? ' · od agenta, niezatwierdzony' : ''}</small></div>
        {#if can('full')}
          <button class="run" aria-label="Uruchom {f.title}" disabled={r?.state === 'running' || f.running} onclick={() => run(f.id)}>
            {#if r?.state === 'running' || f.running}<span class="spin"></span>{:else}<Icon name="play" size={16} />{/if}
          </button>
        {/if}
      </div>
      {#if r && r.state !== 'running'}<pre class:err={r.state === 'error'}>{r.result}</pre>{/if}
    </article>
  {:else}
    <p class="empty muted">Na komputerze nie ma jeszcze workflow.</p>
  {/each}
  {#if !can('full') && S.flows.length}<p class="note muted">Uruchamianie workflow wymaga uprawnienia „Pełny dostęp”.</p>{/if}
</div>

<style>
  .list { flex: 1; overflow: auto; padding: 0 12px 12px; display: flex; flex-direction: column; gap: 8px; }
  .head { display: flex; align-items: center; gap: 8px; }
  .head p { flex: 1; margin: 0; font-size: 13.5px; }
  .card { background: var(--card); border-radius: 20px; padding: 12px; }
  .row { display: flex; align-items: center; gap: 12px; }
  .row i { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: color-mix(in oklab, var(--chart-4) 22%, var(--muted)); flex: none; }
  .t { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .t b { font-weight: 600; } .t small { color: var(--muted-foreground); font-size: 12.5px; }
  .run { width: 44px; height: 44px; border: 0; border-radius: 50%; background: var(--primary); color: var(--primary-foreground); display: grid; place-items: center; }
  .run :global(svg) { fill: currentColor; }
  pre { margin: 10px 0 0; padding: 10px 12px; border-radius: 12px; background: var(--muted); font: 12.5px/1.5 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; animation: in .3s ease; }
  pre.err { color: var(--destructive); }
  @keyframes in { from { opacity: 0; transform: translateY(4px); } }
  .spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid color-mix(in oklab, currentColor 30%, transparent); border-top-color: currentColor; animation: r .8s linear infinite; }
  @keyframes r { to { transform: rotate(360deg); } }
  .empty, .note { text-align: center; font-size: 13.5px; }
</style>
