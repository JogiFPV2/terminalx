<script lang="ts">
  import Icon from '../Icon.svelte';
  import { app, ui, newTab, addWorkspace, curTab, splitTab, closeTab, activateTab, tabKind } from '../state.svelte';
  import { runSnippet } from '../agent.svelte';
  import { plug, runCommand } from '../plugins/host.svelte';

  let q = $state('');
  let sel = $state(0);

  type Cmd = { group: string; label: string; hint?: string; icon: string; run: () => void };
  const cmds = $derived.by((): Cmd[] => {
    const list: Cmd[] = [];
    for (const s of ui.shells) list.push({ group: 'Nowa zakładka', label: s.name, icon: 'terminal', run: () => newTab(s.id) });
    list.push({ group: 'Nowa zakładka', label: 'Workflow', icon: 'flow', run: () => newTab('flow') });
    list.push({ group: 'Aplikacja', label: 'Nowy workspace', icon: 'plus', run: addWorkspace });
    list.push({ group: 'Aplikacja', label: 'Panel agenta', icon: 'sparks', run: () => (app.layout.agentOpen = !app.layout.agentOpen) });
    list.push({ group: 'Aplikacja', label: 'Ustawienia', icon: 'sliders', run: () => (ui.settingsOpen = true) });
    const t = curTab();
    if (t?.kind === 'terminal') {
      list.push({ group: 'Zakładka', label: t.panes.length > 1 ? 'Scal panele' : 'Podziel panel', icon: 'split', run: () => splitTab(t.id) });
      list.push({ group: 'Zakładka', label: 'Szukaj w terminalu', icon: 'search', run: () => (ui.searchPane = t.panes[0].id) });
    }
    if (t) list.push({ group: 'Zakładka', label: `Zamknij „${t.title}”`, icon: 'x', run: () => closeTab(t.id) });
    for (const ws of app.workspaces) for (const tb of ws.tabs) list.push({ group: 'Przejdź do', label: `${ws.name} › ${tb.title}`, hint: tabKind(tb).label, icon: tb.kind === 'flow' ? 'flow' : 'term', run: () => activateTab(tb.id) });
    for (const s of app.snippets) list.push({ group: 'Snippety', label: s.name, hint: s.kind === 'ai' ? 'AI' : 'komenda', icon: 'snip', run: () => runSnippet(s) });
    for (const c of plug.commands) list.push({ group: 'Pluginy', label: c.title, hint: c.keybinding, icon: 'puzzle', run: () => runCommand(c) });
    for (const [p, l] of [['appearance', 'Wygląd'], ['agents', 'Agenci'], ['providers', 'Providerzy'], ['local', 'Lokalne AI'], ['prompts', 'Prompty'], ['nodes', 'Nody'], ['snippets', 'Snippety'], ['plugins', 'Pluginy']])
      list.push({ group: 'Ustawienia', label: l, icon: 'sliders', run: () => { ui.settingsPage = p; ui.settingsOpen = true; } });
    return list;
  });
  const filtered = $derived.by(() => {
    const s = q.trim().toLowerCase();
    if (!s) return cmds;
    const words = s.split(/\s+/);
    return cmds.filter((c) => words.every((w) => `${c.group} ${c.label}`.toLowerCase().includes(w)));
  });
  $effect(() => { void q; sel = 0; });

  function run(c: Cmd | undefined) { if (!c) return; ui.palette = false; c.run(); }
  function key(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(filtered.length - 1, sel + 1); scroll(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); scroll(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(filtered[sel]); }
    else if (e.key === 'Escape') ui.palette = false;
  }
  function scroll() { requestAnimationFrame(() => document.querySelector('.pal .hl')?.scrollIntoView({ block: 'nearest' })); }
  function focusEl(el: HTMLElement) { el.focus(); requestAnimationFrame(() => el.focus()); setTimeout(() => el.focus(), 50); }
</script>

<svelte:window onkeydowncapture={(e) => { if (e.key === 'Escape') { e.stopPropagation(); ui.palette = false; } }} />
<div class="overlay top" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && (ui.palette = false)}>
  <div class="pal" role="dialog" aria-label="Paleta komend">
    <div class="in"><Icon name="search" /><input bind:value={q} use:focusEl onkeydown={key} placeholder="Komenda, zakładka, snippet…" aria-label="Szukaj komendy" /></div>
    <div class="list">
      {#each filtered as c, i}
        <button class:hl={i === sel} onpointermove={() => (sel = i)} onclick={() => run(c)}>
          <Icon name={c.icon} size={14} /><span class="g">{c.group}</span><span class="l">{c.label}</span>{#if c.hint}<kbd>{c.hint}</kbd>{/if}
        </button>
      {:else}
        <div class="none">Nic nie pasuje.</div>
      {/each}
    </div>
  </div>
</div>

<style>
  .overlay.top { place-items: start center; padding-top: 12vh; background: rgb(0 0 0 / .3); }
  .pal { width: min(620px, 100%); background: var(--card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; box-shadow: 0 24px 60px -20px rgb(0 0 0 / .6); }
  .in { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border); color: var(--muted-foreground); }
  .in input { flex: 1; background: none; border: 0; outline: none; color: var(--foreground); font: inherit; font-size: 14px; }
  .list { max-height: 50vh; overflow: auto; padding: 4px; }
  .list button { display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 10px; border-radius: 6px; text-align: left; }
  .list button.hl { background: var(--accent); }
  .g { color: var(--muted-foreground); font-size: 11.5px; width: 110px; flex: none; }
  .l { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  kbd { font-family: var(--font-mono); font-size: 10.5px; color: var(--muted-foreground); }
  .none { padding: 14px; color: var(--muted-foreground); }
</style>
