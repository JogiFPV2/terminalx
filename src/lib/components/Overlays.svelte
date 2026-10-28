<script lang="ts">
  import Icon from '../Icon.svelte';
  import { ui, undo } from '../state.svelte';

  let now = $state(Date.now());
  $effect(() => { const t = setInterval(() => (now = Date.now()), 500); return () => clearInterval(t); });

  let menuEl: HTMLDivElement | undefined = $state();
  let pos = $state({ x: 0, y: 0 });
  $effect(() => {
    const m = ui.menu;
    if (!m) return;
    pos = { x: m.x, y: m.y };
    requestAnimationFrame(() => {
      if (!menuEl) return;
      const r = menuEl.getBoundingClientRect();
      pos = { x: Math.max(4, Math.min(m.x, innerWidth - r.width - 6)), y: Math.max(4, Math.min(m.y, innerHeight - r.height - 6)) };
    });
  });

  let inputVal = $state('');
  $effect(() => { if (ui.confirm?.input) inputVal = ui.confirm.input.value; });
  function done(v: any) { const c = ui.confirm; ui.confirm = null; c?.resolve(v); }
  function focusEl(el: HTMLElement) { setTimeout(() => el.focus(), 0); }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && ui.menu) ui.menu = null; }} />

{#if ui.menu}
  <div class="menu-catch" role="presentation" onpointerdown={() => (ui.menu = null)} oncontextmenu={(e) => { e.preventDefault(); ui.menu = null; }}></div>
  <div class="menu" role="menu" bind:this={menuEl} style:left="{pos.x}px" style:top="{pos.y}px">
    {#each ui.menu.items as it}
      {#if it.sep}<hr />
      {:else if it.heading}<span class="label">{it.heading}</span>
      {:else}
        <button role="menuitem" disabled={it.disabled} onclick={() => { ui.menu = null; it.run?.(); }}>
          {#if it.badge}<span class="badge" style:--c={it.badge.c}>{it.badge.text}</span>{:else if it.icon}<span class="mi" style:color={it.c}><Icon name={it.icon} size={14} /></span>{:else}<span style="width:14px"></span>{/if}
          <span>{it.label}</span>
          {#if it.soon}<span class="soon">{it.soon}</span>{:else if it.kbd}<kbd>{it.kbd}</kbd>{/if}
        </button>
      {/if}
    {/each}
  </div>
{/if}

<div class="toasts" aria-live="polite">
  {#each ui.pending.slice(-4) as p (p.id)}
    <div class="toast">
      <div class="row"><span>{p.label}</span><small>{Math.max(0, Math.ceil((p.ms - (now - p.start)) / 1000))} s</small>
        <button class="btn" onclick={() => undo(p.id)}><Icon name="undo" />Przywróć</button></div>
      <div class="bar" style:animation-duration="{p.ms}ms" style:animation-delay="-{now - p.start}ms"></div>
    </div>
  {/each}
  {#each ui.toasts as t (t.id)}
    <div class="toast note {t.kind}"><div class="row"><span>{t.text}</span></div></div>
  {/each}
</div>

{#if ui.confirm}
  {@const c = ui.confirm}
  <div class="overlay" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && done(c.input ? null : false)}>
    <div class="dialog" role="dialog" aria-label={c.title}>
      <header>{c.title}</header>
      <div class="body">
        {#if c.message}<p class="hint" style="color:var(--foreground)">{c.message}</p>{/if}
        {#if c.input}
          <div class="field"><label for="cin">{c.input.label}</label>
            <input class="inp" id="cin" bind:value={inputVal} use:focusEl onkeydown={(e) => { if (e.key === 'Enter') done(inputVal); if (e.key === 'Escape') done(null); }} /></div>
        {/if}
      </div>
      <footer>
        <button class="btn" onclick={() => done(c.input ? null : false)}>Anuluj</button>
        <button class="btn {c.danger ? 'danger' : 'pri'}" use:focusEl onclick={() => done(c.input ? inputVal : true)}>{c.confirmLabel || 'OK'}</button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .menu-catch { position: fixed; inset: 0; z-index: 59; }
  .toasts { position: fixed; right: 12px; bottom: 34px; z-index: 65; display: flex; flex-direction: column; gap: 8px; width: min(360px, calc(100vw - 24px)); pointer-events: none; }
  .toast { background: var(--card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; box-shadow: 0 12px 30px -12px rgb(0 0 0 / .45); pointer-events: auto; }
  .toast .row { display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 12px; }
  .toast .row span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .toast.note .row span { white-space: normal; }
  .toast .row small { color: var(--muted-foreground); font-variant-numeric: tabular-nums; font-size: 11.5px; }
  .toast .bar { height: 2px; background: var(--primary); transform-origin: left; animation: shrink linear forwards; }
  .toast.success { border-left: 3px solid var(--chart-1); }
  .toast.warning { border-left: 3px solid var(--chart-3); }
  .toast.error { border-left: 3px solid var(--destructive); }
  @keyframes shrink { to { transform: scaleX(0); } }
</style>
