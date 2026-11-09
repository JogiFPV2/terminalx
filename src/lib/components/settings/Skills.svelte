<script lang="ts">
  import Icon from '../../Icon.svelte';
  import { app, ui, notify } from '../../state.svelte';
  import { call, isTauri } from '../../ipc';
  import { nid } from '../../util';
  import type { Skill } from '../../types';
  import { parseSkillCommand } from '../../skillcmd';

  /* ---------- dodawanie komendą `npx skills add …` ---------- */
  type Found = { name: string; description: string; body: string; files: Record<string, string>; on: boolean };
  let cmd = $state('');
  let fetching = $state(false);
  let found = $state<Found[] | null>(null);
  let skipped = $state<string[]>([]);
  let fromSource = $state('');
  const exists = (name: string) => app.skills.some((s) => s.name === name);

  async function openSkillsSite() {
    if (isTauri) { const { openUrl } = await import('@tauri-apps/plugin-opener'); await openUrl('https://skills.sh').catch(() => {}); } else window.open('https://skills.sh', '_blank');
  }

  async function fetchSkills() {
    const r = parseSkillCommand(cmd);
    if ('error' in r) { notify(r.error, 'warning'); return; }
    if (!isTauri) { notify('Pobieranie skilli działa w aplikacji.', 'warning'); return; }
    fetching = true; found = null; skipped = [];
    try {
      const res = await call<{ skills: Omit<Found, 'on'>[]; skipped: string[] }>('skills_fetch', { source: r.source, skills: r.skills });
      found = res.skills.map((s) => ({ ...s, on: true }));
      skipped = res.skipped;
      fromSource = r.source;
      if (!found.length) notify('Nie udało się odczytać żadnego skilla z tego źródła.', 'warning');
    } catch (e) { notify(String(e).replace(/^Error: /, ''), 'error'); }
    finally { fetching = false; }
  }

  function importFound() {
    if (!found) return;
    let added = 0, updated = 0;
    for (const f of found.filter((x) => x.on)) {
      const prev = app.skills.find((s) => s.name === f.name);
      const skill: Skill = { id: prev?.id || nid('sk'), name: f.name, description: f.description, body: f.body, files: Object.keys(f.files).length ? f.files : undefined };
      if (prev) { Object.assign(prev, skill); updated++; } else { app.skills.push(skill); added++; }
    }
    notify(`Skille z ${fromSource}: dodano ${added}${updated ? `, zaktualizowano ${updated}` : ''}.`, 'success');
    found = null; skipped = []; cmd = '';
  }

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

<div class="addcmd">
  <input class="inp mono" bind:value={cmd} placeholder="npx skills add mattpocock/skills" spellcheck="false" aria-label="Komenda dodawania skilli"
    onkeydown={(e) => e.key === 'Enter' && !fetching && fetchSkills()} disabled={fetching} />
  <button class="btn pri" onclick={fetchSkills} disabled={fetching || !cmd.trim()}>{#if fetching}<span class="spin"></span>Pobieram…{:else}<Icon name="download" />Pobierz{/if}</button>
</div>
<p class="hint small">Komenda z <button class="lnk" onclick={openSkillsSite}>skills.sh</button>: <code>npx skills add owner/repo</code>, link do repozytorium albo samo <code>owner/repo</code>; <code>--skill nazwa</code> wybiera konkretne skille. Hermitty uruchamia <code>npx skills</code> (wymaga Node.js) w folderze tymczasowym, więc nic nie trafia do folderów innych agentów.</p>

{#if found}
  <div class="form">
    <h3 style="margin:0">Skille z {fromSource} ({found.filter((f) => f.on).length} z {found.length})</h3>
    {#if found.length > 1}
      <div class="row"><button class="btn" onclick={() => found!.forEach((f) => (f.on = true))}>Zaznacz wszystkie</button><button class="btn" onclick={() => found!.forEach((f) => (f.on = false))}>Odznacz wszystkie</button></div>
    {/if}
    <div class="found">
      {#each found as f (f.name)}
        <label class="frow"><input type="checkbox" bind:checked={f.on} />
          <span><span class="fhead"><b>{f.name}</b>{#if exists(f.name)}<span class="chip" title="Skill o tej nazwie już jest; import go zaktualizuje">zaktualizuje</span>{/if}{#if Object.keys(f.files).length}<span class="chip">pliki: {Object.keys(f.files).length}</span>{/if}</span>
            <small>{f.description || f.body.slice(0, 140)}</small></span></label>
      {/each}
    </div>
    {#if skipped.length}<details class="skipped"><summary>Pominięte: {skipped.length}</summary>{#each skipped as s}<div class="mono">{s}</div>{/each}</details>{/if}
    <div class="formbtns"><button class="btn" onclick={() => { found = null; skipped = []; }}>Anuluj</button>
      <button class="btn pri" onclick={importFound} disabled={!found.some((f) => f.on)}>Importuj zaznaczone ({found.filter((f) => f.on).length})</button></div>
  </div>
{/if}

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
  .addcmd { display: flex; gap: 8px; margin-top: 10px; }
  .addcmd .inp { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 12px; }
  .hint.small { font-size: 11.5px; margin-top: 6px; }
  .found { display: flex; flex-direction: column; gap: 2px; max-height: 360px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; padding: 4px; }
  .frow { display: flex; gap: 10px; align-items: flex-start; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
  .frow:hover { background: var(--accent); }
  .frow input { margin-top: 3px; accent-color: var(--primary); }
  .frow span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .frow .fhead { display: flex; flex-direction: row; align-items: center; gap: 6px; }
  .frow b { font-weight: 600; }
  .lnk { background: none; border: 0; padding: 0; color: var(--primary-ink); text-decoration: underline; cursor: pointer; font: inherit; }
  .frow small { color: var(--muted-foreground); }
  .skipped { font-size: 11.5px; color: var(--muted-foreground); }
  .skipped .mono { font-family: var(--font-mono); padding: 2px 0; }
  .spin { width: 11px; height: 11px; border-radius: 50%; border: 1.5px solid color-mix(in oklab, currentColor 30%, transparent); border-top-color: currentColor; animation: rot .8s linear infinite; }
  @keyframes rot { to { transform: rotate(360deg); } }
  .row { display: flex; gap: 6px; }
</style>
