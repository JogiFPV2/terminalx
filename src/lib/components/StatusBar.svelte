<script lang="ts">
  import Icon from '../Icon.svelte';
  import { app, ui, curWs, curTab, shellName } from '../state.svelte';
  import * as sessions from '../terminal/sessions.svelte';
  import { agentState } from '../agent.svelte';
  import { plug, emit } from '../plugins/host.svelte';
  import { BRAND } from '../defaults';
  import { remote } from '../remote.svelte';

  const ws = $derived(curWs());
  const tab = $derived(curTab());
  const pane = $derived(tab?.panes.find((p) => p.id === ui.focusedPane) || tab?.panes[0]);
  const st = $derived(pane ? sessions.termStatus[pane.id] : undefined);
  const items = $derived(plug.status.filter((s) => s.visible && s.place !== 'top').sort((a, b) => b.priority - a.priority));
  const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
</script>

<footer class="status">
  {#if pane && tab?.kind === 'terminal'}
    <span title="Powłoka"><Icon name="term" size={12} />{shellName(pane.shell)}</span>
    {#if st?.cwd}<span class="cwd" title={st.cwd}>{st.cwd}</span>{/if}
    {#if st?.exited}<span class="warn" title="Proces zakończony"><Icon name="stop" size={12} /></span>{/if}
  {/if}
  {#if ui.pending.length}<span title="Do przywrócenia (Ctrl+Shift+T)"><Icon name="undo" size={12} />{ui.pending.length}</span>{/if}
  <div class="spacer"></div>
  {#each items as s (s.pluginId + s.id)}
    <button class="pitem {s.variant}" title={s.tooltip} disabled={!s.clickable} onclick={() => emit(s.pluginId, 'statusClick', { id: s.id })}>
      {#if s.icon}<Icon name={s.icon} size={12} />{/if}{s.text}
    </button>
  {/each}
  {#if tab && agentState.subBusy[tab.id]}<span title="Podagent: {agentState.subBusy[tab.id]}"><span class="sub busy"></span></span>
  {:else if agentState.busy[ws.id]}<span title="Agent pracuje"><span class="sub busy"></span></span>{/if}
  <button class:live={remote.running} title={remote.running ? `Zdalny dostęp: ${app.remote.mode === 'tailscale' ? 'Tailscale' : 'Wi-Fi'}, połączone urządzenia: ${remote.clients.length}` : 'Zdalny dostęp wyłączony'}
    onclick={() => { ui.settingsPage = 'remote'; ui.settingsOpen = true; }}><Icon name={remote.running ? 'wifi' : 'phone'} size={12} />{#if remote.clients.length}{remote.clients.length}{/if}</button>
  <span title="Pamięć rdzenia {BRAND.name} (bez WebView2 i powłok)"><Icon name="cpu" size={12} />{mb(ui.stats.appMem)}</span>
</footer>

<style>
  .status { display: flex; align-items: center; gap: 14px; padding: 0 10px; height: 24px; border-top: 1px solid var(--border); background: var(--sidebar); color: var(--muted-foreground); font-size: 11px; white-space: nowrap; overflow: hidden; font-variant-numeric: tabular-nums; }
  .status > span, .status > button { display: flex; align-items: center; gap: 5px; }
  .status button { color: inherit; font-size: 11px; padding: 0 4px; border-radius: 4px; height: 18px; }
  .status button:hover:not(:disabled) { background: var(--accent); color: var(--foreground); }
  .status button:disabled { cursor: default; }
  .cwd { max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
  .warn, .pitem.warning { color: var(--chart-3); }
  .pitem.error { color: var(--destructive); }
  .live { color: var(--chart-1) !important; }
</style>
