<script lang="ts">
  import Icon from '../../Icon.svelte';
  import { app } from '../../state.svelte';
  import { isChat } from '../../defaults';

  const chat = $derived(app.providers.filter(isChat));
  const modelsOf = (id: string) => app.providers.find((p) => p.id === id)?.models || [];

  function add() {
    const p = chat.find((x) => x.id !== app.defModel.provider) || chat[0];
    if (p) app.fallback.chain.push({ provider: p.id, model: p.models[0] || '' });
  }
  function move(i: number, d: number) {
    const c = app.fallback.chain, j = i + d;
    if (j < 0 || j >= c.length) return;
    [c[i], c[j]] = [c[j], c[i]];
  }
</script>

<div class="pagehead"><h2>Zastępstwa</h2>
  <div><label class="tgl"><input type="checkbox" bind:checked={app.fallback.enabled} /> Włączone</label>
    <button class="icobtn" title="Dodaj zastępstwo" onclick={add}><Icon name="plus" /></button></div></div>
<p class="hint">Gdy provider odpowie limitem zapytań (429), brakiem środków (402) albo przeciążeniem (503, 529), agent, snippet albo nod workflow ponawia zapytanie u kolejnego providera z listy, w tej kolejności. Inne błędy, np. zły klucz, przerywają od razu. Dotyczy kluczy API; konta subskrypcji nie przełączają się same.</p>

<div class="list">
  <div class="lrow first">
    <div class="picon"><Icon name="star" /></div>
    <div class="info"><b>Wybór agenta, snippeta albo noda</b><small>najpierw zawsze model ustawiony w danym miejscu (domyślnie {app.defModel.model})</small></div>
  </div>
  {#each app.fallback.chain as f, i}
    <div class="lrow">
      <span class="num">{i + 1}</span>
      <select class="inp" aria-label="Provider" bind:value={f.provider} onchange={() => (f.model = modelsOf(f.provider)[0] || '')}>
        {#each chat as p}<option value={p.id}>{p.name}</option>{/each}
      </select>
      <input class="inp model" aria-label="Model" list="fbm{i}" bind:value={f.model} placeholder="model" spellcheck="false" />
      <datalist id="fbm{i}">{#each modelsOf(f.provider) as m}<option value={m}></option>{/each}</datalist>
      <div class="acts">
        <button class="icobtn" title="Wyżej" disabled={i === 0} onclick={() => move(i, -1)}><Icon name="chev" size={14} /></button>
        <button class="icobtn down" title="Niżej" disabled={i === app.fallback.chain.length - 1} onclick={() => move(i, 1)}><Icon name="chev" size={14} /></button>
        <button class="icobtn del" title="Usuń" onclick={() => app.fallback.chain.splice(i, 1)}><Icon name="trash" size={14} /></button>
      </div>
    </div>
  {:else}
    <div class="lrow"><small class="hint">Brak zastępstw. Dodaj np. OpenRouter albo lokalną Ollamę, żeby praca nie stawała przy limicie.</small></div>
  {/each}
</div>

<style>
  .tgl { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted-foreground); }
  .first { opacity: .8; }
  .num { width: 22px; text-align: center; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
  .lrow select { flex: 0 1 180px; min-width: 0; }
  .lrow .model { flex: 1 1 200px; min-width: 0; font-family: var(--font-mono); font-size: 12px; }
  .acts :global(svg) { transform: rotate(-90deg); }
  .acts .down :global(svg) { transform: rotate(90deg); }
  .acts .del :global(svg) { transform: none; }
</style>
