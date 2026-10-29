<script module lang="ts">
  export interface Item { value: string; label?: string; hint?: string }
</script>

<script lang="ts">
  // Wybór z listy z wyszukiwaniem i podpowiedziami: przycisk-chip, a po kliknięciu okienko z polem szukania.
  // Strzałki wybierają, Enter zatwierdza, Esc zamyka. `custom` pozwala zatwierdzić wpisaną wartość spoza listy.
  import Icon from '../Icon.svelte';

  let { value, label, items, icon = '', title = '', placeholder = 'Szukaj…', custom = false, loading = false, up = true, onopen, onpick }: {
    value: string; label: string; items: Item[]; icon?: string; title?: string; placeholder?: string; custom?: boolean; loading?: boolean; up?: boolean;
    onopen?: () => void; onpick: (v: string) => void;
  } = $props();

  let open = $state(false);
  let q = $state('');
  let hi = $state(0);
  let root: HTMLDivElement;
  let listEl = $state<HTMLDivElement>();
  let pos = $state('');

  // Najpierw trafienia od początku nazwy, potem w środku; wielkość liter bez znaczenia.
  const shown = $derived.by(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    const words = s.split(/\s+/);
    const score = (it: Item) => { const t = `${it.label || it.value} ${it.value} ${it.hint || ''}`.toLowerCase(); return words.every((w) => t.includes(w)) ? (t.startsWith(words[0]) ? 0 : 1) : -1; };
    return items.map((it) => [score(it), it] as const).filter(([sc]) => sc >= 0).sort((a, b) => a[0] - b[0]).map(([, it]) => it);
  });
  const extra = $derived(custom && q.trim() && !items.some((i) => i.value === q.trim()) ? q.trim() : '');
  const total = $derived(shown.length + (extra ? 1 : 0));

  function toggle() {
    open = !open;
    if (open) {
      // Pozycja stała względem okna, przyciśnięta do krawędzi: okienko nie rozpycha układu.
      const r = root.getBoundingClientRect(), w = Math.min(260, innerWidth - 16), left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
      pos = `left:${left}px;width:${w}px;` + (up ? `bottom:${innerHeight - r.top + 4}px` : `top:${r.bottom + 4}px`);
      q = ''; hi = Math.max(0, items.findIndex((i) => i.value === value)); onopen?.(); requestAnimationFrame(scrollHi); }
  }
  function pick(v: string) { open = false; if (v && v !== value) onpick(v); }
  function scrollHi() { listEl?.querySelector('.hi')?.scrollIntoView({ block: 'nearest' }); }
  function key(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); hi = (hi + (e.key === 'ArrowDown' ? 1 : -1) + total) % Math.max(1, total); requestAnimationFrame(scrollHi); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(hi < shown.length ? shown[hi]?.value : extra); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); open = false; }
  }
  function outside(e: PointerEvent) { if (open && !root.contains(e.target as Node)) open = false; }
  function mark(text: string) {
    const s = q.trim().split(/\s+/)[0];
    const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    const i = s ? text.toLowerCase().indexOf(s.toLowerCase()) : -1;
    return i < 0 ? esc(text) : `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + s.length))}</mark>${esc(text.slice(i + s.length))}`;
  }
  function focusEl(el: HTMLInputElement) { el.focus(); }
</script>

<svelte:window onpointerdown={outside} />

<div class="combo" bind:this={root}>
  <button class="chip" class:on={open} {title} aria-haspopup="listbox" aria-expanded={open} onclick={toggle}>
    {#if icon}<Icon name={icon} size={12} />{/if}<span class="cl">{label}</span><Icon name="chev" size={10} />
  </button>
  {#if open}
    <div class="pop" style={pos} role="dialog" aria-label={title}>
      <div class="search"><Icon name="search" size={12} />
        <input use:focusEl bind:value={q} {placeholder} aria-label={placeholder} spellcheck="false" autocomplete="off"
          oninput={() => (hi = 0)} onkeydown={key} />
        {#if loading}<span class="spin" title="Pobieranie listy…"></span>{/if}
      </div>
      <div class="items" role="listbox" bind:this={listEl}>
        {#each shown as it, i (it.value)}
          <button class="it" class:hi={i === hi} class:cur={it.value === value} role="option" aria-selected={it.value === value}
            onpointerenter={() => (hi = i)} onclick={() => pick(it.value)}>
            <span class="tx">{@html mark(it.label || it.value)}</span>
            {#if it.hint}<span class="hint">{it.hint}</span>{/if}
            {#if it.value === value}<Icon name="check" size={12} />{/if}
          </button>
        {/each}
        {#if extra}
          <button class="it" class:hi={hi === shown.length} role="option" aria-selected="false" onpointerenter={() => (hi = shown.length)} onclick={() => pick(extra)}>
            <span class="tx">Użyj „{extra}”</span>
          </button>
        {/if}
        {#if !total}<p class="none">{loading ? 'Pobieranie…' : 'Brak wyników'}</p>{/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .combo { position: relative; min-width: 0; }
  .chip { display: flex; align-items: center; gap: 4px; max-width: 100%; height: 22px; padding: 0 6px; border-radius: 5px; font-size: 11.5px; color: var(--muted-foreground); }
  .chip:hover, .chip.on { background: var(--muted); color: var(--foreground); }
  .cl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .chip :global(svg:last-child) { transform: rotate(90deg); opacity: .6; flex: none; }
  .pop { position: fixed; z-index: 60; background: var(--card); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 12px 32px -12px rgb(0 0 0 / .45); display: flex; flex-direction: column; overflow: hidden; }
  .search { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--border); color: var(--muted-foreground); }
  .search input { flex: 1; min-width: 0; background: none; border: 0; outline: none; color: var(--foreground); font: inherit; font-size: 12.5px; }
  .items { max-height: 260px; overflow: auto; padding: 4px; display: flex; flex-direction: column; }
  .it { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 5px; text-align: left; font-size: 12.5px; color: var(--foreground); min-width: 0; }
  .it.hi { background: var(--muted); }
  .it.cur { font-weight: 600; }
  .it :global(svg) { color: var(--primary); flex: none; }
  .tx { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tx :global(mark) { background: none; color: var(--primary); font-weight: 600; }
  .hint { flex: none; font-size: 10.5px; color: var(--muted-foreground); }
  .none { margin: 6px 8px; font-size: 12px; color: var(--muted-foreground); }
  .spin { width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid var(--muted-foreground); border-top-color: transparent; animation: spin .8s linear infinite; flex: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
