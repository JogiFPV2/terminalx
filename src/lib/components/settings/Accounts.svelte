<script lang="ts">
  import Icon from '../../Icon.svelte';
  import { app, ui } from '../../state.svelte';
  import { ACCOUNT_SERVICES, PLAN_SERVICES, planUsage, loginAccount, addAccount, removeAccount, type PlanUsage } from '../../accounts';
  import type { AccountService, ToolAccount } from '../../types';

  interface Row { key: string; service: string; title: string; from: string; account: ToolAccount | null }
  let usage = $state<Record<string, { data?: PlanUsage; error?: string; busy?: boolean }>>({});
  let adding = $state<{ service: AccountService; name: string } | null>(null);

  const rows = $derived<Row[]>(PLAN_SERVICES.flatMap((s) => [
    { key: s.id, service: s.id, title: s.name, from: s.from, account: null },
    ...app.accounts.filter((a) => a.service === s.id).map((a) => ({ key: `${s.id}@${a.id}`, service: s.id, title: `${s.name} · ${a.name}`, from: 'osobne konto w Hermitty', account: a })),
  ]));

  async function load(r: Row) {
    usage[r.key] = { ...usage[r.key], busy: true };
    try { usage[r.key] = { data: await planUsage(r.service, r.account?.id) }; }
    catch (e) { usage[r.key] = { error: String(e).replace(/^Error: /, '') }; }
  }
  // Limity czytamy raz po otwarciu strony; dalej przycisk „odśwież”.
  let loaded = false;
  $effect(() => { if (!loaded) { loaded = true; for (const r of rows) load(r); } });

  async function confirmAdd() {
    if (!adding) return;
    const acc = addAccount(adding.service, adding.name);
    adding = null;
    await loginAccount(acc.service, acc.id);
    ui.settingsOpen = false;
  }
  function askRemove(a: ToolAccount) {
    ui.confirm = {
      title: `Usunąć konto „${a.name}”?`,
      message: `Zniknie też logowanie ${ACCOUNT_SERVICES[a.service].name} zapisane dla tego konta. Zakładki, które go używały, wrócą do konta domyślnego.`,
      confirmLabel: 'Usuń',
      danger: true,
      resolve: (ok: unknown) => { if (ok) { removeAccount(a); delete usage[`${a.service}@${a.id}`]; } },
    };
  }
  function left(ms: number) {
    if (!ms) return '';
    const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
    return m >= 1440 ? `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h` : m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
  }
  const tone = (p: number) => (p >= 95 ? 'var(--destructive)' : p >= 80 ? 'var(--chart-3)' : 'var(--chart-1)');
</script>

<div class="pagehead"><h2>Konta subskrypcji</h2><div><button class="icobtn" title="Dodaj konto Claude Code albo Codex" onclick={() => (adding = { service: 'claude', name: '' })}><Icon name="plus" /></button></div></div>
<p class="hint">Limity planów (Claude Pro/Max, ChatGPT, Google, Cursor) z logowania narzędzi na tym komputerze. Claude Code i Codex mogą mieć kilka kont, np. prywatne i firmowe: każde ma własne logowanie, a zakładkę terminala przypinasz do konta w jej menu (prawy przycisk → Konto). Konta nie przełączają się same, bo regulaminy usług nie pozwalają omijać limitów planu kilkoma kontami.</p>

{#if adding}
  <div class="form">
    <h3 style="margin:0">Nowe konto</h3>
    <div class="grid2">
      <div class="field"><label for="accSvc">Narzędzie</label>
        <select class="inp" id="accSvc" bind:value={adding.service}>{#each Object.entries(ACCOUNT_SERVICES) as [k, v]}<option value={k}>{v.name}</option>{/each}</select></div>
      <div class="field"><label for="accName">Nazwa</label><input class="inp" id="accName" bind:value={adding.name} placeholder="np. Firma" /></div>
    </div>
    <p class="hint">Po dodaniu otworzy się zakładka z <code>{ACCOUNT_SERVICES[adding.service].login}</code>, gdzie logujesz się na to konto. Logowanie zostaje w folderze konta w danych Hermitty.</p>
    <div class="formbtns"><button class="btn" onclick={() => (adding = null)}>Anuluj</button><button class="btn pri" onclick={confirmAdd}>Dodaj i zaloguj</button></div>
  </div>
{/if}

<div class="list">
  {#each rows as r (r.key)}
    {@const u = usage[r.key]}
    <div class="lrow">
      <div class="picon"><Icon name={r.account ? 'key' : 'spark'} /></div>
      <div class="info">
        <b>{r.title}{#if u?.data?.plan}<span class="chip">{u.data.plan}</span>{/if}</b>
        {#if u?.data?.windows.length}
          <div class="wins">
            {#each u.data.windows as w}
              <div class="win" title="{w.label}: zużyto {Math.round(w.usedPercent)}%{w.resetsAt ? `, reset za ${left(w.resetsAt)}` : ''}">
                <span class="wl">{w.label}</span>
                <span class="bar"><i style:width="{Math.min(100, w.usedPercent)}%" style:background={tone(w.usedPercent)}></i></span>
                <span class="wp">{Math.round(w.usedPercent)}%{#if w.resetsAt}<em>{left(w.resetsAt)}</em>{/if}</span>
              </div>
            {/each}
          </div>
        {:else if u?.error}<small class:err={!/^Brak logowania|nie jest jeszcze zalogowane/.test(u.error)} title={u.error}>{u.error}</small>
        {:else if u?.busy}<small>Sprawdzam…</small>
        {:else}<small>{r.from}</small>{/if}
      </div>
      <div class="acts">
        <button class="icobtn" title="Odśwież limity" disabled={u?.busy} onclick={() => load(r)}><Icon name="refresh" size={14} /></button>
        {#if r.service in ACCOUNT_SERVICES}
          <button class="icobtn" title="Zaloguj w zakładce terminala" onclick={() => { loginAccount(r.service as AccountService, r.account?.id || null); ui.settingsOpen = false; }}><Icon name="term" size={14} /></button>
        {/if}
        {#if r.account}<button class="icobtn del" title="Usuń konto" onclick={() => askRemove(r.account!)}><Icon name="trash" size={14} /></button>{/if}
      </div>
    </div>
  {/each}
</div>

<style>
  .err { color: var(--destructive) !important; white-space: normal !important; }
  .wins { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; max-width: 420px; }
  .win { display: grid; grid-template-columns: 74px 1fr 92px; gap: 8px; align-items: center; font-size: 11.5px; color: var(--muted-foreground); }
  .wl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar { height: 5px; border-radius: 3px; background: var(--muted); overflow: hidden; }
  .bar i { display: block; height: 100%; border-radius: 3px; }
  .wp { font-variant-numeric: tabular-nums; color: var(--foreground); }
  .wp em { font-style: normal; color: var(--muted-foreground); margin-left: 6px; }
</style>
