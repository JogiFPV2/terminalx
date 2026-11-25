<script lang="ts">
  // Terminal SSH na telefonie (serwer albo Termux przez 127.0.0.1:8022), dopasowany do ekranu telefonu.
  // Używany przez ekran serwera i przez zakładki workspace'ów; ukryta zakładka zostaje zamontowana, więc sesja żyje dalej.
  import { onMount } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import '@xterm/xterm/css/xterm.css';
  import { terminalTheme } from '../../../src/lib/theme';
  import Icon from '../../../src/lib/Icon.svelte';
  import { upsertHost, shell, write, resize, close, type ShellEvent, type SshHost } from '../lib/ssh.svelte';
  import { ensureSshd } from '../lib/termux.svelte';
  import { toast, msg } from '../lib/store.svelte';
  import { outputs, inputs } from '../lib/termbus';

  let { host, id, active = true, onstate }: { host: SshHost; id: string; active?: boolean; onstate?: (s: 'connecting' | 'ready' | 'closed', error: string) => void } = $props();
  let el: HTMLDivElement;
  let term: Terminal | null = null;
  let fitter: FitAddon | null = null;
  let sid: number | null = null;
  let phase = $state<'connecting' | 'ready' | 'closed'>('connecting');
  let ctrl = $state(false);
  let line = $state('');
  let size = $state(12);

  const set = (p: typeof phase, e = '') => { phase = p; onstate?.(p, e); };

  function send(data: string) {
    if (sid === null || phase !== 'ready') return;
    if (ctrl && data.length === 1) { const c = data.toUpperCase().charCodeAt(0); if (c >= 64 && c <= 95) data = String.fromCharCode(c - 64); ctrl = false; }
    write(sid, data).catch((e) => toast(msg(e)));
  }

  function fit() {
    if (!term || !fitter || !active) return;
    term.options.fontSize = size;
    try { fitter.fit(); } catch { /* ukryty element */ }
    if (sid !== null) resize(sid, term.cols, term.rows).catch(() => {});
  }

  export async function connect() {
    if (!term) return;
    set('connecting');
    term.reset();
    term.write(`\x1b[2mŁączę z ${host.termux ? 'Termuxem' : `${host.user}@${host.host}:${host.port}`}…\x1b[0m\r\n`);
    try {
      if (host.termux) await ensureSshd();
      sid = await shell(host, term.cols, term.rows, (e: ShellEvent) => {
        if (e.type === 'data') { if (phase === 'connecting') set('ready'); term?.write(e.data); outputs.emit(id, e.data); }
        else {
          sid = null;
          if (e.error) { set('closed', e.error); term?.write(`\r\n\x1b[31m${e.error}\x1b[0m\r\n`); }
          else { set('closed'); term?.write(`\r\n\x1b[2mSesja zakończona${e.code != null ? ` (kod ${e.code})` : ''}. Stuknij „Połącz”, by otworzyć nową.\x1b[0m\r\n`); }
        }
      });
      upsertHost({ ...host, lastUsed: Date.now() });
    } catch (e) { set('closed', msg(e)); term.write(`\x1b[31m${msg(e)}\x1b[0m\r\n`); }
  }

  onMount(() => {
    term = new Terminal({ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: size, cursorBlink: true, scrollback: 5000, theme: terminalTheme(), allowProposedApi: true });
    fitter = new FitAddon();
    term.loadAddon(fitter);
    term.open(el);
    term.onData(send);
    fit();
    connect();
    // Agent i workflow piszą do tej zakładki przez wspólną szynę (np. node „Wyślij do zakładki”).
    const offIn = inputs.on(id, (d) => send(d));
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    const mo = new MutationObserver(() => { if (term) term.options.theme = terminalTheme(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    return () => { offIn(); ro.disconnect(); mo.disconnect(); if (sid !== null) close(sid).catch(() => {}); term?.dispose(); term = null; };
  });

  $effect(() => { void size; if (active) requestAnimationFrame(fit); });

  const KEYS: [string, string][] = [['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['^C', '\x03'], ['^D', '\x04'], ['|', '|'], ['~', '~'], ['/', '/'], ['-', '-']];
</script>

<div class="tv">
  <div class="wrap" style:background="var(--term-bg)">
    <div class="host" bind:this={el}></div>
    <div class="tools">
      {#if phase === 'closed'}<button class="btn sm pri" onclick={connect}>Połącz</button>{/if}
      <button class="ib" aria-label="Mniejsza czcionka" onclick={() => (size = Math.max(8, size - 1))}><Icon name="minus" size={16} /></button>
      <button class="ib" aria-label="Większa czcionka" onclick={() => (size = Math.min(22, size + 1))}><Icon name="plus" size={16} /></button>
    </div>
  </div>
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
  .tv { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .wrap { position: relative; flex: 1; min-height: 0; margin: 0 8px; padding: 8px; border-radius: 16px; display: flex; }
  .host { flex: 1; min-width: 0; min-height: 0; }
  .host :global(.xterm-viewport) { background: transparent !important; }
  .tools { position: absolute; right: 8px; bottom: 8px; display: flex; gap: 4px; align-items: center; }
  .tools .ib { width: 34px; height: 34px; background: color-mix(in oklab, var(--card) 85%, transparent); box-shadow: 0 0 0 1px var(--border); }
  .keys { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding: 8px 8px 0; flex: none; }
  .keys::-webkit-scrollbar { display: none; }
  .keys button { flex: none; min-width: 44px; height: 38px; padding: 0 10px; border: 0; border-radius: 10px; background: var(--card); font: 500 13px var(--font-mono); }
  .keys button.on { background: var(--primary); color: var(--primary-foreground); }
  .line { display: flex; gap: 8px; padding: 8px; flex: none; }
  .line .inp { min-height: 44px; font-size: 14px; }
  .send { width: 44px; height: 44px; flex: none; border: 0; border-radius: 50%; background: var(--primary); color: var(--primary-foreground); display: grid; place-items: center; }
  .send:disabled { opacity: .4; }
</style>
