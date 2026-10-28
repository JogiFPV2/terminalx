<script lang="ts">
  import { app, ui, notify, saveNow } from '../../state.svelte';
  import { BRAND } from '../../defaults';
  import { call, isTauri } from '../../ipc';
  import { checkUpdate, upd } from '../../update.svelte';
  import Icon from '../../Icon.svelte';

  const isWin = typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent);
  let explorer = $state(false);
  if (isTauri && isWin) call<boolean>('explorer_menu', { enable: null }).then((v) => (explorer = v)).catch(() => {});
  async function setExplorer(on: boolean) {
    try { explorer = await call<boolean>('explorer_menu', { enable: on }); } catch (e) { explorer = !on; notify(String(e), 'error'); }
  }
</script>

<h2>Ogólne</h2>
<div class="field" style="max-width:420px">
  <label for="lang">Język interfejsu</label>
  <select class="inp" id="lang" value={app.settings.lang || 'auto'} onchange={async (e) => { app.settings.lang = e.currentTarget.value; await saveNow(); location.reload(); }}>
    <option value="auto">Automatycznie (język systemu)</option>
    <option value="pl">Polski</option>
    <option value="en">English</option>
  </select>
</div>
<div class="field" style="max-width:420px">
  <label for="defShell">Domyślna powłoka (Ctrl+T)</label>
  <select class="inp" id="defShell" bind:value={app.settings.defaultShell}>
    {#each ui.shells as s}<option value={s.id}>{s.name}</option>{/each}
  </select>
</div>
<div class="field" style="max-width:420px">
  <label for="undo">Czas na przywrócenie zamkniętego elementu: {app.settings.undoSec} s</label>
  <input type="range" id="undo" min="5" max="60" step="5" bind:value={app.settings.undoSec} />
  <small>Zamknięta zakładka, workspace albo notatka znika z widoku, ale proces działa do końca tego czasu. Ctrl+Shift+T przywraca ostatni element.</small>
</div>
<div class="field" style="max-width:560px">
  <label class="checks"><input type="checkbox" bind:checked={app.settings.lightMode} />Tryb lekki (zalecany)</label>
  <small>Interfejs bez akceleracji GPU i terminal z rendererem DOM: około połowę mniej pamięci RAM. Wyłącz, jeśli masz mocną kartę graficzną i terminal wyświetla bardzo dużo danych. Zmiana działa po ponownym uruchomieniu.</small>
</div>
<div class="field" style="max-width:560px">
  <label for="ask">Komendy zawsze wymagające zgody (także w trybie „Automatycznie”)</label>
  <textarea class="inp" id="ask" value={app.settings.alwaysAsk.join('\n')} oninput={(e) => (app.settings.alwaysAsk = e.currentTarget.value.split('\n').map((s) => s.trim()).filter(Boolean))}></textarea>
  <small>Jeden wzorzec w linii. Agent pyta o zgodę, gdy komenda zawiera któryś z nich.</small>
</div>
{#if isTauri && isWin}
  <div class="field" style="max-width:560px">
    <label class="checks"><input type="checkbox" checked={explorer} onchange={(e) => setExplorer(e.currentTarget.checked)} />„Otwórz w {BRAND.name}” w menu Eksploratora</label>
    <small>Prawy przycisk na folderze otwiera w nim terminal. Z wiersza poleceń: <code>--open-terminal-path &lt;folder&gt;</code>, <code>--open-terminal-shell &lt;powłoka&gt;</code>.</small>
  </div>
{/if}
<p class="hint">
  {BRAND.name} {BRAND.version}{#if upd.version} · dostępna wersja {upd.version}{/if}
  {#if isTauri}<button class="icobtn" style="display:inline-grid;vertical-align:middle" title="Sprawdź aktualizacje" onclick={() => checkUpdate(true)}><Icon name="refresh" size={13} /></button>{/if}
</p>
<p class="hint"> Dane aplikacji są w folderze danych użytkownika; folder <code>data</code> obok pliku exe włącza tryb portable.</p>
