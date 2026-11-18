<script lang="ts">
  // Dostawca AI agenta na telefonie: rodzaj, adres, klucz API (do sejfu) i model z listy dostawcy.
  import { AG, KINDS, saveCfg, setKey, listModels, type Kind } from '../lib/agent.svelte';
  import { toast, msg } from '../lib/store.svelte';

  let key = $state('');
  let models = $state<string[]>([]);
  let loading = $state(false);
  const kind = $derived(KINDS.find((k) => k.id === AG.cfg.kind)!);

  function pick(id: Kind) {
    if (AG.cfg.kind === id) return;
    AG.cfg.kind = id; AG.cfg.url = KINDS.find((k) => k.id === id)!.url; AG.cfg.model = ''; models = [];
    saveCfg();
  }
  async function saveKey() {
    try { await setKey(key); key = ''; toast(AG.hasKey ? 'Klucz zapisany w sejfie telefonu' : 'Usunięto klucz'); } catch (e) { toast(msg(e)); }
  }
  async function load() {
    loading = true;
    try { models = await listModels(); if (!models.length) toast('Dostawca nie zwrócił żadnych modeli'); } catch (e) { toast(msg(e)); } finally { loading = false; }
  }
</script>

<div class="field"><span class="lbl">Dostawca</span>
  <div class="chips">{#each KINDS as k}<button class:on={AG.cfg.kind === k.id} onclick={() => pick(k.id)}>{k.name}</button>{/each}</div></div>

<div class="field"><label for="au">Adres API</label>
  <input id="au" class="inp mono" bind:value={AG.cfg.url} onchange={saveCfg} autocapitalize="off" spellcheck="false" inputmode="url" />
  {#if AG.cfg.kind === 'ollama' || AG.cfg.kind === 'custom'}<small class="muted">Adres komputera w sieci lokalnej, nie localhost (to byłby sam telefon).</small>{/if}</div>

<div class="field"><label for="ak">Klucz API{kind.key ? '' : ' (opcjonalny)'}</label>
  <div class="row"><input id="ak" class="inp" type="password" bind:value={key} placeholder={AG.hasKey ? 'zapisany, wpisz nowy, by zmienić' : ''} autocomplete="off" />
    <button class="btn sm" disabled={!key && !AG.hasKey} onclick={saveKey}>{key ? 'Zapisz' : 'Usuń'}</button></div>
  <small class="muted">Klucz trafia do sejfu telefonu (Android Keystore).</small></div>

<div class="field"><label for="am">Model</label>
  <div class="row">
    {#if models.length}
      <select id="am" class="inp mono" bind:value={AG.cfg.model} onchange={saveCfg}><option value="" disabled>wybierz…</option>{#each models as m}<option value={m}>{m}</option>{/each}</select>
    {:else}
      <input id="am" class="inp mono" bind:value={AG.cfg.model} onchange={saveCfg} placeholder="pobierz listę albo wpisz" autocapitalize="off" spellcheck="false" />
    {/if}
    <button class="btn sm" disabled={loading} onclick={load}>{loading ? 'Pobieram…' : 'Pobierz listę'}</button>
  </div></div>

<style>
  .field { display: grid; gap: 6px; margin-bottom: 16px; }
  label, .lbl { font-size: 13px; color: var(--muted-foreground); }
  small { font-size: 12.5px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chips button { border: 0; border-radius: 999px; padding: 8px 14px; min-height: 40px; background: var(--muted); }
  .chips button.on { background: var(--foreground); color: var(--background); }
  .row { display: flex; gap: 8px; align-items: center; }
  .row .inp { flex: 1; min-width: 0; }
  .row .btn { flex: none; }
</style>
