<script lang="ts">
  // Galeria wyników workflow: obrazy i wideo z promptem, modelem i seedem. Dane: media/gallery.jsonl.
  import Icon from '../Icon.svelte';
  import { app, notify, activateTab } from '../state.svelte';
  import { call, isTauri } from '../ipc';
  import { mediaSrc } from '../workflow/media';

  type Entry = { path: string; kind: 'image' | 'video'; op: string; prompt: string; provider: string; model: string; seed: number | null; aspect?: string; flowId: string; nodeId: string; at: number };

  let items = $state<Entry[]>([]);
  let filter = $state<'all' | 'image' | 'video'>('all');
  let q = $state('');
  let view = $state<number | null>(null);
  let loaded = $state(false);

  async function load() {
    items = isTauri ? (await call<Entry[]>('gallery_list').catch(() => [])).reverse() : [];
    loaded = true;
  }
  load();

  const shown = $derived(items.filter((e) => (filter === 'all' || e.kind === filter) && (!q || e.prompt.toLowerCase().includes(q.toLowerCase()) || e.model.toLowerCase().includes(q.toLowerCase()))));
  const cur = $derived(view != null ? shown[view] : null);
  const date = (t: number) => new Date(t).toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  async function reveal(e: Entry) {
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    await revealItemInDir(e.path).catch((err) => notify(String(err), 'error'));
  }
  async function remove(e: Entry) {
    await call('gallery_remove', { paths: [e.path] }).catch((err) => notify(String(err), 'error'));
    items = items.filter((x) => x.path !== e.path);
    if (view != null && view >= shown.length) view = shown.length ? shown.length - 1 : null;
  }
  /** Ustawia seed w nodzie, który wygenerował plik, i przechodzi do jego workflow. */
  function reuse(e: Entry) {
    const flow = app.flows[e.flowId];
    const node = flow?.nodes.find((n) => n.id === e.nodeId);
    if (!node) { notify('Workflow albo node, z którego pochodzi ten plik, już nie istnieje', 'warning'); return; }
    if (e.seed != null) node.cfg.seed = String(e.seed);
    const tab = app.workspaces.flatMap((w) => w.tabs).find((t) => t.flowId === e.flowId);
    if (tab) activateTab(tab.id);
    view = null;
    notify(e.seed != null ? `Seed ${e.seed} ustawiony w nodzie – uruchom go ponownie` : 'Provider nie zwrócił seeda; przechodzę do noda', 'success');
  }
  function key(ev: KeyboardEvent) {
    const v = view;
    if (v == null) return;
    if (ev.key === 'Escape') view = null;
    else if (ev.key === 'ArrowRight') view = (v + 1) % shown.length;
    else if (ev.key === 'ArrowLeft') view = (v - 1 + shown.length) % shown.length;
  }
  const focusMe = (el: HTMLElement) => el.focus();
</script>

<div class="gal">
  <div class="bar">
    <span class="title">Galeria</span>
    <input class="inp search" placeholder="Szukaj w promptach i modelach" bind:value={q} />
    <span class="spacer"></span>
    <div class="seg">
      <button class:on={filter === 'all'} title="Wszystko" onclick={() => (filter = 'all')}><Icon name="layers" size={13} /></button>
      <button class:on={filter === 'image'} title="Obrazy" onclick={() => (filter = 'image')}><Icon name="image" size={13} /></button>
      <button class:on={filter === 'video'} title="Wideo" onclick={() => (filter = 'video')}><Icon name="film" size={13} /></button>
    </div>
    <button class="icobtn" title="Odśwież" onclick={load}><Icon name="refresh" size={14} /></button>
  </div>
  {#if loaded && !shown.length}
    <p class="empty">{items.length ? 'Nic nie pasuje do filtra.' : 'Tu pojawią się obrazy i wideo z nodów workflow.'}</p>
  {/if}
  <div class="grid">
    {#each shown as e, i (e.path)}
      <button class="cell" title={e.prompt} onclick={() => (view = i)}>
        {#if e.kind === 'video'}
          <video src={mediaSrc(e.path)} muted loop playsinline preload="metadata" onmouseenter={(ev) => ev.currentTarget.play()} onmouseleave={(ev) => ev.currentTarget.pause()}></video>
          <span class="badge"><Icon name="film" size={11} /></span>
        {:else}
          <img src={mediaSrc(e.path)} alt="" loading="lazy" draggable="false" />
        {/if}
      </button>
    {/each}
  </div>
</div>

{#if cur}
  <div class="lb" role="dialog" aria-modal="true" aria-label="Podgląd" tabindex="-1" use:focusMe onkeydown={key}
    onclick={(ev) => { if (ev.target === ev.currentTarget) view = null; }}>
    <div class="media">
      {#if cur.kind === 'video'}<video src={mediaSrc(cur.path)} controls autoplay loop><track kind="captions" /></video>{:else}<img src={mediaSrc(cur.path)} alt="" />{/if}
    </div>
    <aside>
      <p class="prompt">{cur.prompt || '(bez promptu)'}</p>
      <dl>
        <dt>Model</dt><dd>{cur.model || '–'}{cur.provider ? ` · ${cur.provider}` : ''}</dd>
        <dt>Seed</dt><dd>{cur.seed ?? '–'}</dd>
        {#if cur.aspect}<dt>Proporcje</dt><dd>{cur.aspect}</dd>{/if}
        <dt>Data</dt><dd>{date(cur.at)}</dd>
      </dl>
      <div class="acts">
        <button class="icobtn" title="Powtórz z tym seedem" onclick={() => reuse(cur)}><Icon name="undo" size={14} /></button>
        <button class="icobtn" title="Kopiuj prompt" onclick={() => navigator.clipboard.writeText(cur.prompt).then(() => notify('Skopiowano prompt', 'success'))}><Icon name="copy" size={14} /></button>
        <button class="icobtn" title="Pokaż w folderze" onclick={() => reveal(cur)}><Icon name="folder" size={14} /></button>
        <button class="icobtn" title="Usuń plik" onclick={() => remove(cur)}><Icon name="trash" size={14} /></button>
        <span class="spacer"></span>
        <button class="icobtn" title="Zamknij (Esc)" onclick={() => (view = null)}><Icon name="x" size={14} /></button>
      </div>
    </aside>
  </div>
{/if}

<style>
  .gal { height: 100%; overflow: auto; padding: 10px 14px; background: var(--background); }
  .bar { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; position: sticky; top: -10px; padding: 4px 0; background: var(--background); z-index: 1; }
  .title { font-weight: 600; margin-right: 6px; }
  .search { max-width: 280px; height: 28px; }
  .spacer { flex: 1; }
  .seg { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .seg button { width: 28px; height: 26px; display: grid; place-items: center; color: var(--muted-foreground); }
  .seg button.on { background: var(--accent); color: var(--foreground); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
  .cell { position: relative; aspect-ratio: 1; border-radius: 6px; overflow: hidden; background: var(--muted); padding: 0; }
  .cell img, .cell video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .cell:hover { outline: 2px solid var(--primary-ink); outline-offset: -2px; }
  .badge { position: absolute; right: 5px; bottom: 5px; background: rgb(0 0 0 / .55); color: #fff; border-radius: 4px; padding: 2px 4px; display: grid; }
  .empty { color: var(--muted-foreground); text-align: center; margin-top: 60px; }
  .lb { position: fixed; inset: 0; z-index: 50; background: rgb(0 0 0 / .82); display: flex; outline: none; }
  .media { flex: 1; display: grid; place-items: center; padding: 20px; min-width: 0; }
  .media img, .media video { max-width: 100%; max-height: calc(100vh - 40px); object-fit: contain; border-radius: 6px; }
  aside { width: 300px; background: var(--card); color: var(--card-foreground); padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow: auto; }
  .prompt { white-space: pre-wrap; font-size: 13px; line-height: 1.45; margin: 0; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; margin: 0; font-size: 12px; }
  dt { color: var(--muted-foreground); }
  dd { margin: 0; word-break: break-all; }
  .acts { display: flex; gap: 2px; margin-top: auto; }
  @media (max-width: 700px) { .lb { flex-direction: column; } aside { width: auto; } }
</style>
