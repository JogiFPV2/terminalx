<script lang="ts">
  import Icon from '../../Icon.svelte';
  import { app, ui, notify } from '../../state.svelte';
  import { runSnippet } from '../../agent.svelte';
  import { isChat } from '../../defaults';
  import { nid } from '../../util';
  import type { Snippet } from '../../types';

  let q = $state('');
  let edit = $state<Snippet | null>(null);
  let isNew = $state(false);
  const list = $derived(app.snippets.filter((s) => !q || (s.name + s.body).toLowerCase().includes(q.toLowerCase())));
  const models = (pid: string | null) => app.providers.find((p) => p.id === pid)?.models || [];
  const label = (s: Snippet) => (s.provider ? `${s.model} · ${app.providers.find((p) => p.id === s.provider)?.name || '?'}` : `domyślny (${app.defModel.model})`);

  function create() { edit = { id: nid('s'), name: '', kind: 'cmd', body: '', provider: null, model: null }; isNew = true; }
  function open(s: Snippet) { edit = { ...s }; isNew = false; }
  function save() {
    if (!edit) return;
    if (!edit.name.trim() || !edit.body.trim()) { notify('Snippet potrzebuje nazwy i treści.', 'warning'); return; }
    if (!edit.provider) edit.model = null;
    if (isNew) app.snippets.unshift(edit);
    else { const i = app.snippets.findIndex((s) => s.id === edit!.id); if (i >= 0) app.snippets[i] = edit; }
    edit = null;
  }
</script>

<div class="pagehead"><h2>Snippety</h2><div><button class="icobtn" title="Nowy snippet" onclick={create}><Icon name="plus" /></button></div></div>
<p class="hint">Snippet to gotowa komenda (wstawiana do aktywnego terminala) albo prompt AI (odpowiedź w panelu agenta). Każdy może mieć własnego providera i model; bez wyboru używa domyślnego <code>{app.defModel.model}</code>. Zmienne: <code>{'{{selection}}'}</code>, <code>{'{{cwd}}'}</code>, <code>{'{{last_output:80}}'}</code>, <code>{'{{cmd:git status}}'}</code>, dowolne <code>{'{{nazwa}}'}</code> (pytanie przy uruchomieniu). Snippety są też w palecie komend (Ctrl+K).</p>
<input class="inp" bind:value={q} placeholder="Szukaj snippetów…" aria-label="Szukaj snippetów" style="max-width:320px" />

{#if edit}
  <div class="form">
    <h3 style="margin:0">{isNew ? 'Nowy snippet' : 'Edytuj snippet'}</h3>
    <div class="grid2">
      <div class="field"><label for="sName">Nazwa</label><input class="inp" id="sName" bind:value={edit.name} placeholder="np. Logi kontenera" /></div>
      <div class="field"><span class="flabel">Rodzaj</span>
        <div class="seg"><button class:on={edit.kind === 'cmd'} onclick={() => (edit!.kind = 'cmd')}>Komenda</button><button class:on={edit.kind === 'ai'} onclick={() => (edit!.kind = 'ai')}>Prompt AI</button></div></div>
      <div class="field"><label for="sProv">Provider</label>
        <select class="inp" id="sProv" bind:value={edit.provider} onchange={() => (edit!.model = edit!.provider ? models(edit!.provider)[0] || null : null)}>
          <option value={null}>Domyślny</option>{#each app.providers.filter(isChat) as p}<option value={p.id}>{p.name}</option>{/each}</select></div>
      <div class="field"><label for="sModel">Model</label>
        <select class="inp" id="sModel" bind:value={edit.model} disabled={!edit.provider}>
          {#if !edit.provider}<option value={null}>Domyślny ({app.defModel.model})</option>{/if}
          {#each models(edit.provider) as m}<option value={m}>{m}</option>{/each}</select></div>
    </div>
    <div class="field"><label for="sBody">Treść</label><textarea class="inp" id="sBody" bind:value={edit.body} placeholder={'docker logs -f {{kontener}}'}></textarea>
      <small>Dla komend model służy do uzupełniania parametrów i wyjaśniania wyniku.</small></div>
    <div class="formbtns"><button class="btn" onclick={() => (edit = null)}>Anuluj</button><button class="btn pri" onclick={save}>Zapisz</button></div>
  </div>
{/if}

<div class="list">
  {#each list as s (s.id)}
    <div class="lrow">
      <span class="badge" style:--c={s.kind === 'ai' ? 'var(--primary)' : 'var(--chart-2)'} style="min-width:30px;text-align:center">{s.kind === 'ai' ? 'AI' : 'CMD'}</span>
      <div class="info"><b>{s.name}</b><small class="mono">{s.body.replace(/\n/g, ' ⏎ ')}</small></div>
      <div class="meta"><span class="chip" class:pri={!!s.provider}>{label(s)}</span></div>
      <div class="acts">
        <button class="icobtn" title="Uruchom" onclick={() => { ui.settingsOpen = false; runSnippet(s); }}><Icon name="play" size={14} /></button>
        <button class="icobtn" title="Edytuj" onclick={() => open(s)}><Icon name="edit" size={14} /></button>
        <button class="icobtn del" title="Usuń" onclick={() => app.snippets.splice(app.snippets.findIndex((x) => x.id === s.id), 1)}><Icon name="trash" size={14} /></button>
      </div>
    </div>
  {:else}
    <div class="lrow"><span class="hint">Brak snippetów pasujących do wyszukiwania.</span></div>
  {/each}
</div>
