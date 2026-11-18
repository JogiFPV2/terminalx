<script lang="ts">
  // Terminal SSH otwarty z telefonu (bez komputera). Tu rozmiar terminala dopasowuje się do ekranu telefonu,
  // bo sesja należy tylko do telefonu (inaczej niż w pilocie, gdzie terminal ma rozmiar okna na komputerze).
  import { onMount } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import '@xterm/xterm/css/xterm.css';
  import { terminalTheme } from '../../../src/lib/theme';
  import Icon from '../../../src/lib/Icon.svelte';
  import { SSH, hostById, upsertHost, shell, write, resize, close, type ShellEvent } from '../lib/ssh.svelte';
  import { toast, msg } from '../lib/store.svelte';

  const h = hostById(SSH.open)!;
  let host: HTMLDivElement;
  let term: Terminal | null = null;
  let fitter: FitAddon | null = null;
  let sid: number | null = null;
  let phase = $state<'connecting' | 'ready' | 'closed'>('connecting');
  let error = $state('');
  let ctrl = $state(false);
  let line = $state('');
  let size = $state(12);

  function send(data: string) {
    if (sid === null || phase !== 'ready') return;
    if (ctrl && data.length === 1) { const c = data.toUpperCase().charCodeAt(0); if (c >= 64 && c <= 95) data = String.fromCharCode(c - 64); ctrl = false; }
    write(sid, data).catch((e) => toast(msg(e)));
  }

  function fit() {
    if (!term || !fitter) return;
    term.options.fontSize = size;
    try { fitter.fit(); } catch { /* ukryty element */ }
    if (sid !== null) resize(sid, term.cols, term.rows).catch(() => {});
  }

  async function connect() {
    if (!term) return;
    phase = 'connecting'; error = '';
    term.reset();
    term.write(`\x1b[2mŁączę z ${h.user}@${h.host}:${h.port}…\x1b[0m\r\n`);
    try {
      sid = await shell(h, term.cols, term.rows, (e: ShellEvent) => {
        if (e.type === 'data') { if (phase === 'connecting') phase = 'ready'; term?.write(e.data); }
        else {
          phase = 'closed'; sid = null;
          if (e.error) { error = e.error; term?.write(`\r\n\x1b[31m${e.error}\x1b[0m\r\n`); }
          else term?.write(`\r\n\x1b[2mSesja zakończona${e.code != null ? ` (kod ${e.code})` : ''}.\x1b[0m\r\n`);
        }
      });
      upsertHost({ ...h, lastUsed: Date.now() });
    } catch (e) { phase = 'closed'; error = msg(e); term.write(`\x1b[31m${error}\x1b[0m\r\n`); }
  }

  function leave() { if (sid !== null) close(sid).catch(() => {}); SSH.open = null; }

  onMount(() => {
    term = new Terminal({ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: size, cursorBlink: true, scrollback: 5000, theme: terminalTheme(), allowProposedApi: true });
    fitter = new FitAddon();
    term.loadAddon(fitter);
    term.open(host);
    term.onData(send);
    fit();
    connect();
    const ro = new ResizeObserver(() => fit());
    ro.observe(host);
    const mo = new MutationObserver(() => { if (term) term.options.theme = terminalTheme(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    return () => { ro.disconnect(); mo.disconnect(); if (sid !== null) close(sid).catch(() => {}); term?.dispose(); term = null; };
  });

  $effect(() => { void size; fit(); });

  const KEYS: [string, string][] = [['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['^C', '\x03'], ['^D', '\x04'], ['|', '|'], ['~', '~'], ['/', '/'], ['-', '-']];
  const statusText = $derived(phase === 'ready' ? 'połączono' : phase === 'connecting' ? 'łączę…' : error ? 'błąd' : 'rozłączono');
</script>

<div class="app">
  <header class="top">
    <button class="ib back" aria-label="Wróć" onclick={leave}><Icon name="chev" size={20} /></button>
    <div class="who"><b>{h.name}</b><small><span class="dot {phase === 'ready' ? 'ok' : phase === 'connecting' ? 'wait' : 'bad'}"></span>{statusText} · <span class="mono">{h.user}@{h.host}</span></small></div>
    {#if phase === 'closed'}<button class="btn sm" onclick={connect}>Połącz</button>{/if}
    <button class="ib" aria-label="Mniejsza czcionka" onclick={() => (size = Math.max(8, size - 1))}><Icon name="minus" size={18} /></button>
    <button class="ib" aria-label="Większa czcionka" onclick={() => (size = Math.min(22, size + 1))}><Icon name="plus" size={18} /></button>
  </header>

  <div class="wrap" style:background="var(--term-bg)"><div class="host" bind:this={host}></div></div>

  <div class="keys" role="toolbar" aria-label="Klawisze specjalne">
    <button class:on={ctrl} onclick={() => (ctrl = !ctrl)} aria-pressed={ctrl}>Ctrl</button>
    {#each KEYS as [l, seq]}<button onclick={() => send(seq)}>{l}</button>{/each}
  </div>
  <form class="line" onsubmit={(e) => { e.preventDefault(); if (line) { send(line + '\r'); line = ''; } }}>
    <input class="inp mono" bind:value={line} placeholder="Komenda…" autocapitalize="off" autocomplete="off" spellcheck="false" enterkeyhint="send" />
    <button class="send" aria-label="Wyślij komendę" disabled={!line || phase !== 'ready'}><Icon name="send" size={18} /></button>
  </form>
</div>

<style>
  .app { height: 100%; display: flex; flex-direction: column; padding: var(--safe-t) 0 var(--safe-b); }
  .top { display: flex; align-items: center; gap: 4px; height: 56px; padding: 0 4px; flex: none; }
  .back :global(svg) { transform: rotate(180deg); }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .who b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who small { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted-foreground); white-space: nowrap; overflow: hidden; }
  .who .dot { width: 7px; height: 7px; flex: none; }
  .wrap { flex: 1; min-height: 0; margin: 0 8px; padding: 8px; border-radius: 16px; display: flex; }
  .host { flex: 1; min-width: 0; min-height: 0; }
  .host :global(.xterm-viewport) { background: transparent !important; }
  .keys { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding: 8px 8px 0; flex: none; }
  .keys::-webkit-scrollbar { display: none; }
  .keys button { flex: none; min-width: 44px; height: 38px; padding: 0 10px; border: 0; border-radius: 10px; background: var(--card); font: 500 13px var(--font-mono); }
  .keys button.on { background: var(--primary); color: var(--primary-foreground); }
  .line { display: flex; gap: 8px; padding: 8px; flex: none; }
  .line .inp { min-height: 44px; font-size: 14px; }
  .send { width: 44px; height: 44px; flex: none; border: 0; border-radius: 50%; background: var(--primary); color: var(--primary-foreground); display: grid; place-items: center; }
  .send:disabled { opacity: .4; }
</style>
