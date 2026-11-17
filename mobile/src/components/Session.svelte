<script lang="ts">
  import Icon from '../../../src/lib/Icon.svelte';
  import { S, curPc, curWs, disconnect, open, req, msg, toast, can, loadChat, type View } from '../lib/store.svelte';
  import Terminal from './Terminal.svelte';
  import Agent from './Agent.svelte';
  import Flows from './Flows.svelte';
  import Parked from './Parked.svelte';
  import Sheet from './Sheet.svelte';
  import NewTab from './NewTab.svelte';

  const pc = $derived(curPc());
  const ws = $derived(curWs());
  const terms = $derived(ws?.tabs.filter((t) => t.kind === 'terminal') || []);
  const pending = $derived(Object.values(S.chat).flat().filter((m) => m.approve?.state === 'pending').length);
  const NAV: [View, string, string][] = [['term', 'Terminal', 'term'], ['agent', 'Agent', 'bot'], ['flows', 'Workflow', 'flow'], ['bg', 'W tle', 'layers']];

  function pickWs(id: string) {
    S.ws = id;
    const w = curWs();
    S.tab = (w?.activeTab && w.tabs.find((t) => t.id === w.activeTab && t.kind === 'terminal')?.id) || w?.tabs.find((t) => t.kind === 'terminal')?.id || '';
    if (S.view === 'agent') loadChat();
  }
  async function closeTab(id: string) {
    try { await req('closeTab', { tab: id }); } catch (e) { toast(msg(e)); }
  }
  const status = $derived(S.state === 'ready' ? 'ok' : S.state === 'connecting' || S.state === 'offline' ? 'wait' : 'bad');
  const statusText = $derived({ ready: 'połączono', connecting: 'łączę…', offline: 'brak połączenia, ponawiam…', waiting: 'czekam na zgodę', denied: 'odrzucono', error: S.error || 'błąd', idle: 'rozłączono' }[S.state]);
</script>

<div class="app">
  <header class="top">
    <button class="ib" aria-label="Komputery" onclick={disconnect}><Icon name="chev" size={20} /></button>
    <div class="who"><b>{pc?.name}</b><small><span class="dot {status}"></span>{statusText}{#if S.state === 'ready' && S.perm !== 'full'} · {S.perm === 'control' ? 'sterowanie' : 'podgląd'}{/if}</small></div>
    {#if S.state === 'error' || S.state === 'denied'}<button class="btn sm" onclick={() => pc && open(pc.device)}>Połącz</button>{/if}
    <button class="ib" aria-label="Ustawienia" onclick={() => (S.sheet = 'settings')}><Icon name="sliders" size={20} /></button>
  </header>

  {#if S.workspaces.length}
    <nav class="wss" aria-label="Workspace'y">
      {#each S.workspaces as w (w.id)}
        <button class:on={w.id === S.ws} style:--c={w.color} onclick={() => pickWs(w.id)}><span class="wdot"></span>{w.name}{#if w.busy}<span class="busy" title="Agent pracuje"></span>{/if}</button>
      {/each}
    </nav>
  {/if}

  {#if S.view === 'term'}
    <nav class="tabs" aria-label="Zakładki">
      {#each terms as t (t.id)}
        <button class:on={t.id === S.tab} onclick={() => (S.tab = t.id)}><span class="lab" style:color={t.color}>{t.label}</span>{t.title}
          {#if t.id === S.tab && can('full')}<span class="x" role="button" tabindex="0" aria-label="Zamknij {t.title}" onclick={(e) => { e.stopPropagation(); closeTab(t.id); }} onkeydown={(e) => e.key === 'Enter' && closeTab(t.id)}><Icon name="x" size={12} /></span>{/if}
        </button>
      {/each}
      {#if can('full')}<button class="plus" aria-label="Nowa zakładka" onclick={() => (S.sheet = 'newTab')}><Icon name="plus" size={16} /></button>{/if}
    </nav>
  {/if}

  <section class="content">
    {#if S.state !== 'ready' && !S.workspaces.length}
      <div class="wait"><span class="dot {status}"></span>{statusText}</div>
    {:else if S.view === 'term'}<Terminal />
    {:else if S.view === 'agent'}<Agent />
    {:else if S.view === 'flows'}<Flows />
    {:else}<Parked />{/if}
  </section>

  <nav class="bottom" aria-label="Widoki">
    {#each NAV as [v, label, icon]}
      <button class:on={S.view === v} onclick={() => { S.view = v; if (v === 'agent') loadChat(); }} aria-current={S.view === v ? 'page' : undefined}>
        <i><Icon name={icon} size={22} />{#if v === 'agent' && pending}<em>{pending}</em>{/if}{#if v === 'bg' && S.parked.length}<em class="n">{S.parked.length}</em>{/if}</i>{label}
      </button>
    {/each}
  </nav>
</div>

{#if S.sheet === 'newTab'}<Sheet title="Nowa zakładka" onclose={() => (S.sheet = null)}><NewTab /></Sheet>{/if}

<style>
  .app { height: 100%; display: flex; flex-direction: column; padding-top: var(--safe-t); }
  .top { display: flex; align-items: center; gap: 4px; height: 56px; padding: 0 4px; flex: none; }
  .top .ib:first-child :global(svg) { transform: rotate(180deg); }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .who b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who small { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted-foreground); }
  .who .dot { width: 7px; height: 7px; }
  .wss, .tabs { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding: 2px 12px 8px; flex: none; }
  .wss::-webkit-scrollbar, .tabs::-webkit-scrollbar { display: none; }
  .wss button { display: flex; align-items: center; gap: 8px; border: 0; border-radius: 999px; padding: 0 14px; min-height: 36px; white-space: nowrap; background: color-mix(in oklab, var(--c) 14%, transparent); }
  .wss button.on { background: color-mix(in oklab, var(--c) 30%, var(--card)); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--c) 55%, var(--border)); font-weight: 600; }
  .wdot { width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
  .busy { width: 6px; height: 6px; border-radius: 50%; background: var(--chart-3); animation: blink 1s infinite; }
  @keyframes blink { 50% { opacity: .2; } }
  .tabs button { display: flex; align-items: center; gap: 7px; border: 0; border-radius: 12px; padding: 0 12px; min-height: 36px; white-space: nowrap; background: transparent; color: var(--muted-foreground); font-size: 14px; }
  .tabs button.on { background: var(--card); color: var(--foreground); }
  .lab { font: 600 10.5px var(--font-mono); }
  .x { display: grid; place-items: center; width: 22px; height: 22px; margin-right: -6px; border-radius: 50%; }
  .plus { padding: 0 10px !important; }
  .content { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .wait { margin: auto; display: flex; align-items: center; gap: 10px; color: var(--muted-foreground); }
  .bottom { flex: none; display: grid; grid-template-columns: repeat(4, 1fr); padding: 6px 8px calc(6px + var(--safe-b)); border-top: 1px solid var(--border); background: var(--background); }
  .bottom button { display: flex; flex-direction: column; align-items: center; gap: 2px; border: 0; background: none; font-size: 12px; color: var(--muted-foreground); padding: 4px 0; }
  .bottom i { position: relative; display: grid; place-items: center; width: 56px; height: 30px; border-radius: 999px; transition: background .25s ease; }
  .bottom button.on { color: var(--foreground); font-weight: 600; }
  .bottom button.on i { background: var(--primary); color: var(--primary-foreground); }
  .bottom em { position: absolute; top: -4px; right: 6px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--destructive); color: #fff; font: 600 11px/18px var(--font-sans); font-style: normal; }
  .bottom em.n { background: var(--foreground); color: var(--background); }
</style>
