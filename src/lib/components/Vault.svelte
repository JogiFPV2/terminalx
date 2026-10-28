<script lang="ts">
  import Icon from '../Icon.svelte';
  import { app, ui, notify, deferClose } from '../state.svelte';
  import { DISTROS, newHost, openSsh, openSftp, saveSecret, generateKey, startForward, stopForward, forwardId, describe, sshState, disconnect, refresh } from '../hosts.svelte';
  import { call } from '../ipc';
  import { nid } from '../util';
  import type { Host, Forward } from '../types';

  let q = $state('');
  let view = $state<'grid' | 'list' | 'tree'>('grid');
  let edit = $state<Host | null>(null);
  let isNew = $state(false);
  let secret = $state('');
  let tagsText = $state('');
  let closedGroups = $state<Record<string, boolean>>({});

  const filtered = $derived(app.hosts.filter((h) => !q || `${h.name} ${h.host} ${h.user} ${h.group} ${h.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase())));
  const groups = $derived.by(() => {
    const g: Record<string, Host[]> = {};
    for (const h of filtered) (g[h.group || 'Bez grupy'] ||= []).push(h);
    return Object.entries(g).sort(([a], [b]) => (a === 'Bez grupy' ? 1 : b === 'Bez grupy' ? -1 : a.localeCompare(b)));
  });
  const groupNames = $derived([...new Set(app.hosts.map((h) => h.group).filter(Boolean))]);
  const distro = (h: Host) => (h.distro && DISTROS[h.distro]) || null;
  const connected = (h: Host) => sshState.connected.includes(h.id);

  function create() { edit = newHost(); isNew = true; secret = ''; tagsText = ''; }
  function open(h: Host) { edit = JSON.parse(JSON.stringify(h)); isNew = false; secret = ''; tagsText = h.tags.join(', '); }
  async function save() {
    if (!edit) return;
    if (!edit.host.trim() || !edit.user.trim()) { notify('Podaj adres hosta i użytkownika.', 'warning'); return; }
    edit.name = edit.name.trim() || edit.host.trim();
    edit.tags = tagsText.split(',').map((s) => s.trim()).filter(Boolean);
    edit.port = +edit.port || 22;
    try { await saveSecret(edit, secret); } catch (e) { notify(String(e), 'error'); return; }
    if (isNew) app.hosts.push(edit);
    else { const i = app.hosts.findIndex((h) => h.id === edit!.id); if (i >= 0) app.hosts[i] = edit; }
    edit = null;
  }
  function remove(h: Host) {
    const i = app.hosts.indexOf(h);
    deferClose(`Usunięto host „${h.name}”`, () => { app.hosts.splice(app.hosts.indexOf(h), 1); }, () => { app.hosts.splice(Math.min(i, app.hosts.length), 0, h); },
      () => { call('secret_delete', { keyRef: h.secretRef }).catch(() => {}); });
  }
  async function keygen() {
    try {
      const k = await generateKey();
      if (!k) return;
      if (edit) { edit.auth = 'key'; edit.keyPath = k.path; }
      await navigator.clipboard.writeText(k.pub).catch(() => {});
      notify(`Utworzono ${k.path}. Klucz publiczny jest w schowku: dopisz go do ~/.ssh/authorized_keys na serwerze.`, 'success', 12000);
    } catch (e) { notify(`Nie udało się utworzyć klucza: ${String(e).replace(/^Error: /, '')}`, 'error', 8000); }
  }
  function addForward() { edit?.forwards.push({ id: nid('fw'), kind: 'local', bindPort: 8080, targetHost: '127.0.0.1', targetPort: 80, auto: false }); }
  const active = (h: Host, f: Forward) => sshState.forwards.includes(forwardId(h, f));
  $effect(() => { refresh(); });
</script>

{#snippet card(h: Host)}
  {@const d = distro(h)}
  <div class="card" class:on={connected(h)} role="button" tabindex="0" ondblclick={() => openSsh(h.id)} onkeydown={(e) => e.key === 'Enter' && openSsh(h.id)}>
    <div class="top">
      <span class="os" style:--c={d?.c || 'var(--muted-foreground)'} title={d?.name || 'nieznany system'}>{d?.label || 'SSH'}</span>
      <div class="ttl"><b>{h.name}</b><small>{h.user}@{h.host}{h.port !== 22 ? `:${h.port}` : ''}</small></div>
      {#if connected(h)}<span class="sub" title="Połączony"></span>{/if}
    </div>
    {#if h.tags.length || h.forwards.length}
      <div class="tags">{#each h.tags as t}<span class="chip">{t}</span>{/each}{#if h.forwards.length}<span class="chip pri"><Icon name="ext" size={11} />{h.forwards.length}</span>{/if}</div>
    {/if}
    <div class="acts">
      <button class="btn pri" onclick={() => openSsh(h.id)}><Icon name="terminal" />SSH</button>
      <button class="btn" onclick={() => openSftp(h.id)}><Icon name="folder" />SFTP</button>
      <span class="spacer"></span>
      {#if connected(h)}<button class="icobtn" title="Rozłącz" onclick={() => disconnect(h.id)}><Icon name="x" size={14} /></button>{/if}
      <button class="icobtn" title="Edytuj" onclick={() => open(h)}><Icon name="edit" size={14} /></button>
      <button class="icobtn del" title="Usuń" onclick={() => remove(h)}><Icon name="trash" size={14} /></button>
    </div>
  </div>
{/snippet}

<div class="vault">
  <div class="bar">
    <h2>Hosty</h2>
    <div class="search"><Icon name="search" size={14} /><input bind:value={q} placeholder="Szukaj hostów, grup, tagów…" aria-label="Szukaj hostów" /></div>
    <div class="seg">
      <button class:on={view === 'grid'} onclick={() => (view = 'grid')} title="Siatka"><Icon name="tile" /></button>
      <button class:on={view === 'list'} onclick={() => (view = 'list')} title="Lista"><Icon name="list" /></button>
      <button class:on={view === 'tree'} onclick={() => (view = 'tree')} title="Drzewo grup"><Icon name="folder" /></button>
    </div>
    <span class="spacer"></span>
    <button class="icobtn" title="Nowy klucz SSH (ed25519)" onclick={keygen}><Icon name="key" /></button>
    <button class="icobtn" title="Nowy host" onclick={create}><Icon name="plus" /></button>
  </div>

  {#if !app.hosts.length}
    <div class="empty">
      <Icon name="hosts" size={28} />
      <p>Brak zapisanych hostów. Dodaj serwer, żeby łączyć się przez SSH, przeglądać pliki przez SFTP i przekierowywać porty.</p>
      <button class="btn pri" onclick={create}><Icon name="plus" />Dodaj pierwszy host</button>
    </div>
  {:else if view === 'grid'}
    <div class="grid">{#each filtered as h (h.id)}{@render card(h)}{/each}</div>
  {:else if view === 'list'}
    <div class="list">
      {#each filtered as h (h.id)}
        {@const d = distro(h)}
        <div class="lrow">
          <span class="os sm" style:--c={d?.c || 'var(--muted-foreground)'}>{d?.label || 'SSH'}</span>
          <div class="info"><b>{h.name}{#if connected(h)} <span class="sub"></span>{/if}</b><small class="mono">{h.user}@{h.host}:{h.port}</small></div>
          <div class="meta">{#if h.group}<span class="chip">{h.group}</span>{/if}{#each h.tags as t}<span class="chip">{t}</span>{/each}</div>
          <div class="acts">
            <button class="icobtn" title="SSH" onclick={() => openSsh(h.id)}><Icon name="terminal" size={14} /></button><button class="icobtn" title="SFTP" onclick={() => openSftp(h.id)}><Icon name="folder" size={14} /></button>
            <button class="icobtn" title="Edytuj" onclick={() => open(h)}><Icon name="edit" size={14} /></button>
            <button class="icobtn del" title="Usuń" onclick={() => remove(h)}><Icon name="trash" size={14} /></button>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    {#each groups as [g, list] (g)}
      <div class="group">
        <button class="gh" onclick={() => (closedGroups[g] = !closedGroups[g])}><span class="chev" class:open={!closedGroups[g]}><Icon name="chev" size={12} /></span><Icon name="folder" size={14} />{g}<span class="n">{list.length}</span></button>
        {#if !closedGroups[g]}<div class="grid">{#each list as h (h.id)}{@render card(h)}{/each}</div>{/if}
      </div>
    {/each}
  {/if}
</div>

{#if edit}
  <div class="overlay" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && (edit = null)}>
    <div class="dialog wide" role="dialog" aria-label="Host">
      <header>{isNew ? 'Nowy host' : `Edytuj „${edit.name}”`}<span class="spacer"></span><button class="icobtn" onclick={() => (edit = null)} title="Zamknij"><Icon name="x" /></button></header>
      <div class="body">
        <div class="grid2">
          <div class="field"><label for="hName">Nazwa</label><input class="inp" id="hName" bind:value={edit.name} placeholder="np. VPS produkcja" /></div>
          <div class="field"><label for="hGroup">Grupa</label><input class="inp" id="hGroup" bind:value={edit.group} list="groups" placeholder="np. Produkcja" />
            <datalist id="groups">{#each groupNames as g}<option value={g}></option>{/each}</datalist></div>
          <div class="field"><label for="hHost">Adres</label><input class="inp" id="hHost" bind:value={edit.host} placeholder="example.com albo 10.0.0.5" spellcheck="false" /></div>
          <div class="grid2 inner">
            <div class="field"><label for="hUser">Użytkownik</label><input class="inp" id="hUser" bind:value={edit.user} spellcheck="false" /></div>
            <div class="field"><label for="hPort">Port</label><input class="inp" id="hPort" type="number" min="1" max="65535" bind:value={edit.port} /></div>
          </div>
        </div>
        <div class="field"><span class="flabel">Uwierzytelnianie</span>
          <div class="seg"><button class:on={edit.auth === 'password'} onclick={() => (edit!.auth = 'password')}>Hasło</button><button class:on={edit.auth === 'key'} onclick={() => (edit!.auth = 'key')}>Klucz</button></div></div>
        {#if edit.auth === 'key'}
          <div class="grid2">
            <div class="field"><label for="hKey">Plik klucza prywatnego</label><input class="inp" id="hKey" bind:value={edit.keyPath} spellcheck="false" /></div>
            <div class="field"><label for="hSecret">Hasło klucza (jeśli jest)</label><input class="inp" id="hSecret" type="password" bind:value={secret} autocomplete="off" placeholder={edit.hasSecret ? 'zapisane; puste = bez zmian' : 'brak'} /></div>
          </div>
          <div><button class="btn" onclick={keygen}><Icon name="key" />Wygeneruj nowy klucz ed25519</button></div>
        {:else}
          <div class="field" style="max-width:320px"><label for="hPass">Hasło</label><input class="inp" id="hPass" type="password" bind:value={secret} autocomplete="off" placeholder={edit.hasSecret ? 'zapisane; puste = bez zmian' : ''} />
            <small>Zapis w Menedżerze poświadczeń Windows.</small></div>
        {/if}
        <div class="field"><label for="hTags">Tagi (po przecinku)</label><input class="inp" id="hTags" bind:value={tagsText} placeholder="docker, prod" /></div>
        <div class="field">
          <span class="flabel">Przekierowania portów</span>
          <div class="list">
            {#each edit.forwards as f, i (f.id)}
              <div class="lrow fw">
                <select class="inp" bind:value={f.kind} style="width:130px" aria-label="Rodzaj"><option value="local">Lokalne (-L)</option><option value="remote">Zdalne (-R)</option><option value="dynamic">SOCKS (-D)</option></select>
                <input class="inp" type="number" bind:value={f.bindPort} style="width:90px" aria-label="Port nasłuchu" title={f.kind === 'remote' ? 'Port na serwerze' : 'Port lokalny'} />
                {#if f.kind !== 'dynamic'}
                  <span class="arrow">→</span>
                  <input class="inp" bind:value={f.targetHost} style="flex:1" placeholder="host docelowy" aria-label="Host docelowy" />
                  <input class="inp" type="number" bind:value={f.targetPort} style="width:90px" aria-label="Port docelowy" />
                {:else}<span class="hint" style="flex:1">proxy SOCKS5 dla przeglądarki i narzędzi</span>{/if}
                <label class="checks"><input type="checkbox" bind:checked={f.auto} />auto</label>
                {#if !isNew && sshState.connected.includes(edit.id)}
                  {@const h = app.hosts.find((x) => x.id === edit!.id)}
                  {#if h}
                    {#if active(h, f)}<button class="btn" onclick={() => stopForward(h, f)}>Zatrzymaj</button>{:else}<button class="btn" onclick={() => startForward(edit!, f)}>Uruchom</button>{/if}
                  {/if}
                {/if}
                <button class="icobtn" title="Usuń" onclick={() => edit!.forwards.splice(i, 1)}><Icon name="trash" size={14} /></button>
              </div>
            {:else}
              <div class="lrow"><span class="hint">Brak. „auto” uruchamia przekierowanie przy połączeniu.</span></div>
            {/each}
          </div>
          <div><button class="btn" onclick={addForward}><Icon name="plus" />Dodaj przekierowanie</button></div>
        </div>
      </div>
      <footer><small>Nasłuch lokalny zawsze na 127.0.0.1.</small><button class="btn" onclick={() => (edit = null)}>Anuluj</button><button class="btn pri" onclick={save}>Zapisz</button></footer>
    </div>
  </div>
{/if}

<style>
  .vault { height: 100%; overflow: auto; padding: 18px 20px; display: flex; flex-direction: column; gap: 16px; background: var(--background); }
  .bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .bar h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .search { display: flex; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: 7px; padding: 4px 8px; color: var(--muted-foreground); background: var(--card); min-width: 240px; }
  .search input { border: 0; background: none; outline: none; color: var(--foreground); font: inherit; flex: 1; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
  .card { border: 1px solid var(--border); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 10px; background: var(--card); cursor: default; }
  .card:hover { border-color: color-mix(in oklab, var(--primary) 40%, var(--border)); }
  .card.on { border-color: color-mix(in oklab, var(--chart-1) 55%, var(--border)); }
  .top { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .os { width: 38px; height: 38px; border-radius: 9px; display: grid; place-items: center; font: 600 10px var(--font-mono); color: #fff; background: var(--c); flex: none; letter-spacing: .02em; }
  .os.sm { width: 30px; height: 30px; border-radius: 7px; font-size: 9px; }
  .ttl { min-width: 0; flex: 1; display: flex; flex-direction: column; }
  .ttl b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ttl small { color: var(--muted-foreground); font-family: var(--font-mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tags { display: flex; gap: 4px; flex-wrap: wrap; }
  .acts { display: flex; gap: 6px; align-items: center; }
  .icobtn.del:hover { color: var(--destructive); }
  .empty { display: grid; place-items: center; gap: 12px; padding: 60px 20px; color: var(--muted-foreground); text-align: center; }
  .empty p { margin: 0; max-width: 50ch; }
  .group { display: flex; flex-direction: column; gap: 8px; }
  .gh { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--muted-foreground); padding: 4px 0; }
  .gh .n { font-weight: 400; font-size: 11px; }
  .chev :global(svg) { transition: transform .12s; }
  .chev.open :global(svg) { transform: rotate(90deg); }
  .dialog.wide { width: min(720px, 100%); }
  .grid2.inner { gap: 8px; grid-template-columns: 1fr 100px; }
  .fw { flex-wrap: nowrap; gap: 6px; }
  .fw .inp { padding: 4px 6px; font-size: 12px; }
  .arrow { color: var(--muted-foreground); }
  .mono { font-family: var(--font-mono); }
</style>
