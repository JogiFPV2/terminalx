<script lang="ts">
  // Workspace'y: telefonu (Termux, SSH, notatki, agent, pliki, workflow, terminale z komputera) i, gdy telefon jest
  // połączony z komputerem, także workspace'y komputera z ich zakładkami, z innym podświetleniem (obramowanie i ikona
  // monitora). Terminale telefonu zostają zamontowane w tle, więc sesje nie znikają przy przełączaniu.
  import { onMount } from 'svelte';
  import Icon from '../../../src/lib/Icon.svelte';
  import { WS_COLOR_LIST } from '../../../src/lib/defaults';
  import { WS, curLocal, addWs, removeWs, addTab, closeTab, saveWs, tabHost, wsTools, KIND_ICON, KIND_NAME, sshHostsForTabs, type LTab, type LWs, type TabKind } from '../lib/ws.svelte';
  import { S, open, lastPc, curPc, toast, msg, can, req } from '../lib/store.svelte';
  import { termuxHost, refreshTermux } from '../lib/termux.svelte';
  import { startScheduler } from '../lib/flow.svelte';
  import { AG } from '../lib/agent.svelte';
  import { SSH } from '../lib/ssh.svelte';
  import TermView from './TermView.svelte';
  import TermuxSetup from './TermuxSetup.svelte';
  import NotesTab from './NotesTab.svelte';
  import SftpTab from './SftpTab.svelte';
  import FlowTab from './FlowTab.svelte';
  import ChatView from './ChatView.svelte';
  import Terminal from './Terminal.svelte';
  import Agent from './Agent.svelte';
  import Flows from './Flows.svelte';
  import Sheet from './Sheet.svelte';

  /** Zakładki z terminalem już otwarte (zostają zamontowane w tle). */
  let mounted = $state<Record<string, boolean>>({});
  let termuxReady = $state(!!termuxHost());
  let newName = $state('');
  let pick = $state<'' | 'ssh' | 'sftp' | 'remote'>('');

  const isPc = $derived(WS.cur.startsWith('pc:'));
  const w = $derived(curLocal());
  const pcWs = $derived(isPc ? S.workspaces.find((x) => `pc:${x.id}` === WS.cur) || null : null);
  const pcName = $derived(curPc()?.name || 'Komputer');
  const pcOnline = $derived(S.state === 'ready');
  const active = $derived(w?.tabs.find((t) => t.id === w.active) || null);
  const allTerms = $derived(WS.list.flatMap((x) => x.tabs.filter((t) => t.kind === 'termux' || t.kind === 'ssh').map((t) => ({ t, ws: x }))));

  onMount(() => {
    if (!WS.cur || (!WS.cur.startsWith('pc:') && !WS.list.some((x) => x.id === WS.cur))) WS.cur = WS.list[0].id;
    refreshTermux();
    startScheduler();
    // Sparowany komputer: łączymy się w tle, żeby pokazać jego workspace'y obok tych z telefonu.
    const pc = lastPc();
    if (pc && !S.cur) open(pc.device, true).catch(() => {});
  });

  $effect(() => { if (active && (active.kind === 'termux' || active.kind === 'ssh')) mounted[active.id] = true; });
  // Workspace komputera zniknął (rozłączono): wracamy do pierwszego z telefonu.
  $effect(() => { if (isPc && !pcWs && S.state !== 'connecting') WS.cur = WS.list[0].id; });

  function selectPc(id: string) {
    WS.cur = `pc:${id}`;
    S.ws = id;
    const x = S.workspaces.find((y) => y.id === id);
    S.tab = (x?.activeTab && x.tabs.find((t) => t.id === x.activeTab && t.kind === 'terminal')?.id) || x?.tabs.find((t) => t.kind === 'terminal')?.id || '';
  }

  function add(kind: TabKind, extra: Partial<LTab> = {}) {
    if (!w) return;
    const title = extra.title || (kind === 'ssh' || kind === 'sftp' ? SSH.hosts.find((h) => h.id === extra.host)?.name || KIND_NAME[kind] : KIND_NAME[kind]);
    addTab(w, { kind, title, ...extra, ...(kind === 'notes' ? { note: '' } : {}) });
    WS.sheet = null; pick = '';
  }

  async function connectRemote(device: string) { try { await open(device, true); } catch (e) { toast(msg(e)); } }
  async function closePcTab(id: string) { try { await req('closeTab', { tab: id }); } catch (e) { toast(msg(e)); } }
  function renameTab(t: LTab) { const n = prompt('Nazwa zakładki', t.title); if (n?.trim()) { t.title = n.trim().slice(0, 30); saveWs(); } }

  const editWs = $derived(WS.list.find((x) => x.id === WS.edit) || null);
</script>

<div class="app">
  <header class="top">
    <button class="ib back" aria-label="Wróć" onclick={() => (WS.open = false)}><Icon name="chev" size={20} /></button>
    <div class="who"><b>{isPc ? pcWs?.name : w?.name}</b><small>{isPc ? `${pcName} · ${pcOnline ? 'połączono' : 'łączę…'}` : 'Ten telefon'}</small></div>
    {#if !isPc && active?.kind === 'agent'}<button class="ib" aria-label="Ustawienia agenta" onclick={() => (AG.settings = true)}><Icon name="sliders" size={20} /></button>{/if}
  </header>

  <nav class="wss" aria-label="Workspace'y">
    {#each WS.list as x (x.id)}
      <button class:on={WS.cur === x.id} style:--c={x.color} onclick={() => (WS.cur === x.id ? ((WS.edit = x.id), (WS.sheet = 'ws')) : (WS.cur = x.id))}><span class="wdot"></span>{x.name}</button>
    {/each}
    {#if pcOnline}
      {#each S.workspaces as x (x.id)}
        <button class="pc" class:on={WS.cur === `pc:${x.id}`} style:--c={x.color} onclick={() => selectPc(x.id)} title="Workspace na komputerze {pcName}"><Icon name="monitor" size={13} />{x.name}{#if x.busy}<span class="busy"></span>{/if}</button>
      {/each}
    {/if}
    <button class="plus" aria-label="Nowy workspace" onclick={() => { newName = ''; WS.edit = ''; WS.sheet = 'ws'; }}><Icon name="plus" size={16} /></button>
  </nav>

  {#if isPc && pcWs}
    <nav class="tabs pcs" aria-label="Zakładki na komputerze">
      {#each pcWs.tabs.filter((t) => t.kind === 'terminal') as t (t.id)}
        <button class:on={WS.pcView === 'term' && t.id === S.tab} onclick={() => { WS.pcView = 'term'; S.tab = t.id; }}><Icon name="monitor" size={13} /><span class="lab" style:color={t.color}>{t.label}</span>{t.title}
          {#if t.id === S.tab && can('full')}<span class="x" role="button" tabindex="0" aria-label="Zamknij {t.title}" onclick={(e) => { e.stopPropagation(); closePcTab(t.id); }} onkeydown={(e) => e.key === 'Enter' && closePcTab(t.id)}><Icon name="x" size={12} /></span>{/if}
        </button>
      {/each}
      <button class:on={WS.pcView === 'agent'} onclick={() => (WS.pcView = 'agent')}><Icon name="bot" size={14} />Agent</button>
      <button class:on={WS.pcView === 'flows'} onclick={() => (WS.pcView = 'flows')}><Icon name="flow" size={14} />Workflow</button>
    </nav>
  {:else if w}
    <nav class="tabs" aria-label="Zakładki">
      {#each w.tabs as t (t.id)}
        <button class:on={t.id === w.active} class:remote={t.kind === 'remote'} onclick={() => (t.id === w.active ? renameTab(t) : ((w.active = t.id), saveWs()))}>
          <Icon name={KIND_ICON[t.kind]} size={14} />{t.title}
          {#if t.id === w.active}<span class="x" role="button" tabindex="0" aria-label="Zamknij {t.title}" onclick={(e) => { e.stopPropagation(); if (confirm(`Zamknąć zakładkę „${t.title}”?`)) closeTab(w, t.id); }} onkeydown={(e) => e.key === 'Enter' && closeTab(w, t.id)}><Icon name="x" size={12} /></span>{/if}
        </button>
      {/each}
      <button class="plus" aria-label="Nowa zakładka" onclick={() => { pick = ''; WS.sheet = 'addTab'; }}><Icon name="plus" size={16} /></button>
    </nav>
  {/if}

  <section class="content">
    <!-- Terminale telefonu: zamontowane raz, ukrywane zamiast niszczenia (sesja SSH trwa). -->
    {#each allTerms as { t } (t.id)}
      {@const h = tabHost(t)}
      {#if mounted[t.id] && h}
        <div class="pane" class:hidden={isPc || t.id !== active?.id}><TermView host={h} id={t.id} active={!isPc && t.id === active?.id} /></div>
      {/if}
    {/each}

    {#if isPc}
      {#if !pcOnline}<div class="wait"><span class="dot wait"></span>Łączę z {pcName}…</div>
      {:else if WS.pcView === 'agent'}<div class="pane"><Agent /></div>
      {:else if WS.pcView === 'flows'}<div class="pane"><Flows /></div>
      {:else}<div class="pane"><Terminal /></div>{/if}
    {:else if !w || !active}
      <div class="empty">
        <p class="muted">Pusty workspace. Dodaj zakładkę: Termux, serwer SSH, notatki, agenta AI, pliki, workflow albo terminal z komputera.</p>
        <button class="btn pri" onclick={() => { pick = ''; WS.sheet = 'addTab'; }}><Icon name="plus" size={18} />Dodaj zakładkę</button>
      </div>
    {:else if active.kind === 'termux' && !termuxReady}
      <div class="pane"><TermuxSetup onready={() => { termuxReady = true; mounted[active.id] = true; }} /></div>
    {:else if (active.kind === 'termux' || active.kind === 'ssh') && !tabHost(active)}
      <div class="empty"><p class="muted">Serwera tej zakładki nie ma już na liście. Zamknij ją i dodaj nową.</p></div>
    {:else if active.kind === 'notes'}<div class="pane"><NotesTab tab={active} /></div>
    {:else if active.kind === 'agent'}
      <div class="pane"><ChatView scope={`ws:${w.id}`} tools={wsTools(w.id)} empty={`Agent workspace'u „${w.name}” widzi jego zakładki (${w.tabs.length}). Komendy i wpisywanie do terminali zatwierdzisz tutaj.`} /></div>
    {:else if active.kind === 'sftp'}
      {@const h = tabHost(active)}
      {#if h}{#key active.id}<div class="pane"><SftpTab host={h} /></div>{/key}{:else}<div class="empty"><p class="muted">Serwera tej zakładki nie ma już na liście.</p></div>{/if}
    {:else if active.kind === 'flow'}{#key active.id}<div class="pane"><FlowTab tab={active} ws={w} /></div>{/key}
    {:else if active.kind === 'remote'}
      {#if S.cur !== active.device || !pcOnline}
        <div class="empty"><p class="muted">Ta zakładka jest na komputerze {S.pcs.find((p) => p.device === active.device)?.name || ''}.</p>
          {#if S.pcs.some((p) => p.device === active.device)}<button class="btn pri" onclick={() => active.device && connectRemote(active.device)}>Połącz</button>{:else}<p class="muted">Ten komputer nie jest już sparowany.</p>{/if}</div>
      {:else}<div class="pane"><Terminal tab={active.rtab} /></div>{/if}
    {/if}
  </section>
</div>

{#if WS.sheet === 'addTab' && w}
  <Sheet title="Nowa zakładka" onclose={() => (WS.sheet = null)}>
    {#if !pick}
      <div class="kinds">
        <button onclick={() => add('termux')}><Icon name="term" size={20} /><span><b>Termux</b><small>Terminal Termuxa na tym telefonie</small></span></button>
        <button onclick={() => (pick = 'ssh')}><Icon name="ssh" size={20} /><span><b>Serwer SSH</b><small>Terminal na serwerze z listy</small></span></button>
        <button onclick={() => add('agent', { title: 'Agent' })}><Icon name="bot" size={20} /><span><b>Agent AI</b><small>Czat z dostępem do zakładek</small></span></button>
        <button onclick={() => add('notes')}><Icon name="note" size={20} /><span><b>Notatki</b><small>Tekst tego workspace'u</small></span></button>
        <button onclick={() => (pick = 'sftp')}><Icon name="folder" size={20} /><span><b>Pliki (SFTP)</b><small>Termux albo serwer SSH</small></span></button>
        <button onclick={() => add('flow')}><Icon name="flow" size={20} /><span><b>Workflow</b><small>Edytor z nodami jak na komputerze</small></span></button>
        <button disabled={!S.pcs.length} onclick={() => (pick = 'remote')}><Icon name="monitor" size={20} /><span><b>Z komputera</b><small>{S.pcs.length ? 'Terminal z połączonego komputera' : 'Najpierw sparuj komputer'}</small></span></button>
      </div>
    {:else if pick === 'ssh' || pick === 'sftp'}
      <div class="pick">
        {#if pick === 'sftp'}<button disabled={!termuxHost()} onclick={() => add('sftp', { host: 'termux', title: 'Pliki Termux' })}><Icon name="term" size={18} />Termux{#if !termuxHost()}<small>najpierw otwórz zakładkę Termux</small>{/if}</button>{/if}
        {#each sshHostsForTabs() as h (h.id)}<button onclick={() => add(pick as 'ssh' | 'sftp', { host: h.id, title: pick === 'sftp' ? `Pliki ${h.name}` : h.name })}><Icon name="ssh" size={18} />{h.name}<small class="mono">{h.user}@{h.host}</small></button>{/each}
        {#if !sshHostsForTabs().length}<p class="muted">Brak serwerów. Dodaj je na ekranie startowym (Ten telefon → Dodaj serwer SSH).</p>{/if}
        <button class="btn ghost sm" onclick={() => { WS.sheet = null; SSH.edit = 'new'; }}><Icon name="plus" size={16} />Nowy serwer</button>
      </div>
    {:else if pick === 'remote'}
      <div class="pick">
        {#if pcOnline}
          {#each S.workspaces as x (x.id)}
            {#each x.tabs.filter((t) => t.kind === 'terminal') as t (t.id)}
              <button onclick={() => add('remote', { device: S.cur || '', rtab: t.id, title: t.title })}><Icon name="monitor" size={18} />{t.title}<small>{x.name}</small></button>
            {/each}
          {/each}
        {:else}
          <p class="muted">Łączę z komputerem… Gdy się połączy, pojawią się jego terminale.</p>
          {#each S.pcs as p (p.device)}<button onclick={() => connectRemote(p.device)}><Icon name="monitor" size={18} />Połącz z {p.name}</button>{/each}
        {/if}
      </div>
    {/if}
  </Sheet>
{/if}

{#if WS.sheet === 'ws'}
  <Sheet title={editWs ? 'Workspace' : 'Nowy workspace'} onclose={() => (WS.sheet = null)}>
    {#if editWs}
      <div class="field"><label for="wn">Nazwa</label><input id="wn" class="inp" bind:value={editWs.name} oninput={() => saveWs()} maxlength="30" /></div>
      <div class="field"><span class="lbl">Kolor</span>
        <div class="colors">{#each WS_COLOR_LIST as [c, label] (c)}<button class:on={editWs.color === c} style:--c={c} aria-label={label} onclick={() => { editWs.color = c; saveWs(); }}></button>{/each}</div></div>
      <button class="btn ghost sm" disabled={WS.list.length < 2 && !editWs.tabs.length} onclick={() => { if (confirm(`Usunąć workspace „${editWs.name}” z zakładkami?`)) { removeWs(editWs.id); WS.sheet = null; } }}><Icon name="trash" size={16} />Usuń workspace</button>
    {:else}
      <form onsubmit={(e) => { e.preventDefault(); addWs(newName); WS.sheet = null; }}>
        <div class="field"><label for="wnn">Nazwa</label><input id="wnn" class="inp" bind:value={newName} placeholder="np. Serwery, Projekt" maxlength="30" /></div>
        <button class="btn pri wide">Utwórz</button>
      </form>
    {/if}
  </Sheet>
{/if}

<style>
  .app { height: 100%; display: flex; flex-direction: column; padding: var(--safe-t) 0 var(--safe-b); }
  .top { display: flex; align-items: center; gap: 4px; height: 56px; padding: 0 4px; flex: none; }
  .back :global(svg) { transform: rotate(180deg); }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .who b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who small { font-size: 12.5px; color: var(--muted-foreground); }
  .wss, .tabs { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding: 0 8px 8px; flex: none; }
  .wss::-webkit-scrollbar, .tabs::-webkit-scrollbar { display: none; }
  .wss button { flex: none; display: flex; align-items: center; gap: 7px; height: 36px; padding: 0 14px; border: 0; border-radius: 999px; background: var(--card); font-size: 14px; }
  .wss button.on { background: var(--foreground); color: var(--background); }
  .wdot { width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
  /* Workspace'y komputera: przerywane obramowanie w kolorze workspace'u i ikona monitora. */
  .wss button.pc { background: color-mix(in oklab, var(--c) 12%, transparent); box-shadow: inset 0 0 0 1.5px color-mix(in oklab, var(--c) 70%, transparent); color: var(--foreground); }
  .wss button.pc.on { background: color-mix(in oklab, var(--c) 30%, var(--card)); box-shadow: inset 0 0 0 2px var(--c); }
  .busy { width: 7px; height: 7px; border-radius: 50%; background: var(--primary-ink); animation: pulse 1s infinite; }
  .wss .plus, .tabs .plus { width: 36px; padding: 0; justify-content: center; flex: none; display: grid; place-items: center; height: 36px; border: 0; border-radius: 50%; background: var(--card); }
  .tabs button { flex: none; display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px; border: 0; border-radius: 10px; background: transparent; font-size: 13.5px; color: var(--muted-foreground); }
  .tabs button.on { background: var(--card); color: var(--foreground); }
  .tabs button.remote { box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--primary-ink) 50%, transparent); }
  .tabs.pcs button.on { background: color-mix(in oklab, var(--primary) 30%, var(--card)); }
  .lab { font: 600 11px var(--font-mono); }
  .x { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: var(--muted); }
  .content { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
  .pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .pane.hidden { display: none; }
  .empty { margin: auto; padding: 24px; text-align: center; display: grid; gap: 14px; justify-items: center; max-width: 34ch; }
  .wait { margin: auto; display: flex; align-items: center; gap: 10px; color: var(--muted-foreground); }
  .kinds { display: grid; gap: 6px; }
  .kinds button, .pick button { display: flex; align-items: center; gap: 12px; border: 0; border-radius: 14px; background: var(--muted); padding: 12px 14px; text-align: left; min-height: 52px; }
  .kinds button span { display: flex; flex-direction: column; }
  .kinds small, .pick small { color: var(--muted-foreground); font-size: 12px; }
  .pick small { margin-left: auto; }
  .kinds button:disabled, .pick button:disabled { opacity: .5; }
  .pick { display: grid; gap: 6px; }
  .field { display: grid; gap: 6px; margin-bottom: 14px; }
  label, .lbl { font-size: 13px; color: var(--muted-foreground); }
  .colors { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; }
  .colors button { aspect-ratio: 1; border-radius: 50%; border: 0; background: var(--c); }
  .colors button.on { box-shadow: 0 0 0 3px var(--card), 0 0 0 5px var(--foreground); }
  .wide { width: 100%; }
  @keyframes pulse { 50% { opacity: .4; } }
</style>
