<script lang="ts">
  import Icon from '../../Icon.svelte';
  import { app, notify } from '../../state.svelte';
  import { call, isTauri } from '../../ipc';
  import { nid } from '../../util';
  import { catalogPresets, local, refreshLocal, fit, installed, presetSize, downloadPreset, removePreset, installComfy, startComfy, stopComfy, ensureProvider, inspectCustom, fileKey, GB } from '../../workflow/comfy.svelte';
  import type { MediaOp, Provider } from '../../types';
  import type { Preset } from '../../workflow/comfy.svelte';

  let busy = $state('');
  let showAll = $state(false);
  let log = $state<string[] | null>(null);
  let defDir = $state('');

  $effect(() => { refreshLocal(); if (isTauri) call<string>('comfy_default_dir').then((d) => (defDir = d)).catch(() => {}); });

  const gpu = $derived(local.hw?.gpus[0]);
  const gb = (b: number) => (b / GB < 10 ? (b / GB).toFixed(1) : Math.round(b / GB)).toString().replace('.', ',');
  const OPS: Record<MediaOp, [string, string]> = { image: ['image', 'Obraz'], edit: ['wand', 'Edycja'], video: ['film', 'Wideo'], i2v: ['clapper', 'Obraz → wideo'], upscale: ['maximize', 'Powiększenie'], rmbg: ['scissors', 'Usuwanie tła'] };
  const FIT = { ok: ['var(--chart-1)', 'Pasuje do tego komputera'], slow: ['var(--chart-3)', 'Zadziała wolniej (część modelu w RAM)'], no: ['var(--destructive)', 'Za mało pamięci na tym komputerze'], '?': ['var(--muted-foreground)', 'Nie znam wymagań'] } as const;
  const all = $derived(catalogPresets());

  // Zdalne serwery ComfyUI: zwykli providerzy typu comfy z adresem innym niż ten komputer.
  const remotes = $derived(app.providers.filter((p) => p.type === 'comfy' && p.id !== 'comfy'));
  let ping = $state<Record<string, boolean>>({});
  function addRemote() {
    const id = nid('comfy');
    app.providers.push({ id, type: 'comfy', name: 'ComfyUI (zdalny)', url: 'http://', keyRef: `provider:${id}`, hasKey: false, models: [] });
  }
  async function testRemote(p: Provider) {
    try {
      await call('media_request', { provider: { type: p.type, url: p.url, keyRef: p.keyRef }, method: 'GET', url: `${p.url.replace(/\/$/, '')}/system_stats`, body: null, multipart: null, headers: null });
      ping[p.id] = true;
    } catch (e) { ping[p.id] = false; notify(`${p.name}: ${String(e).replace(/^Error: /, '')}`, 'error'); }
  }
  const shown = $derived(all.filter((p) => showAll || fit(p) !== 'no' || installed(p)));
  const hidden = $derived(all.length - shown.length);
  const progressOf = (p: Preset) => {
    const act = p.files.map((m) => local.dl[fileKey(m)]).filter(Boolean);
    if (!act.length) return null;
    const err = act.find((d) => d.error);
    if (err) return { err: err.error };
    const done = p.files.reduce((s, m) => s + (local.have[fileKey(m)] === m.size ? m.size : local.dl[fileKey(m)]?.done || 0), 0);
    return { pct: Math.min(100, (done / presetSize(p)) * 100) };
  };

  async function run(label: string, fn: () => Promise<unknown>) {
    busy = label;
    try { await fn(); } catch (e) { notify(String(e).replace(/^Error: /, ''), 'error', 8000); } finally { busy = ''; }
  }
  const install = () => run('install', async () => { await installComfy((s) => (busy = s)); notify('ComfyUI zainstalowany', 'success'); });
  async function pickDir() {
    if (!isTauri) return;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const d = await open({ directory: true, defaultPath: app.local.comfyDir || undefined });
    if (typeof d !== 'string') return;
    const found = await call('comfy_find', { dir: d });
    if (!found) { notify('W tym folderze nie ma ComfyUI (szukam main.py albo wersji przenośnej).', 'warning'); return; }
    app.local.comfyDir = d;
    ensureProvider();
    refreshLocal();
  }
  async function toggleRun() {
    if (local.running) { await stopComfy(); return; }
    ensureProvider();
    run('start', async () => { await startComfy((s) => (busy = s)); });
  }
  async function openUi() {
    const p = app.providers.find((x) => x.type === 'comfy');
    const url = p?.url || `http://127.0.0.1:${app.local.port}`;
    if (!local.running) await run('start', () => startComfy((s) => (busy = s)));
    if (isTauri) { const { openUrl } = await import('@tauri-apps/plugin-opener'); await openUrl(url); }
  }
  async function showLog() {
    if (log) { log = null; return; }
    log = (await call<{ log: string[] }>('comfy_status')).log;
  }
  const get = (p: Preset) => run(p.id, async () => { ensureProvider(); await downloadPreset(p); notify(`Pobrano: ${p.name}`, 'success'); });
  function cancel(p: Preset) { for (const m of p.files) if (local.dl[fileKey(m)]) call('dl_cancel', { id: fileKey(m) }); }
  const del = (p: Preset) => run(p.id, () => removePreset(p));

  async function importJson() {
    if (!isTauri) return;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const f = await open({ multiple: false, filters: [{ name: 'Workflow ComfyUI (API)', extensions: ['json'] }] });
    if (typeof f !== 'string') return;
    try {
      const graph = JSON.parse(await call<string>('fs_read_text', { path: f }));
      const info = inspectCustom(graph);
      const op: MediaOp = info.video ? (info.images.length ? 'i2v' : 'video') : info.images.length ? 'edit' : 'image';
      const name = f.split(/[\\/]/).pop()!.replace(/\.json$/i, '');
      app.local.custom.push({ id: nid('cw'), name, op, graph, created: Date.now() });
      ensureProvider();
      notify(`Zaimportowano „${name}”${info.pos ? '' : ' (bez wykrytego promptu)'}`, 'success');
    } catch (e) { notify(String(e).replace(/^Error: /, ''), 'error', 8000); }
  }
</script>

<div class="pagehead"><h2>Lokalne AI</h2><div><button class="icobtn" title="Odśwież" onclick={() => refreshLocal()}><Icon name="refresh" /></button></div></div>
<p class="hint">Grafika i wideo na tym komputerze, bez opłat. ComfyUI startuje dopiero, gdy workflow go potrzebuje, i zamyka się po bezczynności. Lokalne zadania idą po kolei, więc na karcie jest zawsze jeden model (także względem Ollamy).</p>

<div class="hw">
  <span title="Karta graficzna"><Icon name="chip" size={14} />{gpu ? `${gpu.name} · ${gb(gpu.vramMb * 1024 * 1024)} GB` : local.hw ? 'Brak karty graficznej' : '…'}</span>
  <span title="Pamięć RAM"><Icon name="cpu" size={14} />{local.hw ? `${gb(local.hw.ramMb * 1024 * 1024)} GB RAM` : '…'}</span>
</div>

<div class="box">
  <div class="lrow">
    <span class="dot" title={local.running ? 'Działa' : local.inst ? 'Zatrzymany' : 'Nie zainstalowano'} style:background={local.running ? 'var(--chart-1)' : local.inst ? 'var(--muted-foreground)' : 'var(--chart-3)'}></span>
    <div class="info"><b>ComfyUI</b><small class="mono" title={local.inst?.comfy}>{local.inst?.comfy || (app.local.comfyDir ? `nie znaleziono w ${app.local.comfyDir}` : 'nie zainstalowano')}</small></div>
    <div class="acts">
      {#if !local.inst}<button class="icobtn" title="Zainstaluj ComfyUI (ok. 2 GB, do {app.local.comfyDir || defDir})" disabled={!!busy} onclick={install}><Icon name="download" /></button>{/if}
      <button class="icobtn" title="Wskaż folder z ComfyUI" onclick={pickDir}><Icon name="folder" /></button>
      {#if local.inst}
        <button class="icobtn" title={local.running ? 'Zatrzymaj' : 'Uruchom'} disabled={busy === 'start' || local.starting} onclick={toggleRun}><Icon name={local.running ? 'stop' : 'play'} /></button>
        <button class="icobtn" title="Otwórz edytor ComfyUI w przeglądarce" onclick={openUi}><Icon name="ext" /></button>
        <button class="icobtn" class:on={!!log} title="Log" onclick={showLog}><Icon name="list" /></button>
      {/if}
    </div>
  </div>
  {#if busy && !all.some((p) => p.id === busy)}
    <div class="prog"><span class="spin"></span>{busy === 'install' || busy === 'start' ? 'pracuję…' : busy}
      {#if local.dl.comfyui?.total}<progress max={local.dl.comfyui.total} value={local.dl.comfyui.done}></progress>{/if}</div>
  {/if}
  {#if log}<pre class="log">{log.slice(-80).join('\n') || 'Pusty log (ComfyUI nie był uruchamiany z aplikacji).'}</pre>{/if}
  <div class="grid3">
    <div class="field"><label for="lPort">Port</label><input class="inp" id="lPort" type="number" min="1024" max="65535" bind:value={app.local.port}
      onchange={() => { const p = app.providers.find((x) => x.type === 'comfy'); if (p && /127\.0\.0\.1|localhost/.test(p.url)) p.url = `http://127.0.0.1:${app.local.port}`; }} /></div>
    <div class="field"><label for="lIdle">Zamknij po bezczynności (min)</label><input class="inp" id="lIdle" type="number" min="0" bind:value={app.local.idleMin} title="0 = nie zamykaj" /></div>
    <div class="field"><label for="lArgs">Dodatkowe argumenty</label><input class="inp mono" id="lArgs" bind:value={app.local.args} placeholder="np. --lowvram" spellcheck="false" /></div>
  </div>
</div>

<div class="pagehead sec"><h3>Zdalny ComfyUI</h3><button class="icobtn" title="Dodaj serwer ComfyUI (inny komputer w sieci albo wynajęte GPU)" onclick={addRemote}><Icon name="plus" /></button></div>
<p class="hint">Mocniejszy komputer w sieci lokalnej albo serwer z GPU w chmurze (np. RunPod, Vast.ai) z uruchomionym ComfyUI. Pojawi się jako osobny provider w nodach grafiki i wideo; modele muszą być pobrane na tamtym serwerze.</p>
{#each remotes as p (p.id)}
  <div class="box rrow">
    <span class="dot" title={ping[p.id] === true ? 'Odpowiada' : ping[p.id] === false ? 'Nie odpowiada' : 'Nie sprawdzono'} style:background={ping[p.id] === true ? 'var(--chart-1)' : ping[p.id] === false ? 'var(--destructive)' : 'var(--muted-foreground)'}></span>
    <input class="inp" bind:value={p.name} aria-label="Nazwa" />
    <input class="inp mono" bind:value={p.url} placeholder="http://192.168.1.20:8188" aria-label="Adres" spellcheck="false" />
    <button class="icobtn" title="Sprawdź połączenie" onclick={() => testRemote(p)}><Icon name="refresh" size={14} /></button>
    <button class="icobtn" title="Usuń" onclick={() => (app.providers = app.providers.filter((x) => x.id !== p.id))}><Icon name="trash" size={14} /></button>
  </div>
{/each}

<div class="pagehead sec"><h3>Modele</h3>
  {#if hidden || showAll}<div><button class="icobtn" class:on={showAll} title={showAll ? 'Pokaż tylko pasujące do tego komputera' : `Pokaż też modele dla mocniejszych komputerów (${hidden})`} onclick={() => (showAll = !showAll)}><Icon name="eye" /></button></div>{/if}
</div>
<div class="list">
  {#each shown as p (p.id)}
    {@const st = progressOf(p)}
    {@const ok = installed(p)}
    {@const fv = fit(p)}
    <div class="lrow">
      <div class="picon"><Icon name={OPS[p.ops[0]][0]} /></div>
      <div class="info">
        <b>{p.name}</b>
        <small title={p.desc}>{p.desc}</small>
        {#if st?.pct != null}<progress max="100" value={st.pct}></progress>{:else if st?.err}<small class="err">{st.err}</small>{/if}
      </div>
      <div class="meta">
        {#each p.ops as op}<span class="op" title={OPS[op][1]}><Icon name={OPS[op][0]} size={13} /></span>{/each}
        <span class="chip" title="Rozmiar plików (wspólne pliki pobierają się raz)">{gb(presetSize(p))} GB</span>
        <span class="dot" title="{FIT[fv][1]}. Zalecane: {p.vram} GB karty, {p.ram} GB RAM." style:background={FIT[fv][0]}></span>
      </div>
      <div class="acts">
        {#if ok}<span class="okmark" title="Pobrany"><Icon name="check" size={14} /></span><button class="icobtn del" title="Usuń pliki modelu" disabled={busy === p.id} onclick={() => del(p)}><Icon name="trash" size={14} /></button>
        {:else if st?.pct != null}<button class="icobtn" title="Anuluj pobieranie" onclick={() => cancel(p)}><Icon name="x" size={14} /></button>
        {:else}<button class="icobtn" title={local.inst ? `Pobierz (${gb(presetSize(p))} GB)` : 'Najpierw zainstaluj ComfyUI'} disabled={!local.inst || !!busy} onclick={() => get(p)}><Icon name="download" size={14} /></button>{/if}
      </div>
    </div>
  {/each}
</div>

<div class="pagehead sec"><h3>Własne workflow</h3><button class="icobtn" title="Importuj workflow ComfyUI (Workflow → Export (API))" onclick={importJson}><Icon name="upload" /></button></div>
<p class="hint">Dowolny workflow z ComfyUI wyeksportowany jako API. Aplikacja podstawia prompt, obraz z wejścia, seed, proporcje i długość klipu.</p>
{#if app.local.custom.length}
  <div class="list">
    {#each app.local.custom as c (c.id)}
      <div class="lrow">
        <div class="picon"><Icon name={OPS[c.op][0]} /></div>
        <div class="info"><input class="inp name" bind:value={c.name} aria-label="Nazwa" /></div>
        <select class="inp opsel" bind:value={c.op} aria-label="Rodzaj">{#each Object.entries(OPS) as [k, [, l]]}<option value={k}>{l}</option>{/each}</select>
        <div class="acts"><button class="icobtn del" title="Usuń" onclick={() => app.local.custom.splice(app.local.custom.indexOf(c), 1)}><Icon name="trash" size={14} /></button></div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .hw { display: flex; gap: 18px; flex-wrap: wrap; color: var(--muted-foreground); font-size: 12px; }
  .hw span { display: inline-flex; align-items: center; gap: 6px; }
  .box { border: 1px solid var(--border); border-radius: var(--radius); padding: 2px 12px 10px; display: grid; gap: 8px; }
  .box .lrow { padding-left: 0; padding-right: 0; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .prog { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--muted-foreground); }
  progress { width: 100%; height: 4px; margin-top: 6px; accent-color: var(--primary); }
  .prog progress { margin: 0; flex: 1; }
  .log { max-height: 220px; overflow: auto; font-size: 11px; background: var(--muted); padding: 8px; border-radius: 6px; margin: 0; white-space: pre-wrap; }
  .pagehead.sec { margin-top: 6px; }
  .pagehead.sec h3 { margin: 0; }
  .op { color: var(--muted-foreground); display: grid; }
  .okmark { color: var(--chart-1); display: grid; padding: 0 4px; }
  .err { color: var(--destructive) !important; white-space: normal !important; }
  .rrow { display: flex; align-items: center; gap: 6px; padding: 6px 8px; margin-bottom: 6px; }
  .rrow .inp:first-of-type { width: 170px; flex: none; }
  .rrow .inp.mono { flex: 1; min-width: 0; }
  .name { height: 28px; }
  .opsel { width: auto; height: 28px; }
  .icobtn.on { color: var(--primary-ink); }
  .spin { width: 11px; height: 11px; border-radius: 50%; border: 1.5px solid color-mix(in oklab, var(--primary-ink) 25%, transparent); border-top-color: var(--primary-ink); animation: rot .8s linear infinite; flex: none; }
  @keyframes rot { to { transform: rotate(360deg); } }
</style>
