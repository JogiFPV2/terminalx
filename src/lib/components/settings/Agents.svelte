<script lang="ts">
  import Icon from '../../Icon.svelte';
  import { app, notify } from '../../state.svelte';
  import { TOOLS, PERM_LABEL, isChat } from '../../defaults';
  import { nid } from '../../util';
  import type { AgentProfile } from '../../types';

  let edit = $state<AgentProfile | null>(null);
  let isNew = $state(false);
  const agents = $derived(app.agents.filter((a) => a.kind === 'agent'));
  const subs = $derived(app.agents.filter((a) => a.kind === 'sub'));
  const groups = $derived<[string, AgentProfile[]][]>([["Agenci workspace'ów", agents], ['Podagenci', subs]]);

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
  function toggleMcp(id: string) {
    if (!edit) return;
    const cur = edit.mcp ?? app.mcp.map((s) => s.id);
    edit.mcp = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  }
  function toggleTool(k: string) { if (!edit) return; edit.tools = edit.tools.includes(k) ? edit.tools.filter((t) => t !== k) : [...edit.tools, k]; }
</script>

<div class="pagehead"><h2>Agenci</h2>
  <div><button class="btn" onclick={() => create('agent')}><Icon name="plus" />Nowy agent</button><button class="btn" onclick={() => create('sub')}><Icon name="plus" />Nowy podagent</button></div>
</div>
<p class="hint">Agent to szef workspace'u: planuje, deleguje i sprawdza wyniki. Podagent pracuje w jednej zakładce terminala i raportuje agentowi. Tu tworzysz ich profile i przypisujesz je do workspace'ów.</p>

{#if edit}
  <div class="form">
    <h3 style="margin:0">{isNew ? 'Nowy' : 'Edytuj'} {edit.kind === 'agent' ? 'agent' : 'podagent'}</h3>
    <div class="grid2">
      <div class="field"><label for="aName">Nazwa</label><input class="inp" id="aName" bind:value={edit.name} placeholder={edit.kind === 'agent' ? 'np. Szef QA' : 'np. Tester'} /></div>
      <div class="field"><span class="flabel">Uprawnienia</span>
        <div class="seg">{#each Object.entries(PERM_LABEL) as [k, l]}<button class:on={edit.perm === k} onclick={() => (edit!.perm = k as any)}>{l}</button>{/each}</div></div>
      <div class="field"><label for="aProv">Provider</label>
        <select class="inp" id="aProv" bind:value={edit.provider} onchange={() => (edit!.model = models(edit!.provider)[0] || '')}>
          {#each app.providers.filter(isChat) as p}<option value={p.id}>{p.name}</option>{/each}</select></div>
      <div class="field"><label for="aModel">Model</label>
        {#if models(edit.provider).length}
          <select class="inp" id="aModel" bind:value={edit.model}>{#each models(edit.provider) as m}<option value={m}>{m}</option>{/each}</select>
        {:else}<input class="inp" id="aModel" bind:value={edit.model} placeholder="nazwa modelu" />{/if}</div>
    </div>
    <div class="field"><span class="flabel">Narzędzia</span>
      <div class="checks">{#each Object.entries(TOOLS[edit.kind]) as [k, l]}<label><input type="checkbox" checked={edit.tools.includes(k)} onchange={() => toggleTool(k)} />{l}</label>{/each}</div></div>
    {#if app.mcp.length}
      <div class="field"><span class="flabel">Serwery MCP</span>
        <div class="checks">{#each app.mcp as s (s.id)}<label title={s.enabled ? '' : 'Wyłączony w Ustawienia → Serwery MCP'}><input type="checkbox" checked={edit.mcp == null || edit.mcp.includes(s.id)} onchange={() => toggleMcp(s.id)} />{s.name}{s.enabled ? '' : ' (wyłączony)'}</label>{/each}</div></div>
    {/if}
    {#if edit.kind === 'agent'}<div class="field" style="max-width:240px"><label for="aPar">Maks. podagentów równolegle</label><input class="inp" id="aPar" type="number" min="1" max="16" bind:value={edit.parallel} /></div>{/if}
    <div class="field"><label for="aPrompt">Instrukcja systemowa</label><textarea class="inp" id="aPrompt" bind:value={edit.prompt}></textarea></div>
    <div class="formbtns"><button class="btn" onclick={() => (edit = null)}>Anuluj</button><button class="btn pri" onclick={save}>Zapisz</button></div>
  </div>
{/if}

{#each groups as [title, list]}
  <div><h3>{title}</h3>
    <div class="list">
      {#each list as a (a.id)}
        <div class="lrow">
          <div class="info"><b>{a.name}</b><small>{a.prompt}</small></div>
          <div class="meta"><span class="chip pri">{a.model}</span><span class="chip" class:warn={a.perm === 'auto'}>{PERM_LABEL[a.perm]}</span></div>
          <div class="acts"><button class="icobtn" title="Edytuj" onclick={() => open(a)}><Icon name="edit" size={14} /></button>
            <button class="icobtn del" title="Usuń" onclick={() => remove(a)}><Icon name="trash" size={14} /></button></div>
        </div>
      {/each}
    </div>
  </div>
{/each}

<div><h3>Przypisania</h3>
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

<style>
  .tablewrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  td, th { padding: 7px 8px; border-top: 1px solid var(--border); text-align: left; }
  th { font-weight: 500; color: var(--muted-foreground); border-top: 0; font-size: 11px; }
</style>
