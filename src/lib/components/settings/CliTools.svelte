<script lang="ts">
  // Zakładka CLI na stronie providerów: zainstalowane narzędzia AI (Claude Code, Codex, Gemini CLI, Amp…).
  // Logowanie robi samo narzędzie w zakładce terminala; włączone narzędzie staje się providerem czatu
  // (jedno uruchomienie w trybie bez okna na pytanie, bez narzędzi aplikacji).
  import Icon from '../../Icon.svelte';
  import { app, notify } from '../../state.svelte';
  import { call } from '../../ipc';
  import { cliIcon, CLI_DEFAULT_MODEL } from '../../defaults';
  import { cliInTab, accountName } from '../../accounts';
  import { ask, listModels } from '../../ai';
  import type { AccountService, Provider } from '../../types';

  interface CliInfo { id: string; name: string; installed: boolean; path: string; version: string; headless: boolean; login: string; install: string; models: string[]; accounts: boolean; note: string }

  let list = $state<CliInfo[] | null>(null);
  let err = $state('');
  let busy = $state(false);
  let st = $state<Record<string, { status?: string; ok?: boolean | null; test?: 'run' | 'ok' | 'error'; msg?: string }>>({});

  async function detect() {
    busy = true; err = '';
    try { list = await call<CliInfo[]>('aicli_detect'); }
    catch (e) { err = String(e).replace(/^Error: /, ''); }
    busy = false;
    for (const c of list || []) if (c.installed && c.headless) status(c);
  }
  $effect(() => { detect(); });

  const providerOf = (id: string) => app.providers.find((p) => p.type === 'cli' && p.cli === id);
  const label = (m: string) => (m === CLI_DEFAULT_MODEL ? 'domyślny w narzędziu' : m);

  async function status(c: CliInfo) {
    try {
      const r = await call<{ loggedIn: boolean | null; text: string }>('aicli_status', { id: c.id, account: providerOf(c.id)?.account || null });
      st[c.id] = { ...st[c.id], ok: r.loggedIn, status: r.text };
    } catch (e) { st[c.id] = { ...st[c.id], ok: null, status: String(e).replace(/^Error: /, '') }; }
  }

  async function enable(c: CliInfo) {
    const p: Provider = { id: `cli-${c.id}`, type: 'cli', cli: c.id, name: c.name, url: '', keyRef: `cli:${c.id}`, hasKey: false, models: [CLI_DEFAULT_MODEL, ...c.models] };
    app.providers.push(p);
    try { const m = await listModels(p); if (m.length > 1) providerOf(c.id)!.models = m; } catch { /* lista z narzędzia jest opcjonalna */ }
  }
  function disable(c: CliInfo) {
    const p = providerOf(c.id);
    if (!p) return;
    if (p.id === app.defModel.provider) { notify('To domyślny provider. Najpierw wybierz inny domyślny model.', 'warning'); return; }
    app.providers.splice(app.providers.indexOf(p), 1);
  }

  async function test(c: CliInfo) {
    const p = providerOf(c.id);
    if (!p) return;
    st[c.id] = { ...st[c.id], test: 'run', msg: '' };
    const t0 = Date.now();
    try {
      const r = await ask('Odpowiedz jednym słowem: OK', { providerId: p.id, model: p.defModel || p.models[0] });
      st[c.id] = { ...st[c.id], test: 'ok', msg: `„${r.slice(0, 40)}” · ${((Date.now() - t0) / 1000).toFixed(1)} s` };
    } catch (e) { st[c.id] = { ...st[c.id], test: 'error', msg: String(e).replace(/^Error: /, '') }; }
  }

  function login(c: CliInfo) {
    const acc = providerOf(c.id)?.account;
    cliInTab(`Logowanie · ${c.name}`, c.login, true, acc ? { [c.id]: acc } : undefined);
  }
  function install(c: CliInfo) {
    // Komenda wpisana bez Enter: użytkownik widzi, co się uruchomi, i potwierdza sam.
    cliInTab(`Instalacja · ${c.name}`, c.install, false);
    notify(`Komenda instalacji ${c.name} jest wpisana w nowej zakładce. Naciśnij Enter, a po instalacji odśwież listę.`, 'info', 6000);
  }
  async function copy(t: string) { try { await navigator.clipboard.writeText(t); notify('Skopiowano.', 'info', 1500); } catch { /* bez schowka */ } }

  const accountsFor = (id: string) => app.accounts.filter((a) => a.service === (id as AccountService));
  const installed = $derived((list || []).filter((c) => c.installed));
  const missing = $derived((list || []).filter((c) => !c.installed));
</script>

<p class="hint">Narzędzia AI zainstalowane na tym komputerze. Włączone narzędzie pojawia się na listach providerów (czat, agenci, snippety, nody) i odpowiada z Twojego planu w tym narzędziu. Każde pytanie to jedno uruchomienie w pustym folderze, bez dostępu do projektów; narzędzia aplikacji (komendy w zakładkach, workflow) działają tylko z providerami API. Logujesz się w samym narzędziu, a Hermitty nie czyta jego plików logowania.</p>

<div class="psub" style="display:flex;align-items:center;gap:6px;padding-left:0;border:0">
  <span class="sublabel">{list ? `Zainstalowane: ${installed.length}` : 'Szukam narzędzi…'}</span>
  <button class="icobtn sm" title="Wyszukaj ponownie" disabled={busy} onclick={detect}><Icon name="refresh" size={13} /></button>
</div>
{#if err}<p class="hint err">{err}</p>{/if}

{#each installed as c (c.id)}
  {@const p = providerOf(c.id)}
  {@const s = st[c.id]}
  <div class="pcard">
    <div class="lrow">
      <div class="picon"><Icon name={cliIcon(c.id)} /></div>
      <div class="info">
        <b>{c.name}
          {#if c.version}<span class="chip mono">{c.version}</span>{/if}
          {#if !c.headless}<span class="chip warn">tylko edytor</span>
          {:else if s?.ok === true}<span class="chip ok" title={s.status}>{s.status || 'zalogowano'}</span>
          {:else if s?.ok === false}<span class="chip bad">niezalogowano</span>{/if}
        </b>
        <small>{c.note}</small>
        {#if s?.test === 'error'}<small class="err" title={s.msg}>{s.msg}</small>{:else if s?.test === 'ok'}<small class="okt">{s.msg}</small>{/if}
      </div>
      {#if p}
        <select class="inp defm" title="Model (domyślny dla tego narzędzia)" bind:value={p.defModel}>
          {#each p.models as m}<option value={m === p.models[0] ? undefined : m}>{label(m)}</option>{/each}
        </select>
      {/if}
      <div class="acts">
        {#if c.headless}
          <button class="icobtn" title="Zaloguj w terminalu ({c.login})" onclick={() => login(c)}><Icon name="key" size={14} /></button>
          {#if p}<button class="icobtn" title="Testuj (krótkie pytanie)" disabled={s?.test === 'run'} onclick={() => test(c)}><Icon name={s?.test === 'run' ? 'clock' : 'play'} size={14} /></button>{/if}
          <button class="switch" class:on={!!p} role="switch" aria-checked={!!p} aria-label="Używaj {c.name} jako providera czatu"
            title={p ? 'Włączony jako provider czatu' : 'Używaj jako providera czatu'} onclick={() => (p ? disable(c) : enable(c))}></button>
        {/if}
      </div>
    </div>
    {#if p && c.accounts && accountsFor(c.id).length}
      <div class="psub">
        <span class="sublabel">Konto</span>
        <select class="inp defm" bind:value={p.account} onchange={() => status(c)}>
          <option value={null}>domyślne</option>
          {#each accountsFor(c.id) as a}<option value={a.id}>{accountName(c.id, a.id)}</option>{/each}
        </select>
      </div>
    {/if}
  </div>
{/each}

{#if missing.length}
  <div class="psub" style="padding-left:0;border:0;margin-top:6px"><span class="sublabel">Nie zainstalowane</span></div>
  <div class="pcard">
    {#each missing as c (c.id)}
      <div class="lrow">
        <div class="picon dim"><Icon name={cliIcon(c.id)} /></div>
        <div class="info"><b>{c.name}</b><small class="mono" title={c.install}>{c.install}</small></div>
        <div class="acts">
          {#if c.headless}
            <button class="icobtn" title="Kopiuj komendę instalacji" onclick={() => copy(c.install)}><Icon name="copy" size={14} /></button>
            <button class="icobtn" title="Wpisz komendę w nowej zakładce terminala" onclick={() => install(c)}><Icon name="terminal" size={14} /></button>
          {:else}
            <span class="chip" title={c.note}>edytor</span>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}

<p class="hint">Z.ai (GLM) nie ma własnego CLI: dodaj go w zakładce API jako „Zgodny z OpenAI” z adresem <span class="mono">https://api.z.ai/api/paas/v4</span> (plan GLM Coding: <span class="mono">https://api.z.ai/api/coding/paas/v4</span>).</p>

<style>
  .err { color: var(--destructive) !important; white-space: normal !important; }
  .okt { color: var(--chart-1) !important; }
  .defm { width: auto; max-width: 200px; font-size: 12px; padding: 3px 6px; font-family: var(--font-mono); }
  .dim { opacity: .5; }
</style>
