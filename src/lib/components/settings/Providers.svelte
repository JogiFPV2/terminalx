<script lang="ts">
  // Providerzy jako karty: klucze API (czat przełącza się między nimi przy limicie), domyślny model
  // i konta subskrypcji tej samej firmy z limitami planu (do zakładek terminala, wybierane ręcznie).
  import Icon from '../../Icon.svelte';
  import Accounts from './Accounts.svelte';
  import { app, notify } from '../../state.svelte';
  import { PROVIDER_TYPES, isChat, isMedia, providerIcon } from '../../defaults';
  import { PLAN_SERVICES } from '../../accounts';
  import { listModels, providerKeys, keyLimitedUntil, MAIN_KEY } from '../../ai';
  import { call } from '../../ipc';
  import { nid } from '../../util';
  import type { Provider, ProviderKey } from '../../types';

  const KEY_HINT: Partial<Record<Provider['type'], string>> = { anthropic: 'sk-ant-…', google: 'AIza… (aistudio.google.com)', fal: 'klucz z fal.ai/dashboard/keys', replicate: 'r8_… (replicate.com/account)' };
  /** Subskrypcje tej samej firmy co provider (pokazywane przy pierwszym providerze danego typu). */
  const PLAN_OF: Partial<Record<Provider['type'], string[]>> = { anthropic: ['claude'], openai: ['codex'], google: ['gemini'] };
  const optionalKey = (p: Provider) => p.type === 'ollama' || p.type === 'comfy';

  let edit = $state<Provider | null>(null);
  let isNew = $state(false);
  let key = $state('');
  let modelsText = $state('');
  let status = $state<Record<string, { state: 'testing' | 'ok' | 'error'; msg?: string }>>({});
  let adding = $state<{ pid: string; name: string; value: string } | null>(null);
  // Odliczanie „odpoczywa do …” po limicie klucza.
  let now = $state(Date.now());
  $effect(() => { const t = setInterval(() => (now = Date.now()), 5000); return () => clearInterval(t); });

  $effect(() => {
    // Stan kluczy sprawdzamy w magazynie systemowym, bo zapisany stan aplikacji go nie zna.
    for (const p of app.providers) {
      call<boolean>('secret_has', { keyRef: p.keyRef }).then((h) => { if (p.hasKey !== h) p.hasKey = h; });
      for (const k of p.keys || []) call<boolean>('secret_has', { keyRef: k.keyRef }).then((h) => { if (k.hasKey !== h) k.hasKey = h; });
    }
  });

  const planOf = (p: Provider) => (app.providers.find((x) => x.type === p.type) === p ? PLAN_OF[p.type] || [] : []);
  const otherPlans = $derived(PLAN_SERVICES.map((s) => s.id).filter((id) => !app.providers.some((p) => planOf(p).includes(id))));

  function create() {
    const id = nid('prov');
    edit = { id, type: 'anthropic', name: '', url: PROVIDER_TYPES.anthropic.url, keyRef: `provider:${id}`, hasKey: false, models: [...PROVIDER_TYPES.anthropic.models] };
    isNew = true; key = ''; modelsText = edit.models.join(', ');
  }
  function open(p: Provider) { edit = JSON.parse(JSON.stringify(p)); isNew = false; key = ''; modelsText = p.models.join(', '); }
  function typeChanged() {
    if (!edit) return;
    if (!edit.url || Object.values(PROVIDER_TYPES).some((t) => t.url === edit!.url)) edit.url = PROVIDER_TYPES[edit.type].url;
    if (!modelsText.trim() || isNew) modelsText = PROVIDER_TYPES[edit.type].models.join(', ');
  }
  async function save() {
    if (!edit) return;
    if (!edit.name.trim()) { notify('Podaj nazwę providera.', 'warning'); return; }
    edit.models = modelsText.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      if (key.trim()) { await call('secret_set', { keyRef: edit.keyRef, value: key.trim() }); edit.hasKey = true; }
    } catch (e) { notify(String(e), 'error'); return; }
    if (isNew) app.providers.push(edit);
    else { const i = app.providers.findIndex((p) => p.id === edit!.id); if (i >= 0) app.providers[i] = edit; }
    const id = edit.id;
    edit = null; key = '';
    test(app.providers.find((p) => p.id === id)!);
  }
  async function test(p: Provider) {
    status[p.id] = { state: 'testing' };
    try {
      const models = await listModels(p);
      if (models.length) p.models = p.type === 'anthropic' ? models.filter((m) => m.startsWith('claude')) : models;
      status[p.id] = { state: 'ok', msg: `${models.length} modeli` };
    } catch (e) { status[p.id] = { state: 'error', msg: String(e).replace(/^Error: /, '') }; }
  }
  async function remove(p: Provider) {
    if (p.id === app.defModel.provider) { notify('To domyślny provider. Najpierw wybierz inny domyślny model.', 'warning'); return; }
    for (const k of providerKeys(p)) await call('secret_delete', { keyRef: k.keyRef }).catch(() => {});
    app.providers.splice(app.providers.findIndex((x) => x.id === p.id), 1);
  }

  /* ---------- klucze ---------- */

  async function addKey() {
    const a = adding, p = app.providers.find((x) => x.id === a?.pid);
    if (!a || !p) return;
    if (!a.value.trim()) { notify('Wklej klucz API.', 'warning'); return; }
    // Pierwszy klucz providera bez klucza trafia na miejsce głównego.
    if (!p.hasKey) {
      try { await call('secret_set', { keyRef: p.keyRef, value: a.value.trim() }); } catch (e) { notify(String(e), 'error'); return; }
      p.hasKey = true;
      if (a.name.trim()) p.keyName = a.name.trim();
    } else {
      const id = nid('k').toLowerCase().replace(/[^a-z0-9]/g, '');
      const k: ProviderKey = { id, name: a.name.trim() || `Klucz ${providerKeys(p).length + 1}`, keyRef: `provider:${p.id}:${id}`, hasKey: true };
      try { await call('secret_set', { keyRef: k.keyRef, value: a.value.trim() }); } catch (e) { notify(String(e), 'error'); return; }
      (p.keys ||= []).push(k);
    }
    adding = null;
  }
  async function removeKey(p: Provider, k: ProviderKey) {
    await call('secret_delete', { keyRef: k.keyRef }).catch(() => {});
    if (k.id === MAIN_KEY) { p.hasKey = false; return; }
    p.keys = (p.keys || []).filter((x) => x.id !== k.id);
    // Agenci i rozmowy przypięte do usuniętego klucza wracają do „automatycznie”.
    for (const a of app.agents) if (a.provider === p.id && a.key === k.id) a.key = null;
    for (const w of app.workspaces) if (w.chatModel?.provider === p.id && w.chatModel.key === k.id) w.chatModel.key = null;
  }
  function rename(p: Provider, k: ProviderKey, name: string) {
    if (k.id === MAIN_KEY) p.keyName = name.trim() || undefined;
    else { const x = p.keys?.find((y) => y.id === k.id); if (x) x.name = name.trim() || x.name; }
  }
  const clock = (t: number) => { const d = new Date(t); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const allModels = $derived(app.providers.filter(isChat).flatMap((p) => p.models.map((m) => ({ p, m }))));
</script>

<div class="pagehead"><h2>Konta i providerzy</h2><div><button class="icobtn" title="Dodaj providera" onclick={create}><Icon name="plus" /></button></div></div>
<p class="hint">Provider może mieć kilka kluczy API, np. prywatny i firmowy. W czacie i profilu agenta wybierasz provider, klucz (albo „automatycznie”) i model. Przy „automatycznie” klucz z limitem albo bez środków odpoczywa minutę, a zapytanie idzie następnym kluczem. Klucze leżą w Menedżerze poświadczeń Windows; agenci i pluginy ich nie widzą. Konta subskrypcji (Claude Code, Codex) służą zakładkom terminala, wybierasz je ręcznie i nie przełączają się same.</p>

<div class="field" style="max-width:440px">
  <label for="defModel">Domyślny model (agenci, snippety i nody bez własnego wyboru)</label>
  <select class="inp" id="defModel" value="{app.defModel.provider}|{app.defModel.model}"
    onchange={(e) => { const [p, ...m] = e.currentTarget.value.split('|'); app.defModel = { provider: p, model: m.join('|') }; }}>
    {#each allModels as { p, m }}<option value="{p.id}|{m}">{m} · {p.name}</option>{/each}
  </select>
</div>

{#if edit}
  <div class="form">
    <h3 style="margin:0">{isNew ? 'Nowy provider' : 'Edytuj providera'}</h3>
    <div class="grid2">
      <div class="field"><label for="pType">Typ</label>
        <select class="inp" id="pType" bind:value={edit.type} onchange={typeChanged}>{#each Object.entries(PROVIDER_TYPES) as [k, v]}<option value={k}>{v.label}</option>{/each}</select></div>
      <div class="field"><label for="pName">Nazwa</label><input class="inp" id="pName" bind:value={edit.name} placeholder="np. Anthropic" /></div>
      <div class="field"><label for="pUrl">Adres API</label><input class="inp" id="pUrl" bind:value={edit.url} spellcheck="false" /></div>
      <div class="field"><label for="pKey">{isNew ? 'Klucz API' : 'Klucz główny'} {optionalKey(edit) ? '(opcjonalny)' : ''}</label>
        <input class="inp" id="pKey" type="password" autocomplete="off" bind:value={key} placeholder={edit.hasKey ? 'zapisany; zostaw puste, żeby nie zmieniać' : KEY_HINT[edit.type] || 'sk-…'} /></div>
    </div>
    {#if isChat(edit)}<div class="field"><label for="pModels">Modele czatu (po przecinku)</label><input class="inp" id="pModels" bind:value={modelsText} placeholder="uzupełnią się po teście połączenia" /></div>{/if}
    {#if edit.type === 'comfy'}<p class="hint">Modele i instalacja: Ustawienia → Lokalne AI. Adres możesz zmienić na inny komputer z ComfyUI w sieci.</p>
    {:else if isMedia(edit)}<p class="hint">Grafika i wideo: model wybierasz w nodzie workflow (podpowiedzi: {[...(PROVIDER_TYPES[edit.type].media?.image || []).slice(0, 2), ...(PROVIDER_TYPES[edit.type].media?.video || []).slice(0, 1)].join(', ')}…).</p>{/if}
    {#if !isNew}<p class="hint">Kolejne klucze dodajesz na karcie providera (+ przy „Klucze API”).</p>{/if}
    <div class="formbtns"><button class="btn" onclick={() => (edit = null)}>Anuluj</button><button class="btn pri" onclick={save}>Zapisz</button></div>
  </div>
{/if}

{#each app.providers as p (p.id)}
  {@const s = status[p.id]}
  {@const keys = providerKeys(p)}
  {@const shownKeys = keys.filter((k) => k.hasKey)}
  <div class="pcard">
    <div class="lrow">
      <div class="picon"><Icon name={providerIcon(p)} /></div>
      <div class="info"><b>{p.name} <span class="chip">{PROVIDER_TYPES[p.type].label}</span></b><small class="mono">{p.url}</small>
        {#if s?.state === 'error'}<small class="err" title={s.msg}>{s.msg}</small>{/if}</div>
      {#if isChat(p) && p.models.length}
        <select class="inp defm" title="Domyślny model tego providera (gdy wybierasz sam provider)" bind:value={p.defModel}>
          <option value={undefined}>{p.models[0]} (pierwszy)</option>
          {#each p.models.slice(1) as m}<option value={m}>{m}</option>{/each}
        </select>
      {/if}
      <div class="meta caps">
        {#if isChat(p)}<span title="Czat: {p.models.length} modeli"><Icon name="spark" size={13} /></span>{/if}
        {#if PROVIDER_TYPES[p.type].media?.image}<span title="Grafika"><Icon name="image" size={13} /></span>{/if}
        {#if PROVIDER_TYPES[p.type].media?.video}<span title="Wideo"><Icon name="film" size={13} /></span>{/if}
        <span class="dot" title={s?.state === 'testing' ? 'Testuję…' : s?.state === 'ok' ? `Połączono (${s.msg})` : s?.state === 'error' ? 'Błąd' : p.hasKey ? 'Klucz zapisany' : optionalKey(p) ? 'Bez klucza' : 'Brak klucza'}
          style:background={s?.state === 'error' ? 'var(--destructive)' : s?.state === 'testing' ? 'var(--chart-3)' : p.hasKey || optionalKey(p) ? 'var(--chart-1)' : 'var(--chart-3)'}></span>
      </div>
      <div class="acts">
        <button class="icobtn" title="Testuj połączenie i pobierz listę modeli" onclick={() => test(p)}><Icon name="refresh" size={14} /></button>
        <button class="icobtn" title="Edytuj" onclick={() => open(p)}><Icon name="edit" size={14} /></button>
        <button class="icobtn del" title="Usuń providera" onclick={() => remove(p)}><Icon name="trash" size={14} /></button>
      </div>
    </div>

    <div class="psub">
      <span class="sublabel">Klucze API{#if shownKeys.length > 1} · przełączanie przy limicie{/if}</span>
      <button class="icobtn sm" title="Dodaj klucz API" onclick={() => (adding = { pid: p.id, name: '', value: '' })}><Icon name="plus" size={13} /></button>
    </div>
    {#each shownKeys as k (k.id)}
      {@const until = (void now, keyLimitedUntil(p.id, k.id))}
      <div class="krow">
        <span class="kico"><Icon name="key" size={13} /></span>
        <div class="info">
          <input class="kname" value={k.name} aria-label="Nazwa klucza" spellcheck="false" onchange={(e) => rename(p, k, e.currentTarget.value)} />
          <small>{until > now ? `limit albo brak środków · odpoczywa do ${clock(until)}` : k.id === MAIN_KEY ? 'klucz główny (także grafika, głos i saldo)' : 'zapisany'}</small>
        </div>
        <div class="acts"><button class="icobtn del" title="Usuń klucz" onclick={() => removeKey(p, k)}><Icon name="trash" size={14} /></button></div>
      </div>
    {:else}
      {#if !adding || adding.pid !== p.id}<div class="krow"><small class="hint">{optionalKey(p) ? 'Bez klucza (lokalnie).' : 'Brak klucza. Dodaj go przyciskiem +.'}</small></div>{/if}
    {/each}
    {#if adding?.pid === p.id}
      <div class="form">
        <div class="grid2">
          <div class="field"><label for="kName">Nazwa</label><input class="inp" id="kName" bind:value={adding.name} placeholder={p.hasKey ? 'np. Firma' : 'np. Prywatny'} /></div>
          <div class="field"><label for="kVal">Klucz</label><input class="inp" id="kVal" type="password" autocomplete="off" bind:value={adding.value} placeholder={KEY_HINT[p.type] || 'sk-…'} /></div>
        </div>
        <div class="formbtns"><button class="btn" onclick={() => (adding = null)}>Anuluj</button><button class="btn pri" onclick={addKey}>Zapisz klucz</button></div>
      </div>
    {/if}

    <Accounts only={planOf(p)} />
  </div>
{/each}

{#if otherPlans.length}
  <div class="pcard">
    <div class="lrow">
      <div class="picon"><Icon name="activity" /></div>
      <div class="info"><b>Inne subskrypcje</b><small>Narzędzia bez providera API w aplikacji: limity planu z logowania na tym komputerze.</small></div>
    </div>
    <Accounts only={otherPlans} />
  </div>
{/if}

<style>
  .err { color: var(--destructive) !important; white-space: normal !important; }
  .caps { color: var(--muted-foreground); gap: 8px !important; }
  .caps > span { display: grid; }
  .defm { width: auto; max-width: 200px; font-size: 12px; padding: 3px 6px; font-family: var(--font-mono); }
  .kname { font: inherit; font-size: 12.5px; font-weight: 500; color: var(--foreground); background: none; border: 1px solid transparent; border-radius: 5px; padding: 1px 4px; margin-left: -5px; max-width: 260px; }
  .kname:hover { border-color: var(--border); }
  .kname:focus { border-color: var(--primary); outline: none; background: var(--background); }
</style>
