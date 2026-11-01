<script lang="ts">
  import Icon from '../Icon.svelte';
  import { app, ui, curWs, tabKind, findTab, notify } from '../state.svelte';
  import { agentState, sendToAgent, sendToSub, stopAgent, resolveApproval, newChat, ensureChatId, listChats, openChat, deleteChat, type ChatMeta } from '../agent.svelte';
  import { track, clamp } from '../util';
  import { PERM_LABEL, PROVIDER_TYPES, isChat } from '../defaults';
  import { resolveModel, listModels, usableKeys } from '../ai';
  import { prepare, fmtSize, saveAudio } from '../attach';
  import { voice, startRec, stopRec, cancelRec, transcribe, toggleSpeak, stopSpeaking } from '../voice.svelte';
  import { mediaSrc } from '../workflow/media';
  import { isTauri } from '../ipc';
  import Combo from './Combo.svelte';
  import type { Att } from '../types';

  const ws = $derived(curWs());
  const agent = $derived(app.agents.find((a) => a.id === ws.agentId) || app.agents.find((a) => a.kind === 'agent'));
  const subs = $derived(ws.tabs.filter((t) => t.subagent));
  let text = $state('');

  // Provider i model rozmowy: wybór w panelu (per workspace) albo ustawienia profilu agenta.
  const chatProviders = $derived(app.providers.filter(isChat));
  const eff = $derived.by(() => {
    try { return resolveModel(ws.chatModel?.provider || agent?.provider, ws.chatModel?.model || agent?.model); } catch { return null; }
  });
  // Podpowiedź: typ providera, a przy powtórzonej nazwie adres, żeby dało się je odróżnić.
  const providerItems = $derived(chatProviders.map((p) => {
    const twin = chatProviders.some((x) => x !== p && x.name === p.name);
    const type = PROVIDER_TYPES[p.type]?.label;
    return { value: p.id, label: p.name, hint: twin ? p.url.replace(/^https?:\/\//, '') : type === p.name ? '' : type };
  }));
  const fetched = $state<Record<string, string[]>>({});
  let loadingModels = $state(false);
  // Pozycja listy modeli to „provider␁model”: modele z gwiazdką (z każdego providera) są na górze.
  const SEP = '\u0001';
  const isStar = (pid: string, m: string) => app.starred.some((s) => s.provider === pid && s.model === m);
  const modelItems = $derived.by(() => {
    const p = eff?.p;
    if (!p) return [];
    const stars = app.starred.filter((s) => chatProviders.some((x) => x.id === s.provider))
      .map((s) => ({ value: s.provider + SEP + s.model, label: s.model, hint: s.provider === p.id ? '' : chatProviders.find((x) => x.id === s.provider)!.name }));
    const all = [...new Set([...(p.models || []), ...(fetched[p.id] || []), ...(p.id === app.defModel.provider ? [app.defModel.model] : [])])].filter((m) => m && !isStar(p.id, m));
    return [...stars, ...all.map((m) => ({ value: p.id + SEP + m, label: m, hint: p.models.includes(m) ? 'zapisany' : '' }))];
  });
  async function loadModels() {
    const p = eff?.p;
    if (!p || fetched[p.id] || loadingModels) return;
    loadingModels = true;
    try { fetched[p.id] = await listModels(p); } catch { fetched[p.id] = []; } finally { loadingModels = false; }
  }
  function pickProvider(id: string) {
    const r = resolveModel(id, null);
    ws.chatModel = { provider: r.p.id, model: r.model, key: null };
  }
  // Klucz zostaje przy zmianie modelu tego samego providera.
  const curKey = $derived(ws.chatModel ? ws.chatModel.key || null : agent?.provider === eff?.p.id ? agent?.key || null : null);
  function pickModel(v: string) {
    const [provider, model] = v.includes(SEP) ? v.split(SEP) : [eff?.p.id || '', v];
    if (provider) ws.chatModel = { provider, model, key: provider === eff?.p.id ? curKey : null };
  }
  // Klucz: widoczny, gdy provider ma ich kilka; „automatycznie” przełącza przy limicie.
  const keys = $derived(eff ? usableKeys(eff.p).filter((k) => k.hasKey) : []);
  const keyItems = $derived([{ value: 'auto', label: 'Automatycznie', hint: 'przełącza przy limicie' }, ...keys.map((k) => ({ value: k.id, label: k.name, hint: 'tylko ten klucz' }))]);
  function pickKey(v: string) {
    if (eff) ws.chatModel = { provider: eff.p.id, model: eff.model, key: v === 'auto' ? null : v };
  }
  function toggleStar(v: string) {
    const [provider, model] = v.split(SEP);
    const i = app.starred.findIndex((s) => s.provider === provider && s.model === model);
    if (i >= 0) app.starred.splice(i, 1); else app.starred.push({ provider, model });
  }

  // Adresat wiadomości: agent workspace'u albo podagent wybranej zakładki.
  let to = $state<Record<string, string>>({});
  const target = $derived(subs.some((t) => t.id === to[ws.id]) ? to[ws.id] : 'agent');
  const targetItems = $derived([{ value: 'agent', label: agent?.name || 'Agent', hint: 'agent' }, ...subs.map((t) => ({ value: t.id, label: t.title, hint: 'podagent' }))]);

  /* ---------- załączniki ---------- */

  interface Pending { id: number; name: string; size: number; preview: string; att?: Att; error?: string }
  let pending = $state<Record<string, Pending[]>>({});
  const cur = $derived(pending[ws.id] || []);
  const loadingAtt = $derived(cur.some((p) => !p.att && !p.error));
  let pid = 0;
  let fileInput = $state<HTMLInputElement>();
  let dragOver = $state(false);

  function addFiles(files: FileList | File[] | null | undefined) {
    const list = [...(files || [])];
    if (!list.length) return;
    const w = ws, chat = ensureChatId(w);
    if (!pending[w.id]) pending[w.id] = [];
    const arr = pending[w.id];   // reaktywna tablica (`||=` zwróciłoby surową)
    for (const f of list) {
      if (arr.length >= 20) { notify('Maksymalnie 20 załączników w jednej wiadomości.', 'warning'); break; }
      const p: Pending = { id: ++pid, name: f.name || 'wklejony obraz', size: f.size, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : '' };
      arr.push(p);
      prepare(f, chat).then((a) => { const x = pending[w.id]?.find((y) => y.id === p.id); if (x) x.att = a; })
        .catch((e) => { const x = pending[w.id]?.find((y) => y.id === p.id); if (x) x.error = String(e).replace(/^Error: /, ''); notify(`${p.name}: ${String(e).replace(/^Error: /, '')}`, 'error'); });
    }
  }
  function unattach(p: Pending) {
    if (p.preview) URL.revokeObjectURL(p.preview);
    pending[ws.id] = cur.filter((x) => x !== p);
  }
  function onDrop(e: DragEvent) {
    dragOver = false;
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  }
  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  function onPaste(e: ClipboardEvent) {
    const files = e.clipboardData?.files;
    if (files?.length) { e.preventDefault(); addFiles(files); }
  }

  let chatEl = $state<HTMLDivElement>();
  $effect(() => { void ws.chat.length; if (chatEl && view === 'chat') requestAnimationFrame(() => chatEl && (chatEl.scrollTop = chatEl.scrollHeight)); });

  function send() {
    const t = text.trim();
    if (loadingAtt) { notify('Poczekaj, załączniki jeszcze się zapisują.', 'info'); return; }
    const att = cur.filter((p) => p.att).map((p) => p.att!);
    if (!t && !att.length) return;
    text = '';
    for (const p of cur) if (p.preview) URL.revokeObjectURL(p.preview);
    pending[ws.id] = [];
    if (target === 'agent') sendToAgent(ws, t, att);
    else sendToSub(ws, target, t, att);
  }

  /* ---------- głos ---------- */

  let input = $state<HTMLTextAreaElement>();
  const recHere = $derived(voice.rec === ws.id);
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  async function mic() {
    if (voice.busy) return;
    if (!voice.rec) { startRec(ws.id); return; }
    const w = ws;
    const blob = await stopRec();
    if (!blob || blob.size < 1200) { notify('Nagranie jest puste.', 'info'); return; }
    try {
      const d = await transcribe(blob);
      if (!d.text) { notify('Nie rozpoznano mowy. Spróbuj bliżej mikrofonu.', 'warning'); return; }
      if (app.voice.keepAudio) {
        const att = await saveAudio(ensureChatId(w), d.blob, d.data);
        if (!pending[w.id]) pending[w.id] = [];
        pending[w.id].push({ id: ++pid, name: att.name, size: att.size, preview: '', att });
      }
      text = text.trim() ? `${text.trim()} ${d.text}` : d.text;
      if (app.voice.autoSend && w.id === ws.id) send();
      else input?.focus();
    } catch (e) { notify(String(e).replace(/^Error: /, ''), 'error'); }
  }
  let lastSpeak: 'agent' | 'all' = 'agent';
  function toggleRead() {
    if (app.voice.speak === 'off') app.voice.speak = lastSpeak;
    else { lastSpeak = app.voice.speak; app.voice.speak = 'off'; stopSpeaking(); }
  }

  function gutter(e: PointerEvent) {
    e.preventDefault();
    const sx = e.clientX, start = app.layout.agent;
    track((ev) => (app.layout.agent = clamp(start - (ev.clientX - sx), 260, 640)));
  }
  // Prosty markdown: bloki kodu i `kod`, reszta jako tekst.
  function md(s: string) {
    const esc = (x: string) => x.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
    // Nazwa języka tylko z nową linią po niej: w ```npm test``` pierwsze słowo to kod, nie język.
    return s.split(/```(?:[\w-]*\n)?([\s\S]*?)```/g).map((part, i) => i % 2 ? `<pre>${esc(part.trim())}</pre>` : esc(part).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>')).join('');
  }
  let lightbox = $state('');
  async function reveal(a: Att) {
    if (!a.path || !isTauri) return;
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    await revealItemInDir(a.path).catch((e) => notify(String(e), 'error'));
  }

  /* ---------- historia ---------- */

  let view = $state<'chat' | 'history'>('chat');
  let q = $state('');
  let onlyWs = $state(false);
  let list = $state<ChatMeta[]>([]);
  let listBusy = $state(false);
  let qTimer = 0;
  async function refresh() {
    listBusy = true;
    try { list = await listChats(q); } catch (e) { notify(String(e), 'error'); } finally { listBusy = false; }
  }
  function showHistory() {
    view = view === 'history' ? 'chat' : 'history';
    if (view === 'history') refresh();
  }
  $effect(() => { void q; clearTimeout(qTimer); if (view === 'history') qTimer = window.setTimeout(refresh, 250); });
  const shown = $derived(onlyWs ? list.filter((c) => c.wsId === ws.id) : list);
  async function open(c: ChatMeta) {
    try { await openChat(ws, c.id); view = 'chat'; } catch (e) { notify(String(e).replace(/^Error: /, ''), 'error'); }
  }
  async function remove(c: ChatMeta) {
    await deleteChat(c.id).catch((e) => notify(String(e), 'error'));
    list = list.filter((x) => x.id !== c.id);
  }
  // Czas jak w reszcie aplikacji: 24 h, bez zależności od języka WebView.
  function when(ms: number) {
    const d = new Date(ms), now = new Date(), two = (n: number) => String(n).padStart(2, '0');
    const time = `${d.getHours()}:${two(d.getMinutes())}`;
    if (d.toDateString() === now.toDateString()) return `dziś ${time}`;
    if (new Date(now.getTime() - 86400000).toDateString() === d.toDateString()) return `wczoraj ${time}`;
    return `${d.getDate()}.${two(d.getMonth() + 1)}${d.getFullYear() !== now.getFullYear() ? `.${d.getFullYear()}` : ''}`;
  }
</script>

<aside class="agent" style:width="{app.layout.agent}px" aria-label="Panel agenta"
  ondragover={(e) => { if (hasFiles(e)) { e.preventDefault(); dragOver = true; } }}
  ondragleave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) dragOver = false; }}
  ondrop={onDrop}>
  <div class="gutter" role="separator" aria-label="Szerokość panelu agenta" onpointerdown={gutter} ondblclick={() => (app.layout.agent = 320)}></div>
  <div class="head">
    <span class="ico"><Icon name="spark" /></span>
    <div class="who" title="{eff?.model || agent?.model} · {agent ? PERM_LABEL[agent.perm].toLowerCase() : ''}"><b>{view === 'history' ? 'Historia rozmów' : agent?.name}</b></div>
    <button class="icobtn" class:on={app.voice.speak !== 'off'} title={app.voice.speak === 'off' ? 'Czytaj odpowiedzi na głos' : 'Wyłącz czytanie odpowiedzi'} onclick={toggleRead}><Icon name="volume" size={14} /></button>
    <button class="icobtn" title="Nowa rozmowa (obecna zostaje w historii)" onclick={() => { newChat(ws); view = 'chat'; }}><Icon name="chatplus" size={14} /></button>
    <button class="icobtn" class:on={view === 'history'} title="Historia rozmów" onclick={showHistory}><Icon name="history" size={14} /></button>
    <button class="icobtn" title="Konfiguracja agentów" onclick={() => { ui.settingsPage = 'agents'; ui.settingsOpen = true; }}><Icon name="sliders" size={14} /></button>
  </div>

  {#if view === 'history'}
    <div class="hsearch">
      <div class="sbox"><Icon name="search" size={12} /><input bind:value={q} placeholder="Szukaj w rozmowach…" aria-label="Szukaj w rozmowach" spellcheck="false" />
        {#if listBusy}<span class="spin"></span>{/if}</div>
      <label class="only" title="Pokaż tylko rozmowy z tego workspace'u"><input type="checkbox" bind:checked={onlyWs} />Ten workspace</label>
    </div>
    <div class="hist">
      {#each shown as c (c.id)}
        <div class="hrow" class:cur={c.id === ws.chatId} role="button" tabindex="0" onclick={() => open(c)} onkeydown={(e) => e.key === 'Enter' && open(c)}>
          <div class="ht"><b>{c.title}</b><span class="hd">{when(c.updated)}</span></div>
          {#if c.preview}<div class="hp">{c.preview}</div>{/if}
          <div class="hm"><span>{c.ws}</span>{#each c.who as w}<span>{w}</span>{/each}<span>{c.count} wiad.</span></div>
          <button class="icobtn hdel" title="Usuń rozmowę z historii" onclick={(e) => { e.stopPropagation(); remove(c); }}><Icon name="trash" size={13} /></button>
        </div>
      {:else}
        <p class="empty">{q ? 'Nic nie pasuje.' : 'Brak zapisanych rozmów. Każda rozmowa z agentem i podagentami trafia tutaj sama.'}</p>
      {/each}
    </div>
  {:else}
  {#if subs.length}
  <div class="subs">
    {#each subs as t (t.id)}
      {@const k = tabKind(t)}
      <div class="subrow" title={app.agents.find((a) => a.id === t.subagent)?.name}><span class="sdot" class:busy={!!agentState.subBusy[t.id]}></span><span class="ki" style:color={k.c}><Icon name={k.icon} size={13} /></span><span class="nm">{t.title}</span><span class="st">{agentState.subBusy[t.id] || ''}</span></div>
    {/each}
  </div>
  {/if}
  <div class="chat" bind:this={chatEl}>
    {#if !ws.chat.length}
      <div class="intro">
        <p>Np. „Sprawdź, czemu testy w zakładce api nie przechodzą”. Możesz dołączyć zrzuty ekranu, wideo, PDF-y i pliki: spinacz, przeciągnięcie albo Ctrl+V.</p>
        {#if !app.providers.find((p) => p.id === (agent?.provider || app.defModel.provider))?.hasKey && app.providers.find((p) => p.id === (agent?.provider || app.defModel.provider))?.type !== 'ollama'}
          <button class="btn" onclick={() => { ui.settingsPage = 'providers'; ui.settingsOpen = true; }}><Icon name="key" />Klucz API</button>
        {/if}
      </div>
    {/if}
    {#each ws.chat as m (m.id)}
      <div class="msg {m.role}">
        <div class="mwho">{m.who}{#if m.text && (m.role === 'agent' || m.role === 'sub')}<button class="spk" class:on={voice.speaking === m.id} title={voice.speaking === m.id ? 'Zatrzymaj' : 'Przeczytaj na głos'} onclick={() => toggleSpeak(m)}><Icon name={voice.speaking === m.id ? 'stop' : 'volume'} size={11} /></button>{/if}</div>
        {#if m.att?.length}
          <div class="atts">
            {#each m.att as a}
              {#if a.kind === 'image' || a.kind === 'video'}
                <button class="thumb" title="{a.name} · {fmtSize(a.size)}{a.duration ? ` · ${a.duration} s` : ''}" onclick={() => (lightbox = a.path)}>
                  <img src={mediaSrc(a.path)} alt={a.name} loading="lazy" />{#if a.kind === 'video'}<span class="badge"><Icon name="film" size={11} />{a.frames?.length}</span>{/if}
                </button>
              {:else if a.kind === 'audio'}
                <audio class="aud" controls preload="none" src={mediaSrc(a.path)} title={a.name}></audio>
              {:else}
                <button class="fchip" title="{a.path || 'nie skopiowano'} · kliknij: pokaż w folderze" onclick={() => reveal(a)}><Icon name="file" size={12} /><span>{a.name}</span><small>{fmtSize(a.size)}</small></button>
              {/if}
            {/each}
          </div>
        {/if}
        {#if m.text}<div class="mtext">{@html md(m.text)}</div>{/if}
        {#if m.approve}
          <div class="approve">
            <span class="label">{m.approve.state === 'pending' ? 'Wymaga zgody' : m.approve.state === 'approved' ? 'Zatwierdzono' : 'Odrzucono'} · {(m.approve.tabId && findTab(m.approve.tabId)?.tab.title) || m.approve.label || ''}</span>
            <pre>{m.approve.command}</pre>
            {#if m.approve.state === 'pending'}
              <div class="row"><button class="btn pri" onclick={() => resolveApproval(ws, m.id, true)}>{m.approve.tabId ? 'Uruchom' : 'Zezwól'}</button><button class="btn" onclick={() => resolveApproval(ws, m.id, false)}>Odrzuć</button></div>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
    {#if agentState.busy[ws.id]}<div class="msg agent"><div class="typing"><span></span><span></span><span></span></div></div>{/if}
  </div>
  <div class="composer">
    {#if cur.length}
      <div class="pend">
        {#each cur as p (p.id)}
          <div class="pchip" class:err={!!p.error} title={p.error || `${p.name} · ${fmtSize(p.size)}`}>
            {#if p.preview}<img src={p.preview} alt="" />{:else}<Icon name={p.att?.kind === 'video' ? 'film' : p.att?.kind === 'audio' ? 'mic' : 'file'} size={12} />{/if}
            <span>{p.name}</span>
            {#if !p.att && !p.error}<span class="spin"></span>{/if}
            <button class="px" title="Usuń załącznik" onclick={() => unattach(p)}><Icon name="x" size={11} /></button>
          </div>
        {/each}
      </div>
    {/if}
    {#if recHere || voice.busy}
      <div class="recbar" role="status">
        {#if voice.busy}<span class="spin"></span><span>Zamieniam mowę na tekst…</span>
        {:else}
          <span class="dot"></span><span class="tm">{clock(voice.secs)}</span>
          <span class="lvl"><i style:width="{Math.round(voice.level * 100)}%"></i></span>
          <span class="rh">{app.voice.autoSend ? 'kliknij mikrofon, żeby wysłać' : 'kliknij mikrofon, żeby wstawić tekst'}</span>
          <button class="icobtn" title="Anuluj nagranie (Esc)" onclick={cancelRec}><Icon name="x" size={13} /></button>
        {/if}
      </div>
    {/if}
    <div class="box">
      <button class="icobtn clip" title="Dołącz pliki: obrazy, wideo, PDF, kod… (albo przeciągnij / Ctrl+V)" onclick={() => fileInput?.click()}><Icon name="clip" size={15} /></button>
      <input type="file" multiple hidden bind:this={fileInput} onchange={(e) => { addFiles(e.currentTarget.files); e.currentTarget.value = ''; }} />
      <textarea bind:this={input} bind:value={text} rows="1" placeholder={target === 'agent' ? 'Zleć coś agentowi…' : `Napisz do podagenta „${subs.find((t) => t.id === target)?.title}”…`} aria-label="Wiadomość do agenta"
        onpaste={onPaste} onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}></textarea>
      <button class="icobtn mic" class:rec={recHere} disabled={voice.busy || (!!voice.rec && !recHere)}
        title={recHere ? (app.voice.autoSend ? 'Zakończ i wyślij' : 'Zakończ i wstaw tekst') : 'Dyktuj (mowa na tekst)'} onclick={mic}><Icon name={recHere ? 'square' : 'mic'} size={15} /></button>
      {#if agentState.busy[ws.id]}
        <button class="icobtn" title="Zatrzymaj" onclick={() => stopAgent(ws.id)}><Icon name="stop" /></button>
      {:else}
        <button class="icobtn" title="Wyślij (Enter)" onclick={send}><Icon name="send" /></button>
      {/if}
    </div>
    <div class="pick">
      {#if subs.length}
        <Combo value={target} label={target === 'agent' ? (agent?.name || 'Agent') : `→ ${subs.find((t) => t.id === target)?.title}`} icon={target === 'agent' ? 'spark' : 'bot'} title="Adresat wiadomości" placeholder="Agent albo podagent…"
          items={targetItems} onpick={(v) => (to[ws.id] = v)} />
      {/if}
      <Combo value={eff?.p.id || ''} label={eff?.p.name || 'Brak providera'} icon="bot" title="Provider" placeholder="Szukaj providera…"
        items={providerItems}
        onpick={pickProvider} />
      {#if keys.length > 1}
        <Combo value={curKey || 'auto'} label={keys.find((k) => k.id === curKey)?.name || 'Auto'} icon="key" title="Klucz API (automatycznie: przełącza przy limicie)" placeholder="Szukaj klucza…"
          items={keyItems} onpick={pickKey} />
      {/if}
      <Combo value={eff ? eff.p.id + SEP + eff.model : ''} label={eff?.model || '—'} icon="spark" title="Model (gwiazdka: na górę listy)" placeholder="Szukaj albo wpisz model…" custom={true}
        items={modelItems} loading={loadingModels} onopen={loadModels} onpick={pickModel}
        starred={(v) => { const [p, m] = v.split(SEP); return isStar(p, m); }} onstar={toggleStar} />
      {#if ws.chatModel}
        <button class="icobtn reset" title="Wróć do ustawień agenta ({agent?.model || 'domyślny'})" onclick={() => (ws.chatModel = null)}><Icon name="undo" size={12} /></button>
      {/if}
    </div>
  </div>
  {/if}
  {#if dragOver}<div class="drop"><Icon name="clip" size={22} /><span>Upuść, żeby dołączyć do wiadomości</span></div>{/if}
  {#if lightbox}
    <div class="lightbox" role="presentation" onclick={() => (lightbox = '')}><img src={mediaSrc(lightbox)} alt="Podgląd załącznika" /></div>
  {/if}
</aside>

<svelte:window onkeydown={(e) => {
  if (e.key !== 'Escape') return;
  if (lightbox) { lightbox = ''; e.stopPropagation(); }
  else if (voice.rec) { cancelRec(); e.stopPropagation(); }
}} />

<style>
  .ki { display: grid; flex: none; }
  .agent { border-left: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; background: var(--background); position: relative; flex: none; }
  .gutter { position: absolute; top: 0; bottom: 0; left: -4px; width: 7px; z-index: 6; cursor: col-resize; }
  .gutter:hover { background: linear-gradient(90deg, transparent 2px, var(--primary) 2px, var(--primary) 4px, transparent 4px); }
  .head { display: flex; align-items: center; gap: 8px; padding: 10px 8px 10px 12px; border-bottom: 1px solid var(--border); min-width: 0; }
  .head .icobtn.on { color: var(--primary); background: var(--muted); }
  .ico { color: var(--primary); display: grid; }
  .who { min-width: 0; flex: 1; display: flex; flex-direction: column; }
  .who b { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .subs { padding: 10px 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; max-height: 160px; overflow: auto; }
  .subrow { display: flex; align-items: center; gap: 8px; font-size: 12px; min-width: 0; }
  .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st { margin-left: auto; color: var(--muted-foreground); font-size: 11px; white-space: nowrap; }
  .chat { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
  .intro { color: var(--muted-foreground); font-size: 12.5px; line-height: 1.55; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
  .intro p { margin: 0; }
  .msg { font-size: 12.5px; line-height: 1.5; min-width: 0; }
  .mwho { font-size: 11px; color: var(--muted-foreground); margin-bottom: 2px; display: flex; align-items: center; gap: 4px; min-height: 18px; }
  .msg.user { align-self: flex-end; background: var(--muted); padding: 7px 10px; border-radius: 8px; max-width: 88%; }
  .msg.sub .mtext { border-left: 2px solid var(--border); padding-left: 8px; }
  .msg.error .mtext { color: var(--destructive); }
  .msg.system .mtext { color: var(--muted-foreground); font-style: italic; }
  .mtext { overflow-wrap: anywhere; }
  .mtext :global(code) { font-family: var(--font-mono); font-size: 11.5px; background: var(--muted); padding: 1px 4px; border-radius: 4px; }
  .mtext :global(pre), .approve pre { margin: 6px 0 0; font-family: var(--font-mono); font-size: 11.5px; background: var(--term-bg); border: 1px solid var(--border); padding: 6px 8px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; }
  .approve { border: 1px solid var(--border); border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
  .approve .row { display: flex; gap: 6px; }
  .typing { display: flex; gap: 4px; padding: 6px 0; }
  .typing span { width: 6px; height: 6px; border-radius: 50%; background: var(--muted-foreground); animation: pulse 1s infinite; }
  .typing span:nth-child(2) { animation-delay: .2s; } .typing span:nth-child(3) { animation-delay: .4s; }
  .atts { display: flex; flex-wrap: wrap; gap: 4px; margin: 2px 0 4px; }
  .thumb { position: relative; width: 64px; height: 64px; border-radius: 6px; overflow: hidden; border: 1px solid var(--border); padding: 0; background: var(--card); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .badge { position: absolute; right: 2px; bottom: 2px; display: flex; align-items: center; gap: 2px; font-size: 10px; padding: 1px 3px; border-radius: 4px; background: rgb(0 0 0 / .6); color: #fff; }
  .fchip, .pchip { display: flex; align-items: center; gap: 5px; max-width: 100%; min-width: 0; font-size: 11.5px; border: 1px solid var(--border); border-radius: 6px; padding: 3px 6px; background: var(--card); color: var(--foreground); }
  .fchip span, .pchip span:not(.spin) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .fchip small { color: var(--muted-foreground); flex: none; }
  .composer { border-top: 1px solid var(--border); padding: 10px; }
  .pend { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
  .pchip { max-width: 180px; padding: 2px 3px 2px 4px; }
  .pchip img { width: 20px; height: 20px; object-fit: cover; border-radius: 3px; flex: none; }
  .pchip.err { border-color: var(--destructive); color: var(--destructive); }
  .px { display: grid; place-items: center; width: 16px; height: 16px; border-radius: 4px; color: var(--muted-foreground); flex: none; }
  .px:hover { background: var(--muted); color: var(--foreground); }
  .pick { display: flex; align-items: center; gap: 2px; margin-top: 4px; min-width: 0; }
  .pick :global(.combo) { flex: 0 1 auto; }
  .reset { width: 22px; height: 22px; color: var(--muted-foreground); }
  .box { display: flex; align-items: flex-end; gap: 4px; border: 1px solid var(--border); border-radius: 8px; padding: 6px 6px 6px 4px; background: var(--card); }
  .clip, .mic { color: var(--muted-foreground); }
  .mic.rec { color: var(--destructive); }
  .recbar { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; padding: 4px 4px 4px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 11.5px; color: var(--muted-foreground); min-width: 0; }
  .recbar .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--destructive); animation: pulse 1.2s infinite; flex: none; }
  .recbar .tm { font-variant-numeric: tabular-nums; color: var(--foreground); flex: none; }
  .lvl { width: 48px; height: 4px; border-radius: 2px; background: var(--muted); overflow: hidden; flex: none; }
  .lvl i { display: block; height: 100%; background: var(--primary); transition: width .08s linear; }
  .rh { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .recbar .icobtn { width: 22px; height: 22px; margin-left: auto; }
  .aud { height: 30px; max-width: 100%; }
  .spk { display: grid; place-items: center; width: 18px; height: 18px; border-radius: 4px; color: var(--muted-foreground); opacity: 0; }
  .msg:hover .spk, .spk.on, .spk:focus-visible { opacity: 1; }
  .spk:hover { background: var(--muted); color: var(--foreground); }
  .spk.on { color: var(--primary); }
  textarea { flex: 1; min-width: 0; background: none; border: 0; color: inherit; font: inherit; outline: none; resize: none; max-height: 140px; field-sizing: content; padding: 3px 0; }
  .spin { width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid var(--muted-foreground); border-top-color: transparent; animation: spin .8s linear infinite; flex: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .drop { position: absolute; inset: 6px; z-index: 20; border: 1.5px dashed var(--primary); border-radius: 10px; background: color-mix(in srgb, var(--background) 88%, transparent); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--primary); font-size: 12.5px; pointer-events: none; }
  .lightbox { position: fixed; inset: 0; z-index: 80; background: rgb(0 0 0 / .75); display: grid; place-items: center; cursor: zoom-out; padding: 24px; }
  .lightbox img { max-width: 100%; max-height: 100%; border-radius: 6px; box-shadow: 0 20px 60px rgb(0 0 0 / .5); }
  .hsearch { padding: 10px 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; }
  .sbox { display: flex; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: 7px; padding: 5px 8px; background: var(--card); color: var(--muted-foreground); }
  .sbox input { flex: 1; min-width: 0; background: none; border: 0; outline: none; color: var(--foreground); font: inherit; font-size: 12.5px; }
  .only { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted-foreground); }
  .hist { flex: 1; overflow: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px; min-height: 0; }
  .hrow { position: relative; padding: 7px 30px 7px 8px; border-radius: 7px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .hrow:hover { background: var(--muted); }
  .hrow.cur { background: var(--accent); }
  .ht { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
  .ht b { font-weight: 600; font-size: 12.5px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hd { font-size: 10.5px; color: var(--muted-foreground); flex: none; }
  .hp { font-size: 11.5px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hm { display: flex; flex-wrap: wrap; gap: 4px; font-size: 10.5px; color: var(--muted-foreground); }
  .hm span { border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hdel { position: absolute; right: 4px; top: 6px; width: 22px; height: 22px; opacity: 0; }
  .hrow:hover .hdel, .hdel:focus-visible { opacity: 1; }
  .empty { color: var(--muted-foreground); font-size: 12px; margin: 8px 6px; line-height: 1.5; }
</style>
