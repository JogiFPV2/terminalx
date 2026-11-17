<script lang="ts">
  import { tick } from 'svelte';
  import Icon from '../../../src/lib/Icon.svelte';
  import { S, curWs, req, msg, toast, can } from '../lib/store.svelte';

  const ws = $derived(curWs());
  const list = $derived(ws ? S.chat[ws.id] || [] : []);
  let text = $state('');
  let box: HTMLDivElement;

  // Prosty markdown jak w panelu agenta na komputerze: bloki kodu, `kod`, **pogrubienie**.
  function md(s: string) {
    const esc = (x: string) => x.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
    return s.split(/```(?:[\w-]*\n)?([\s\S]*?)```/g).map((part, i) => i % 2 ? `<pre>${esc(part.trim())}</pre>` : esc(part).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>')).join('');
  }

  $effect(() => { void list.length; tick().then(() => box?.scrollTo({ top: box.scrollHeight, behavior: 'smooth' })); });

  async function approve(id: string, ok: boolean) {
    if (!ws) return;
    try { await req('approve', { ws: ws.id, msg: id, ok }); } catch (e) { toast(msg(e)); }
  }
  async function sendMsg() {
    const t = text.trim();
    if (!t || !ws) return;
    text = '';
    try { await req('agent', { ws: ws.id, text: t }); } catch (e) { text = t; toast(msg(e)); }
  }
  async function stop() { if (ws) req('stopAgent', { ws: ws.id }).catch((e) => toast(msg(e))); }
</script>

<div class="chat" bind:this={box}>
  {#if !list.length}<p class="empty muted">Napisz do agenta workspace'u „{ws?.name}”. Komendy, które zechce uruchomić, zatwierdzisz tutaj.</p>{/if}
  {#each list as m (m.id)}
    <div class="msg {m.role}">
      <div class="who">{m.who}</div>
      {#if m.text}<div class="text">{@html md(m.text)}</div>{/if}
      {#if m.approve}
        <div class="ask" class:pending={m.approve.state === 'pending'}>
          <span class="st">{m.approve.state === 'pending' ? 'Wymaga zgody' : m.approve.state === 'approved' ? 'Zatwierdzono' : 'Odrzucono'}{m.approve.label ? ` · ${m.approve.label}` : ''}</span>
          <pre>{m.approve.command}</pre>
          {#if m.approve.state === 'pending'}
            {#if can('control')}<div class="row"><button class="btn pri sm" onclick={() => approve(m.id, true)}>{m.approve.tabId ? 'Uruchom' : 'Zezwól'}</button><button class="btn ghost sm" onclick={() => approve(m.id, false)}>Odrzuć</button></div>
            {:else}<small class="muted">Zatwierdzanie wymaga uprawnienia „Sterowanie”.</small>{/if}
          {/if}
        </div>
      {/if}
    </div>
  {/each}
  {#if ws?.busy}<div class="typing" aria-label="Agent pracuje"><i></i><i></i><i></i></div>{/if}
</div>

{#if can('full')}
  <form class="compose" onsubmit={(e) => { e.preventDefault(); sendMsg(); }}>
    <textarea class="inp" rows="1" bind:value={text} placeholder="Zleć coś agentowi…" onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } }}></textarea>
    {#if ws?.busy}<button type="button" class="send stop" aria-label="Zatrzymaj agenta" onclick={stop}><Icon name="stop" size={18} /></button>
    {:else}<button class="send" aria-label="Wyślij" disabled={!text.trim()}><Icon name="send" size={18} /></button>{/if}
  </form>
{:else}<p class="note muted">Pisanie do agenta wymaga uprawnienia „Pełny dostęp” dla tego telefonu.</p>{/if}

<style>
  .chat { flex: 1; min-height: 0; overflow: auto; padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 12px; }
  .empty { margin: auto 8px; text-align: center; }
  .msg { max-width: 100%; }
  .who { font: 11px var(--font-mono); color: var(--muted-foreground); margin: 0 4px 3px; }
  .text { padding: 10px 14px; border-radius: 18px 18px 18px 6px; background: var(--card); overflow-wrap: anywhere; }
  .msg.user { align-self: flex-end; max-width: 88%; }
  .msg.user .who { text-align: right; }
  .msg.user .text { background: var(--foreground); color: var(--background); border-radius: 18px 18px 6px 18px; }
  .msg.error .text { color: var(--destructive); }
  .text :global(code) { font: 12.5px var(--font-mono); background: var(--muted); padding: 1px 4px; border-radius: 4px; }
  .msg.user .text :global(code) { background: rgb(255 255 255 / .15); }
  .text :global(pre), .ask pre { font: 12.5px/1.5 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; background: var(--muted); padding: 8px 10px; border-radius: 10px; margin: 6px 0 0; }
  .ask { margin-top: 6px; padding: 10px 12px; border-radius: 16px; background: var(--card); }
  .ask.pending { box-shadow: inset 0 0 0 1.5px var(--primary-ink); }
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
  .note { padding: 10px 16px; font-size: 13px; }
</style>
