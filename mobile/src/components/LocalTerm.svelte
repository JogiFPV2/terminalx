<script lang="ts">
  // Ekran serwera SSH otwartego z listy „Ten telefon”: nagłówek i terminal (TermView).
  import Icon from '../../../src/lib/Icon.svelte';
  import { SSH, hostById } from '../lib/ssh.svelte';
  import TermView from './TermView.svelte';

  const h = hostById(SSH.open)!;
  let phase = $state<'connecting' | 'ready' | 'closed'>('connecting');
  let error = $state('');
  const statusText = $derived(phase === 'ready' ? 'połączono' : phase === 'connecting' ? 'łączę…' : error ? 'błąd' : 'rozłączono');
</script>

<div class="app">
  <header class="top">
    <button class="ib back" aria-label="Wróć" onclick={() => (SSH.open = null)}><Icon name="chev" size={20} /></button>
    <div class="who"><b>{h.name}</b><small><span class="dot {phase === 'ready' ? 'ok' : phase === 'connecting' ? 'wait' : 'bad'}"></span>{statusText} · <span class="mono">{h.user}@{h.host}</span></small></div>
  </header>
  <TermView host={h} id={`srv:${h.id}`} onstate={(p, e) => { phase = p; error = e; }} />
</div>

<style>
  .app { height: 100%; display: flex; flex-direction: column; padding: var(--safe-t) 0 var(--safe-b); }
  .top { display: flex; align-items: center; gap: 4px; height: 56px; padding: 0 4px; flex: none; }
  .back :global(svg) { transform: rotate(180deg); }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .who b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who small { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted-foreground); white-space: nowrap; overflow: hidden; }
  .who .dot { width: 7px; height: 7px; flex: none; }
</style>
