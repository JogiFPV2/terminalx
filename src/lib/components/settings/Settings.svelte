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

  const PAGES: ([string, string, string] | null)[] = [
    ['general', 'Ogólne', 'sliders'], ['appearance', 'Wygląd', 'palette'], ['terminal', 'Terminal', 'terminal'], ['shortcuts', 'Skróty', 'kbd'],
    null,
    ['agents', 'Agenci', 'bot'], ['providers', 'Providerzy', 'key'], ['local', 'Lokalne AI', 'chip'], ['prompts', 'Prompty', 'book'], ['nodes', 'Nody', 'nodes'], ['snippets', 'Snippety', 'snip'], ['plugins', 'Pluginy', 'plug'],
    null,
    ['remote', 'Zdalny dostęp', 'phone'],
  ];
  const close = () => (ui.settingsOpen = false);
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && !ui.confirm && !ui.menu) close(); }} />

<div class="overlay" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && close()}>
  <div class="modal" role="dialog" aria-label="Ustawienia">
    <nav>
      {#each PAGES as p}
        {#if p}
          <button class:on={ui.settingsPage === p[0]} onclick={() => (ui.settingsPage = p[0])}><Icon name={p[2]} size={14} />{p[1]}</button>
        {:else}<hr />{/if}
      {/each}
    </nav>
    <section>
      <button class="icobtn closer" title="Zamknij (Esc)" onclick={close}><Icon name="x" /></button>
      {#if ui.settingsPage === 'general'}<General />
      {:else if ui.settingsPage === 'appearance'}<Appearance />
      {:else if ui.settingsPage === 'terminal'}<TerminalPage />
      {:else if ui.settingsPage === 'shortcuts'}<Shortcuts />
      {:else if ui.settingsPage === 'agents'}<Agents />
      {:else if ui.settingsPage === 'providers'}<Providers />
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
  .modal { width: min(940px, 100%); height: min(680px, 100%); background: var(--card); border: 1px solid var(--border); border-radius: 12px; display: grid; grid-template-columns: 184px 1fr; overflow: hidden; box-shadow: 0 30px 80px -30px rgb(0 0 0 / .6); }
  nav { border-right: 1px solid var(--border); padding: 12px 8px; display: flex; flex-direction: column; gap: 2px; background: var(--sidebar); overflow: auto; }
  nav button { display: flex; align-items: center; gap: 9px; text-align: left; padding: 6px 10px; border-radius: 6px; color: var(--muted-foreground); white-space: nowrap; }
  nav button:hover { color: var(--foreground); }
  nav button.on { background: var(--accent); color: var(--foreground); }
  nav hr { border: 0; border-top: 1px solid var(--border); margin: 6px 4px; }
  section { position: relative; padding: 18px 20px 28px; display: flex; flex-direction: column; gap: 18px; min-width: 0; overflow: auto; }
  .closer { position: absolute; right: 12px; top: 12px; }
  section :global(h2) { margin: 0; font-size: 15px; font-weight: 600; padding-right: 40px; }
  section :global(h3) { margin: 0 0 8px; font-size: 12px; font-weight: 600; }
  section :global(.pagehead) { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; padding-right: 40px; }
  section :global(.pagehead > div) { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
</style>
