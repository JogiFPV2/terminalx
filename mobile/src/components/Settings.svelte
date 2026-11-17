<script lang="ts">
  import { S, saveSettings } from '../lib/store.svelte';
  import { BUILTIN } from '../../../src/lib/theme';
  const themes = Object.keys(BUILTIN);
</script>

<div class="field"><label for="nm">Nazwa tego telefonu</label>
  <input id="nm" class="inp" bind:value={S.settings.name} onchange={saveSettings} maxlength="40" />
  <small class="muted">Tak komputer pokaże telefon przy parowaniu.</small></div>
<div class="field"><span class="lbl">Motyw</span>
  <div class="themes">{#each themes as t}<button class:on={S.settings.theme === t} onclick={() => { S.settings.theme = t; saveSettings(); }}>{t}</button>{/each}</div></div>
<div class="field"><span class="lbl">Tryb</span>
  <div class="seg">{#each [['system', 'Systemowy'], ['light', 'Jasny'], ['dark', 'Ciemny']] as [v, l]}<button class:on={S.settings.mode === v} onclick={() => { S.settings.mode = v as any; saveSettings(); }}>{l}</button>{/each}</div></div>
<p class="muted ver">Hermitty na Androida {__APP_VERSION__}</p>

<style>
  .field { display: grid; gap: 6px; margin-bottom: 18px; }
  label, .lbl { font-size: 13px; color: var(--muted-foreground); }
  small { font-size: 12.5px; }
  .themes { display: flex; flex-wrap: wrap; gap: 6px; }
  .themes button, .seg button { border: 0; border-radius: 999px; padding: 8px 14px; min-height: 40px; background: var(--muted); }
  .themes button.on, .seg button.on { background: var(--foreground); color: var(--background); }
  .seg { display: flex; gap: 6px; }
  .ver { font-size: 12.5px; }
</style>
