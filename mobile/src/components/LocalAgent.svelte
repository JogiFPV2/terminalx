<script lang="ts">
  // Agent AI na telefonie: czat, który wykonuje komendy na serwerach SSH zapisanych w telefonie, za zgodą użytkownika.
  import { tick } from 'svelte';
  import Icon from '../../../src/lib/Icon.svelte';
  import { AG, KINDS, send, stop, decide, clearChat } from '../lib/agent.svelte';
  import { SSH } from '../lib/ssh.svelte';

  let text = $state('');
  let box: HTMLDivElement;
  const kind = $derived(KINDS.find((k) => k.id === AG.cfg.kind));
  const ready = $derived(!!AG.cfg.model && (AG.hasKey || !kind?.key));

  function md(s: string) {
    const esc = (x: string) => x.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
    return s.split(/```(?:[\w-]*\n)?([\s\S]*?)```/g).map((part, i) => i % 2 ? `<pre>${esc(part.trim())}</pre>` : esc(part).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>')).join('');
  }
  $effect(() => { void AG.items.length; void AG.busy; tick().then(() => box?.scrollTo({ top: box.scrollHeight, behavior: 'smooth' })); });

  function submit() { const t = text.trim(); if (!t) return; text = ''; send(t); }
</script>

<div class="app">
  <header class="top">
    <button class="ib back" aria-label="Wróć" onclick={() => (AG.open = false)}><Icon name="chev" size={20} /></button>
    <div class="who"><b>Agent AI</b><small>{kind?.name}{AG.cfg.model ? ` · ${AG.cfg.model}` : ''}</small></div>
    <button class="ib" aria-label="Wyczyść rozmowę" disabled={AG.busy || !AG.items.length} onclick={clearChat}><Icon name="chatplus" size={20} /></button>
    <button class="ib" aria-label="Ustawienia agenta" onclick={() => (AG.settings = true)}><Icon name="sliders" size={20} /></button>
  </header>

  <div class="chat" bind:this={box}>
    {#if !ready}
      <div class="empty"><p class="muted">Wybierz dostawcę AI, wpisz klucz API i model.</p><button class="btn pri" onclick={() => (AG.settings = true)}>Ustaw agenta</button></div>
    {:else if !AG.items.length}
      <p class="empty muted">{SSH.hosts.length ? `Agent widzi ${SSH.hosts.length === 1 ? 'serwer' : 'serwery'}: ${SSH.hosts.map((h) => h.name).join(', ')}. Każdą komendę zatwierdzisz tutaj.` : 'Dodaj serwer SSH na ekranie startowym: agent wykonuje na nich komendy za Twoją zgodą.'}</p>
    {/if}
    {#each AG.items as m (m.id)}
      <div class="msg {m.role}">
        {#if m.cmd}
          <div class="ask" class:pending={m.cmd.state === 'pending'}>
            <span class="st">{m.cmd.state === 'pending' ? 'Wymaga zgody' : m.cmd.state === 'rejected' ? 'Odrzucono' : m.cmd.state === 'approved' ? 'Wykonuję…' : `Wykonano${m.cmd.code != null ? ` · kod ${m.cmd.code}` : ''}`} · {m.cmd.serverName}</span>
            <pre>{m.cmd.command}</pre>
            {#if m.cmd.state === 'pending'}<div class="row"><button class="btn pri sm" onclick={() => decide(m.id, true)}>Uruchom</button><button class="btn ghost sm" onclick={() => decide(m.id, false)}>Odrzuć</button></div>{/if}
            {#if m.text}<details><summary>Wyjście</summary><pre class="out">{m.text}</pre></details>{/if}
          </div>
        {:else}
          <div class="text">{@html md(m.text)}</div>
        {/if}
      </div>
    {/each}
    {#if AG.busy}<div class="typing" aria-label="Agent pracuje"><i></i><i></i><i></i></div>{/if}
  </div>

  <form class="compose" onsubmit={(e) => { e.preventDefault(); submit(); }}>
    <textarea class="inp" rows="1" bind:value={text} placeholder="Zleć coś agentowi…" disabled={!ready} onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}></textarea>
    {#if AG.busy}<button type="button" class="send stop" aria-label="Zatrzymaj agenta" onclick={stop}><Icon name="stop" size={18} /></button>
    {:else}<button class="send" aria-label="Wyślij" disabled={!text.trim() || !ready}><Icon name="send" size={18} /></button>{/if}
  </form>
</div>

<style>
  .app { height: 100%; display: flex; flex-direction: column; padding: var(--safe-t) 0 var(--safe-b); }
  .top { display: flex; align-items: center; gap: 4px; height: 56px; padding: 0 4px; flex: none; }
  .back :global(svg) { transform: rotate(180deg); }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .who b { font-weight: 600; }
  .who small { font-size: 12.5px; color: var(--muted-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chat { flex: 1; min-height: 0; overflow: auto; padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 12px; }
  .empty { margin: auto 8px; text-align: center; display: grid; gap: 12px; justify-items: center; }
  .text { padding: 10px 14px; border-radius: 18px 18px 18px 6px; background: var(--card); overflow-wrap: anywhere; }
  .msg.user { align-self: flex-end; max-width: 88%; }
  .msg.user .text { background: var(--foreground); color: var(--background); border-radius: 18px 18px 6px 18px; }
  .msg.error .text { color: var(--destructive); }
  .text :global(code) { font: 12.5px var(--font-mono); background: var(--muted); padding: 1px 4px; border-radius: 4px; }
  .text :global(pre), .ask pre { font: 12.5px/1.5 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; background: var(--muted); padding: 8px 10px; border-radius: 10px; margin: 6px 0 0; }
  .ask { padding: 10px 12px; border-radius: 16px; background: var(--card); }
  .ask.pending { box-shadow: inset 0 0 0 1.5px var(--primary-ink); }
  .ask .out { max-height: 240px; overflow: auto; }
  .ask summary { margin-top: 8px; font-size: 13px; color: var(--muted-foreground); }
  .st { font-size: 12.5px; font-weight: 600; }
  .row { display: flex; gap: 8px; margin-top: 10px; }
  .typing { display: flex; gap: 4px; padding: 12px 14px; background: var(--card); border-radius: 18px; align-self: flex-start; }
  .typing i { width: 7px; height: 7px; border-radius: 50%; background: var(--muted-foreground); animation: b 1s infinite; }
  .typing i:nth-child(2) { animation-delay: .15s; } .typing i:nth-child(3) { animation-delay: .3s; }
  @keyframes b { 50% { transform: translateY(-4px); opacity: .5; } }
  .compose { display: flex; gap: 8px; padding: 8px; align-items: flex-end; flex: none; }
  .compose textarea { resize: none; max-height: 120px; field-sizing: content; }
  .send { width: 44px; height: 44px; flex: none; border: 0; border-radius: 50%; background: var(--primary); color: var(--primary-foreground); display: grid; place-items: center; }
  .send.stop { background: var(--destructive); color: #fff; }
  .send:disabled { opacity: .4; }
</style>
