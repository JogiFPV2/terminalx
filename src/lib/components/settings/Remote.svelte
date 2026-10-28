<script lang="ts">
  import Icon from '../../Icon.svelte';
  import qrcode from 'qrcode-generator';
  import { app } from '../../state.svelte';
  import { remote, startRemote, stopRemote, beginPair, setPerm, revoke, refreshStatus } from '../../remote.svelte';

  let now = $state(Date.now());
  let urlIdx = $state(0);
  $effect(() => { refreshStatus(); const t = setInterval(() => (now = Date.now()), 1000); return () => clearInterval(t); });

  const left = $derived(remote.pair ? Math.max(0, Math.round((remote.pair.expires - now) / 1000)) : 0);
  const qrSvg = $derived.by(() => {
    const url = remote.pair?.urls[urlIdx] || remote.pair?.urls[0];
    if (!url) return '';
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true });
  });
  const PERM = { view: 'Podgląd', control: 'Sterowanie', full: 'Pełny (z agentem AI)' } as const;
  const online = (id: string) => remote.clients.some(([, d]) => d === id);
  const when = (ms?: number) => (ms ? new Date(ms).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  async function toggle() { if (remote.running) await stopRemote(); else await startRemote(); }
  async function changeMode(m: 'lan' | 'tailscale') { app.remote.mode = m; if (remote.running) await startRemote(); }
</script>

<div class="pagehead"><h2>Zdalny dostęp</h2>
  <div><span class="hint">{remote.running ? 'Włączony' : 'Wyłączony'}</span><button class="switch" class:on={remote.running} role="switch" aria-checked={remote.running} aria-label="Zdalny dostęp" onclick={toggle}></button></div>
</div>
<p class="hint">Steruj aplikacją z telefonu: terminale, czat z agentem, zatwierdzanie komend i Procesy w tle. Telefon paruje się raz przez kod QR; cała komunikacja jest szyfrowana kluczem urządzenia (XSalsa20-Poly1305), a nowe urządzenie musisz potwierdzić na tym komputerze.</p>

<div><h3>Sposób połączenia</h3>
  <div class="modes">
    <button class="mode" class:on={app.remote.mode === 'lan'} onclick={() => changeMode('lan')}><b>Ta sama sieć Wi-Fi</b><small>Telefon w tej samej sieci co komputer. Ruch nie wychodzi z domu.</small></button>
    <button class="mode" class:on={app.remote.mode === 'tailscale'} onclick={() => changeMode('tailscale')}><b>Z dowolnego miejsca (Tailscale)</b><small>Bez publicznego IP i bez otwierania portów. Wymaga Tailscale na komputerze i telefonie; aplikacja nasłuchuje tylko na adresie z Twojej sieci tailnet.</small></button>
    <div class="mode off"><b>P2P bez Tailscale</b><small>Połączenie po kluczu urządzenia (iroh) wymaga natywnej aplikacji mobilnej. W przygotowaniu.</small></div>
  </div>
</div>

<div class="field" style="max-width:200px"><label for="rport">Port</label><input class="inp" id="rport" type="number" min="1024" max="65535" bind:value={app.remote.port} disabled={remote.running} /></div>
{#if remote.error}<div class="err-box">{remote.error}</div>{/if}

{#if remote.running}
  <div><h3>Adresy</h3>
    <div class="list">{#each remote.addrs as a}<div class="lrow"><code class="k">{a}</code></div>{:else}<div class="lrow"><span class="hint">Brak adresów dla tego trybu.</span></div>{/each}</div>
    <p class="hint" style="margin-top:6px">Przy pierwszym włączeniu Windows może zapytać o zgodę zapory: zezwól na dostęp w sieciach prywatnych.</p>
  </div>
  <div><h3>Sparuj telefon</h3>
    {#if remote.pair && left > 0}
      <div class="pair">
        <div class="qr" aria-label="Kod QR do parowania">{@html qrSvg}</div>
        <div class="steps">
          <ol><li>Zeskanuj kod aparatem telefonu.</li><li>Otwórz link w przeglądarce.</li><li>Potwierdź urządzenie na tym komputerze.</li></ol>
          <span class="hint">Kod jest jednorazowy i ważny jeszcze {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.</span>
          {#if remote.pair.urls.length > 1}
            <select class="inp" bind:value={urlIdx} aria-label="Adres w kodzie">{#each remote.pair.urls as u, i}<option value={i}>{u.split('/#')[0]}</option>{/each}</select>
          {/if}
          <button class="icobtn" title="Nowy kod" onclick={beginPair}><Icon name="refresh" /></button>
        </div>
      </div>
    {:else}
      <button class="btn pri" onclick={beginPair} disabled={!remote.addrs.length}><Icon name="phone" />Pokaż kod QR</button>
    {/if}
  </div>
{/if}

<div><h3>Sparowane urządzenia</h3>
  <div class="list">
    {#each remote.devices as d (d.id)}
      <div class="lrow">
        <div class="picon"><Icon name="phone" /></div>
        <div class="info"><b>{d.name}{#if online(d.id)} <span class="chip ok">połączony</span>{/if}</b><small>dodany {when(d.added)} · ostatnio {when(d.lastSeen)}</small></div>
        <select class="inp" style="width:auto" value={d.perm} onchange={(e) => setPerm(d.id, e.currentTarget.value)} aria-label="Uprawnienia {d.name}">
          {#each Object.entries(PERM) as [k, v]}<option value={k}>{v}</option>{/each}</select>
        <div class="acts"><button class="btn ghost danger" onclick={() => revoke(d.id)}>Odłącz</button></div>
      </div>
    {:else}
      <div class="lrow"><span class="hint">Brak sparowanych urządzeń.</span></div>
    {/each}
  </div>
</div>

<ul class="sec">
  <li><Icon name="check" size={14} />Klucz urządzenia jest tylko w kodzie QR i w Menedżerze poświadczeń; nie przechodzi przez sieć.</li>
  <li><Icon name="check" size={14} />Uprawnienia sprawdza rdzeń: „Podgląd” tylko czyta, „Sterowanie” pisze do terminali i zatwierdza komendy, „Pełny” także rozmawia z agentem.</li>
  <li><Icon name="check" size={14} />Hasła, klucze API i Vault nigdy nie trafiają na telefon.</li>
</ul>

<style>
  .modes { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
  .mode { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; text-align: left; display: flex; flex-direction: column; gap: 4px; }
  .mode b { font-weight: 500; }
  .mode small { color: var(--muted-foreground); font-size: 11.5px; line-height: 1.45; }
  .mode.on { border-color: var(--primary); box-shadow: inset 0 0 0 1px var(--primary); }
  .mode.off { opacity: .6; }
  .pair { display: flex; gap: 18px; align-items: center; border: 1px solid var(--border); border-radius: 10px; padding: 14px; flex-wrap: wrap; }
  .qr { width: 190px; height: 190px; background: #fff; border-radius: 8px; padding: 4px; flex: none; }
  .qr :global(svg) { width: 100%; height: 100%; display: block; }
  .steps { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
  .steps ol { margin: 0; padding-left: 18px; font-size: 12.5px; line-height: 1.7; color: var(--muted-foreground); }
  .sec { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; font-size: 12px; color: var(--muted-foreground); }
  .sec li { display: flex; gap: 8px; align-items: flex-start; }
  .sec li :global(svg) { color: var(--chart-1); margin-top: 1px; }
</style>
