<script lang="ts">
  import Icon from '../../../src/lib/Icon.svelte';
  import { S, pair, disconnect, toast } from '../lib/store.svelte';
  import { isTauri } from '../../../src/lib/ipc';

  let text = $state('');
  let started = $state(false);
  const busy = $derived(started && !S.cur && (S.state === 'connecting' || S.state === 'waiting'));

  function go(t = text) {
    if (!pair(t)) { toast('To nie jest link z kodu Hermitty. Zeskanuj kod z Ustawienia → Zdalny dostęp.'); return; }
    started = true;
  }

  async function scan() {
    try {
      const B = await import('@tauri-apps/plugin-barcode-scanner');
      let p = await B.checkPermissions();
      if (p !== 'granted') p = await B.requestPermissions();
      if (p !== 'granted') { toast('Bez dostępu do aparatu wklej link poniżej.'); return; }
      const r = await B.scan({ windowed: false, formats: [B.Format.QRCode] });
      if (r?.content) { text = r.content; go(r.content); }
    } catch (e) { toast(`Skanowanie nie zadziałało: ${String(e)}`); }
  }
</script>

{#if busy || (started && (S.state === 'denied' || S.state === 'error'))}
  <div class="status">
    {#if S.state === 'waiting'}
      <i class="pulse"><Icon name="monitor" size={28} /></i><h3>Potwierdź na komputerze</h3>
      <p class="muted">W Hermitty pojawiło się pytanie o nowe urządzenie „{S.settings.name}”. Kliknij <b>Zezwól</b>.</p>
    {:else if S.state === 'connecting'}
      <i class="pulse"><Icon name="wifi" size={28} /></i><h3>Łączę z komputerem…</h3>
      <p class="muted">Telefon i komputer muszą być w tej samej sieci Wi-Fi albo w Tailscale.</p>
    {:else}
      <i class="bad"><Icon name="x" size={28} /></i><h3>{S.state === 'denied' ? 'Odrzucono' : 'Nie udało się sparować'}</h3>
      <p class="muted">{S.error}</p>
      <button class="btn ghost" onclick={() => { started = false; disconnect(); }}>Spróbuj ponownie</button>
    {/if}
  </div>
{:else}
  <p class="muted">Na komputerze: Hermitty → Ustawienia → <b>Zdalny dostęp</b> → <b>Sparuj telefon</b>. Pokaże się kod QR ważny 5 minut.</p>
  {#if isTauri}<button class="btn pri wide" onclick={scan}><Icon name="search" size={18} />Zeskanuj kod QR</button>{/if}
  <label class="lbl" for="link">{isTauri ? 'albo wklej link spod kodu' : 'Link spod kodu QR'}</label>
  <textarea id="link" class="inp mono" rows="3" bind:value={text} placeholder="http://192.168.1.24:7420/#p=…&k=…" spellcheck="false" autocapitalize="off"></textarea>
  <button class="btn wide" disabled={!text.trim()} onclick={() => go()}>Sparuj</button>
{/if}

<style>
  .wide { width: 100%; margin-top: 12px; }
  .lbl { display: block; font-size: 13px; color: var(--muted-foreground); margin: 18px 0 6px; }
  textarea { resize: none; font-size: 13px; }
  .status { text-align: center; padding: 18px 8px 8px; display: grid; justify-items: center; gap: 4px; }
  .status i { width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; background: var(--muted); }
  .status i.bad { color: var(--destructive); }
  .pulse { animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 50% { transform: scale(1.08); box-shadow: 0 0 0 10px color-mix(in oklab, var(--primary) 15%, transparent); } }
  h3 { margin: 10px 0 0; font: 500 20px var(--font-mono); letter-spacing: -0.03em; }
  .status p { margin: 4px 0 12px; max-width: 32ch; }
</style>
