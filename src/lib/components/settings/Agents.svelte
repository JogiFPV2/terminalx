<script lang="ts">
  import Icon from '../../Icon.svelte';
  import { app, notify } from '../../state.svelte';
  import { TOOLS, PERM_LABEL, isChat } from '../../defaults';
  import { nid } from '../../util';
  import { usableKeys } from '../../ai';
  import type { AgentProfile } from '../../types';

  let edit = $state<AgentProfile | null>(null);
  let isNew = $state(false);
  const agents = $derived(app.agents.filter((a) => a.kind === 'agent'));
  const subs = $derived(app.agents.filter((a) => a.kind === 'sub'));
  let tab = $state<'agent' | 'sub' | 'assign'>('agent');
  const shown = $derived(tab === 'sub' ? subs : agents);

  function create(kind: 'agent' | 'sub') {
    edit = { id: nid('a'), kind, name: '', provider: app.defModel.provider, model: app.defModel.model, perm: 'ask', tools: Object.keys(TOOLS[kind]), prompt: '', parallel: kind === 'agent' ? 3 : undefined };
    isNew = true;
  }
  function open(a: AgentProfile) { edit = JSON.parse(JSON.stringify(a)); isNew = false; }
  function save() {
    if (!edit) return;
    if (!edit.name.trim()) { notify('Podaj nazwę profilu.', 'warning'); return; }
    if (isNew) app.agents.push(edit);
    else { const i = app.agents.findIndex((a) => a.id === edit!.id); if (i >= 0) app.agents[i] = edit; }
    edit = null;
  }
  function remove(a: AgentProfile) {
    if (app.agents.filter((x) => x.kind === a.kind).length < 2) { notify('Musi zostać co najmniej jeden profil tego rodzaju.', 'warning'); return; }
    app.agents.splice(app.agents.findIndex((x) => x.id === a.id), 1);
    const fallback = app.agents.find((x) => x.kind === a.kind)!.id;
    for (const ws of app.workspaces) {
      if (ws.agentId === a.id) ws.agentId = fallback;
      if (ws.subDefault === a.id) ws.subDefault = null;
      for (const t of ws.tabs) if (t.subagent === a.id) t.subagent = null;
    }
  }
  const models = (pid: string) => app.providers.find((p) => p.id === pid)?.models || [];
  const keysOf = (pid: string) => { const p = app.providers.find((x) => x.id === pid); return p ? usableKeys(p).filter((k) => k.hasKey) : []; };
  function toggleMcp(id: string) {
    if (!edit) return;
    const cur = edit.mcp ?? app.mcp.map((s) => s.id);
    edit.mcp = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  }
  function toggleTool(k: string) { if (!edit) return; edit.tools = edit.tools.includes(k) ? edit.tools.filter((t) => t !== k) : [...edit.tools, k]; }
  function toggleSkill(id: string) { if (!edit) return; const cur = edit.skills || []; edit.skills = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]; }
  const skillNames = (a: AgentProfile) => (a.skills || []).map((id) => app.skills.find((s) => s.id === id)?.name).filter(Boolean);
</script>

<div class="pagehead"><h2>Agenci</h2>
  <div>
    <div class="seg">
      <button class:on={tab === 'agent'} onclick={() => (tab = 'agent')}>Agenci <span class="n">{agents.length}</span></button>
      <button class:on={tab === 'sub'} onclick={() => (tab = 'sub')}>Podagenci <span class="n">{subs.length}</span></button>
      <button class:on={tab === 'assign'} onclick={() => (tab = 'assign')}>Przypisania</button>
    </div>
    {#if tab !== 'assign'}<button class="btn" onclick={() => create(tab === 'sub' ? 'sub' : 'agent')}><Icon name="plus" />{tab === 'sub' ? 'Nowy podagent' : 'Nowy agent'}</button>{/if}
  </div>
</div>
<p class="hint">{tab === 'sub' ? 'Podagent pracuje w jednej zakładce terminala: czyta jej wyjście, uruchamia komendy i raportuje agentowi.' : tab === 'assign' ? "Który agent prowadzi workspace i jaki podagent dostają jego nowe zakładki." : "Agent to szef workspace'u: planuje, deleguje pracę podagentom i sprawdza wyniki."} Model, uprawnienia, narzędzia, serwery MCP i skille ustawiasz w profilu.</p>

{#if edit}
  <div class="form">
    <h3 style="margin:0">{isNew ? 'Nowy' : 'Edytuj'} {edit.kind === 'agent' ? 'agent' : 'podagent'}</h3>
    <div class="grid2">
      <div class="field"><label for="aName">Nazwa</label><input class="inp" id="aName" bind:value={edit.name} placeholder={edit.kind === 'agent' ? 'np. Szef QA' : 'np. Tester'} /></div>
      <div class="field"><span class="flabel">Uprawnienia</span>
        <div class="seg">{#each Object.entries(PERM_LABEL) as [k, l]}<button class:on={edit.perm === k} onclick={() => (edit!.perm = k as any)}>{l}</button>{/each}</div></div>
      <div class="field"><label for="aProv">Provider</label>
        <select class="inp" id="aProv" bind:value={edit.provider} onchange={() => { edit!.model = app.providers.find((p) => p.id === edit!.provider)?.defModel || models(edit!.provider)[0] || ''; edit!.key = null; }}>
          {#each app.providers.filter(isChat) as p}<option value={p.id}>{p.name}</option>{/each}</select></div>
      <div class="field"><label for="aModel">Model</label>
        {#if models(edit.provider).length}
          <select class="inp" id="aModel" bind:value={edit.model}>{#each models(edit.provider) as m}<option value={m}>{m}</option>{/each}</select>
        {:else}<input class="inp" id="aModel" bind:value={edit.model} placeholder="nazwa modelu" />{/if}</div>
      {#if keysOf(edit.provider).length > 1}
        <div class="field"><label for="aKey">Klucz API</label>
          <select class="inp" id="aKey" value={edit.key || ''} onchange={(e) => (edit!.key = e.currentTarget.value || null)}>
            <option value="">Automatycznie (przełączanie przy limicie)</option>
            {#each keysOf(edit.provider) as k}<option value={k.id}>{k.name} (tylko ten)</option>{/each}
          </select></div>
      {/if}
    </div>
    <div class="field"><span class="flabel">Narzędzia</span>
      <div class="checks">{#each Object.entries(TOOLS[edit.kind]) as [k, l]}<label><input type="checkbox" checked={edit.tools.includes(k)} onchange={() => toggleTool(k)} />{l}</label>{/each}</div></div>
    {#if app.mcp.length}
      <div class="field"><span class="flabel">Serwery MCP</span>
        <div class="checks">{#each app.mcp as s (s.id)}<label title={s.enabled ? '' : 'Wyłączony w Ustawienia → Serwery MCP'}><input type="checkbox" checked={edit.mcp == null || edit.mcp.includes(s.id)} onchange={() => toggleMcp(s.id)} />{s.name}{s.enabled ? '' : ' (wyłączony)'}</label>{/each}</div></div>
    {/if}
    <div class="field"><span class="flabel">Skille</span>
      {#if app.skills.length}
        <div class="checks">{#each app.skills as s (s.id)}<label title={s.description}><input type="checkbox" checked={(edit.skills || []).includes(s.id)} onchange={() => toggleSkill(s.id)} />{s.name}</label>{/each}</div>
      {:else}<small class="hint">Brak skilli. Dodasz je w Ustawienia → Skille.</small>{/if}</div>
    {#if edit.kind === 'agent'}<div class="field" style="max-width:240px"><label for="aPar">Maks. podagentów równolegle</label><input class="inp" id="aPar" type="number" min="1" max="16" bind:value={edit.parallel} /></div>{/if}
    <div class="field"><label for="aPrompt">Instrukcja systemowa</label><textarea class="inp" id="aPrompt" bind:value={edit.prompt}></textarea></div>
    <div class="formbtns"><button class="btn" onclick={() => (edit = null)}>Anuluj</button><button class="btn pri" onclick={save}>Zapisz</button></div>
  </div>
{/if}

{#if tab !== 'assign'}
  <div class="list">
    {#each shown as a (a.id)}
      <div class="lrow">
        <div class="picon"><Icon name={a.kind === 'agent' ? 'bot' : 'term'} /></div>
        <div class="info"><b>{a.name}</b><small>{a.prompt}</small></div>
        <div class="meta"><span class="chip pri">{a.model}</span><span class="chip" class:warn={a.perm === 'auto'}>{PERM_LABEL[a.perm]}</span>
          {#each skillNames(a) as n}<span class="chip"><Icon name="book" size={11} />{n}</span>{/each}</div>
        <div class="acts"><button class="icobtn" title="Edytuj" onclick={() => open(a)}><Icon name="edit" size={14} /></button>
          <button class="icobtn del" title="Usuń" onclick={() => remove(a)}><Icon name="trash" size={14} /></button></div>
      </div>
    {/each}
  </div>
{:else}
<div>
  <div class="tablewrap"><table>
    <thead><tr><th>Workspace</th><th>Agent</th><th>Podagent nowych zakładek</th></tr></thead>
    <tbody>
      {#each app.workspaces as w (w.id)}
        <tr><td><span class="dot" style:background={w.color}></span> {w.name}</td>
          <td><select class="inp" bind:value={w.agentId} aria-label="Agent dla {w.name}">{#each agents as a}<option value={a.id}>{a.name}</option>{/each}</select></td>
          <td><select class="inp" bind:value={w.subDefault} aria-label="Podagent dla {w.name}"><option value={null}>Brak</option>{#each subs as a}<option value={a.id}>{a.name}</option>{/each}</select></td></tr>
      {/each}
    </tbody>
  </table></div>
  <p class="hint" style="margin-top:8px">Podagenta pojedynczej zakładki zmienisz z menu PPM na zakładce.</p>
</div>
{/if}

<style>
  .tablewrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  td, th { padding: 7px 8px; border-top: 1px solid var(--border); text-align: left; }
  th { font-weight: 500; color: var(--muted-foreground); border-top: 0; font-size: 11px; }
  .n { font-size: 10.5px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
</style>
