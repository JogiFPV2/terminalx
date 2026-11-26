<script lang="ts">
  // Dodawanie komputera: z listy komputerów w tej sieci (bez skanowania; oba ekrany pokazują ten sam 6-cyfrowy kod)
  // albo kodem QR / linkiem. Na komputerze parowanie otwiera „Sparuj telefon” (Ustawienia → Zdalny dostęp).
  import { onMount } from 'svelte';
  import Icon from '../../../src/lib/Icon.svelte';
  import { S, pair, pairNear, disconnect, toast } from '../lib/store.svelte';
  import Scanner from './Scanner.svelte';
  import { BR, parseBridgeLink, pendingLink, lanGranted, askLan, scanPcs, type FoundPc } from '../lib/bridge.svelte';
  import { inTauri } from '../lib/ssh.svelte';
  import LanHint from './LanHint.svelte';

  let text = $state('');
  let started = $state(false);
  const busy = $derived(started && !S.cur && (S.state === 'connecting' || S.state === 'waiting'));

  let lanOk = $state(true);
  async function lan() {
    // Android 17: bez zgody na sieć lokalną połączenie z komputerem kończy się przekroczeniem czasu.
    lanOk = await lanGranted();
    if (!lanOk) askLan().catch(() => {});
    return lanOk;
  }

  async function go(t = text) {
    if (!(await lan())) return;
    // Kod wtyczki Telefon (hermitty://pair…) to mostek, nie zdalny dostęp: przejście do ekranu mostka.
    const b = parseBridgeLink(t);
    if (b) { pendingLink.v = b; S.sheet = null; BR.open = true; return; }
    if (!pair(t)) { toast('To nie jest link z kodu Hermitty. Zeskanuj kod z Ustawienia → Zdalny dostęp.'); return; }
    started = true;
  }

  // Komputery w tej sieci (UDP); szukamy od razu i co kilka sekund, dopóki ekran jest otwarty.
  let found = $state<FoundPc[]>([]);
  let searching = $state(false);
  let searched = $state(false);
  async function search() {
    if (searching || !inTauri()) return;
    searching = true;
    try { if (await lanGranted()) found = await scanPcs(); } catch { /* następna próba */ } finally { searching = false; searched = true; }
  }
  onMount(() => { search(); const t = setInterval(() => { if (!started) search(); }, 5000); return () => clearInterval(t); });

  async function near(f: FoundPc) {
    if (!(await lan())) return;
    pairNear(f.host, f.port, f.name, f.id);
    started = true;
  }

  let scanning = $state(false);
  const camera = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const sas = $derived(S.sas ? `${S.sas.slice(0, 3)} ${S.sas.slice(3)}` : '');
  let diag = $state(false);
</script>

{#if !lanOk}<LanHint onok={() => { lanOk = true; search(); }} />{/if}
{#if busy || (started && (S.state === 'denied' || S.state === 'error'))}
  <div class="status">
    {#if S.state === 'waiting'}
      {#if sas}
        <span class="lbl2">Kod</span>
        <div class="sas mono" aria-label="Kod parowania {S.sas}">{sas}</div>
        <h3>Sprawdź kod na komputerze</h3>
        <p class="muted">Hermitty na komputerze pokazuje teraz kod. Kliknij tam <b>Zezwól</b> tylko, jeśli jest taki sam jak tutaj.</p>
      {:else}
        <i class="pulse"><Icon name="monitor" size={28} /></i><h3>Potwierdź na komputerze</h3>
        <p class="muted">W Hermitty pojawiło się pytanie o nowe urządzenie „{S.settings.name}”. Kliknij <b>Zezwól</b>.</p>
      {/if}
    {:else if S.state === 'connecting'}
      <i class="pulse"><Icon name="wifi" size={28} /></i><h3>Łączę z komputerem…</h3>
      <p class="muted">Telefon i komputer muszą być w tej samej sieci Wi-Fi albo w Tailscale.</p>
    {:else}
      <i class="bad"><Icon name="x" size={28} /></i><h3>{S.state === 'denied' ? 'Odrzucono' : 'Nie udało się sparować'}</h3>
      <p class="muted">{S.error}</p>
      <LanHint quiet />
      <button class="btn ghost" onclick={() => { started = false; disconnect(); search(); }}>Spróbuj ponownie</button>
    {/if}
  </div>
{:else}
  <p class="muted">Na komputerze: Hermitty → Ustawienia → <b>Zdalny dostęp</b> → włącz → <b>Pokaż kod QR</b>. Od tej chwili przez 5 minut możesz wybrać komputer z listy poniżej albo zeskanować kod.</p>

  <div class="near">
    <div class="nh"><b>W tej sieci</b>{#if searching}<span class="spin" aria-label="Szukam"></span>{:else}<button class="ib" aria-label="Szukaj ponownie" onclick={search}><Icon name="refresh" size={16} /></button>{/if}</div>
    {#each found as f (f.id + f.host)}
      <button class="pc" onclick={() => near(f)}><i><Icon name="monitor" size={20} /></i><span><b>{f.name}</b><small class="mono">{f.host}:{f.port}</small></span><Icon name="chev" size={16} /></button>
    {:else}
      <p class="muted small">{!inTauri() ? 'Wyszukiwanie działa w aplikacji na telefonie.' : searched ? 'Nie widzę komputera z Hermitty. Sprawdź, czy Zdalny dostęp jest włączony i telefon jest w tej samej sieci Wi-Fi, albo zeskanuj kod QR.' : 'Szukam…'}</p>
    {/each}
  </div>

  {#if camera}<button class="btn pri wide" onclick={() => (scanning = true)}><Icon name="search" size={18} />Zeskanuj kod QR</button>{/if}
  <label class="lbl" for="link">{camera ? 'albo wklej link spod kodu' : 'Link spod kodu QR'}</label>
  <textarea id="link" class="inp mono" rows="3" bind:value={text} placeholder="http://192.168.1.24:7420/#p=…&k=…" spellcheck="false" autocapitalize="off"></textarea>
  <button class="btn wide" disabled={!text.trim()} onclick={() => go()}>Sparuj</button>

  <button class="btn ghost sm diagb" onclick={() => (diag = !diag)}><Icon name="activity" size={15} />Diagnostyka połączenia</button>
  {#if diag}
    <ul class="diag">
      <li class:ok={lanOk}>{lanOk ? 'Zgoda na sieć lokalną: jest' : 'Zgoda na sieć lokalną: brak (Android 17 blokuje połączenia z komputerem)'}</li>
      <li class:ok={found.length > 0}>{found.length ? `Komputery w sieci: ${found.map((f) => `${f.name} (${f.host})`).join(', ')}` : 'Komputery w sieci: nie odpowiedział żaden. Włącz Zdalny dostęp na komputerze; jeśli jest włączony, Zapora Windows może blokować UDP (Zdalny dostęp → „Dodaj regułę zapory”).'}</li>
      {#each S.pcs as p (p.device)}
        {@const seen = found.find((f) => f.id === p.pcId)}
        <li class:ok={!!seen}>{p.name}: {seen ? `widoczny pod ${seen.host}${p.url.includes(seen.host) ? '' : ' (nowy adres: telefon połączy się sam)'}` : `nie odpowiada (zapisany adres ${p.url.replace(/^https?:\/\//, '')})`}</li>
      {/each}
      <li>Gdy strona z adresu komputera otwiera się w Chrome, a tu nie, zgoda na sieć lokalną jest wyłączona.</li>
    </ul>
  {/if}
{/if}

{#if scanning}<Scanner onresult={(t) => { scanning = false; text = t; go(t); }} onclose={() => (scanning = false)} />{/if}

<style>
  .wide { width: 100%; margin-top: 12px; }
  .lbl { display: block; font-size: 13px; color: var(--muted-foreground); margin: 18px 0 6px; }
  textarea { resize: none; font-size: 13px; }
  .near { margin-top: 14px; background: var(--muted); border-radius: 18px; padding: 10px; display: grid; gap: 6px; }
  .nh { display: flex; align-items: center; justify-content: space-between; padding: 0 4px; min-height: 32px; }
  .pc { display: flex; align-items: center; gap: 12px; border: 0; border-radius: 14px; background: var(--card); padding: 10px 12px; text-align: left; min-height: 56px; }
  .pc i { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; background: var(--primary); color: var(--primary-foreground); flex: none; }
  .pc span { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .pc small { font-size: 12px; color: var(--muted-foreground); }
  .small { font-size: 13px; margin: 2px 4px 6px; line-height: 1.45; }
  .spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--foreground); animation: r .8s linear infinite; margin-right: 8px; }
  @keyframes r { to { transform: rotate(360deg); } }
  .status { text-align: center; padding: 18px 8px 8px; display: grid; justify-items: center; gap: 4px; }
  .status i { width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; background: var(--muted); }
  .status i.bad { color: var(--destructive); }
  .pulse { animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 50% { transform: scale(1.08); box-shadow: 0 0 0 10px color-mix(in oklab, var(--primary) 15%, transparent); } }
  h3 { margin: 10px 0 0; font: 500 20px var(--font-mono); letter-spacing: -0.03em; }
  .status p { margin: 4px 0 12px; max-width: 32ch; }
  .lbl2 { font-size: 13px; color: var(--muted-foreground); }
  .sas { font-size: 44px; font-weight: 600; letter-spacing: .08em; padding: 8px 18px; border-radius: 18px; background: var(--primary); color: var(--primary-foreground); }
  .diagb { margin-top: 16px; }
  .diag { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 6px; font-size: 13px; line-height: 1.45; }
  .diag li { padding: 8px 10px 8px 30px; border-radius: 12px; background: var(--muted); position: relative; }
  .diag li::before { content: '•'; position: absolute; left: 12px; color: var(--muted-foreground); }
  .diag li.ok::before { content: '✓'; color: var(--chart-1); }
</style>
