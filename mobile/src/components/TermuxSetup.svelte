<script lang="ts">
  // Jednorazowa konfiguracja Termuxa dla zakładek: instalacja, zgoda Androida, allow-external-apps w Termuxie,
  // potem Hermitty sam instaluje openssh, dodaje swój klucz i uruchamia sshd (przez RUN_COMMAND).
  import { onMount } from 'svelte';
  import Icon from '../../../src/lib/Icon.svelte';
  import { TX, ALLOW_CMD, refreshTermux, askPermission, openTermux, setupTermux } from '../lib/termux.svelte';
  import { toast, msg } from '../lib/store.svelte';

  let { onready }: { onready: () => void } = $props();
  let busy = $state(false);
  let step = $state('');
  let error = $state('');

  onMount(() => {
    refreshTermux();
    const vis = () => document.visibilityState === 'visible' && refreshTermux();
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  });

  async function copy() {
    try { await navigator.clipboard.writeText(ALLOW_CMD); toast('Skopiowano. Wklej w Termuxie i zatwierdź Enterem.'); } catch { toast('Zaznacz komendę i skopiuj ręcznie.'); }
  }
  async function go() {
    busy = true; error = '';
    try { await setupTermux((s) => (step = s)); toast('Termux gotowy'); onready(); }
    catch (e) { error = msg(e); }
    finally { busy = false; step = ''; }
  }
</script>

<div class="setup">
  <h2>Termux w Hermitty</h2>
  <p class="muted">Zakładka Termuxa to pełny terminal Termuxa (pkg, git, python, termux-*) w Hermitty. Konfiguracja jest jednorazowa.</p>

  <ol>
    <li class:ok={TX.installed}>
      <b>Zainstaluj Termux</b>
      {#if TX.installed}<span class="done"><Icon name="check" size={14} />zainstalowany</span>
      {:else}<small class="muted">Z F-Droid albo z GitHuba (termux/termux-app). Wersja ze Sklepu Play jest przestarzała.</small>{/if}
    </li>
    <li class:ok={TX.permission}>
      <b>Zezwól Hermitty na komendy w Termuxie</b>
      {#if TX.permission}<span class="done"><Icon name="check" size={14} />zezwolono</span>
      {:else}<button class="btn sm pri" disabled={!TX.installed} onclick={() => askPermission().then(refreshTermux)}>Zezwól</button>{/if}
    </li>
    <li>
      <b>W Termuxie pozwól na komendy z innych aplikacji</b>
      <small class="muted">Otwórz Termux, wklej tę komendę i naciśnij Enter (raz):</small>
      <code class="cmd mono">{ALLOW_CMD}</code>
      <div class="row"><button class="btn sm" onclick={copy}><Icon name="copy" size={16} />Kopiuj</button><button class="btn sm ghost" disabled={!TX.installed} onclick={() => openTermux().catch((e) => toast(msg(e)))}>Otwórz Termux</button></div>
    </li>
    <li>
      <b>Skonfiguruj serwer SSH w Termuxie</b>
      <small class="muted">Hermitty zainstaluje openssh, doda swój klucz (bez hasła) i uruchomi sshd na porcie 8022 tylko dla tego telefonu.</small>
      <button class="btn pri wide" disabled={busy || !TX.installed || !TX.permission} onclick={go}>{busy ? 'Konfiguruję…' : 'Konfiguruj i otwórz terminal'}</button>
      {#if step}<small class="muted">{step}</small>{/if}
      {#if error}<p class="err">{error}</p>{/if}
    </li>
  </ol>
</div>

<style>
  .setup { flex: 1; overflow: auto; padding: 8px 16px 24px; }
  h2 { margin: 4px 0 6px; font: 500 22px var(--font-mono); letter-spacing: -0.03em; }
  ol { list-style: none; padding: 0; margin: 14px 0 0; display: grid; gap: 10px; counter-reset: s; }
  li { counter-increment: s; background: var(--card); border-radius: 18px; padding: 14px 14px 14px 52px; position: relative; display: grid; gap: 8px; }
  li::before { content: counter(s); position: absolute; left: 14px; top: 13px; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; background: var(--muted); font: 600 13px var(--font-mono); }
  li.ok::before { content: '✓'; background: var(--primary); color: var(--primary-foreground); }
  small { font-size: 12.5px; line-height: 1.45; }
  .done { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: var(--muted-foreground); }
  .cmd { display: block; font-size: 11.5px; word-break: break-all; background: var(--muted); border-radius: 10px; padding: 8px 10px; user-select: all; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .wide { width: 100%; }
  .err { margin: 0; color: var(--destructive); font-size: 13px; white-space: pre-wrap; }
</style>
