<script lang="ts">
  import { onMount } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import '@xterm/xterm/css/xterm.css';
  import { terminalTheme } from '../../../src/lib/theme';
  import Icon from '../../../src/lib/Icon.svelte';
  import { S, req, onOut, can, msg, toast } from '../lib/store.svelte';

  let host: HTMLDivElement;
  let wrap: HTMLDivElement;
  let term: Terminal | null = null;
  let cols = 80, rows = 24;
  let ctrl = $state(false);
  let line = $state('');
  let zoom = $state(1);
  /** Dopasowanie do szerokości ekranu (drobny tekst) albo czytelna czcionka z przewijaniem w poziomie. */
  let fitWidth = $state(false);
  const writable = $derived(can('control'));

  // Szerokość jak na komputerze (nie zmieniamy rozmiaru terminala na PC, bo zmieniłby się też tam).
  function fit() {
    if (!term || !wrap) return;
    const w = wrap.clientWidth - 16;
    const base = fitWidth ? Math.max(5, Math.floor((w / (cols * 0.602)) * 10) / 10) : 11;
    term.options.fontSize = Math.round(base * zoom * 10) / 10;
    term.resize(cols, rows);
  }

  let current = '';
  async function attach(tab: string) {
    if (!term) return;
    if (current) req('unsubscribe', { tab: current }).catch(() => {});
    current = tab;
    term.reset();
    if (!tab) return;
    try {
      const r = await req<{ cols: number; rows: number; screen: string }>('subscribe', { tab });
      if (current !== tab) return;
      cols = r.cols || 80; rows = r.rows || 24; fit();
      term.write(r.screen.replace(/\r?\n/g, '\r\n'));
    } catch (e) { term.write(`\x1b[31m${msg(e)}\x1b[0m\r\n`); }
  }

  function send(data: string) {
    if (!writable) { toast('To urządzenie ma tylko podgląd. Zmień uprawnienie na komputerze.'); return; }
    if (ctrl && data.length === 1) { const c = data.toUpperCase().charCodeAt(0); if (c >= 64 && c <= 95) data = String.fromCharCode(c - 64); ctrl = false; }
    req('write', { tab: S.tab, data }).catch((e) => toast(msg(e)));
  }

  onMount(() => {
    term = new Terminal({ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 11, cursorBlink: true, scrollback: 3000, theme: terminalTheme(), allowProposedApi: true, convertEol: false });
    term.open(host);
    term.onData((d) => send(d));
    const off = onOut((tab, data) => { if (tab === current) term?.write(data); });
    const ro = new ResizeObserver(() => fit());
    ro.observe(wrap);
    // Motyw zmienia się w ustawieniach: kolory terminala za nim.
    const mo = new MutationObserver(() => { if (term) term.options.theme = terminalTheme(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    return () => { off(); ro.disconnect(); mo.disconnect(); if (current) req('unsubscribe', { tab: current }).catch(() => {}); term?.dispose(); term = null; };
  });

  $effect(() => { const t = S.tab; if (term && S.state === 'ready') attach(t); });
  $effect(() => { void zoom; void fitWidth; fit(); });

  const KEYS: [string, string][] = [['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['^C', '\x03'], ['|', '|'], ['~', '~'], ['/', '/'], ['-', '-']];
</script>

<div class="area">
  <div class="wrap" bind:this={wrap} style:background="var(--term-bg)">
    {#if !S.tab}<p class="empty muted">W tym workspace nie ma terminala.</p>{/if}
    <div class="host" bind:this={host}></div>
  </div>
  <div class="zoom"><button class="ib" class:on={fitWidth} aria-pressed={fitWidth} aria-label="Dopasuj do szerokości ekranu" onclick={() => { fitWidth = !fitWidth; zoom = 1; }}><Icon name="maximize" size={16} /></button><button class="ib" aria-label="Pomniejsz" onclick={() => (zoom = Math.max(0.6, zoom - 0.15))}><Icon name="minus" size={16} /></button><button class="ib" aria-label="Powiększ" onclick={() => (zoom = Math.min(2.4, zoom + 0.15))}><Icon name="plus" size={16} /></button></div>
</div>

{#if writable}
  <div class="keys" role="toolbar" aria-label="Klawisze specjalne">
    <button class:on={ctrl} onclick={() => (ctrl = !ctrl)} aria-pressed={ctrl}>Ctrl</button>
    {#each KEYS as [l, seq]}<button onclick={() => send(seq)}>{l}</button>{/each}
  </div>
  <form class="line" onsubmit={(e) => { e.preventDefault(); if (line) { send(line + '\r'); line = ''; } }}>
    <input class="inp mono" bind:value={line} placeholder="Komenda…" autocapitalize="off" autocomplete="off" spellcheck="false" enterkeyhint="send" />
    <button class="send" aria-label="Wyślij komendę" disabled={!line}><Icon name="send" size={18} /></button>
  </form>
{/if}

<style>
  .area { position: relative; flex: 1; min-height: 0; display: flex; margin: 0 8px; }
  .wrap { flex: 1; min-width: 0; overflow: auto; padding: 8px; border-radius: 16px; }
  .host { min-width: max-content; }
  .host :global(.xterm-viewport) { background: transparent !important; }
  .empty { padding: 20px; }
  .zoom { position: absolute; right: 8px; bottom: 8px; display: flex; gap: 4px; }
  .zoom .ib { width: 36px; height: 36px; background: color-mix(in oklab, var(--card) 85%, transparent); box-shadow: 0 0 0 1px var(--border); }
  .zoom .ib.on { background: var(--primary); color: var(--primary-foreground); }
  .keys { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding: 8px 8px 0; flex: none; }
  .keys::-webkit-scrollbar { display: none; }
  .keys button { flex: none; min-width: 44px; height: 38px; padding: 0 10px; border: 0; border-radius: 10px; background: var(--card); font: 500 13px var(--font-mono); }
  .keys button.on { background: var(--primary); color: var(--primary-foreground); }
  .line { display: flex; gap: 8px; padding: 8px; flex: none; }
  .line .inp { min-height: 44px; font-size: 14px; }
  .send { width: 44px; height: 44px; flex: none; border: 0; border-radius: 50%; background: var(--primary); color: var(--primary-foreground); display: grid; place-items: center; }
  .send:disabled { opacity: .4; }
</style>
