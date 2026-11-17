<script lang="ts">
  import Icon from '../../../src/lib/Icon.svelte';
  import { S, req, msg, toast } from '../lib/store.svelte';
  const ICON: Record<string, string> = { ps: 'ps', ps5: 'ps', cmd: 'cmd', wsl: 'linux', bash: 'bash' };
  async function open(shell: string) {
    try {
      const r = await req<{ tab: string | null }>('newTab', { shell, ws: S.ws });
      if (r?.tab) S.tab = r.tab;
      S.sheet = null; S.view = 'term';
    } catch (e) { toast(msg(e)); }
  }
</script>

{#if !S.shells}<p class="muted">Pobieram listę powłok…</p>{:else}
  <p class="lbl">Na komputerze</p>
  <div class="grid">{#each S.shells.shells as s (s.id)}<button onclick={() => open(s.id)}><Icon name={ICON[s.kind] || 'term'} size={20} />{s.name}</button>{/each}</div>
  {#if S.shells.hosts.length}
    <p class="lbl">SSH</p>
    <div class="grid">{#each S.shells.hosts as h (h.id)}<button onclick={() => open(`ssh:${h.id}`)}><Icon name="ssh" size={20} /><span>{h.name}<small class="mono">{h.addr}</small></span></button>{/each}</div>
  {/if}
{/if}

<style>
  .lbl { font-size: 13px; color: var(--muted-foreground); margin: 10px 4px 6px; }
  .grid { display: grid; gap: 6px; }
  .grid button { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 8px 14px; border: 0; border-radius: 16px; background: var(--muted); text-align: left; }
  .grid span { display: flex; flex-direction: column; }
  small { font-size: 12px; color: var(--muted-foreground); }
</style>
