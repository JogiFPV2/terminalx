<script lang="ts">
  import Icon from '../../Icon.svelte';
  import { app } from '../../state.svelte';
  const COLORS = [['destructive', 'czerwony'], ['chart-3', 'żółty'], ['chart-1', 'zielony'], ['chart-2', 'niebieski'], ['chart-4', 'fioletowy'], ['chart-5', 'turkusowy'], ['primary', 'akcent']];
</script>

<h2>Terminal</h2>
<div class="grid2" style="max-width:640px">
  <div class="field"><label for="ff">Czcionka</label><input class="inp" id="ff" bind:value={app.settings.fontFamily} spellcheck="false" /></div>
  <div class="field"><label for="fs">Rozmiar: {app.settings.fontSize}px</label><input type="range" id="fs" min="9" max="24" bind:value={app.settings.fontSize} /></div>
  <div class="field"><label for="lh">Interlinia: {app.settings.lineHeight}</label><input type="range" id="lh" min="1" max="1.8" step="0.05" bind:value={app.settings.lineHeight} /></div>
  <div class="field"><label for="sb">Historia (linie)</label><input class="inp" id="sb" type="number" min="500" max="100000" step="500" bind:value={app.settings.scrollback} /></div>
</div>
<label class="checks"><input type="checkbox" bind:checked={app.settings.cursorBlink} />Migający kursor</label>
<div>
  <h3>Podświetlanie słów kluczowych</h3>
  <p class="hint">Wyrażenia regularne kolorowane w wyjściu terminala, np. <code>\bERROR\b</code>.</p>
  <div class="list" style="margin-top:8px">
    {#each app.settings.keywords as k, i}
      <div class="lrow">
        <input class="inp mono" bind:value={k.pattern} spellcheck="false" aria-label="Wzorzec" style="flex:1" />
        <select class="inp" bind:value={k.color} style="width:140px" aria-label="Kolor">{#each COLORS as [v, l]}<option value={v}>{l}</option>{/each}</select>
        <span class="dot" style:background="var(--{k.color})"></span>
        <button class="icobtn" title="Usuń" onclick={() => app.settings.keywords.splice(i, 1)}><Icon name="trash" size={14} /></button>
      </div>
    {/each}
  </div>
  <button class="btn" style="margin-top:8px" onclick={() => app.settings.keywords.push({ pattern: '', color: 'chart-2' })}><Icon name="plus" />Dodaj regułę</button>
</div>

<style> .mono { font-family: var(--font-mono); font-size: 12px; } </style>
