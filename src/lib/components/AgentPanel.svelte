<script lang="ts">
  import Icon from '../Icon.svelte';
  import { app, ui, curWs, tabKind, findTab } from '../state.svelte';
  import { agentState, sendToAgent, stopAgent, resolveApproval, clearChat } from '../agent.svelte';
  import { track, clamp } from '../util';
  import { PERM_LABEL } from '../defaults';

  const ws = $derived(curWs());
  const agent = $derived(app.agents.find((a) => a.id === ws.agentId) || app.agents.find((a) => a.kind === 'agent'));
  const subs = $derived(ws.tabs.filter((t) => t.subagent));
  let text = $state('');
  let chatEl: HTMLDivElement;

  $effect(() => { void ws.chat.length; if (chatEl) requestAnimationFrame(() => (chatEl.scrollTop = chatEl.scrollHeight)); });

  function send() {
    const t = text.trim();
    if (!t) return;
    text = '';
    sendToAgent(ws, t);
  }
  function gutter(e: PointerEvent) {
    e.preventDefault();
    const sx = e.clientX, start = app.layout.agent;
    track((ev) => (app.layout.agent = clamp(start - (ev.clientX - sx), 260, 640)));
  }
  // Prosty markdown: bloki kodu i `kod`, reszta jako tekst.
  function md(s: string) {
    const esc = (x: string) => x.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
    return s.split(/```(?:[\w-]*)\n?([\s\S]*?)```/g).map((part, i) => i % 2 ? `<pre>${esc(part.trim())}</pre>` : esc(part).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>')).join('');
  }
</script>

<aside class="agent" style:width="{app.layout.agent}px" aria-label="Panel agenta">
  <div class="gutter" role="separator" aria-label="Szerokość panelu agenta" onpointerdown={gutter} ondblclick={() => (app.layout.agent = 320)}></div>
  <div class="head">
    <span class="ico"><Icon name="spark" /></span>
    <div class="who" title="{agent?.model} · {agent ? PERM_LABEL[agent.perm].toLowerCase() : ''}"><b>{agent?.name}</b></div>
    <button class="icobtn" title="Wyczyść rozmowę" onclick={() => clearChat(ws)}><Icon name="trash" size={14} /></button>
    <button class="icobtn" title="Konfiguracja agentów" onclick={() => { ui.settingsPage = 'agents'; ui.settingsOpen = true; }}><Icon name="sliders" size={14} /></button>
  </div>
  {#if subs.length}
  <div class="subs">
    {#each subs as t (t.id)}
      {@const k = tabKind(t)}
      <div class="subrow" title={app.agents.find((a) => a.id === t.subagent)?.name}><span class="sub" class:busy={!!agentState.subBusy[t.id]}></span><span class="ki" style:color={k.c}><Icon name={k.icon} size={13} /></span><span class="nm">{t.title}</span><span class="st">{agentState.subBusy[t.id] || ''}</span></div>
    {/each}
  </div>
  {/if}
  <div class="chat" bind:this={chatEl}>
    {#if !ws.chat.length}
      <div class="intro">
        <p>Np. „Sprawdź, czemu testy w zakładce api nie przechodzą”.</p>
        {#if !app.providers.find((p) => p.id === (agent?.provider || app.defModel.provider))?.hasKey && app.providers.find((p) => p.id === (agent?.provider || app.defModel.provider))?.type !== 'ollama'}
          <button class="btn" onclick={() => { ui.settingsPage = 'providers'; ui.settingsOpen = true; }}><Icon name="key" />Klucz API</button>
        {/if}
      </div>
    {/if}
    {#each ws.chat as m (m.id)}
      <div class="msg {m.role}">
        <div class="mwho">{m.who}</div>
        <div class="mtext">{@html md(m.text)}</div>
        {#if m.approve}
          <div class="approve">
            <span class="label">{m.approve.state === 'pending' ? 'Wymaga zgody' : m.approve.state === 'approved' ? 'Zatwierdzono' : 'Odrzucono'} · {findTab(m.approve.tabId)?.tab.title || ''}</span>
            <pre>{m.approve.command}</pre>
            {#if m.approve.state === 'pending'}
              <div class="row"><button class="btn pri" onclick={() => resolveApproval(ws, m.id, true)}>Uruchom</button><button class="btn" onclick={() => resolveApproval(ws, m.id, false)}>Odrzuć</button></div>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
    {#if agentState.busy[ws.id]}<div class="msg agent"><div class="typing"><span></span><span></span><span></span></div></div>{/if}
  </div>
  <div class="composer">
    <div class="box">
      <textarea bind:value={text} rows="1" placeholder="Zleć coś agentowi…" aria-label="Wiadomość do agenta"
        onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}></textarea>
      {#if agentState.busy[ws.id]}
        <button class="icobtn" title="Zatrzymaj" onclick={() => stopAgent(ws.id)}><Icon name="stop" /></button>
      {:else}
        <button class="icobtn" title="Wyślij (Enter)" onclick={send}><Icon name="send" /></button>
      {/if}
    </div>
  </div>
</aside>

<style>
  .ki { display: grid; flex: none; }
  .agent { border-left: 1px solid var(--border); display: grid; grid-template-rows: auto auto 1fr auto; min-height: 0; background: var(--background); position: relative; flex: none; }
  .gutter { position: absolute; top: 0; bottom: 0; left: -4px; width: 7px; z-index: 6; cursor: col-resize; }
  .gutter:hover { background: linear-gradient(90deg, transparent 2px, var(--primary) 2px, var(--primary) 4px, transparent 4px); }
  .head { display: flex; align-items: center; gap: 8px; padding: 10px 8px 10px 12px; border-bottom: 1px solid var(--border); min-width: 0; }
  .ico { color: var(--primary); display: grid; }
  .who { min-width: 0; flex: 1; display: flex; flex-direction: column; }
  .who b { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .subs { padding: 10px 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; max-height: 160px; overflow: auto; }
  .subrow { display: flex; align-items: center; gap: 8px; font-size: 12px; min-width: 0; }
  .subrow.muted { color: var(--muted-foreground); }
  .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st { margin-left: auto; color: var(--muted-foreground); font-size: 11px; white-space: nowrap; }
  .chat { overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
  .intro { color: var(--muted-foreground); font-size: 12.5px; line-height: 1.55; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
  .intro p { margin: 0; }
  .msg { font-size: 12.5px; line-height: 1.5; min-width: 0; }
  .mwho { font-size: 11px; color: var(--muted-foreground); margin-bottom: 2px; }
  .msg.user { align-self: flex-end; background: var(--muted); padding: 7px 10px; border-radius: 8px; max-width: 88%; }
  .msg.sub .mtext { border-left: 2px solid var(--border); padding-left: 8px; }
  .msg.error .mtext { color: var(--destructive); }
  .msg.system .mtext { color: var(--muted-foreground); font-style: italic; }
  .mtext { overflow-wrap: anywhere; }
  .mtext :global(code) { font-family: var(--font-mono); font-size: 11.5px; background: var(--muted); padding: 1px 4px; border-radius: 4px; }
  .mtext :global(pre), .approve pre { margin: 6px 0 0; font-family: var(--font-mono); font-size: 11.5px; background: var(--term-bg); border: 1px solid var(--border); padding: 6px 8px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; }
  .approve { border: 1px solid var(--border); border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
  .approve .row { display: flex; gap: 6px; }
  .typing { display: flex; gap: 4px; padding: 6px 0; }
  .typing span { width: 6px; height: 6px; border-radius: 50%; background: var(--muted-foreground); animation: pulse 1s infinite; }
  .typing span:nth-child(2) { animation-delay: .2s; } .typing span:nth-child(3) { animation-delay: .4s; }
  .composer { border-top: 1px solid var(--border); padding: 10px; }
  .box { display: flex; align-items: flex-end; gap: 6px; border: 1px solid var(--border); border-radius: 8px; padding: 6px 6px 6px 10px; background: var(--card); }
  textarea { flex: 1; min-width: 0; background: none; border: 0; color: inherit; font: inherit; outline: none; resize: none; max-height: 140px; field-sizing: content; padding: 3px 0; }
</style>
