<script lang="ts">
  import Icon from '../../Icon.svelte';
  import { app, notify } from '../../state.svelte';
  import { PROVIDER_TYPES, isChat, isMedia } from '../../defaults';
  import { listModels } from '../../ai';
  import { call } from '../../ipc';
  import { nid } from '../../util';
  import type { Provider } from '../../types';

  const KEY_HINT: Partial<Record<Provider['type'], string>> = { anthropic: 'sk-ant-…', google: 'AIza… (aistudio.google.com)', fal: 'klucz z fal.ai/dashboard/keys', replicate: 'r8_… (replicate.com/account)' };
  let edit = $state<Provider | null>(null);
  let isNew = $state(false);
  let key = $state('');
  let modelsText = $state('');
  let status = $state<Record<string, { state: 'testing' | 'ok' | 'error'; msg?: string }>>({});

  $effect(() => {
    // Stan klucza sprawdzamy w magazynie systemowym, bo zapisany stan aplikacji go nie zna.
    for (const p of app.providers) call<boolean>('secret_has', { keyRef: p.keyRef }).then((h) => { if (p.hasKey !== h) p.hasKey = h; });
  });

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
    await call('secret_delete', { keyRef: p.keyRef }).catch(() => {});
    app.providers.splice(app.providers.findIndex((x) => x.id === p.id), 1);
  }
  async function forgetKey(p: Provider) { await call('secret_delete', { keyRef: p.keyRef }).catch(() => {}); p.hasKey = false; }
  const allModels = $derived(app.providers.filter(isChat).flatMap((p) => p.models.map((m) => ({ p, m }))));
</script>

<div class="pagehead"><h2>Providerzy AI</h2><div><button class="icobtn" title="Dodaj providera" onclick={create}><Icon name="plus" /></button></div></div>
<p class="hint">Klucze API trafiają do Menedżera poświadczeń Windows, nie do plików. Agenci, snippety, workflow i pluginy z uprawnieniem <code>ai:invoke</code> korzystają z providerów, ale nigdy nie dostają samych kluczy.</p>

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
      <div class="field"><label for="pName">Nazwa</label><input class="inp" id="pName" bind:value={edit.name} placeholder="np. Anthropic praca" /></div>
      <div class="field"><label for="pUrl">Adres API</label><input class="inp" id="pUrl" bind:value={edit.url} spellcheck="false" /></div>
      <div class="field"><label for="pKey">Klucz API {edit.type === 'ollama' || edit.type === 'comfy' ? '(opcjonalny)' : ''}</label>
        <input class="inp" id="pKey" type="password" autocomplete="off" bind:value={key} placeholder={edit.hasKey ? 'zapisany; zostaw puste, żeby nie zmieniać' : KEY_HINT[edit.type] || 'sk-…'} /></div>
    </div>
    {#if isChat(edit)}<div class="field"><label for="pModels">Modele czatu (po przecinku)</label><input class="inp" id="pModels" bind:value={modelsText} placeholder="uzupełnią się po teście połączenia" /></div>{/if}
    {#if edit.type === 'comfy'}<p class="hint">Modele i instalacja: Ustawienia → Lokalne AI. Adres możesz zmienić na inny komputer z ComfyUI w sieci.</p>
    {:else if isMedia(edit)}<p class="hint">Grafika i wideo: model wybierasz w nodzie workflow (podpowiedzi: {[...(PROVIDER_TYPES[edit.type].media?.image || []).slice(0, 2), ...(PROVIDER_TYPES[edit.type].media?.video || []).slice(0, 1)].join(', ')}…).</p>{/if}
    <div class="formbtns"><button class="btn" onclick={() => (edit = null)}>Anuluj</button><button class="btn pri" onclick={save}>Zapisz</button></div>
  </div>
{/if}

<div class="list">
  {#each app.providers as p (p.id)}
    {@const s = status[p.id]}
    <div class="lrow">
      <div class="picon"><Icon name={p.type === 'ollama' || p.type === 'comfy' ? 'cpu' : 'key'} /></div>
      <div class="info"><b>{p.name} <span class="chip">{PROVIDER_TYPES[p.type].label}</span></b><small class="mono">{p.url}</small>
        {#if s?.state === 'error'}<small class="err" title={s.msg}>{s.msg}</small>{/if}</div>
      <div class="meta caps">
        {#if isChat(p)}<span title="Czat: {p.models.length} modeli"><Icon name="spark" size={13} /></span>{/if}
        {#if PROVIDER_TYPES[p.type].media?.image}<span title="Grafika"><Icon name="image" size={13} /></span>{/if}
        {#if PROVIDER_TYPES[p.type].media?.video}<span title="Wideo"><Icon name="film" size={13} /></span>{/if}
        <span class="dot" title={s?.state === 'testing' ? 'Testuję…' : s?.state === 'ok' ? 'Połączono' : s?.state === 'error' ? 'Błąd' : p.hasKey ? 'Klucz zapisany' : p.type === 'ollama' || p.type === 'comfy' ? 'Bez klucza' : 'Brak klucza'}
          style:background={s?.state === 'error' ? 'var(--destructive)' : s?.state === 'testing' ? 'var(--chart-3)' : p.hasKey || p.type === 'ollama' || p.type === 'comfy' ? 'var(--chart-1)' : 'var(--chart-3)'}></span>
      </div>
      <div class="acts">
        <button class="icobtn" title="Testuj połączenie" onclick={() => test(p)}><Icon name="refresh" size={14} /></button>
        {#if p.hasKey}<button class="icobtn" title="Usuń zapisany klucz" onclick={() => forgetKey(p)}><Icon name="key" size={14} /></button>{/if}
        <button class="icobtn" title="Edytuj" onclick={() => open(p)}><Icon name="edit" size={14} /></button>
        <button class="icobtn del" title="Usuń" onclick={() => remove(p)}><Icon name="trash" size={14} /></button>
      </div>
    </div>
  {/each}
</div>

<style>
  .err { color: var(--destructive) !important; white-space: normal !important; }
  .caps { color: var(--muted-foreground); gap: 8px !important; }
  .caps > span { display: grid; }
</style>
