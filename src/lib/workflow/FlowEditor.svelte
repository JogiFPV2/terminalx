<script lang="ts">
  import Icon from '../Icon.svelte';
  import { app, ui, notify } from '../state.svelte';
  import { NODE_CATS, CAT_COLOR, isChat } from '../defaults';
  import { allNodeTypes, nodeType, makeNode, runFlow, flowRun } from './engine.svelte';
  import { ASPECTS, isVideoOp, mediaProviders, modelHints, mediaSrc, kindOf } from './media';
  import { presetsFor, presetById, installed, local, refreshLocal } from './comfy.svelte';
  if (app.providers.some((p) => p.type === 'comfy')) refreshLocal();
  import { call, isTauri } from '../ipc';
  import { track, nid } from '../util';
  import type { Flow, Tab, FlowNode, Media } from '../types';

  let { flow, tab, compact = false }: { flow: Flow; tab: Tab; compact?: boolean } = $props();
  const NODE_W = 172, MEDIA_W = 232, PORT_Y = 17;

  let canvas: HTMLDivElement | undefined = $state();
  let surface: HTMLDivElement | undefined = $state();
  let sel = $state<string | null>(null);
  let q = $state('');
  let closed = $state<Record<string, boolean>>({ Pliki: true, 'Sieć': true, Dane: true });
  let wire = $state<{ from: string; x: number; y: number } | null>(null);
  let view = $state<{ list: Media[]; i: number } | null>(null);

  const selNode = $derived(flow.nodes.find((n) => n.id === sel) || null);
  const selType = $derived(selNode ? nodeType(selNode.type) : null);
  const types = $derived(allNodeTypes());
  const running = $derived(!!flowRun.running[flow.id]);

  $effect(() => { if (canvas && !compact) { canvas.scrollLeft = flow.sx || 0; canvas.scrollTop = flow.sy || 0; } });

  const visual = (n: FlowNode) => { const t = nodeType(n.type); return !!t.media || t.id === 'media_in' || t.id === 'vid_frame' || t.id === 'vid_concat' || t.id === 'media_save'; };
  const width = (n: FlowNode) => (visual(n) ? MEDIA_W : NODE_W);
  const curve = (x1: number, y1: number, x2: number, y2: number) => { const d = Math.max(30, Math.abs(x2 - x1) / 2); return `M${x1} ${y1} C ${x1 + d} ${y1}, ${x2 - d} ${y2}, ${x2} ${y2}`; };
  function edgePath(a: string, b: string) {
    const A = flow.nodes.find((n) => n.id === a), B = flow.nodes.find((n) => n.id === b);
    return A && B ? curve(A.x + width(A), A.y + PORT_Y, B.x, B.y + PORT_Y) : '';
  }
  const promptName = (id: string) => app.prompts.find((p) => p.id === id && p.type === 'prompt')?.name;
  function promptPath(id: string | null): string {
    const parts: string[] = [];
    let n = app.prompts.find((p) => p.id === id);
    while (n) { parts.unshift(n.name); n = n.parent ? app.prompts.find((p) => p.id === n!.parent) : undefined; }
    return parts.join(' / ');
  }
  const promptGroups = $derived.by(() => {
    const g: Record<string, { id: string; name: string }[]> = {};
    for (const p of app.prompts.filter((x) => x.type === 'prompt')) (g[p.parent ? promptPath(p.parent) : 'Bez folderu'] ||= []).push(p);
    return Object.entries(g);
  });
  function summary(n: FlowNode) {
    const ty = nodeType(n.type);
    if (ty.media) return n.cfg.prompt || promptName(n.cfg.base) || (presetById(n.cfg.model)?.name || n.cfg.model || 'model automatyczny');
    if (ty.ai) return `${promptName(n.cfg.base) || n.cfg.prompt?.slice(0, 40) || 'prompt'} · ${(n.cfg.model || app.defModel.model).replace('claude-', '')}${n.cfg.results > 1 ? ` ×${n.cfg.results}` : ''}`;
    const f = ty.fields?.[0];
    return f ? String(n.cfg[f[0]] || '—').split(/[\\/]/).pop() : '';
  }
  /** Podgląd w nodzie: ostatni wynik albo wybrany plik wejściowy. */
  function shown(n: FlowNode): Media[] {
    if (flowRun.media[n.id]?.length) return flowRun.media[n.id];
    if (n.type === 'media_in' && n.cfg.path) return [{ kind: kindOf(n.cfg.path), path: n.cfg.path }];
    return [];
  }
  const ratio = (n: FlowNode) => (n.cfg.aspect || '1:1').replace(':', ' / ');

  function addNode(typeId: string) {
    const s = selNode;
    const x = s ? s.x + width(s) + 28 : (canvas?.scrollLeft || 0) + 40 + (flow.nodes.length % 4) * 30;
    const y = s ? s.y + flow.edges.filter((e) => e[0] === s.id).length * (visual(s) ? 230 : 84) : (canvas?.scrollTop || 0) + 40 + (flow.nodes.length % 4) * 30;
    const n = makeNode(typeId, Math.round(x), Math.round(y));
    flow.nodes.push(n);
    if (s) flow.edges.push([s.id, n.id]);
    sel = n.id;
    reveal(n);
  }
  function reveal(n: FlowNode) {
    requestAnimationFrame(() => {
      if (!canvas) return;
      const vis = canvas.clientWidth - 300;
      if (n.x + width(n) + 16 > canvas.scrollLeft + vis) canvas.scrollLeft = n.x + width(n) + 16 - vis;
      if (n.x - 16 < canvas.scrollLeft) canvas.scrollLeft = Math.max(0, n.x - 16);
    });
  }
  function delNode() {
    if (!selNode) return;
    const id = selNode.id;
    flow.nodes = flow.nodes.filter((n) => n.id !== id);
    flow.edges = flow.edges.filter(([a, b]) => a !== id && b !== id);
    sel = null;
  }

  function dragNode(e: PointerEvent, n: FlowNode) {
    if (e.button !== 0) return;
    e.preventDefault();
    sel = n.id;
    const sx = e.clientX, sy = e.clientY, ox = n.x, oy = n.y;
    track((ev) => { n.x = Math.max(0, Math.round((ox + ev.clientX - sx) / 6) * 6); n.y = Math.max(0, Math.round((oy + ev.clientY - sy) / 6) * 6); });
  }
  function startWire(e: PointerEvent, n: FlowNode) {
    e.preventDefault();
    e.stopPropagation();
    const r = surface!.getBoundingClientRect();
    wire = { from: n.id, x: e.clientX - r.left, y: e.clientY - r.top };
    track((ev) => { const r2 = surface!.getBoundingClientRect(); wire = { from: n.id, x: ev.clientX - r2.left, y: ev.clientY - r2.top }; }, (ev) => {
      wire = null;
      const hit = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const to = hit?.closest('[data-nid]')?.getAttribute('data-nid');
      if (to && to !== n.id && !flow.edges.some(([a, b]) => a === n.id && b === to)) flow.edges.push([n.id, to]);
    });
  }

  async function run(only?: string) {
    try { const out = await runFlow(flow, '', only); if (!flow.nodes.some((n) => flowRun.status[n.id] === 'err')) notify(only ? 'Node gotowy' : 'Workflow zakończony', 'success'); console.info(out); }
    catch (e) { notify(String(e), 'error'); }
  }

  function saveAsType() {
    if (!selNode || !selType) return;
    app.nodeTypes.push({ id: 'c-' + nid(), cat: 'Własne', name: `${selNode.label || selType.name} (własny)`, icon: selType.icon, ai: !selType.media, media: selType.media, custom: true, desc: 'Zapisany z kanwy.', defaults: JSON.parse(JSON.stringify(selNode.cfg)) });
    closed['Własne'] = false;
    notify('Dodano do palety w kategorii „Własne”', 'success');
  }
  async function pickFile() {
    if (!selNode || !isTauri) return;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const f = await open({ multiple: false, filters: [{ name: 'Obrazy i wideo', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov'] }] });
    if (typeof f === 'string') { try { selNode.cfg.path = await call<string>('media_import', { path: f }); } catch (e) { notify(String(e), 'error'); } }
  }
  async function pickDir() {
    if (!selNode || !isTauri) return;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const d = await open({ directory: true });
    if (typeof d === 'string') selNode.cfg.dir = d;
  }
  async function reveal2(path: string) { if (isTauri) { const { revealItemInDir } = await import('@tauri-apps/plugin-opener'); await revealItemInDir(path).catch((e) => notify(String(e), 'error')); } }
  const isAnthropic = (pid: string) => (app.providers.find((p) => p.id === (pid || app.defModel.provider))?.type === 'anthropic');
  const hover = (e: Event, play: boolean) => { const v = e.currentTarget as HTMLVideoElement; if (play) v.play().catch(() => {}); else v.pause(); };
  const focusMe = (el: HTMLElement) => el.focus();
</script>

{#snippet thumb(m: Media, cls = '')}
  {#if m.kind === 'video'}
    <video class={cls} src={mediaSrc(m.path)} muted loop playsinline preload="metadata" onmouseenter={(e) => hover(e, true)} onmouseleave={(e) => hover(e, false)}></video>
  {:else}
    <img class={cls} src={mediaSrc(m.path)} alt="" loading="lazy" draggable="false" />
  {/if}
{/snippet}

<div class="wf" class:compact class:has-insp={!!selNode && !compact}>
  {#if !compact}
    {#if app.layout.palHidden}
      <div class="pal mini"><button class="icobtn" title="Pokaż nody" onclick={() => (app.layout.palHidden = false)}><Icon name="nodes" /></button></div>
    {:else}
      <div class="pal">
        <div class="pal-h">
          <span class="srch"><Icon name="search" size={13} /><input bind:value={q} placeholder="Szukaj" aria-label="Szukaj nodów" /></span>
          <button class="icobtn" title="Zwiń" onclick={() => (app.layout.palHidden = true)}><Icon name="chev" size={13} /></button>
        </div>
        <div class="cats">
          {#each NODE_CATS as c}
            {@const list = types.filter((t) => t.cat === c && (!q || t.name.toLowerCase().includes(q.toLowerCase())))}
            {#if list.length || c === 'Własne'}
              <div class="cat" class:closed={closed[c] && !q}>
                <button class="cat-h" onclick={() => (closed[c] = !closed[c])}><Icon name="chev" size={11} /><i style:--c={CAT_COLOR[c]}></i>{c}<span class="n">{list.length}</span></button>
                <div class="cat-b">
                  {#each list as t (t.id)}
                    <button class="pn" style:--c={CAT_COLOR[c]} title={t.desc || t.name} onclick={() => addNode(t.id)}><Icon name={t.icon} size={14} />{t.name}</button>
                  {/each}
                  {#if c === 'Własne'}<button class="pn" style:--c="var(--muted-foreground)" title="Utwórz własny node" onclick={() => { ui.settingsPage = 'nodes'; ui.settingsOpen = true; }}><Icon name="plus" size={14} />Nowy</button>{/if}
                </div>
              </div>
            {/if}
          {/each}
        </div>
      </div>
    {/if}
  {/if}

  <div class="canvas" bind:this={canvas} onscroll={() => { if (canvas) { flow.sx = canvas.scrollLeft; flow.sy = canvas.scrollTop; } }}>
    <div class="surface" bind:this={surface} role="presentation" onpointerdown={(e) => { if (e.target === surface) sel = null; }}>
      <svg class="edges" width="3000" height="2000" aria-hidden="true">
        {#each flow.edges as [a, b], i (a + b)}
          {@const d = edgePath(a, b)}
          <g>
            <path class="hit" {d} role="button" tabindex="-1" aria-label="Usuń połączenie" onclick={() => flow.edges.splice(i, 1)}><title>Kliknij, aby usunąć połączenie</title></path>
            <path class="vis" class:live={flowRun.status[a] === 'run' || (flowRun.status[a] === 'ok' && flowRun.status[b] === 'run')} {d} />
          </g>
        {/each}
        {#if wire}
          {@const A = flow.nodes.find((n) => n.id === wire!.from)}
          {#if A}<path class="vis live" d={curve(A.x + width(A), A.y + PORT_Y, wire.x, wire.y)} />{/if}
        {/if}
      </svg>
      {#each flow.nodes as n (n.id)}
        {@const ty = nodeType(n.type)}
        {@const vis = visual(n)}
        {@const ms = vis ? shown(n) : []}
        <div class="node {flowRun.status[n.id] || ''}" class:sel={sel === n.id} class:vis data-nid={n.id} style:left="{n.x}px" style:top="{n.y}px" style:--c={CAT_COLOR[ty.cat]}
          role="button" tabindex="0" onclick={() => { sel = n.id; reveal(n); }} onkeydown={(e) => { if (e.key === 'Delete' && sel === n.id) delNode(); }}>
          <header role="presentation" onpointerdown={(e) => !compact && dragNode(e, n)}>
            <Icon name={ty.icon} size={14} /><span>{n.label || ty.name}</span>
            {#if flowRun.status[n.id] === 'run'}<span class="sub busy"></span>{:else if flowRun.status[n.id] === 'ok'}<Icon name="check" size={13} />{:else if flowRun.status[n.id] === 'err'}<Icon name="x" size={13} />{/if}
          </header>
          {#if vis}
            <div class="pv" style:aspect-ratio={ms.length ? null : ratio(n)}>
              {#if ms.length}
                <button class="pvb" title="Powiększ" onclick={(e) => { e.stopPropagation(); view = { list: ms, i: 0 }; }}>{@render thumb(ms[0])}</button>
                {#if ms.length > 1}<span class="more">+{ms.length - 1}</span>{/if}
              {:else if flowRun.status[n.id] === 'run' && flowRun.preview[n.id]}
                <img class="live" src={flowRun.preview[n.id]} alt="" /><span class="wait over"><span class="spin"></span>{flowRun.note[n.id] || ''}</span>
              {:else if flowRun.status[n.id] === 'run'}
                <span class="wait"><span class="spin"></span>{flowRun.note[n.id] || ''}</span>
              {:else if flowRun.status[n.id] === 'err'}
                <span class="wait err" title={flowRun.out[n.id]}>{flowRun.out[n.id]}</span>
              {:else}
                <span class="wait"><Icon name={ty.media && isVideoOp(ty.media) ? 'film' : 'image'} size={22} /></span>
              {/if}
            </div>
            {#if ty.media && summary(n)}<div class="sum">{summary(n)}</div>{/if}
          {:else if summary(n)}
            <div class="sum">{summary(n)}</div>
          {/if}
          <i class="port in"></i>
          {#if !compact}<button class="port out" title="Przeciągnij, aby połączyć" aria-label="Połącz z innym nodem" onpointerdown={(e) => startWire(e, n)}></button>{/if}
        </div>
      {/each}
    </div>
  </div>

  {#if !compact}
    <div class="tools"><button class="fab" disabled={running} title={running ? 'Działa…' : 'Uruchom workflow'} onclick={() => run()}>{#if running}<span class="spin"></span>{:else}<Icon name="play" size={14} />{/if}</button></div>
  {/if}

  {#if selNode && selType && !compact}
    {@const c = selNode.cfg}
    {@const op = selType.media}
    <aside class="insp" style:--c={CAT_COLOR[selType.cat]} aria-label="Ustawienia noda">
      <div class="ih">
        <Icon name={selType.icon} /><input class="title" bind:value={selNode.label} placeholder={selType.name} aria-label="Nazwa noda" />
        <button class="icobtn" title="Uruchom ten node" disabled={running} onclick={() => run(selNode!.id)}><Icon name="play" size={13} /></button>
        <button class="icobtn" title="Zamknij" onclick={() => (sel = null)}><Icon name="x" size={14} /></button>
      </div>
      {#if selType.desc}<p class="hint">{selType.desc}</p>{/if}

      {#if selType.ai || op}
        {#if op !== 'upscale' && op !== 'rmbg'}
          <div class="field"><label for="nBase">Prompt bazowy</label>
            <select class="inp" id="nBase" bind:value={selNode.cfg.base}>
              <option value="">—</option>
              {#each promptGroups as [g, list]}<optgroup label={g}>{#each list as p}<option value={p.id}>{p.name}</option>{/each}</optgroup>{/each}
            </select>
            {#if c.base && app.prompts.find((p) => p.id === c.base)}<pre class="code small">{app.prompts.find((p) => p.id === c.base)?.body}</pre>{/if}
          </div>
          <div class="field"><label for="nPrompt">Prompt</label><textarea class="inp" id="nPrompt" bind:value={selNode.cfg.prompt} placeholder={op ? 'Co ma powstać? {{input}} to tekst z poprzedniego noda.' : 'Doprecyzuj zadanie. {{input}} to wynik poprzedniego noda.'}></textarea></div>
        {/if}
      {/if}

      {#if op}
        {@const mp = mediaProviders()}
        {@const prov = mp.find((p) => p.id === c.provider) || mp.find((p) => p.hasKey && modelHints(p, op).length) || mp[0]}
        <div class="grid2">
          <div class="field"><label for="mProv">Provider</label>
            <select class="inp" id="mProv" bind:value={selNode.cfg.provider} onchange={() => (c.model = '')}>
              <option value="">Automatycznie</option>{#each mp as p}<option value={p.id} disabled={!modelHints(p, op).length && p.type !== 'fal' && p.type !== 'replicate'}>{p.name}</option>{/each}
            </select></div>
          <div class="field"><label for="mModel">Model</label>
            {#if prov?.type === 'comfy'}
              <select class="inp" id="mModel" bind:value={selNode.cfg.model}>
                <option value="">Automatycznie</option>
                {#each presetsFor(op) as m}<option value={m.id}>{m.name}{m.files.length && !installed(m) ? ' (do pobrania)' : ''}</option>{/each}
              </select>
            {:else}
              <input class="inp" id="mModel" list="mModels" bind:value={selNode.cfg.model} placeholder={modelHints(prov, op)[0] || 'id modelu'} spellcheck="false" />
              <datalist id="mModels">{#each modelHints(prov, op) as m}<option value={m}></option>{/each}</datalist>
            {/if}</div>
        </div>
        {#if prov?.type === 'comfy' && /127\.0\.0\.1|localhost/.test(prov.url) && (!local.inst || (presetById(c.model) && !installed(presetById(c.model)!)))}<p class="hint warn">Model lokalny trzeba najpierw pobrać: <button class="lnk" onclick={() => { ui.settingsPage = 'local'; ui.settingsOpen = true; }}>Ustawienia → Lokalne AI</button>.</p>{/if}
        {#if !mp.length}<p class="hint warn">Dodaj providera grafiki i wideo (fal.ai, Replicate, OpenAI, Google) w <button class="lnk" onclick={() => { ui.settingsPage = 'providers'; ui.settingsOpen = true; }}>Ustawienia → Providerzy</button>.</p>{/if}
        {#if op !== 'upscale' && op !== 'rmbg'}
          <div class="field"><span class="flabel">Proporcje</span><div class="seg asp">
            {#each ASPECTS as a}<button class:on={c.aspect === a} title={a} onclick={() => (c.aspect = a)}><i style:aspect-ratio={a.replace(':', ' / ')}></i></button>{/each}
          </div></div>
        {/if}
        <div class="grid3">
          <div class="field"><label for="mN">Wyniki</label><input class="inp" id="mN" type="number" min="1" max="8" bind:value={selNode.cfg.n} /></div>
          {#if isVideoOp(op)}<div class="field"><label for="mDur">Czas (s)</label><input class="inp" id="mDur" bind:value={selNode.cfg.duration} placeholder="auto" /></div>{/if}
          <div class="field"><label for="mSeed">Seed</label><input class="inp" id="mSeed" bind:value={selNode.cfg.seed} placeholder="los" /></div>
        </div>
        <details class="adv"><summary>Zaawansowane</summary>
          {#if op !== 'upscale' && op !== 'rmbg'}<div class="field"><label for="mNeg">Negatywny prompt</label><input class="inp" id="mNeg" bind:value={selNode.cfg.negative} /></div>{/if}
          {#if op !== 'image' && op !== 'video'}<div class="field"><label for="mKey">Pole obrazu wejściowego</label><input class="inp" id="mKey" bind:value={selNode.cfg.imageKey} placeholder="auto (np. image_url, image_urls[])" spellcheck="false" /></div>{/if}
          <div class="field"><label for="mPar">Parametry modelu (JSON)</label><textarea class="inp" id="mPar" bind:value={selNode.cfg.params} placeholder={'{"guidance_scale": 3.5}'} spellcheck="false"></textarea></div>
        </details>
      {:else if selType.ai}
        <div class="grid2">
          <div class="field"><label for="nProv">Provider</label>
            <select class="inp" id="nProv" bind:value={selNode.cfg.provider} onchange={() => (c.model = c.provider ? (app.providers.find((p) => p.id === c.provider)?.models[0] || '') : '')}>
              <option value="">Domyślny</option>{#each app.providers.filter(isChat) as p}<option value={p.id}>{p.name}</option>{/each}
            </select></div>
          <div class="field"><label for="nModel">Model</label>
            <select class="inp" id="nModel" bind:value={selNode.cfg.model} disabled={!c.provider}>
              {#if !c.provider}<option value="">{app.defModel.model}</option>{/if}
              {#each app.providers.find((p) => p.id === c.provider)?.models || [] as m}<option value={m}>{m}</option>{/each}
            </select></div>
        </div>
        <div class="field"><label for="nTemp">Temperatura <output>{c.temperature}</output></label><input type="range" id="nTemp" min="0" max="1" step="0.1" bind:value={selNode.cfg.temperature} disabled={isAnthropic(c.provider)} /></div>
        <div class="grid3">
          <div class="field"><label for="nMax">Tokeny</label><input class="inp" id="nMax" type="number" min="64" step="64" bind:value={selNode.cfg.maxTokens} /></div>
          <div class="field"><label for="nTopP">Top-p</label><input class="inp" id="nTopP" type="number" min="0" max="1" step="0.05" bind:value={selNode.cfg.topP} disabled={isAnthropic(c.provider)} /></div>
          <div class="field"><label for="nRes">Wyniki</label><input class="inp" id="nRes" type="number" min="1" max="10" bind:value={selNode.cfg.results} /></div>
        </div>
        <div class="field"><span class="flabel">Format</span><div class="seg">
          {#each [['text', 'Tekst'], ['json', 'JSON'], ['list', 'Lista']] as [v, l]}<button class:on={c.format === v} onclick={() => (c.format = v)}>{l}</button>{/each}
        </div></div>
      {:else}
        {#each selType.fields || [] as [k, l]}
          <div class="field"><label for="nf-{k}">{l}</label>
            {#if selType.id === 'media_in' && k === 'path'}
              <div class="row"><input class="inp" id="nf-{k}" bind:value={selNode.cfg[k]} spellcheck="false" /><button class="icobtn" title="Wybierz plik" onclick={pickFile}><Icon name="folder" size={14} /></button></div>
            {:else if selType.id === 'media_save' && k === 'dir'}
              <div class="row"><input class="inp" id="nf-{k}" bind:value={selNode.cfg[k]} spellcheck="false" /><button class="icobtn" title="Wybierz folder" onclick={pickDir}><Icon name="folder" size={14} /></button></div>
            {:else}
              <input class="inp" id="nf-{k}" bind:value={selNode.cfg[k]} spellcheck="false" />
            {/if}
          </div>
        {/each}
      {/if}

      {#if flowRun.media[selNode.id]?.length}
        <div class="gal">
          {#each flowRun.media[selNode.id] as m, i}
            <button title="Powiększ" onclick={() => (view = { list: flowRun.media[selNode!.id], i })}>{@render thumb(m)}</button>
          {/each}
        </div>
      {:else if flowRun.out[selNode.id] != null}
        <pre class="code small result" class:bad={flowRun.status[selNode.id] === 'err'}>{flowRun.out[selNode.id]}</pre>
      {/if}
      <div class="foot">
        {#if selType.ai || selType.media}<button class="icobtn" title="Zapisz jako własny node" onclick={saveAsType}><Icon name="save" size={14} /></button>{/if}
        <span class="spacer"></span>
        <button class="icobtn del" title="Usuń node (Delete)" onclick={delNode}><Icon name="trash" size={14} /></button>
      </div>
    </aside>
  {/if}
</div>

{#if view}
  {@const m = view.list[view.i]}
  <div class="lb" role="dialog" aria-modal="true" aria-label="Podgląd" tabindex="-1" use:focusMe
    onclick={(e) => { if (e.target === e.currentTarget) view = null; }}
    onkeydown={(e) => { if (e.key === 'Escape') view = null; if (e.key === 'ArrowRight') view!.i = (view!.i + 1) % view!.list.length; if (e.key === 'ArrowLeft') view!.i = (view!.i - 1 + view!.list.length) % view!.list.length; }}>
    {#if m.kind === 'video'}<video src={mediaSrc(m.path)} controls autoplay loop><track kind="captions" /></video>{:else}<img src={mediaSrc(m.path)} alt="" />{/if}
    <div class="lbbar">
      {#if view.list.length > 1}<span>{view.i + 1}/{view.list.length}</span>{/if}
      <button class="icobtn" title="Pokaż w folderze" onclick={() => reveal2(m.path)}><Icon name="folder" size={14} /></button>
      <button class="icobtn" title="Kopiuj ścieżkę" onclick={() => navigator.clipboard.writeText(m.path)}><Icon name="copy" size={14} /></button>
      <button class="icobtn" title="Zamknij (Esc)" onclick={() => (view = null)}><Icon name="x" size={14} /></button>
    </div>
  </div>
{/if}

<style>
  .wf { position: relative; display: grid; grid-template-columns: auto 1fr; min-height: 0; height: 100%; background: var(--term-bg); }
  .wf.compact { grid-template-columns: 1fr; }
  .pal { width: 196px; border-right: 1px solid var(--border); background: var(--card); display: flex; flex-direction: column; min-height: 0; }
  .pal.mini { width: 40px; align-items: center; padding-top: 8px; }
  .pal-h { display: flex; align-items: center; gap: 2px; padding: 8px 4px 4px 8px; }
  .pal-h .icobtn :global(svg) { transform: rotate(180deg); }
  .srch { flex: 1; display: flex; align-items: center; gap: 6px; padding: 0 8px; height: 28px; border-radius: 6px; background: var(--muted); color: var(--muted-foreground); min-width: 0; }
  .srch input { flex: 1; min-width: 0; border: 0; background: none; font: inherit; font-size: 12px; color: var(--foreground); outline: none; }
  .cats { overflow: auto; flex: 1; padding: 0 6px 10px; min-height: 0; }
  .cat-h { display: flex; align-items: center; gap: 6px; width: 100%; padding: 8px 4px 4px; font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted-foreground); font-weight: 600; }
  .cat-h :global(svg) { transform: rotate(90deg); transition: transform .12s; }
  .cat.closed .cat-h :global(svg) { transform: none; }
  .cat.closed .cat-b { display: none; }
  .cat-h .n { margin-left: auto; letter-spacing: 0; font-weight: 400; opacity: .7; }
  .cat-h i { width: 6px; height: 6px; border-radius: 50%; background: var(--c); }
  .pn { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 6px; border-radius: 5px; font-size: 12px; color: var(--muted-foreground); text-align: left; }
  .pn:hover { background: var(--accent); color: var(--foreground); }
  .pn :global(svg) { color: var(--c); }
  .canvas { position: relative; overflow: auto; min-height: 0; min-width: 0; }
  .surface { position: relative; width: 3000px; height: 2000px; background-image: radial-gradient(color-mix(in oklab, var(--muted-foreground) 30%, transparent) 1px, transparent 1px); background-size: 18px 18px; }
  .edges { position: absolute; left: 0; top: 0; width: 3000px; height: 2000px; pointer-events: none; }
  .edges path { fill: none; }
  .edges .vis { stroke: var(--muted-foreground); stroke-width: 1.5; opacity: .7; }
  .edges .vis.live { stroke: var(--primary); stroke-dasharray: 5 4; opacity: 1; animation: flow .6s linear infinite; }
  @keyframes flow { to { stroke-dashoffset: -9; } }
  .edges .hit { stroke: transparent; stroke-width: 12; pointer-events: stroke; cursor: pointer; }
  .edges g:hover .vis { stroke: var(--destructive); }
  .node { position: absolute; width: 172px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); font-size: 12px; user-select: none; box-shadow: 0 1px 2px rgb(0 0 0 / .08); }
  .node.vis { width: 232px; }
  .node header { display: flex; align-items: center; gap: 7px; padding: 7px 9px; font-weight: 500; cursor: grab; }
  .node header > :global(svg:first-child) { color: var(--c); }
  .node header span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .node .sum { padding: 0 9px 8px; color: var(--muted-foreground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pv { position: relative; margin: 0 6px 6px; border-radius: calc(var(--radius) - 2px); background: var(--muted); overflow: hidden; min-height: 60px; max-height: 260px; display: grid; }
  .pvb { display: block; width: 100%; }
  .pv :global(img), .pv :global(video) { display: block; width: 100%; max-height: 260px; object-fit: contain; background: var(--muted); }
  .more { position: absolute; right: 6px; bottom: 6px; font-size: 10.5px; padding: 1px 6px; border-radius: 99px; background: rgb(0 0 0 / .6); color: #fff; }
  .wait { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--muted-foreground); font-size: 11px; padding: 10px; text-align: center; opacity: .8; }
  .pv > .live, .pv > .over { grid-area: 1 / 1; }
  .wait.over { align-self: end; flex-direction: row; padding: 5px 8px; background: color-mix(in oklab, var(--card) 80%, transparent); color: var(--foreground); opacity: 1; }
  .wait.err { color: var(--destructive); opacity: 1; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; line-clamp: 5; }
  .spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid color-mix(in oklab, var(--primary) 25%, transparent); border-top-color: var(--primary); animation: rot .8s linear infinite; flex: none; }
  @keyframes rot { to { transform: rotate(360deg); } }
  .node.sel { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); }
  .node.ok { border-color: color-mix(in oklab, var(--chart-1) 60%, var(--border)); }
  .node.ok header :global(svg:last-child) { color: var(--chart-1); }
  .node.err { border-color: var(--destructive); }
  .node.err header :global(svg:last-child) { color: var(--destructive); }
  .node.skip { opacity: .55; }
  .port { position: absolute; top: 12px; width: 10px; height: 10px; border-radius: 50%; background: var(--card); border: 1.5px solid var(--c); padding: 0; }
  .port.in { left: -6px; }
  .port.out { right: -6px; cursor: crosshair; }
  .port.out:hover { background: var(--c); }
  .tools { position: absolute; right: 14px; top: 12px; z-index: 3; }
  .has-insp .tools { right: 302px; }
  .fab { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--primary); color: var(--primary-foreground); box-shadow: 0 6px 18px -8px var(--primary); }
  .fab:disabled { background: var(--card); border: 1px solid var(--border); cursor: default; }
  .fab :global(svg) { fill: currentColor; }
  .insp { position: absolute; right: 0; top: 0; bottom: 0; width: 290px; border-left: 1px solid var(--border); background: var(--card); overflow: auto; padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 12px; z-index: 4; box-shadow: -12px 0 30px -24px rgb(0 0 0 / .6); }
  .ih { display: flex; align-items: center; gap: 6px; }
  .ih > :global(svg) { color: var(--c); flex: none; }
  .ih .title { flex: 1; min-width: 0; font: inherit; font-weight: 600; background: none; border: 1px solid transparent; border-radius: 5px; padding: 3px 5px; color: inherit; }
  .ih .title:hover, .ih .title:focus { border-color: var(--border); outline: none; }
  .insp .inp { font-size: 12px; padding: 5px 7px; }
  .insp textarea.inp { min-height: 76px; font-family: var(--font-sans); font-size: 12px; }
  .insp .field > label { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--muted-foreground); font-weight: 500; }
  .insp .flabel { font-size: 11.5px !important; color: var(--muted-foreground); }
  .insp output { font-family: var(--font-mono); font-size: 11px; }
  .insp .seg button { padding: 3px 8px; }
  .asp button { width: 30px; height: 24px; justify-content: center; padding: 0 !important; }
  .asp i { display: block; height: 12px; max-width: 18px; border: 1.5px solid currentColor; border-radius: 2px; }
  .row { display: flex; gap: 4px; align-items: center; }
  .adv summary { cursor: pointer; font-size: 11.5px; color: var(--muted-foreground); }
  .adv[open] { display: flex; flex-direction: column; gap: 10px; }
  .hint.warn { color: var(--chart-3); }
  .lnk { color: var(--primary); text-decoration: underline; font-size: inherit; }
  pre.small { font-size: 10.5px; max-height: 110px; padding: 8px; }
  pre.result { max-height: 220px; }
  pre.bad { color: var(--destructive); }
  .gal { display: grid; grid-template-columns: repeat(auto-fill, minmax(78px, 1fr)); gap: 6px; }
  .gal button { border-radius: 6px; overflow: hidden; background: var(--muted); aspect-ratio: 1; }
  .gal :global(img), .gal :global(video) { width: 100%; height: 100%; object-fit: cover; display: block; }
  .foot { display: flex; align-items: center; margin-top: auto; }
  .foot .del:hover { color: var(--destructive); }
  .lb { position: fixed; inset: 0; z-index: 70; background: rgb(0 0 0 / .82); display: grid; place-items: center; padding: 40px 24px 64px; outline: none; }
  .lb img, .lb video { max-width: 100%; max-height: 100%; border-radius: 8px; box-shadow: 0 20px 60px -20px #000; }
  .lbbar { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 4px; padding: 4px; border-radius: 10px; background: var(--card); border: 1px solid var(--border); font-size: 12px; color: var(--muted-foreground); }
  .lbbar span { padding: 0 8px; font-variant-numeric: tabular-nums; }
</style>
