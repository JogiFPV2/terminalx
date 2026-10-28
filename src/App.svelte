<script lang="ts">
  import { onMount } from 'svelte';
  import TitleBar from './lib/components/TitleBar.svelte';
  import Sidebar from './lib/components/Sidebar.svelte';
  import TabBar from './lib/components/TabBar.svelte';
  import TabContent from './lib/components/TabContent.svelte';
  import Desk from './lib/components/Desk.svelte';
  import AgentPanel from './lib/components/AgentPanel.svelte';
  import StatusBar from './lib/components/StatusBar.svelte';
  import Overlays from './lib/components/Overlays.svelte';
  import CommandPalette from './lib/components/CommandPalette.svelte';
  import Settings from './lib/components/settings/Settings.svelte';
  import PluginFrame from './lib/components/PluginFrame.svelte';
  import { app, ui, curWs, curTab, loadState, scheduleSave, saveNow, finalizeAll, newTab, closeTab, undo, splitTab, addWorkspace, activateTab } from './lib/state.svelte';
  import { applyTheme, BUILTIN } from './lib/theme';
  import * as sessions from './lib/terminal/sessions.svelte';
  import { loadPlugins, startHost, enabledPlugins, broadcastTheme, emitAll, plug, runCommand } from './lib/plugins/host.svelte';
  import { startScheduler } from './lib/workflow/engine.svelte';
  import { startUpdates } from './lib/update.svelte';
  import { call, isTauri } from './lib/ipc';
  import { initHosts } from './lib/hosts.svelte';
  import { initRemote } from './lib/remote.svelte';

  let error = $state('');
  const ws = $derived(curWs());
  const tab = $derived(curTab());
  const hiddenPlugins = $derived(enabledPlugins().filter((p) => !p.manifest.contributes?.sidebar?.length));

  onMount(() => {
    let statsTimer = 0;
    let offClose: (() => void) | undefined;
    let offCli: (() => void) | undefined;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => theme();
    mq.addEventListener('change', onScheme);
    (async () => {
      try {
        initHosts();
        await loadState();
        theme();
        await loadPlugins();
        startHost();
        startScheduler();
        startUpdates();
        // „Otwórz w TerminalX” z Eksploratora i flagi --open-terminal-path / --open-terminal-shell.
        if (isTauri) {
          type CliOpen = { path?: string; shell?: string };
          const open = (o: CliOpen | null) => { if (o) newTab(o.shell && ui.shells.some((x) => x.id === o.shell) ? o.shell : app.settings.defaultShell, app.activeWs, o.path || undefined); };
          open(await call<CliOpen | null>('cli_initial').catch(() => null));
          const { listen } = await import('@tauri-apps/api/event');
          offCli = await listen<CliOpen>('cli-open', (e) => open(e.payload));
        }
        initRemote();
        const poll = async () => { try { ui.stats = await call('sys_stats'); } catch { /* ignore */ } };
        poll();
        statsTimer = window.setInterval(poll, 4000);
        if (isTauri) {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          offClose = await getCurrentWindow().onCloseRequested(async () => { finalizeAll(); await saveNow(); });
        }
      } catch (e) {
        error = String(e);
        console.error(e);
      }
    })();
    const beforeUnload = () => { finalizeAll(); saveNow(); };
    addEventListener('beforeunload', beforeUnload);
    return () => { clearInterval(statsTimer); offClose?.(); offCli?.(); mq.removeEventListener('change', onScheme); removeEventListener('beforeunload', beforeUnload); };
  });

  function theme() {
    applyTheme({ ...BUILTIN, ...app.settings.customThemes }, app.settings.themeName, app.settings.themeMode);
    sessions.refreshAll();
    broadcastTheme();
  }

  // Motyw: przy zmianie nazwy, trybu albo zaimportowanych motywów.
  $effect(() => {
    void app.settings.themeName; void app.settings.themeMode; void JSON.stringify(app.settings.customThemes);
    if (ui.ready) theme();
  });
  // Ustawienia terminala.
  $effect(() => {
    void app.settings.fontSize; void app.settings.fontFamily; void app.settings.lineHeight; void app.settings.cursorBlink; void app.settings.scrollback;
    if (ui.ready) sessions.refreshAll();
  });
  // Autozapis całego stanu (z opóźnieniem).
  $effect(() => {
    void JSON.stringify(app);
    if (ui.ready) scheduleSave();
  });
  // Pluginy z tabs:manage dostają zdarzenie przy każdej zmianie zakładek.
  $effect(() => {
    void app.workspaces.map((w) => w.tabs.map((t) => t.id + t.title).join()).join('|');
    void app.parked.map((p) => p.tab.id).join();
    if (ui.ready) emitAll('tabsChanged', null, 'tabs:manage');
  });

  function matchKey(e: KeyboardEvent, spec: string) {
    const parts = spec.toLowerCase().split('+');
    const key = parts.pop();
    return e.ctrlKey === parts.includes('ctrl') && e.shiftKey === parts.includes('shift') && e.altKey === parts.includes('alt') && e.key.toLowerCase() === key;
  }

  function onKey(e: KeyboardEvent) {
    if (!ui.ready) return;
    const k = e.key.toLowerCase();
    const firstWsl = ui.shells.find((s) => s.kind === 'wsl')?.id;
    const go = (fn: () => void) => { e.preventDefault(); e.stopPropagation(); fn(); };
    if (e.ctrlKey && !e.shiftKey && !e.altKey && k === 't') return go(() => newTab(app.settings.defaultShell));
    if (e.ctrlKey && !e.shiftKey && k === 'k') return go(() => (ui.palette = !ui.palette));
    if (e.ctrlKey && !e.shiftKey && k === ',') return go(() => (ui.settingsOpen = true));
    if (e.ctrlKey && e.key === 'Tab') {
      return go(() => {
        const w = curWs(); const i = w.tabs.findIndex((t) => t.id === w.activeTab);
        const n = w.tabs[(i + (e.shiftKey ? -1 : 1) + w.tabs.length) % w.tabs.length];
        if (n) activateTab(n.id);
      });
    }
    if (e.ctrlKey && e.shiftKey) {
      if (k === 't') return go(() => undo());
      if (k === 'w') return go(() => { const t = curTab(); if (t) closeTab(t.id); });
      if (k === 'n') return go(addWorkspace);
      if (k === 'e') return go(() => newTab('flow'));
      if (k === 'a') return go(() => (app.layout.agentOpen = !app.layout.agentOpen));
      if (k === 'd') return go(() => { const t = curTab(); if (t) splitTab(t.id); });
      if (k === 'f') return go(() => { const t = curTab(); if (t?.kind === 'terminal') ui.searchPane = (t.panes.find((p) => p.id === ui.focusedPane) || t.panes[0]).id; });
      if (e.code === 'Digit1') return go(() => newTab(ui.shells.find((s) => s.id === 'pwsh') ? 'pwsh' : 'powershell'));
      if (e.code === 'Digit2') return go(() => newTab('cmd'));
      if (e.code === 'Digit3' && firstWsl) return go(() => newTab(firstWsl));
    }
    if (e.key === 'F2' && !(e.target as HTMLElement).closest('input, textarea')) { const t = curTab(); if (t) return go(() => (ui.renamingTab = t.id)); }
    for (const c of plug.commands) if (c.keybinding && matchKey(e, c.keybinding)) return go(() => runCommand(c));
  }
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="app">
  <TitleBar />
  {#if error}
    <div class="fatal"><b>Nie udało się uruchomić aplikacji.</b><pre>{error}</pre></div>
  {:else if ui.ready}
    <div class="main" style:grid-template-columns="{app.layout.side}px minmax(0, 1fr) auto">
      <Sidebar />
      <div class="center">
        <TabBar />
        <div class="view">
          {#key ws.id}
            {#if ws.mode === 'windows'}
              <Desk {ws} />
            {:else if tab}
              {#key tab.id}<TabContent {tab} autofocus={true} />{/key}
            {:else}
              <div class="empty">
                <p>Brak zakładek w tym workspace.</p>
                <button class="btn pri" onclick={() => newTab(app.settings.defaultShell)}>Nowy terminal (Ctrl+T)</button>
              </div>
            {/if}
          {/key}
        </div>
      </div>
      {#if app.layout.agentOpen}<AgentPanel />{/if}
    </div>
  {:else}
    <div class="boot">Uruchamianie…</div>
  {/if}
  <StatusBar />
</div>

<div class="dock" aria-hidden="true">
  {#each hiddenPlugins as p (p.manifest.id)}<PluginFrame pluginId={p.manifest.id} hidden={true} />{/each}
</div>

{#if ui.settingsOpen}<Settings />{/if}
{#if ui.palette}<CommandPalette />{/if}
<Overlays />

<style>
  .app { height: 100%; display: grid; grid-template-rows: 36px 1fr 24px; background: var(--background); }
  .main { display: grid; min-height: 0; position: relative; }
  .center { display: grid; grid-template-rows: 34px 1fr; min-width: 0; min-height: 0; }
  .view { min-height: 0; min-width: 0; background: var(--term-bg); position: relative; }
  .empty, .boot { display: grid; place-items: center; align-content: center; gap: 12px; height: 100%; color: var(--muted-foreground); }
  .empty p { margin: 0; }
  .fatal { padding: 24px; color: var(--destructive); }
  .fatal pre { white-space: pre-wrap; color: var(--foreground); }
  .dock { position: fixed; left: 0; top: 0; width: 0; height: 0; overflow: visible; }
</style>
