<script lang="ts">
  // Mostek z komputerem: telefon jako dodatek do Hermitty na komputerze (powiadomienia, SMS-y, dyktafon).
  // To ta sama funkcja co w osobnej aplikacji „Hermitty Telefon”, teraz wbudowana tutaj.
  import { onMount } from 'svelte';
  import Icon from '../../../src/lib/Icon.svelte';
  import { BR, refresh, discover, pairBridge, unpair, kick, dismissLink, setOpt, askPerm, rec, pendingLink } from '../lib/bridge.svelte';
  import { toast, msg, S, req, lastPc, open } from '../lib/store.svelte';
  import Scanner from './Scanner.svelte';
  import { parseBridgeLink } from '../lib/bridge.svelte';

  let found = $state<{ id: string; name: string; host: string; port: number }[]>([]);
  let searching = $state(false);
  let host = $state('');
  let code = $state('');
  let port = $state(47390);
  let pairing = $state(false);
  let scanning = $state(false);
  const st = $derived(BR.st);

  async function search() {
    searching = true;
    try { found = await discover(); if (found.length === 1 && !host) { host = found[0].host; port = found[0].port; } } catch (e) { toast(msg(e)); } finally { searching = false; }
  }

  async function doPair(hosts: string[], p: number, c: string) {
    if (pairing) return;
    pairing = true;
    try { const name = await pairBridge(hosts, p, c); code = ''; pendingLink.v = null; dismissLink().catch(() => {}); toast(`Sparowano z ${name || 'komputerem'}`); }
    catch (e) { toast(msg(e)); }
    finally { pairing = false; refresh(); }
  }

  // Jedno parowanie: komputer sparowany przez Zdalny dostęp daje kod mostka przez już zaufane połączenie.
  const linkReady = () => S.state === 'ready';
  async function viaRemote() {
    if (!linkReady()) {
      const pc = lastPc();
      if (!pc) { toast('Najpierw dodaj komputer (Twoje komputery → Dodaj komputer).'); return; }
      await open(pc.device, true);
      for (let i = 0; i < 40 && !linkReady(); i++) await new Promise((r) => setTimeout(r, 250));
      if (!linkReady()) { toast(S.error || 'Nie udało się połączyć z komputerem.'); return; }
    }
    pairing = true;
    try {
      const r = await req<{ code: string; hosts: string[]; port: number }>('bridgePair', {}, 40_000);
      pairing = false;
      await doPair(r.hosts, r.port, r.code);
    } catch (e) { pairing = false; toast(msg(e)); }
  }

  function fromLink(t: string) {
    const l = parseBridgeLink(t);
    if (!l) { toast('To nie jest kod wtyczki Telefon (hermitty://pair…).'); return; }
    host = l.hosts[0]; port = l.port; code = l.code;
    doPair(l.hosts, l.port, l.code);
  }

  onMount(() => {
    refresh().then(() => {
      const l = pendingLink.v || BR.st?.link;
      if (l && !BR.st?.paired) { host = l.hosts[0] || ''; port = l.port; code = l.code; doPair(l.hosts, l.port, l.code); }
      else if (BR.st && !BR.st.paired) search();
    });
    const t = setInterval(refresh, 1500);
    const vis = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  });

  const stateText = $derived(!st ? '' : !st.paired ? 'Nie sparowano z komputerem' : st.state === 'online' ? `Połączono z ${st.pcName}` : st.state === 'connecting' ? `Łączę z ${st.pcName}…` : `${st.pcName}: offline`);
  const PERMS: [keyof NonNullable<typeof st>['perms'], string, string][] = [
    ['post', 'Powiadomienie usługi', 'Widoczne, gdy telefon jest połączony z komputerem.'],
    ['notifications', 'Dostęp do powiadomień', 'Powiadomienia innych aplikacji na komputerze, odpowiadanie z komputera.'],
    ['sms', 'SMS-y i kontakty', 'Czytanie i wysyłanie SMS-ów z komputera, nazwy zamiast numerów.'],
    ['mic', 'Mikrofon', 'Dyktafon włączany z komputera, także przy zablokowanym ekranie.'],
    ['battery', 'Bateria bez ograniczeń', 'Bez tego system usypia połączenie po kilku minutach.'],
  ];
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  async function act(p: Promise<unknown>) { try { await p; } catch (e) { toast(msg(e)); } refresh(); }
</script>

<div class="app">
  <header class="top">
    <button class="ib back" aria-label="Wróć" onclick={() => (BR.open = false)}><Icon name="chev" size={20} /></button>
    <div class="who"><b>Mostek z komputerem</b><small>Powiadomienia, SMS-y i dyktafon w Hermitty na komputerze</small></div>
  </header>

  <main>
    {#if BR.error && !st}<p class="card err">{BR.error}</p>{/if}
    {#if st}
      <section class="card">
        <div class="state"><span class="dot {st.state === 'online' ? 'ok' : st.state === 'connecting' ? 'wait' : 'bad'}"></span><b>{stateText}</b></div>
        {#if st.paired && st.state !== 'online'}
          {#if st.error}<p class="muted small">{st.error}</p>{/if}
          <p class="muted small">Na komputerze musi być włączona wtyczka Telefon (Ustawienia → Pluginy). Poza domem połącz oba urządzenia przez Tailscale.</p>
          <button class="btn sm" onclick={() => act(kick())}>Połącz teraz</button>
        {/if}
        {#if st.paired && !st.micReady && st.perms.mic}<p class="muted small">Zdalny dyktafon włączy się, gdy aplikacja będzie otwarta (wymóg Androida po restarcie).</p>{/if}
      </section>

      {#if !st.paired}
        <section class="card">
          <h2>Parowanie</h2>
          {#if S.pcs.length}
            <button class="btn pri wide" disabled={pairing} onclick={viaRemote}><Icon name="monitor" size={18} />Sparuj przez połączony komputer</button>
            <p class="muted small">Bez przepisywania kodu: komputer sparowany w „Twoje komputery” sam poda kod mostka. Albo ręcznie:</p>
          {/if}
          <ol class="small"><li>W Hermitty na komputerze włącz wtyczkę Telefon (Ustawienia → Pluginy) i kliknij „Sparuj telefon”.</li><li>Zeskanuj kod QR albo wybierz komputer i przepisz kod z ekranu.</li></ol>
          <button class="btn pri wide" onclick={() => (scanning = true)}><Icon name="search" size={18} />Zeskanuj kod QR</button>
          <p class="muted small">{searching ? 'Szukam komputerów w tej sieci…' : found.length ? 'Komputery w tej sieci:' : 'Nie znaleziono komputera w tej sieci Wi-Fi. Wpisz adres ręcznie (np. adres Tailscale 100.x.x.x).'}</p>
          <div class="found">{#each found as f (f.id + f.host)}<button class:on={host === f.host} onclick={() => { host = f.host; port = f.port; }}><Icon name="monitor" size={16} />{f.name}<small class="mono">{f.host}</small></button>{/each}</div>
          {#if !searching}<button class="btn ghost sm" onclick={search}><Icon name="refresh" size={16} />Szukaj ponownie</button>{/if}
          <div class="field"><label for="bh">Adres komputera</label><input id="bh" class="inp mono" bind:value={host} placeholder="192.168.1.24" autocapitalize="off" spellcheck="false" /></div>
          <div class="field"><label for="bc">Kod z ekranu komputera</label><input id="bc" class="inp mono" bind:value={code} placeholder="ABCD-EFGH-JKMN" autocapitalize="characters" spellcheck="false" /></div>
          <button class="btn pri wide" disabled={pairing || !host.trim() || !code.trim()} onclick={() => { const [h, p] = host.trim().split(':'); doPair([h], Number(p) || port, code); }}>{pairing ? 'Paruję…' : 'Sparuj'}</button>
        </section>
      {/if}

      <section class="card">
        <h2>Uprawnienia</h2>
        {#each PERMS as [k, title, desc]}
          <div class="perm">
            <span class="tick" class:on={st.perms[k]}><Icon name={st.perms[k] ? 'check' : 'plus'} size={14} /></span>
            <div><b>{title}</b><small class="muted">{desc}</small></div>
            {#if !st.perms[k]}<button class="btn sm pri" onclick={() => act(askPerm(k))}>Zezwól</button>{/if}
          </div>
        {/each}
        <p class="muted small">Przełącznik jest wyszarzony? Android blokuje część uprawnień aplikacjom spoza Sklepu Play. Otwórz Informacje o aplikacji → ⋮ (prawy górny róg) → „Zezwól na ustawienia z ograniczeniami” i wróć tutaj.</p>
        <button class="btn ghost sm" onclick={() => act(askPerm('app'))}>Informacje o aplikacji</button>
      </section>

      {#if st.paired}
        <section class="card">
          <h2>Dyktafon</h2>
          <button class="btn wide" class:pri={!st.recording} class:rec={st.recording} onclick={() => act(rec('toggle'))}>{st.recording ? `■  Zatrzymaj · ${mmss(st.secs)}` : '●  Nagrywaj'}</button>
          <p class="muted small">Nagranie można też włączyć z komputera. {st.autoSend ? 'Po zatrzymaniu trafia na komputer.' : 'Wysyłanie ręczne (ustawienie niżej).'}</p>
          {#each st.recordings.slice(0, 8) as r (r.name)}
            <div class="recrow"><span class="mono">{r.name.replace(/^dyktafon-/, '').replace(/\.ogg$/, '')} · {Math.round(r.size / 1024)} KB{r.sent ? ' ✓' : ''}</span>
              {#if !r.sent && st.state === 'online'}<button class="btn sm" onclick={() => act(rec('send', r.name))}>Wyślij</button>{/if}
              <button class="ib" aria-label="Usuń nagranie" onclick={() => act(rec('delete', r.name))}><Icon name="trash" size={16} /></button></div>
          {/each}
        </section>
      {/if}

      <section class="card">
        <h2>Ustawienia</h2>
        <label class="sw"><input type="checkbox" checked={st.showCodes} onchange={(e) => act(setOpt({ showCodes: e.currentTarget.checked }))} /><span><b>Pokazuj kody jednorazowe</b><small class="muted">Domyślnie kody z SMS-ów i powiadomień (logowanie, BLIK) są na komputerze zamaskowane.</small></span></label>
        <label class="sw"><input type="checkbox" checked={st.autoSend} onchange={(e) => act(setOpt({ autoSend: e.currentTarget.checked }))} /><span><b>Wysyłaj nagrania automatycznie</b><small class="muted">Gotowe nagranie od razu trafia na komputer.</small></span></label>
        {#if st.paired}<button class="btn ghost sm" onclick={() => act(unpair()).then(search)}>Zapomnij komputer {st.pcName}</button>{/if}
      </section>
    {/if}
  </main>
</div>

{#if scanning}<Scanner onresult={(t) => { scanning = false; fromLink(t); }} onclose={() => (scanning = false)} />{/if}

<style>
  .app { height: 100%; display: flex; flex-direction: column; padding: var(--safe-t) 0 0; }
  .top { display: flex; align-items: center; gap: 4px; height: 56px; padding: 0 4px; flex: none; }
  .back :global(svg) { transform: rotate(180deg); }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .who b { font-weight: 600; }
  .who small { font-size: 12.5px; color: var(--muted-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  main { flex: 1; overflow: auto; padding: 4px 16px calc(24px + var(--safe-b)); display: grid; gap: 10px; align-content: start; }
  .card { background: var(--card); border-radius: 20px; padding: 16px; display: grid; gap: 10px; margin: 0; }
  .card.err { color: var(--destructive); }
  h2 { margin: 0; font: 500 18px var(--font-mono); letter-spacing: -0.03em; }
  .state { display: flex; align-items: center; gap: 10px; font-size: 16px; }
  .small { font-size: 13px; margin: 0; line-height: 1.45; }
  ol.small { padding-left: 18px; display: grid; gap: 4px; }
  .wide { width: 100%; }
  .found { display: grid; gap: 6px; }
  .found button { display: flex; align-items: center; gap: 8px; border: 0; border-radius: 12px; padding: 10px 12px; background: var(--muted); text-align: left; }
  .found button small { margin-left: auto; color: var(--muted-foreground); }
  .found button.on { background: var(--foreground); color: var(--background); }
  .field { display: grid; gap: 6px; }
  label { font-size: 13px; color: var(--muted-foreground); }
  .perm { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; }
  .perm div { display: flex; flex-direction: column; }
  .perm small { font-size: 12.5px; }
  .tick { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; background: var(--muted); color: var(--muted-foreground); }
  .tick.on { background: var(--primary); color: var(--primary-foreground); }
  .rec { background: var(--destructive); color: #fff; }
  .recrow { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .recrow span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sw { display: flex; gap: 12px; align-items: flex-start; color: var(--foreground); font-size: 15px; }
  .sw input { width: 22px; height: 22px; margin-top: 2px; accent-color: var(--primary-ink); flex: none; }
  .sw span { display: flex; flex-direction: column; }
  .sw small { font-size: 12.5px; }
</style>
