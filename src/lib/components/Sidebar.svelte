<script lang="ts">
  import Icon from '../Icon.svelte';
  import PluginFrame from './PluginFrame.svelte';
  import { app, ui, curWs, activateTab, tabKind, newTab } from '../state.svelte';
  import { plug, sidebarPlugins, emit } from '../plugins/host.svelte';
  import { agentState } from '../agent.svelte';
  import { openVault, openMonitor, openGallery } from '../hosts.svelte';
  import { track, clamp } from '../util';

  const wide = $derived(app.layout.side >= 140);
  const ws = $derived(curWs());

  function gutter(e: PointerEvent) {
    e.preventDefault();
    const sx = e.clientX, start = app.layout.side;
    track((ev) => { const v = start + ev.clientX - sx; app.layout.side = v < 92 ? 44 : clamp(v, 140, 360); });
  }
  function toggleSection(id: string) {
    if (app.layout.collapsed[id]) delete app.layout.collapsed[id]; else app.layout.collapsed[id] = true;
  }
  const sectionFor = (pluginId: string) => plug.sections.find((s) => s.pluginId === pluginId);
  function onDropZone(e: DragEvent) { e.preventDefault(); }
</script>

<nav class="side" class:wide aria-label="Pasek boczny">
  <div class="rail">
    <button class="item" class:on={ws.tabs.find((t) => t.id === ws.activeTab)?.kind === 'terminal'} title="Nowy terminal" onclick={() => newTab(app.settings.defaultShell)}><Icon name="terminal" /></button>
    <button class="item" class:on={ws.tabs.find((t) => t.id === ws.activeTab)?.kind === 'vault'} title="Hosty SSH{app.hosts.length ? ` (${app.hosts.length})` : ''}" onclick={openVault}><Icon name="hosts" /></button>
    <button class="item" class:on={ws.tabs.find((t) => t.id === ws.activeTab)?.kind === 'flow'} title="Nowy workflow" onclick={() => newTab('flow')}><Icon name="flow" /></button>
    <button class="item" class:on={ws.tabs.find((t) => t.id === ws.activeTab)?.kind === 'gallery'} title="Galeria" onclick={openGallery}><Icon name="image" /></button>
    <button class="item" class:on={ws.tabs.find((t) => t.id === ws.activeTab)?.kind === 'monitor'} title="Monitoring" onclick={openMonitor}><Icon name="activity" /></button>
    <button class="item" title="Snippety" onclick={() => { ui.settingsPage = 'snippets'; ui.settingsOpen = true; }}><Icon name="snip" /></button>
  </div>

  {#if wide}
    <div class="sect">
      {#each ws.tabs as t (t.id)}
        {@const k = tabKind(t)}
        <button class:on={t.id === ws.activeTab} onclick={() => activateTab(t.id)} title={t.title}>
          <span class="ki" style:color={k.c}><Icon name={k.icon} size={14} /></span><span class="tt">{t.title}</span>
          {#if agentState.subBusy[t.id]}<span class="sub busy"></span>{:else if t.subagent}<span class="sub"></span>{/if}
        </button>
      {/each}
    </div>
  {/if}

  <div class="plugs" class:narrow={!wide}>
    {#if !wide}
      {#each sidebarPlugins() as p (p.manifest.id)}
        <button class="icobtn pico" title={p.manifest.name} onclick={() => (app.layout.side = 240)}><Icon name={p.manifest.icon || 'puzzle'} /></button>
      {/each}
    {/if}
    {#each sidebarPlugins() as p (p.manifest.id)}
      {@const s = sectionFor(p.manifest.id)}
      {@const decl = p.manifest.contributes?.sidebar?.[0]}
      {@const col = !!app.layout.collapsed[p.manifest.id]}
      <div class="psect" class:collapsed={col} class:hide={!wide} data-tabdrop={s?.acceptsTabs ? p.manifest.id : undefined}
        ondragover={onDropZone} role="region" aria-label={s?.title || decl?.title || p.manifest.name}>
        <div class="psect-h" role="button" tabindex="0" aria-expanded={!col} onclick={() => toggleSection(p.manifest.id)}
          onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggleSection(p.manifest.id))}>
          <span class="pchev"><Icon name="chev" size={11} /></span>
          <span class="label"><Icon name={s?.icon || decl?.icon || p.manifest.icon || 'puzzle'} size={12} />{s?.title || decl?.title || p.manifest.name}
            {#if s?.badge != null}<span class="count">{s.badge}</span>{/if}</span>
          {#if !col && s}
            {#each s.actions as a (a.id)}
              <button class="icobtn act" title={a.title} onclick={(e) => { e.stopPropagation(); emit(p.manifest.id, 'sectionAction', { sectionId: s.id, actionId: a.id }); }}><Icon name={a.icon} size={14} /></button>
            {/each}
          {/if}
        </div>
        <div class="psect-b"><PluginFrame pluginId={p.manifest.id} /></div>
        {#if plug.crashed[p.manifest.id]}<div class="crash" title={plug.crashed[p.manifest.id]}>Plugin zgłosił błąd przy starcie.</div>{/if}
      </div>
    {/each}
  </div>

  <div class="rail end"><button class="item" title="Ustawienia (Ctrl+,)" onclick={() => (ui.settingsOpen = true)}><Icon name="gear" /></button></div>
  <div class="gutter" role="separator" aria-orientation="vertical" aria-label="Szerokość paska bocznego" onpointerdown={gutter}
    ondblclick={() => (app.layout.side = app.layout.side > 44 ? 44 : 240)}></div>
</nav>

<style>
  .side { background: var(--sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; gap: 2px; padding: 8px 6px; position: relative; min-width: 0; min-height: 0; }
  .rail { display: flex; flex-direction: column; gap: 2px; flex: none; }
  .wide .rail { flex-direction: row; justify-content: space-between; padding: 0 2px; }
  .wide .rail.end { justify-content: flex-start; }
  .item { display: grid; place-items: center; height: 32px; width: 32px; border-radius: 6px; color: var(--muted-foreground); position: relative; flex: none; }
  .item:hover:not(:disabled) { background: var(--accent); color: var(--foreground); }
  .item:disabled { opacity: .55; cursor: default; }
  .item.on { background: var(--accent); color: var(--foreground); }
  .item.on { color: var(--primary); }
  .sect { display: flex; flex-direction: column; gap: 1px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); flex: 0 1 auto; max-height: 30%; overflow: auto; }
  .ki { display: grid; flex: none; }
  .sect button { display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 8px; border-radius: 6px; color: var(--muted-foreground); white-space: nowrap; overflow: hidden; width: 100%; flex: none; }
  .sect button:hover, .sect button.on { background: var(--accent); color: var(--foreground); }
  .tt { overflow: hidden; text-overflow: ellipsis; }
  .plugs { flex: 1 1 0; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 14px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
  .plugs.narrow { align-items: center; gap: 4px; }
  .pico { width: 32px; height: 32px; }
  .psect { display: flex; flex-direction: column; min-height: 0; flex: none; border-radius: 6px; }
  .psect.hide { display: none; }
  .psect.collapsed .psect-b { display: none; }
  .psect-h { display: flex; align-items: center; gap: 2px; padding: 0 2px 0 8px; min-height: 24px; border-radius: 5px; cursor: pointer; user-select: none; margin-bottom: 4px; }
  .psect-h:hover { background: var(--accent); }
  .psect-h .label { flex: 1; display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; white-space: nowrap; }
  .pchev { display: grid; place-items: center; width: 12px; margin-left: -4px; color: var(--muted-foreground); }
  .pchev :global(svg) { transform: rotate(90deg); transition: transform .12s; }
  .collapsed .pchev :global(svg) { transform: none; }
  .count { font-size: 10.5px; color: var(--muted-foreground); letter-spacing: 0; margin-left: 2px; font-variant-numeric: tabular-nums; }
  .act { width: 22px; height: 22px; }
  .psect:global(.drop-ok) { outline: 1px dashed var(--primary); outline-offset: 2px; background: color-mix(in oklab, var(--primary) 8%, transparent); }
  .crash { font-size: 11.5px; color: var(--destructive); padding: 2px 8px; }
  .gutter { position: absolute; top: 0; bottom: 0; right: -4px; width: 7px; z-index: 6; cursor: col-resize; touch-action: none; }
  .gutter::after { content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 1px; transition: background .12s; }
  .gutter:hover::after { background: var(--primary); width: 2px; left: 2px; }
</style>
