<script lang="ts">
  import Icon from '../../Icon.svelte';
  import { app, ui, notify } from '../../state.svelte';
  import { call, isTauri } from '../../ipc';
  import { nid } from '../../util';
  import type { Skill } from '../../types';

  let edit = $state<Skill | null>(null);
  let isNew = $state(false);
  const usedBy = (id: string) => app.agents.filter((a) => a.skills?.includes(id)).map((a) => a.name);

  function create() {
    edit = { id: nid('sk'), name: '', description: '', body: '' };
    isNew = true;
  }
  function open(s: Skill) { edit = JSON.parse(JSON.stringify(s)); isNew = false; }
  function save() {
    if (!edit) return;
    if (!edit.name.trim() || !edit.body.trim()) { notify('Skill potrzebuje nazwy i instrukcji.', 'warning'); return; }
    if (isNew) app.skills.push(edit);
    else { const i = app.skills.findIndex((s) => s.id === edit!.id); if (i >= 0) app.skills[i] = edit; }
    edit = null;
  }
  function remove(s: Skill) {
    const who = usedBy(s.id);
    ui.confirm = {
      title: `Usunąć skill „${s.name}”?`,
      message: who.length ? `Używają go: ${who.join(', ')}. Zniknie z tych profili.` : '',
      confirmLabel: 'Usuń',
      danger: true,
      resolve: (ok: unknown) => {
        if (!ok) return;
        app.skills.splice(app.skills.findIndex((x) => x.id === s.id), 1);
        for (const a of app.agents) if (a.skills?.includes(s.id)) a.skills = a.skills.filter((x) => x !== s.id);
      },
    };
  }
  async function importFrom(directory: boolean) {
    if (!isTauri) { notify('Import działa w aplikacji.', 'warning'); return; }
    const { open: pick } = await import('@tauri-apps/plugin-dialog');
    const path = await pick(directory ? { directory: true } : { multiple: false, filters: [{ name: 'Skill', extensions: ['zip', 'md'] }] });
    if (!path || Array.isArray(path)) return;
    try {
      const r = await call<{ name: string; description: string; body: string; files: Record<string, string> }>('skill_import', { path });
      const prev = app.skills.find((s) => s.name === r.name);
      const skill: Skill = { id: prev?.id || nid('sk'), name: r.name, description: r.description, body: r.body, files: Object.keys(r.files).length ? r.files : undefined };
      if (prev) Object.assign(prev, skill); else app.skills.push(skill);
      notify(`${prev ? 'Zaktualizowano' : 'Dodano'} skill „${r.name}”${skill.files ? ` (plików: ${Object.keys(skill.files).length})` : ''}.`, 'success');
    } catch (e) { notify(String(e).replace(/^Error: /, ''), 'error'); }
  }
</script>

<div class="pagehead"><h2>Skille</h2>
  <div>
    <button class="btn" title="Folder ze SKILL.md" onclick={() => importFrom(true)}><Icon name="folder" />Importuj folder</button>
    <button class="btn" title="Archiwum .zip albo plik SKILL.md" onclick={() => importFrom(false)}><Icon name="upload" />Importuj plik</button>
    <button class="icobtn" title="Nowy skill" onclick={create}><Icon name="plus" /></button>
  </div>
</div>
<p class="hint">Skill to instrukcja na konkretny rodzaj zadania, np. „wdrożenie na staging” albo „przegląd migracji SQL”, z opcjonalnymi plikami pomocniczymi. Format jak <code>SKILL.md</code> w Claude: nagłówek z nazwą i opisem, dalej instrukcje. Przypinasz go agentom i podagentom w ich profilu. Agent widzi nazwy i opisy, a pełną treść wczytuje dopiero wtedy, gdy zadanie jej wymaga, więc wiele skilli nie zapycha mu kontekstu.</p>

{#if edit}
  <div class="form">
    <h3 style="margin:0">{isNew ? 'Nowy skill' : 'Edytuj skill'}</h3>
    <div class="grid2">
      <div class="field"><label for="skName">Nazwa</label><input class="inp" id="skName" bind:value={edit.name} placeholder="np. deploy-staging" spellcheck="false" /></div>
      <div class="field"><label for="skDesc">Kiedy go użyć</label><input class="inp" id="skDesc" bind:value={edit.description} placeholder="np. wdrożenie aplikacji na serwer testowy" /></div>
    </div>
    <div class="field"><label for="skBody">Instrukcje</label><textarea class="inp mono" id="skBody" rows="12" bind:value={edit.body} placeholder="Kroki, komendy, na co uważać…"></textarea></div>
    {#if edit.files}
      <div class="field"><span class="flabel">Pliki pomocnicze (agent czyta je na żądanie)</span>
        <div class="files">{#each Object.keys(edit.files) as f}<span class="chip mono"><Icon name="file" size={11} />{f}</span>{/each}</div></div>
    {/if}
    <div class="formbtns"><button class="btn" onclick={() => (edit = null)}>Anuluj</button><button class="btn pri" onclick={save}>Zapisz</button></div>
  </div>
{/if}

<div class="list">
  {#each app.skills as s (s.id)}
    {@const who = usedBy(s.id)}
    <div class="lrow">
      <div class="picon"><Icon name="book" /></div>
      <div class="info"><b>{s.name}{#if s.files}<span class="chip">pliki: {Object.keys(s.files).length}</span>{/if}</b><small>{s.description || s.body.slice(0, 120)}</small></div>
      <div class="meta">{#if who.length}<span class="chip" title={who.join(', ')}><Icon name="bot" size={11} />{who.length}</span>{:else}<span class="chip" title="Nieprzypięty do żadnego profilu">nieużywany</span>{/if}</div>
      <div class="acts"><button class="icobtn" title="Edytuj" onclick={() => open(s)}><Icon name="edit" size={14} /></button>
        <button class="icobtn del" title="Usuń" onclick={() => remove(s)}><Icon name="trash" size={14} /></button></div>
    </div>
  {:else}
    <div class="lrow"><small class="hint">Brak skilli. Utwórz pierwszy przyciskiem + albo zaimportuj folder ze SKILL.md.</small></div>
  {/each}
</div>

<style>
  textarea.mono { font-family: var(--font-mono); font-size: 12px; }
  .files { display: flex; flex-wrap: wrap; gap: 5px; }
</style>
