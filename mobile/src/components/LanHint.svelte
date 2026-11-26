<script lang="ts">
  // Android 17: Hermitty potrzebuje zgody „Urządzenia w pobliżu / sieć lokalna”, żeby łączyć się z komputerem
  // i serwerami w domu (bez niej połączenie kończy się przekroczeniem czasu). `quiet`: pokaż tylko, gdy zgody brak.
  import { onMount } from 'svelte';
  import Icon from '../../../src/lib/Icon.svelte';
  import { lanGranted, askLan } from '../lib/bridge.svelte';

  let { quiet = false, onok }: { quiet?: boolean; onok?: () => void } = $props();
  let ok = $state(true);
  const check = async () => { const was = ok; ok = await lanGranted(); if (ok && !was) onok?.(); };
  onMount(() => {
    check();
    const vis = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', vis);
    const t = setInterval(check, 1500);
    return () => { document.removeEventListener('visibilitychange', vis); clearInterval(t); };
  });
</script>

{#if !ok}
  <div class="lan" role="alert">
    <b><Icon name="wifi" size={16} />Zezwól na dostęp do sieci lokalnej</b>
    <p>Android 17 wymaga tej zgody, żeby Hermitty mógł połączyć się z komputerem w Twojej sieci Wi-Fi (przeglądarka ma ją już nadaną, dlatego tam działało).</p>
    <button class="btn pri sm" onclick={() => askLan().then(check)}>Zezwól</button>
    {#if !quiet}<small>Jeśli okno się nie pojawi: Ustawienia → Aplikacje → Hermitty → Uprawnienia → Urządzenia w pobliżu → Zezwól.</small>{/if}
  </div>
{/if}

<style>
  .lan { display: grid; gap: 8px; justify-items: start; text-align: left; background: color-mix(in oklab, var(--primary) 22%, var(--card)); border-radius: 16px; padding: 14px; margin: 8px 0 12px; }
  b { display: flex; align-items: center; gap: 8px; }
  p { margin: 0; font-size: 13.5px; line-height: 1.45; }
  small { font-size: 12px; color: var(--muted-foreground); }
</style>
