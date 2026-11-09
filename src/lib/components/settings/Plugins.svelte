<script lang="ts">
  import Icon from '../../Icon.svelte';
  import { app, ui } from '../../state.svelte';
  import { plug, record, configOf, setEnabled, setConfig, resetConfig, pickAndInspect, install, uninstall, isEnabled, emit, KNOWN_PERMS, type ImportReview } from '../../plugins/host.svelte';
  import { notify } from '../../state.svelte';

  let review = $state<ImportReview | null>(null);
  let err = $state('');
  let cfgOpen = $state<string | null>(null);

  async function startImport() {
    err = '';
    try { review = await pickAndInspect(); }
    catch (e) { const m = String(e).replace(/^Error: ?/, ''); if (m) err = `Nie zaimportowano pluginu. ${m}`; }
  }
  async function doInstall() {
    if (!review) return;
    try { await install(review); notify(`Zainstalowano „${review.manifest.name}”. Włącz go przełącznikiem.`, 'success'); review = null; }
    catch (e) { err = String(e); }
  }
  const order = $derived([...plug.loaded].sort((a, b) => app.plugins.findIndex((r) => r.id === a.manifest.id) - app.plugins.findIndex((r) => r.id === b.manifest.id)));
  const SAMPLE = `{
  "id": "acme.hello",
  "name": "Hello",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "main.js",
  "permissions": ["ui:sidebar", "storage"],
  "contributes": { "sidebar": [{ "id": "hello", "title": "Hello", "icon": "puzzle" }] },
  "config": { "greeting": "Cześć!" }
}`;
</script>

<div class="pagehead"><h2>Pluginy</h2><div><button class="icobtn" title="Importuj plugin (.zip)" onclick={startImport}><Icon name="upload" /></button></div></div>
<p class="hint">Plugin to folder spakowany do .zip z plikiem <code>plugin.json</code>. Manifest określa, co plugin dodaje i jakich uprawnień potrzebuje. Pluginy działają w izolacji i nie mają dostępu do haseł, kluczy API, magazynu poświadczeń ani do tego, co wpisujesz w terminalu.</p>
{#if err}<div class="err-box">{err}</div>{/if}

{#if review}
  <div class="review">
    <b>Zainstalować „{review.manifest.name}” {review.manifest.version}?</b>
    <span class="hint">{review.manifest.description || ''} · autor: {review.manifest.author || 'nieznany'} · {review.files} plik(ów)</span>
    <div><h3>Wymagane uprawnienia</h3>
      <div class="meta">{#each review.manifest.permissions as p}{@const k = KNOWN_PERMS[p]}<span class="chip" class:warn={k?.risk === 2}>{#if k?.risk === 2}<Icon name="shield" size={11} />{/if}{k?.label || p}</span>{:else}<span class="chip">brak</span>{/each}</div></div>
    <div class="formbtns"><button class="btn" onclick={() => (review = null)}>Anuluj</button><button class="btn pri" onclick={doInstall}>Zainstaluj</button></div>
  </div>
{/if}

<div class="list">
  {#each order as p (p.manifest.id)}
    {@const r = record(p.manifest.id)}
    {@const cfg = configOf(p.manifest.id)}
    <div class="lrow">
      <div class="picon"><Icon name={p.manifest.icon || 'puzzle'} /></div>
      <div class="info"><b>{p.manifest.name} <span class="chip">{p.manifest.version}</span>{#if p.builtin}<span class="chip">wbudowany</span>{/if}
        {#if plug.crashed[p.manifest.id]}<span class="chip bad" title={plug.crashed[p.manifest.id]}>błąd</span>{/if}</b>
        <small>{p.manifest.description || ''}</small></div>
      <div class="acts">
        {#if p.manifest.contributes?.settingsCommand && isEnabled(p.manifest.id)}<button class="btn ghost" onclick={() => { ui.settingsOpen = false; emit(p.manifest.id, 'command', { id: p.manifest.contributes!.settingsCommand }); }}>Ustawienia</button>{/if}
        {#if Object.keys(p.manifest.config || {}).length}<button class="btn ghost" onclick={() => (cfgOpen = cfgOpen === p.manifest.id ? null : p.manifest.id)}>{cfgOpen === p.manifest.id ? 'Zwiń' : 'Konfiguracja'}</button>{/if}
        {#if !p.builtin}<button class="icobtn del" title="Odinstaluj (dane zostają)" onclick={() => uninstall(p.manifest.id)}><Icon name="trash" size={14} /></button>{/if}
        <button class="switch" class:on={r?.enabled} role="switch" aria-checked={!!r?.enabled} aria-label="Włącz {p.manifest.name}" onclick={() => setEnabled(p.manifest.id, !r?.enabled)}></button>
      </div>
      <div class="meta perms">{#each p.manifest.permissions as perm}{@const k = KNOWN_PERMS[perm]}<span class="chip" class:warn={k?.risk === 2}>{#if k?.risk === 2}<Icon name="shield" size={11} />{/if}{k?.label || perm}</span>{/each}</div>
      {#if cfgOpen === p.manifest.id}
        <div class="cfg">
          {#each Object.entries(p.manifest.config || {}) as [k, def]}
            {#if typeof def === 'boolean'}
              <label class="checks"><input type="checkbox" checked={!!cfg[k]} onchange={(e) => setConfig(p.manifest.id, k, e.currentTarget.checked)} />{k}</label>
            {:else}
              <div class="field"><label for="cfg-{p.manifest.id}-{k}">{k}</label>
                <input class="inp" id="cfg-{p.manifest.id}-{k}" type={typeof def === 'number' ? 'number' : 'text'} value={cfg[k]}
                  onchange={(e) => setConfig(p.manifest.id, k, typeof def === 'number' ? +e.currentTarget.value : e.currentTarget.value)} /></div>
            {/if}
          {/each}
          <div class="formbtns" style="grid-column:1/-1"><button class="btn ghost" onclick={() => resetConfig(p.manifest.id)}>Przywróć domyślne</button></div>
        </div>
      {/if}
    </div>
  {/each}
</div>
<details><summary>Format plugin.json</summary><pre class="code">{SAMPLE}</pre>
  <p class="hint" style="margin-top:8px">Struktura archiwum: <code>plugin.json</code>, <code>main.js</code> (moduł ES z <code>activate(tx)</code>), opcjonalnie inne pliki. Pełna specyfikacja: <code>docs/PLUGINS.md</code>, typy API: <code>plugins/sdk/hermitty-plugin.d.ts</code>.</p></details>

<style>
  .review { border: 1px solid color-mix(in oklab, var(--primary-ink) 45%, var(--border)); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 10px; background: color-mix(in oklab, var(--primary) 5%, var(--background)); }
  .perms { width: 100%; padding-left: 44px; }
  .cfg { width: 100%; padding: 6px 0 0 44px; display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; align-items: end; }
  details summary { cursor: pointer; font-size: 12px; font-weight: 500; }
  details[open] summary { margin-bottom: 8px; }
</style>
