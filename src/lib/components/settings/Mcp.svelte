<script lang="ts">
  import Icon from '../../Icon.svelte';
  import { app, notify } from '../../state.svelte';
  import { call } from '../../ipc';
  import { nid } from '../../util';
  import { connect, disconnect, mcpStatus, parseImport, splitArgs, joinArgs } from '../../mcp.svelte';
  import type { McpServer } from '../../types';

  let edit = $state<McpServer | null>(null);
  let isNew = $state(false);
  let argsText = $state('');
  let envText = $state('');
  let headersText = $state('');
  let token = $state('');
  let importing = $state(false);
  let importText = $state('');
  let testing = $state<Record<string, boolean>>({});

  const lines = (o: Record<string, string>, sep: string) => Object.entries(o).map(([k, v]) => `${k}${sep}${v}`).join('\n');
  function parseLines(t: string, sep: RegExp) {
    const out: Record<string, string> = {};
    for (const l of t.split(/\r?\n/)) { const m = l.match(sep); if (m && m[1].trim()) out[m[1].trim()] = m[2].trim(); }
    return out;
  }

  function create() {
    const id = nid('mcp');
    edit = { id, name: '', kind: 'stdio', command: 'npx', args: [], env: {}, cwd: '', url: '', headers: {}, keyRef: `mcp:${id}`, hasKey: false, secretEnv: '', enabled: true };
    isNew = true; argsText = '-y '; envText = ''; headersText = ''; token = '';
  }
  function open(s: McpServer) {
    edit = JSON.parse(JSON.stringify(s)); isNew = false;
    argsText = joinArgs(s.args); envText = lines(s.env, '='); headersText = lines(s.headers, ': '); token = '';
  }
  async function save() {
    if (!edit) return;
    if (!edit.name.trim()) { notify('Podaj nazwę serwera.', 'warning'); return; }
    if (edit.kind === 'stdio' && !edit.command.trim()) { notify('Podaj komendę, np. npx.', 'warning'); return; }
    if (edit.kind === 'http' && !/^https?:\/\//.test(edit.url.trim())) { notify('Adres musi zaczynać się od http:// albo https://', 'warning'); return; }
    edit.args = splitArgs(argsText);
    edit.env = parseLines(envText, /^([^=]+)=(.*)$/);
    edit.headers = parseLines(headersText, /^([^:]+):(.*)$/);
    try {
      if (token.trim()) { await call('secret_set', { keyRef: edit.keyRef, value: token.trim() }); edit.hasKey = true; }
    } catch (e) { notify(String(e), 'error'); return; }
    if (isNew) app.mcp.push(edit);
    else { const i = app.mcp.findIndex((s) => s.id === edit!.id); if (i >= 0) app.mcp[i] = edit; }
    const id = edit.id;
    edit = null; token = '';
    const s = app.mcp.find((x) => x.id === id)!;
    if (s.enabled) test(s);
  }
  async function test(s: McpServer) {
    testing[s.id] = true;
    try { await connect(s); } catch { /* błąd trafia do mcpStatus */ } finally { testing[s.id] = false; }
  }
  async function toggle(s: McpServer) {
    s.enabled = !s.enabled;
    if (s.enabled) test(s);
    else { await disconnect(s.id); delete mcpStatus[s.id]; }
  }
  async function remove(s: McpServer) {
    await disconnect(s.id);
    if (s.hasKey) await call('secret_delete', { keyRef: s.keyRef }).catch(() => {});
    app.mcp.splice(app.mcp.findIndex((x) => x.id === s.id), 1);
    for (const a of app.agents) if (a.mcp) a.mcp = a.mcp.filter((x) => x !== s.id);
    delete mcpStatus[s.id];
  }
  async function forgetToken(s: McpServer) { await call('secret_delete', { keyRef: s.keyRef }).catch(() => {}); s.hasKey = false; }
  function doImport() {
    try {
      const list = parseImport(importText);
      if (!list.length) { notify('Nie znalazłem serwerów w tym JSON-ie.', 'warning'); return; }
      for (const x of list) {
        const id = nid('mcp');
        const s: McpServer = { ...x, id, keyRef: `mcp:${id}`, hasKey: false };
        app.mcp.push(s);
        if (s.enabled) test(app.mcp[app.mcp.length - 1]);
      }
      notify(`Dodano serwery MCP: ${list.map((x) => x.name).join(', ')}`, 'success');
      importing = false; importText = '';
    } catch (e) { notify(`Niepoprawny JSON: ${String(e).replace(/^\w*Error: /, '')}`, 'error'); }
  }
</script>

<div class="pagehead"><h2>Serwery MCP</h2>
  <div><button class="btn" onclick={() => (importing = !importing)}><Icon name="braces" />Importuj JSON</button><button class="icobtn" title="Dodaj serwer" onclick={create}><Icon name="plus" /></button></div>
</div>
<p class="hint">Serwery MCP dają agentom i podagentom dodatkowe narzędzia: GitHub, bazy danych, przeglądarka, pliki, dokumentacja. Serwer lokalny startuje przy pierwszym użyciu i kończy się z aplikacją. W trybie „Pytaj przed komendą” każde narzędzie, które coś zmienia, czeka na Twoją zgodę. Profil „Tylko odczyt” dostaje tylko narzędzia oznaczone przez serwer jako bezpieczne. Które serwery widzi dany profil, ustawisz w Ustawienia → Agenci.</p>

{#if importing}
  <div class="form">
    <h3 style="margin:0">Import konfiguracji</h3>
    <p class="hint">Wklej JSON z Claude Desktop, Claude Code (.mcp.json), Cursora albo VS Code, np. <code>{'{"mcpServers": {"github": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"]}}}'}</code>. Tokeny przenieś potem do pola „Token”: tam trafiają do Menedżera poświadczeń, a zmienne środowiskowe są zapisywane w pliku stanu.</p>
    <textarea class="inp mono" rows="7" bind:value={importText} spellcheck="false" aria-label="JSON z konfiguracją serwerów MCP"></textarea>
    <div class="formbtns"><button class="btn" onclick={() => (importing = false)}>Anuluj</button><button class="btn pri" onclick={doImport}>Importuj</button></div>
  </div>
{/if}

{#if edit}
  <div class="form">
    <h3 style="margin:0">{isNew ? 'Nowy serwer MCP' : 'Edytuj serwer MCP'}</h3>
    <div class="grid2">
      <div class="field"><label for="mName">Nazwa</label><input class="inp" id="mName" bind:value={edit.name} placeholder="np. github" /></div>
      <div class="field"><span class="flabel">Rodzaj</span>
        <div class="seg"><button class:on={edit.kind === 'stdio'} onclick={() => (edit!.kind = 'stdio')}>Lokalny (komenda)</button><button class:on={edit.kind === 'http'} onclick={() => (edit!.kind = 'http')}>Zdalny (HTTP)</button></div></div>
      {#if edit.kind === 'stdio'}
        <div class="field"><label for="mCmd">Komenda</label><input class="inp mono" id="mCmd" bind:value={edit.command} placeholder="npx, uvx, node, python, ścieżka do .exe" spellcheck="false" /></div>
        <div class="field"><label for="mArgs">Argumenty</label><input class="inp mono" id="mArgs" bind:value={argsText} placeholder={'-y @modelcontextprotocol/server-filesystem "C:\\Projekty"'} spellcheck="false" /></div>
        <div class="field"><label for="mCwd">Folder roboczy (opcjonalnie)</label><input class="inp mono" id="mCwd" bind:value={edit.cwd} spellcheck="false" /></div>
        <div class="field"><label for="mSecEnv">Zmienna na token</label><input class="inp mono" id="mSecEnv" bind:value={edit.secretEnv} placeholder="np. GITHUB_PERSONAL_ACCESS_TOKEN (domyślnie API_KEY)" spellcheck="false" /></div>
      {:else}
        <div class="field" style="grid-column:1/-1"><label for="mUrl">Adres serwera (Streamable HTTP)</label><input class="inp mono" id="mUrl" bind:value={edit.url} placeholder="https://example.com/mcp" spellcheck="false" /></div>
      {/if}
      <div class="field"><label for="mTok">Token (opcjonalnie)</label>
        <input class="inp" id="mTok" type="password" autocomplete="off" bind:value={token} placeholder={edit.hasKey ? 'zapisany; zostaw puste, żeby nie zmieniać' : edit.kind === 'http' ? 'wysyłany jako Authorization: Bearer' : 'trafia do zmiennej powyżej'} /></div>
    </div>
    <div class="checks"><label title="Serwer sam oznacza narzędzia jako tylko do odczytu. Włącz tylko dla serwera, któremu ufasz."><input type="checkbox" bind:checked={edit.trustReadOnly} />Ufaj oznaczeniu „tylko do odczytu”: takie narzędzia działają bez pytania w trybie „pytaj” i są dostępne w profilach tylko do odczytu</label></div>
    {#if edit.kind === 'stdio'}
      <div class="field"><label for="mEnv">Zmienne środowiskowe (KLUCZ=wartość, po jednej w linii)</label><textarea class="inp mono" id="mEnv" rows="3" bind:value={envText} spellcheck="false"></textarea></div>
    {:else}
      <div class="field"><label for="mHead">Nagłówki (Nazwa: wartość, po jednym w linii)</label><textarea class="inp mono" id="mHead" rows="3" bind:value={headersText} spellcheck="false"></textarea></div>
    {/if}
    <div class="formbtns"><button class="btn" onclick={() => (edit = null)}>Anuluj</button><button class="btn pri" onclick={save}>Zapisz i połącz</button></div>
  </div>
{/if}

<div class="list">
  {#each app.mcp as s (s.id)}
    {@const st = mcpStatus[s.id]}
    <div class="lrow">
      <div class="picon"><Icon name="server" /></div>
      <div class="info"><b>{s.name} <span class="chip">{s.kind === 'stdio' ? 'lokalny' : 'HTTP'}</span></b>
        <small class="mono">{s.kind === 'stdio' ? `${s.command} ${joinArgs(s.args)}` : s.url}</small>
        {#if st?.error}<small class="err" title={st.error}>{st.error}</small>
        {:else if st?.tools}<small title={st.tools.map((t) => t.name).join(', ')}>{st.tools.length} narzędzi: {st.tools.slice(0, 6).map((t) => t.name).join(', ')}{st.tools.length > 6 ? '…' : ''}</small>{/if}
      </div>
      <div class="meta">
        {#if testing[s.id]}<span class="spin" title="Łączę…"></span>
        {:else}<span class="dot" title={st?.error ? 'Błąd' : st?.tools ? 'Połączono' : 'Jeszcze nie sprawdzono'} style:background={st?.error ? 'var(--destructive)' : st?.tools ? 'var(--chart-1)' : 'var(--border)'}></span>{/if}
        <button class="switch" class:on={s.enabled} role="switch" aria-checked={s.enabled} aria-label="Włącz {s.name}" title={s.enabled ? 'Włączony' : 'Wyłączony'} onclick={() => toggle(s)}></button>
      </div>
      <div class="acts">
        <button class="icobtn" title="Połącz i odśwież listę narzędzi" onclick={() => test(s)}><Icon name="refresh" size={14} /></button>
        {#if s.hasKey}<button class="icobtn" title="Usuń zapisany token" onclick={() => forgetToken(s)}><Icon name="key" size={14} /></button>{/if}
        <button class="icobtn" title="Edytuj" onclick={() => open(s)}><Icon name="edit" size={14} /></button>
        <button class="icobtn del" title="Usuń" onclick={() => remove(s)}><Icon name="trash" size={14} /></button>
      </div>
    </div>
  {:else}
    <p class="hint">Nie masz jeszcze serwerów. Dodaj pierwszy przyciskiem + albo zaimportuj konfigurację z innej aplikacji.</p>
  {/each}
</div>

<style>
  .err { color: var(--destructive) !important; white-space: normal !important; }
  .spin { width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid var(--muted-foreground); border-top-color: transparent; animation: spin .8s linear infinite; flex: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  textarea.mono, input.mono { font-family: var(--font-mono); font-size: 12px; }
</style>
