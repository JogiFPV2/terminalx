<script lang="ts">
  // Edytor workflow z nodami na telefonie (ten sam format co w Hermitty na komputerze).
  // Dotyk: przeciągnij node za nagłówek; stuknij kropkę wyjścia (po prawej), potem node docelowy, by połączyć;
  // stuknij połączenie, by je usunąć; stuknij node, by otworzyć ustawienia.
  import Icon from '../../../src/lib/Icon.svelte';
  import { NODE_CATS, CAT_COLOR, DEFAULT_PROMPTS } from '../../../src/lib/defaults';
  import { NODE_TYPES, nodeType, makeNode, runFlow, FR, importFlow, exportFlow, newFlow } from '../lib/flow.svelte';
  import { saveWs, type LTab, type LWs } from '../lib/ws.svelte';
  import { toast, msg } from '../lib/store.svelte';
  import Sheet from './Sheet.svelte';
  import type { FlowNode } from '../../../src/lib/types';

  let { tab, ws }: { tab: LTab; ws: LWs } = $props();
  // Nowa zakładka workflow: pusty graf z nodem startowym.
  $effect.pre(() => { if (!tab.flow) { tab.flow = newFlow(); saveWs(); } });
  const flow = $derived(tab.flow ?? newFlow());
  const W = 2400, H = 1600, NW = 168, PY = 18;

  let scroller: HTMLDivElement;
  let zoom = $state(1);
  let sel = $state<string | null>(null);
  let wire = $state<string | null>(null);
  let palette = $state(false);
  let io = $state<'' | 'export' | 'import'>('');
  let ioText = $state('');
  let q = $state('');
  const running = $derived(!!FR.running[flow.id]);
  const selNode = $derived(flow.nodes.find((n) => n.id === sel) || null);

  const curve = (x1: number, y1: number, x2: number, y2: number) => { const d = Math.max(30, Math.abs(x2 - x1) / 2); return `M${x1} ${y1} C ${x1 + d} ${y1}, ${x2 - d} ${y2}, ${x2} ${y2}`; };
  const edgeD = (a: string, b: string) => { const A = flow.nodes.find((n) => n.id === a), B = flow.nodes.find((n) => n.id === b); return A && B ? curve(A.x + NW, A.y + PY, B.x, B.y + PY) : ''; };

  // Przeciąganie noda za nagłówek; krótkie stuknięcie bez ruchu otwiera ustawienia.
  function drag(e: PointerEvent, n: FlowNode) {
    if (wire) { connect(n.id); return; }
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY, ox = n.x, oy = n.y;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / zoom, dy = (ev.clientY - sy) / zoom;
      if (!moved && Math.hypot(dx, dy) < 6) return;
      moved = true;
      n.x = Math.max(0, Math.min(W - NW, Math.round(ox + dx)));
      n.y = Math.max(0, Math.min(H - 60, Math.round(oy + dy)));
    };
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      if (moved) saveWs(); else sel = n.id;
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  }

  function connect(to: string) {
    const from = wire;
    wire = null;
    if (!from || from === to) return;
    if (flow.edges.some(([a, b]) => a === from && b === to)) return;
    flow.edges.push([from, to]);
    saveWs();
  }
  function dropEdge(i: number) {
    if (!confirm('Usunąć to połączenie?')) return;
    flow.edges.splice(i, 1); saveWs();
  }

  function addNode(typeId: string) {
    // Nowy node w widocznym miejscu; za zaznaczonym, jeśli jest (i od razu połączony).
    const prev = selNode;
    let x = Math.min(W - NW, prev ? prev.x + NW + 50 : (scroller.scrollLeft + 40) / zoom);
    let y = Math.min(H - 60, prev ? prev.y : (scroller.scrollTop + 60) / zoom);
    // Nie na innym nodzie: zsuwamy w dół, aż miejsce będzie wolne.
    while (y < H - 100 && flow.nodes.some((o) => Math.abs(o.x - x) < NW && Math.abs(o.y - y) < 80)) y += 90;
    const n = makeNode(typeId, x, y);
    flow.nodes.push(n);
    if (prev) flow.edges.push([prev.id, n.id]);
    palette = false; q = ''; sel = n.id; saveWs();
  }
  function removeNode(id: string) {
    flow.nodes = flow.nodes.filter((n) => n.id !== id);
    flow.edges = flow.edges.filter(([a, b]) => a !== id && b !== id);
    sel = null; saveWs();
  }
  function duplicate(n: FlowNode) {
    const c = { ...makeNode(n.type, n.x + 30, n.y + 90), cfg: JSON.parse(JSON.stringify(n.cfg)), label: n.label };
    flow.nodes.push(c); sel = c.id; saveWs();
  }

  async function run(only?: string) {
    try { const r = await runFlow(flow, ws, only); if (!only) toast(r.slice(0, 200)); } catch (e) { toast(msg(e)); }
  }

  function doImport() {
    try {
      const f = importFlow(ioText);
      if (flow.nodes.length > 1 && !confirm('Zastąpić obecny workflow importowanym?')) return;
      tab.flow = f; io = ''; ioText = ''; sel = null; saveWs(true); toast('Zaimportowano workflow');
    } catch (e) { toast(msg(e)); }
  }
  async function doExport() {
    ioText = exportFlow(flow); io = 'export';
    try { await navigator.clipboard.writeText(ioText); toast('Skopiowano JSON. Wklej go w Hermitty na komputerze (Workflow → Import).'); } catch { /* pokażemy do skopiowania */ }
  }

  const types = $derived(NODE_TYPES.filter((t) => !q || `${t.name} ${t.cat} ${t.desc || ''}`.toLowerCase().includes(q.toLowerCase())));
  const prompts = DEFAULT_PROMPTS.filter((p) => p.type === 'prompt');
  const preview = (n: FlowNode) => {
    const ty = nodeType(n.type);
    if (FR.out[n.id] && FR.status[n.id] !== 'run') return FR.out[n.id];
    if (ty.ai) return n.cfg.prompt || prompts.find((p) => p.id === n.cfg.base)?.name || 'Prompt…';
    const f = ty.fields?.[0];
    return f ? String(n.cfg[f[0]] ?? '') : ty.desc || '';
  };
</script>

<div class="flow">
  <div class="bar">
    <button class="btn sm pri" disabled={running} onclick={() => run()}><Icon name={running ? 'timer' : 'play'} size={16} />{running ? 'Działa…' : 'Uruchom'}</button>
    <button class="btn sm" onclick={() => (palette = true)}><Icon name="plus" size={16} />Node</button>
    <span class="sp"></span>
    <button class="ib" aria-label="Pomniejsz" onclick={() => (zoom = Math.max(0.4, +(zoom - 0.15).toFixed(2)))}><Icon name="minus" size={16} /></button>
    <button class="ib" aria-label="Powiększ" onclick={() => (zoom = Math.min(1.6, +(zoom + 0.15).toFixed(2)))}><Icon name="plus" size={16} /></button>
    <button class="ib" aria-label="Eksport JSON" onclick={doExport}><Icon name="upload" size={16} /></button>
    <button class="ib" aria-label="Import JSON" onclick={() => { ioText = ''; io = 'import'; }}><Icon name="download" size={16} /></button>
  </div>
  {#if wire}<div class="wiring">Stuknij node, do którego ma iść połączenie <button class="btn sm ghost" onclick={() => (wire = null)}>Anuluj</button></div>{/if}

  <div class="scroller" bind:this={scroller}>
    <div class="surface" style:width="{W * zoom}px" style:height="{H * zoom}px">
      <div class="world" style:transform="scale({zoom})" style:width="{W}px" style:height="{H}px">
        <svg class="edges" width={W} height={H} aria-hidden="false">
          {#each flow.edges as [a, b], i (a + '>' + b)}
            {@const d = edgeD(a, b)}
            <path {d} class="e" class:live={FR.status[a] === 'ok'} />
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <path {d} class="hit" onclick={() => dropEdge(i)} />
          {/each}
        </svg>
        {#each flow.nodes as n (n.id)}
          {@const ty = nodeType(n.type)}
          <div class="node {FR.status[n.id] || ''}" class:sel={sel === n.id} class:off={!ty.phone} class:target={!!wire && wire !== n.id}
            style:left="{n.x}px" style:top="{n.y}px" style:width="{NW}px" style:--c={CAT_COLOR[ty.cat] || 'var(--muted-foreground)'}>
            <div class="head" role="button" tabindex="0" aria-label="Node {n.label || ty.name}" onpointerdown={(e) => drag(e, n)} onkeydown={(e) => e.key === 'Enter' && (sel = n.id)}>
              <span class="in" aria-hidden="true"></span>
              <Icon name={ty.icon} size={14} /><b>{n.label || ty.name}</b>
              {#if FR.status[n.id]}<i class="st"></i>{/if}
            </div>
            <div class="body">{preview(n).slice(0, 90)}</div>
            <button class="out" aria-label="Połącz z kolejnym nodem" class:on={wire === n.id} onclick={() => (wire = wire === n.id ? null : n.id)}></button>
          </div>
        {/each}
      </div>
    </div>
  </div>
</div>

{#if palette}
  <Sheet title="Dodaj node" onclose={() => { palette = false; q = ''; }}>
    <input class="inp" bind:value={q} placeholder="Szukaj nodów…" />
    {#if selNode}<p class="muted small">Nowy node zostanie połączony za „{selNode.label || nodeType(selNode.type).name}”.</p>{/if}
    {#each NODE_CATS as cat}
      {@const list = types.filter((t) => t.cat === cat)}
      {#if list.length}
        <h4 style:color={CAT_COLOR[cat]}>{cat}</h4>
        <div class="types">
          {#each list as t (t.id)}
            <button class:off={!t.phone} disabled={!t.phone} onclick={() => addNode(t.id)}><Icon name={t.icon} size={16} /><span>{t.name}{#if !t.phone}<small>tylko na komputerze</small>{/if}</span></button>
          {/each}
        </div>
      {/if}
    {/each}
  </Sheet>
{/if}

{#if selNode}
  {@const ty = nodeType(selNode.type)}
  <Sheet title={ty.name} onclose={() => (sel = null)}>
    {#if !ty.phone}<p class="warn">Ten node działa tylko w Hermitty na komputerze. Na telefonie zatrzyma workflow.</p>{/if}
    {#if ty.desc}<p class="muted small">{ty.desc}</p>{/if}
    <div class="field"><label for="nl">Nazwa</label><input id="nl" class="inp" bind:value={selNode.label} oninput={() => saveWs()} placeholder={ty.name} /></div>
    {#if ty.ai}
      <div class="field"><label for="nb">Prompt z biblioteki</label>
        <select id="nb" class="inp" bind:value={selNode.cfg.base} onchange={() => saveWs()}><option value="">(brak)</option>{#each prompts as p (p.id)}<option value={p.id}>{p.name}</option>{/each}</select></div>
      <div class="field"><label for="np">Prompt</label><textarea id="np" class="inp" rows="4" bind:value={selNode.cfg.prompt} oninput={() => saveWs()} placeholder="Użyj {'{{input}}'} dla wejścia z poprzedniego noda"></textarea></div>
      <div class="field"><label for="nf">Format</label>
        <select id="nf" class="inp" bind:value={selNode.cfg.format} onchange={() => saveWs()}><option value="text">Tekst</option><option value="json">JSON</option><option value="list">Lista</option></select></div>
      <p class="muted small">Model: ten z ustawień agenta na telefonie.</p>
    {:else}
      {#each ty.fields || [] as [k, label] (k)}
        <div class="field"><label for="nf-{k}">{label}</label>
          {#if ['command', 'tpl', 'text', 'body', 'task'].includes(k)}<textarea id="nf-{k}" class="inp mono" rows="3" bind:value={selNode.cfg[k]} oninput={() => saveWs()} spellcheck="false" autocapitalize="off"></textarea>
          {:else}<input id="nf-{k}" class="inp mono" bind:value={selNode.cfg[k]} oninput={() => saveWs()} spellcheck="false" autocapitalize="off" />{/if}</div>
      {/each}
    {/if}
    {#if FR.out[selNode.id]}<div class="field"><span class="lbl">Wynik ({FR.status[selNode.id] === 'err' ? 'błąd' : FR.status[selNode.id] === 'skip' ? 'pominięty' : 'ostatnie uruchomienie'})</span><pre class="res">{FR.out[selNode.id]}</pre></div>{/if}
    <div class="acts">
      <button class="btn sm pri" disabled={running} onclick={() => selNode && run(selNode.id)}><Icon name="play" size={15} />Uruchom do tego noda</button>
      <button class="btn sm" onclick={() => { wire = selNode!.id; sel = null; }}>Połącz dalej</button>
      <button class="btn sm ghost" onclick={() => selNode && duplicate(selNode)}>Duplikuj</button>
      <button class="btn sm ghost" onclick={() => selNode && removeNode(selNode.id)}><Icon name="trash" size={15} />Usuń</button>
    </div>
  </Sheet>
{/if}

{#if io}
  <Sheet title={io === 'export' ? 'Eksport workflow' : 'Import workflow'} onclose={() => (io = '')}>
    {#if io === 'export'}<p class="muted small">JSON jest w schowku. Ten sam format przyjmuje Hermitty na komputerze.</p>
    {:else}<p class="muted small">Wklej JSON workflow z Hermitty na komputerze albo z innego telefonu.</p>{/if}
    <textarea class="inp mono io" bind:value={ioText} readonly={io === 'export'} spellcheck="false"></textarea>
    {#if io === 'import'}<button class="btn pri wide" disabled={!ioText.trim()} onclick={doImport}>Importuj</button>{/if}
  </Sheet>
{/if}

<style>
  .flow { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .bar { display: flex; align-items: center; gap: 6px; padding: 0 8px 8px; }
  .sp { flex: 1; }
  .wiring { margin: 0 8px 8px; padding: 8px 12px; border-radius: 12px; background: var(--primary); color: var(--primary-foreground); display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13.5px; }
  .scroller { flex: 1; min-height: 0; overflow: auto; margin: 0 8px 8px; border-radius: 16px; background: var(--card);
    background-image: radial-gradient(color-mix(in oklab, var(--foreground) 14%, transparent) 1px, transparent 1px); background-size: 22px 22px; }
  .surface { position: relative; }
  .world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  .edges { position: absolute; inset: 0; overflow: visible; }
  .e { fill: none; stroke: color-mix(in oklab, var(--foreground) 35%, transparent); stroke-width: 2; }
  .e.live { stroke: var(--primary-ink); }
  .hit { fill: none; stroke: transparent; stroke-width: 18; pointer-events: stroke; }
  .node { position: absolute; background: var(--background); border-radius: 12px; box-shadow: 0 0 0 1px var(--border), 0 4px 14px -8px rgb(0 0 0 / .35); }
  .node.sel { box-shadow: 0 0 0 2px var(--primary-ink); }
  .node.target { box-shadow: 0 0 0 2px var(--primary); animation: pulse 1.2s infinite; }
  .node.off { opacity: .55; }
  .head { display: flex; align-items: center; gap: 6px; padding: 8px 18px 8px 10px; border-bottom: 1px solid var(--border); touch-action: none; user-select: none; color: var(--c); }
  .head b { flex: 1; min-width: 0; font: 600 12.5px var(--font-sans); color: var(--foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .in { position: absolute; left: -7px; top: 11px; width: 12px; height: 12px; border-radius: 50%; background: var(--background); box-shadow: 0 0 0 2px var(--c); }
  .st { width: 8px; height: 8px; border-radius: 50%; background: var(--muted-foreground); }
  .node.ok .st { background: var(--chart-1); } .node.err .st { background: var(--destructive); } .node.run .st { background: var(--chart-3); animation: pulse 1s infinite; }
  .node.err { box-shadow: 0 0 0 1.5px var(--destructive); }
  .body { padding: 6px 10px 9px; font: 11px/1.4 var(--font-mono); color: var(--muted-foreground); max-height: 46px; overflow: hidden; overflow-wrap: anywhere; }
  .out { position: absolute; right: -12px; top: 6px; width: 24px; height: 24px; border-radius: 50%; border: 0; background: var(--c); box-shadow: 0 0 0 3px var(--background); }
  .out.on { background: var(--primary); box-shadow: 0 0 0 3px var(--background), 0 0 0 6px var(--primary-ink); }
  @keyframes pulse { 50% { opacity: .55; } }
  h4 { margin: 14px 0 6px; font: 600 12px var(--font-mono); text-transform: uppercase; letter-spacing: .06em; }
  .types { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .types button { display: flex; align-items: center; gap: 8px; border: 0; border-radius: 12px; padding: 10px; background: var(--muted); text-align: left; font-size: 13.5px; min-height: 44px; }
  .types button span { display: flex; flex-direction: column; }
  .types button small { font-size: 11px; color: var(--muted-foreground); }
  .types button.off { opacity: .5; }
  .field { display: grid; gap: 6px; margin-bottom: 12px; }
  label, .lbl { font-size: 13px; color: var(--muted-foreground); }
  .small { font-size: 13px; margin: 6px 0 10px; }
  .warn { color: var(--destructive); font-size: 13.5px; margin: 0 0 10px; }
  .res { margin: 0; max-height: 200px; overflow: auto; background: var(--muted); border-radius: 10px; padding: 8px 10px; font: 12px/1.45 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
  .acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  .io { min-height: 220px; font-size: 11.5px; resize: vertical; margin-bottom: 10px; }
  .wide { width: 100%; }
</style>
