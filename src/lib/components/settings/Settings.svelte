<script lang="ts">
  import Icon from '../../Icon.svelte';
  import { ui } from '../../state.svelte';
  import General from './General.svelte';
  import Appearance from './Appearance.svelte';
  import TerminalPage from './TerminalPage.svelte';
  import Shortcuts from './Shortcuts.svelte';
  import Agents from './Agents.svelte';
  import Providers from './Providers.svelte';
  import Prompts from './Prompts.svelte';
  import Nodes from './Nodes.svelte';
  import Snippets from './Snippets.svelte';
  import Plugins from './Plugins.svelte';
  import Remote from './Remote.svelte';
  import Local from './Local.svelte';
  import Mcp from './Mcp.svelte';
  import Fallback from './Fallback.svelte';
  import Skills from './Skills.svelte';
  import Voice from './Voice.svelte';

  // Grupy: aplikacja, skąd AI bierze modele (konta, klucze, zastępstwa, lokalne, MCP),
  // jak AI pracuje (agenci, prompty, skille, snippety) i rozszerzenia.
  const GROUPS: [string, [string, string, string][]][] = [
    ['Aplikacja', [['general', 'Ogólne', 'sliders'], ['appearance', 'Wygląd', 'palette'], ['terminal', 'Terminal', 'terminal'], ['shortcuts', 'Skróty', 'kbd'], ['remote', 'Zdalny dostęp', 'phone']]],
    ['AI · połączenia', [['providers', 'Konta i providerzy', 'key'], ['fallback', 'Zastępstwa', 'loop'], ['local', 'Lokalne AI', 'chip'], ['mcp', 'Serwery MCP', 'server']]],
    ['AI · zachowanie', [['agents', 'Agenci', 'bot'], ['prompts', 'Prompty', 'notebook'], ['skills', 'Skille', 'book'], ['snippets', 'Snippety', 'snip'], ['voice', 'Głos', 'mic']]],
    ['Rozszerzenia', [['nodes', 'Nody workflow', 'nodes'], ['plugins', 'Pluginy', 'plug']]],
  ];
  const close = () => (ui.settingsOpen = false);
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && !ui.confirm && !ui.menu) close(); }} />

<div class="overlay" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && close()}>
  <div class="modal" role="dialog" aria-label="Ustawienia">
    <nav>
      {#each GROUPS as [title, pages]}
        <span class="grp">{title}</span>
        {#each pages as p}
          <button class:on={ui.settingsPage === p[0]} onclick={() => (ui.settingsPage = p[0])}><Icon name={p[2]} size={14} />{p[1]}</button>
        {/each}
      {/each}
    </nav>
    <!-- Poza przewijaną sekcją, żeby „zamknij” było widoczne zawsze. -->
    <button class="icobtn closer" title="Zamknij (Esc)" onclick={close}><Icon name="x" /></button>
    <section>
      {#if ui.settingsPage === 'general'}<General />
      {:else if ui.settingsPage === 'appearance'}<Appearance />
      {:else if ui.settingsPage === 'terminal'}<TerminalPage />
      {:else if ui.settingsPage === 'shortcuts'}<Shortcuts />
      {:else if ui.settingsPage === 'agents'}<Agents />
      {:else if ui.settingsPage === 'providers'}<Providers />
      {:else if ui.settingsPage === 'fallback'}<Fallback />
      {:else if ui.settingsPage === 'skills'}<Skills />
      {:else if ui.settingsPage === 'voice'}<Voice />
      {:else if ui.settingsPage === 'mcp'}<Mcp />
      {:else if ui.settingsPage === 'prompts'}<Prompts />
      {:else if ui.settingsPage === 'nodes'}<Nodes />
      {:else if ui.settingsPage === 'snippets'}<Snippets />
      {:else if ui.settingsPage === 'plugins'}<Plugins />
      {:else if ui.settingsPage === 'remote'}<Remote />
      {:else if ui.settingsPage === 'local'}<Local />{/if}
    </section>
  </div>
</div>

<style>
  .modal { position: relative; width: min(960px, 100%); height: min(680px, 100%); background: var(--card); border: 1px solid var(--border); border-radius: 12px; display: grid; grid-template-columns: 196px 1fr; overflow: hidden; box-shadow: 0 30px 80px -30px rgb(0 0 0 / .6); }
  nav { border-right: 1px solid var(--border); padding: 12px 8px; display: flex; flex-direction: column; gap: 2px; background: var(--sidebar); overflow: auto; }
  nav button { display: flex; align-items: center; gap: 9px; text-align: left; padding: 6px 10px; border-radius: 6px; color: var(--muted-foreground); white-space: nowrap; }
  nav button:hover { color: var(--foreground); }
  nav button.on { background: var(--accent); color: var(--foreground); }
  .grp { font-size: 10.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted-foreground); padding: 12px 10px 4px; opacity: .8; }
  .grp:first-child { padding-top: 2px; }
  section { position: relative; padding: 18px 20px 28px; display: flex; flex-direction: column; gap: 18px; min-width: 0; overflow: auto; }
  .closer { position: absolute; right: 12px; top: 12px; z-index: 5; background: var(--card); }
  .closer:hover { background: var(--muted); }
  section :global(h2) { margin: 0; font-size: 15px; font-weight: 600; padding-right: 40px; }
  section :global(h3) { margin: 0 0 8px; font-size: 12px; font-weight: 600; }
  section :global(.pagehead) { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; padding-right: 40px; }
  section :global(.pagehead > div) { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
</style>
