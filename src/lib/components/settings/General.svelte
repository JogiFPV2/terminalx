<script lang="ts">
  import { app, ui } from '../../state.svelte';
  import { BRAND } from '../../defaults';
</script>

<h2>Ogólne</h2>
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
<p class="hint">{BRAND.name} {BRAND.version}. Dane aplikacji są w folderze danych użytkownika; folder <code>data</code> obok pliku exe włącza tryb portable.</p>
