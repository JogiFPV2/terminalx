<script lang="ts">
  import Icon from '../../Icon.svelte';
  import { app, deferClose } from '../../state.svelte';
  import { nid } from '../../util';
  import type { PromptItem } from '../../types';

  let selId = $state<string | null>(null);
  const sel = $derived(app.prompts.find((p) => p.id === selId) || null);
  let form = $state({ name: '', parent: '' as string, body: '' });
  $effect(() => { const s = sel; if (s) form = { name: s.name, parent: s.parent || '', body: s.body || '' }; });

  const children = (parent: string | null) => app.prompts.filter((p) => p.parent === parent);
  function inside(id: string, anc: string) { let n = app.prompts.find((p) => p.id === id); while (n?.parent) { if (n.parent === anc) return true; n = app.prompts.find((p) => p.id === n!.parent); } return false; }
  const count = (id: string) => app.prompts.filter((p) => p.type === 'prompt' && (p.parent === id || inside(p.id, id))).length;
  function path(id: string): string { const parts: string[] = []; let n = app.prompts.find((p) => p.id === id); while (n) { parts.unshift(n.name); n = n.parent ? app.prompts.find((p) => p.id === n!.parent) : undefined; } return parts.join(' / '); }
  const folders = $derived(app.prompts.filter((p) => p.type === 'folder' && p.id !== selId && !(selId && inside(p.id, selId))));
  const usedIn = (id: string) => Object.values(app.flows).flatMap((f) => f.nodes).filter((n) => n.cfg?.base === id).length + app.nodeTypes.filter((t) => t.defaults?.base === id).length;

  function targetParent() { return sel ? (sel.type === 'folder' ? sel.id : sel.parent) : null; }
  function add(type: 'folder' | 'prompt', parent = targetParent()) {
    const p: PromptItem = { id: nid(type === 'folder' ? 'pf' : 'p'), type, parent, name: type === 'folder' ? 'Nowy folder' : 'Nowy prompt', ...(type === 'prompt' ? { body: '{{input}}' } : { open: true }) };
    app.prompts.push(p);
    if (parent) { const f = app.prompts.find((x) => x.id === parent); if (f) f.open = true; }
    selId = p.id;
    setTimeout(() => (document.getElementById('peName') as HTMLInputElement | null)?.select(), 30);
  }
  function save() {
    if (!sel) return;
    sel.name = form.name.trim() || sel.name;
    sel.parent = form.parent || null;
    if (sel.type === 'prompt') sel.body = form.body;
  }
  function remove() {
    if (!sel) return;
    const ids = new Set([sel.id]);
    app.prompts.forEach(() => app.prompts.forEach((x) => { if (x.parent && ids.has(x.parent)) ids.add(x.id); }));
    const removed = app.prompts.filter((x) => ids.has(x.id));
    const pos = removed.map((x) => app.prompts.indexOf(x));
    const label = sel.type === 'folder' ? `Usunięto folder promptów „${sel.name}”` : `Usunięto prompt „${sel.name}”`;
    const keep = sel.id;
    deferClose(label, () => { app.prompts = app.prompts.filter((x) => !ids.has(x.id)); selId = null; },
      () => { removed.forEach((x, i) => app.prompts.splice(Math.min(pos[i], app.prompts.length), 0, x)); selId = keep; });
  }
</script>

{#snippet tree(parent: string | null, d: number)}
  {#each children(parent) as p (p.id)}
    {#if p.type === 'folder'}
      <div class="nrow folder" class:open={p.open} class:sel={selId === p.id} style:--d={d}>
        <button class="chev" aria-label={p.open ? 'Zwiń' : 'Rozwiń'} onclick={() => (p.open = !p.open)}><Icon name="chev" size={12} /></button>
        <Icon name="folder" size={14} />
        <button class="nm" onclick={() => (selId = p.id)}>{p.name}</button><span class="count">{count(p.id)}</span>
      </div>
      {#if p.open}{@render tree(p.id, d + 1)}{/if}
    {:else}
      <button class="nrow note" class:sel={selId === p.id} style:--d={d} onclick={() => (selId = p.id)}><span style="width:12px"></span><Icon name="book" size={14} /><span class="nm">{p.name}</span></button>
    {/if}
  {/each}
{/snippet}

<div class="pagehead"><h2>Prompty</h2>
  <div><button class="icobtn" title="Nowy folder" onclick={() => add('folder')}><Icon name="folder-plus" /></button><button class="icobtn" title="Nowy prompt" onclick={() => add('prompt')}><Icon name="plus" /></button></div>
</div>
<p class="hint">Biblioteka promptów bazowych w folderach. Node AI, własny typ noda albo snippet może wskazać prompt bazowy i dopisać do niego swój.</p>

<div class="plib">
  <div class="ptree" aria-label="Foldery promptów">{@render tree(null, 0)}{#if !app.prompts.length}<div class="empty">Pusto. Dodaj folder.</div>{/if}</div>
  <div class="pedit">
    {#if sel}
      <div class="field"><label for="peName">{sel.type === 'folder' ? 'Nazwa folderu' : 'Nazwa'}</label><input class="inp" id="peName" bind:value={form.name} /></div>
      <div class="field"><label for="pePar">{sel.type === 'folder' ? 'Folder nadrzędny' : 'Folder'}</label>
        <select class="inp" id="pePar" bind:value={form.parent}><option value="">(katalog główny)</option>{#each folders as f}<option value={f.id}>{path(f.id)}</option>{/each}</select></div>
      {#if sel.type === 'prompt'}
        <div class="field"><label for="peBody">Treść promptu bazowego</label><textarea class="inp" id="peBody" bind:value={form.body} style="min-height:220px"></textarea>
          <small>Używany w {usedIn(sel.id)} miejscach. Zmienne: <code class="k">{'{{input}}'}</code> i dowolne <code class="k">{'{{nazwa}}'}</code>.</small></div>
      {:else}
        <div class="formbtns" style="justify-content:flex-start"><button class="btn" onclick={() => add('prompt', sel!.id)}><Icon name="plus" />Prompt w tym folderze</button><button class="btn" onclick={() => add('folder', sel!.id)}><Icon name="folder-plus" />Podfolder</button></div>
      {/if}
      <div class="formbtns"><button class="btn danger" onclick={remove}><Icon name="trash" />Usuń</button><span class="spacer"></span><button class="btn pri" onclick={save}>Zapisz</button></div>
    {:else}
      <p class="hint">Wybierz prompt albo folder z listy.</p>
    {/if}
  </div>
</div>

<style>
  .plib { display: grid; grid-template-columns: 250px 1fr; gap: 14px; min-height: 380px; }
  .ptree { border: 1px solid var(--border); border-radius: 8px; padding: 6px; overflow: auto; max-height: 480px; background: var(--background); }
  .pedit { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .nrow { display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 3px 0 calc(6px + var(--d) * 14px); border-radius: 5px; color: var(--muted-foreground); width: 100%; text-align: left; }
  .nrow:hover, .nrow.sel { background: var(--accent); color: var(--foreground); }
  .chev { width: 16px; height: 16px; display: grid; place-items: center; margin-left: -4px; }
  .chev :global(svg) { transition: transform .12s; }
  .nrow.open .chev :global(svg) { transform: rotate(90deg); }
  .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
  .count { font-size: 10.5px; color: var(--muted-foreground); padding-right: 6px; }
  .empty { padding: 8px; color: var(--muted-foreground); }
</style>
