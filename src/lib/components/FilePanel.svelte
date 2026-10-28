<script lang="ts">
  // Pliki bieżącego katalogu zakładki terminala. Katalog zgłasza powłoka (OSC 7 / 9;9),
  // a lista odświeża się po każdym prompcie; dwuklik w folder wpisuje `cd` w terminalu.
  import Icon from '../Icon.svelte';
  import { call } from '../ipc';
  import { app, notify } from '../state.svelte';
  import * as sessions from '../terminal/sessions.svelte';
  import type { Pane } from '../types';

  let { pane, onclose }: { pane: Pane; onclose: () => void } = $props();
  type E = { name: string; path: string; isDir: boolean; size: number; modified: number };

  const st = $derived(sessions.termStatus[pane.id]);
  const dir = $derived(st?.dir || '');
  let list = $state<E[]>([]);
  let err = $state('');
  let sel = $state('');
  let token = 0;

  async function load(d: string) {
    const my = ++token;
    if (!d) { list = []; err = ''; return; }
    try {
      const [, l] = await call<[string, E[]]>('fs_list_detail', { dir: d });
      if (my === token) { list = l; err = ''; }
    } catch (e) { if (my === token) { list = []; err = String(e).replace(/^Error: /, ''); } }
  }
  $effect(() => { void st?.seq; load(dir); });

  function cd(name: string) {
    sessions.changeDir(pane.id, name).then(() => sessions.focus(pane.id)).catch((e) => notify(String(e), 'error'));
  }
  const up = $derived(!!dir && !/^[A-Za-z]:\\?$/.test(dir) && !/^\\\\[^\\]+\\[^\\]+\\?$/.test(dir));
  const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} K` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} M` : `${(n / 1073741824).toFixed(1)} G`);
</script>

<aside class="fp" style:font-family={app.settings.fontFamily || 'Consolas, monospace'} aria-label="Pliki">
  <header>
    <span class="path" title={st?.cwd || dir}><bdi>{st?.cwd || dir || '…'}</bdi></span>
    <button class="icobtn" title="Odśwież" onclick={() => load(dir)}><Icon name="refresh" size={12} /></button>
    <button class="icobtn" title="Zamknij panel" onclick={onclose}><Icon name="x" size={12} /></button>
  </header>
  <div class="items" role="listbox" aria-label="Zawartość katalogu">
    {#if !dir}
      <p class="hint">Czekam, aż powłoka poda katalog…</p>
    {:else if err}
      <p class="hint err">{err}</p>
    {:else}
      {#if up}
        <button class="row dir" role="option" aria-selected={sel === '..'} class:on={sel === '..'} onclick={() => (sel = '..')} ondblclick={() => cd('..')} onkeydown={(e) => e.key === 'Enter' && cd('..')}>
          <Icon name="folder" size={13} /><span class="n">..</span>
        </button>
      {/if}
      {#each list as e (e.name)}
        <button class="row" class:dir={e.isDir} class:on={sel === e.name} role="option" aria-selected={sel === e.name} title={e.name}
          onclick={() => (sel = e.name)} ondblclick={() => e.isDir && cd(e.name)} onkeydown={(k) => k.key === 'Enter' && e.isDir && cd(e.name)}>
          <Icon name={e.isDir ? 'folder' : 'file'} size={13} /><span class="n">{e.name}</span>
          {#if !e.isDir}<span class="sz">{size(e.size)}</span>{/if}
        </button>
      {/each}
      {#if !list.length}<p class="hint">Pusty katalog</p>{/if}
    {/if}
  </div>
</aside>

<style>
  .fp { display: flex; flex-direction: column; min-width: 0; height: 100%; background: var(--term-bg); color: var(--foreground); font-size: 12px; }
  header { display: flex; align-items: center; gap: 2px; height: 28px; padding: 0 4px 0 10px; border-bottom: 1px solid var(--border); flex: none; }
  .path { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; direction: rtl; text-align: left; color: var(--muted-foreground); }
  header .icobtn { width: 22px; height: 22px; }
  .items { flex: 1; overflow: auto; padding: 4px 0; scrollbar-width: thin; }
  .row { display: flex; align-items: center; gap: 7px; width: 100%; padding: 2px 10px; text-align: left; font: inherit; color: inherit; border-radius: 0; cursor: default; }
  .row :global(svg) { flex: none; opacity: .55; }
  .row:hover { background: var(--muted); }
  .row.on { background: color-mix(in oklab, var(--primary) 18%, transparent); }
  .row.dir { font-weight: 700; }
  .row.dir :global(svg) { opacity: .85; color: var(--primary); }
  .n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sz { flex: none; color: var(--muted-foreground); font-size: 11px; opacity: .7; }
  .hint { margin: 8px 10px; color: var(--muted-foreground); }
  .hint.err { color: var(--destructive); }
</style>
