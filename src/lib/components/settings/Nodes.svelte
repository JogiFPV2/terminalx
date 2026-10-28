<script lang="ts">
  import Icon from '../../Icon.svelte';
  import { app, notify } from '../../state.svelte';
  import { NODE_CATS, CAT_COLOR, BUILTIN_NODES, isChat } from '../../defaults';
  import { aiDefaults } from '../../workflow/engine.svelte';
  import { MEDIA_DEFAULTS, ASPECTS, mediaProviders, modelHints, isVideoOp } from '../../workflow/media';
  import { nid } from '../../util';
  import type { NodeTypeDef, AiCfg } from '../../types';

  const ICONS = ['spark', 'shield', 'bot', 'braces', 'filter', 'list', 'globe', 'term', 'book', 'bell', 'eye', 'branch', 'image', 'wand', 'film', 'clapper', 'scissors', 'maximize'];
  const KINDS: [string, string][] = [['', 'Tekst (AI)'], ['image', 'Tekst → obraz'], ['edit', 'Edycja obrazu'], ['video', 'Tekst → wideo'], ['i2v', 'Obraz → wideo'], ['upscale', 'Powiększenie'], ['rmbg', 'Usunięcie tła']];
  let edit = $state<(NodeTypeDef & { defaults: AiCfg & Record<string, any> }) | null>(null);
  let isNew = $state(false);
  const models = (pid: string) => app.providers.find((p) => p.id === pid)?.models || [];
  function path(id: string): string { const parts: string[] = []; let n = app.prompts.find((p) => p.id === id); while (n) { parts.unshift(n.name); n = n.parent ? app.prompts.find((p) => p.id === n!.parent) : undefined; } return parts.join(' / '); }

  function create() { edit = { id: 'c-' + nid(), cat: 'Własne', name: '', icon: 'spark', desc: '', ai: true, custom: true, defaults: aiDefaults({}) }; isNew = true; }
  function open(t: NodeTypeDef) { edit = { ...JSON.parse(JSON.stringify(t)), defaults: { ...(t.media ? MEDIA_DEFAULTS : aiDefaults({})), ...(t.defaults || {}) } as any }; isNew = false; }
  function kindChanged() {
    if (!edit) return;
    if (edit.media) { edit.ai = false; edit.defaults = { ...MEDIA_DEFAULTS, base: edit.defaults.base, prompt: edit.defaults.prompt, aspect: isVideoOp(edit.media) ? '16:9' : '1:1' } as any; if (edit.icon === 'spark') edit.icon = isVideoOp(edit.media) ? 'film' : 'image'; }
    else { delete edit.media; edit.ai = true; edit.defaults = { ...aiDefaults({}), base: edit.defaults.base, prompt: edit.defaults.prompt }; }
  }
  function save() {
    if (!edit) return;
    if (!edit.name.trim()) { notify('Podaj nazwę noda.', 'warning'); return; }
    if (!edit.defaults.provider && !edit.media) edit.defaults.model = '';
    if (!edit.media) delete edit.media;
    if (isNew) app.nodeTypes.push(edit);
    else { const i = app.nodeTypes.findIndex((t) => t.id === edit!.id); if (i >= 0) app.nodeTypes[i] = edit; }
    edit = null;
  }
</script>

<div class="pagehead"><h2>Nody</h2><div><button class="icobtn" title="Nowy node" onclick={create}><Icon name="plus" /></button></div></div>
<p class="hint">Własne nody pojawiają się w palecie workflow w wybranej kategorii. Prompt bazowy jest opcjonalny; prompt własny dopisuje się po nim, a <code>{'{{input}}'}</code> to wynik poprzedniego noda. Te ustawienia są domyślne dla każdego nowego wystąpienia i można je zmienić na kanwie.</p>

{#if edit}
  <div class="form">
    <h3 style="margin:0">{isNew ? 'Nowy node' : 'Edytuj node'}</h3>
    <div class="grid2">
      <div class="field"><label for="tName">Nazwa</label><input class="inp" id="tName" bind:value={edit.name} placeholder="np. Ocena PR" /></div>
      <div class="field"><label for="tCat">Kategoria</label><select class="inp" id="tCat" bind:value={edit.cat}>{#each NODE_CATS as c}<option>{c}</option>{/each}</select></div>
      <div class="field"><label for="tIcon">Ikona</label><select class="inp" id="tIcon" bind:value={edit.icon}>{#each ICONS as i}<option>{i}</option>{/each}</select></div>
      <div class="field"><label for="tDesc">Opis</label><input class="inp" id="tDesc" bind:value={edit.desc} placeholder="Co robi ten node" /></div>
      <div class="field"><label for="tKind">Rodzaj</label><select class="inp" id="tKind" bind:value={edit.media} onchange={kindChanged}>{#each KINDS as [v, l]}<option value={v}>{l}</option>{/each}</select></div>
    </div>
    <div class="field"><label for="tBase">Prompt bazowy (opcjonalnie)</label>
      <select class="inp" id="tBase" bind:value={edit.defaults.base}><option value="">— brak —</option>{#each app.prompts.filter((p) => p.type === 'prompt') as p}<option value={p.id}>{path(p.id)}</option>{/each}</select></div>
    <div class="field"><label for="tPrompt">Prompt własny</label><textarea class="inp" id="tPrompt" bind:value={edit.defaults.prompt} placeholder={'Doprecyzowanie albo cały prompt. {{input}} to wynik poprzedniego noda.'}></textarea></div>
    {#if edit.media}
      {@const op = edit.media}
      {@const prov = mediaProviders().find((p) => p.id === edit!.defaults.provider) || mediaProviders()[0]}
      <div class="grid2">
        <div class="field"><label for="tmProv">Provider</label>
          <select class="inp" id="tmProv" bind:value={edit.defaults.provider}><option value="">Automatycznie</option>{#each mediaProviders() as p}<option value={p.id}>{p.name}</option>{/each}</select></div>
        <div class="field"><label for="tmModel">Model</label><input class="inp" id="tmModel" list="tmModels" bind:value={edit.defaults.model} placeholder={modelHints(prov, op)[0] || 'id modelu'} spellcheck="false" />
          <datalist id="tmModels">{#each modelHints(prov, op) as m}<option value={m}></option>{/each}</datalist></div>
      </div>
      <div class="grid2">
        <div class="field"><label for="tmAsp">Proporcje</label><select class="inp" id="tmAsp" bind:value={edit.defaults.aspect}>{#each ASPECTS as a}<option>{a}</option>{/each}</select></div>
        <div class="field"><label for="tmN">Liczba wyników</label><input class="inp" id="tmN" type="number" min="1" max="8" bind:value={edit.defaults.n} /></div>
      </div>
      <div class="field"><label for="tmPar">Parametry modelu (JSON)</label><input class="inp" id="tmPar" bind:value={edit.defaults.params} placeholder={'{"guidance_scale": 3.5}'} spellcheck="false" /></div>
    {:else}
    <div class="grid2">
      <div class="field"><label for="tProv">Provider</label>
        <select class="inp" id="tProv" bind:value={edit.defaults.provider} onchange={() => (edit!.defaults.model = models(edit!.defaults.provider)[0] || '')}>
          <option value="">Domyślny</option>{#each app.providers.filter(isChat) as p}<option value={p.id}>{p.name}</option>{/each}</select></div>
      <div class="field"><label for="tModel">Model</label>
        <select class="inp" id="tModel" bind:value={edit.defaults.model} disabled={!edit.defaults.provider}>
          {#if !edit.defaults.provider}<option value="">{app.defModel.model}</option>{/if}
          {#each models(edit.defaults.provider) as m}<option value={m}>{m}</option>{/each}</select></div>
    </div>
    <div class="grid4">
      <div class="field"><label for="tTemp">Temperatura</label><input class="inp" id="tTemp" type="number" min="0" max="1" step="0.1" bind:value={edit.defaults.temperature} /></div>
      <div class="field"><label for="tMax">Maks. tokenów</label><input class="inp" id="tMax" type="number" min="64" step="64" bind:value={edit.defaults.maxTokens} /></div>
      <div class="field"><label for="tTopP">Top-p</label><input class="inp" id="tTopP" type="number" min="0" max="1" step="0.05" bind:value={edit.defaults.topP} /></div>
      <div class="field"><label for="tRes">Liczba wyników</label><input class="inp" id="tRes" type="number" min="1" max="10" bind:value={edit.defaults.results} /></div>
    </div>
    <small class="hint">Temperatura i top-p działają u providerów zgodnych z OpenAI; modele Claude dobierają je same.</small>
    <div class="field"><span class="flabel">Format wyniku</span><div class="seg">
      {#each [['text', 'Tekst'], ['json', 'JSON'], ['list', 'Lista']] as [v, l]}<button class:on={edit.defaults.format === v} onclick={() => (edit!.defaults.format = v as any)}>{l}</button>{/each}</div></div>
    {/if}
    <div class="formbtns"><button class="btn" onclick={() => (edit = null)}>Anuluj</button><button class="btn pri" onclick={save}>Zapisz</button></div>
  </div>
{/if}

<div><h3>Własne nody ({app.nodeTypes.length})</h3>
  <div class="list">
    {#each app.nodeTypes as t (t.id)}
      <div class="lrow">
        <div class="picon" style:color={CAT_COLOR[t.cat]}><Icon name={t.icon} /></div>
        <div class="info"><b>{t.name} <span class="chip">{t.cat}</span></b><small>{t.desc || ''}{t.defaults?.base ? ` · bazowy: ${path(t.defaults.base)}` : ''}</small></div>
        <div class="meta"><span class="chip pri">{t.defaults?.model || (t.media ? 'model automatyczny' : 'domyślny model')}</span><span class="chip">×{(t.media ? t.defaults?.n : t.defaults?.results) || 1}</span></div>
        <div class="acts"><button class="icobtn" title="Edytuj" onclick={() => open(t)}><Icon name="edit" size={14} /></button>
          <button class="icobtn del" title="Usuń" onclick={() => app.nodeTypes.splice(app.nodeTypes.findIndex((x) => x.id === t.id), 1)}><Icon name="trash" size={14} /></button></div>
      </div>
    {:else}
      <div class="lrow"><span class="hint">Brak. Kliknij „Nowy node” albo „Zapisz jako własny” w ustawieniach noda na kanwie.</span></div>
    {/each}
  </div>
</div>
<div><h3>Wbudowane ({BUILTIN_NODES.length} w {NODE_CATS.length - 1} kategoriach)</h3>
  <div class="list">
    {#each NODE_CATS.filter((c) => c !== 'Własne') as c}
      <div class="lrow"><span class="badge" style:--c={CAT_COLOR[c]} style="min-width:80px;text-align:center">{c}</span>
        <div class="info"><small style="white-space:normal">{BUILTIN_NODES.filter((t) => t.cat === c).map((t) => t.name).join(' · ')}</small></div></div>
    {/each}
  </div>
</div>

<style> .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; } </style>
