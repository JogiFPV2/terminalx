<script lang="ts">
  // Agent AI z ekranu startowego: rozmowa „global” z narzędziami na serwerach SSH zapisanych w telefonie.
  import Icon from '../../../src/lib/Icon.svelte';
  import { AG, KINDS, chat, clearChat, serverTools } from '../lib/agent.svelte';
  import { userHosts } from '../lib/ssh.svelte';
  import ChatView from './ChatView.svelte';

  const kind = $derived(KINDS.find((k) => k.id === AG.cfg.kind));
  const hosts = $derived(userHosts());
  const empty = $derived(hosts.length ? `Agent widzi ${hosts.length === 1 ? 'serwer' : 'serwery'}: ${hosts.map((h) => h.name).join(', ')}. Każdą komendę zatwierdzisz tutaj.` : 'Dodaj serwer SSH na ekranie startowym: agent wykonuje na nich komendy za Twoją zgodą.');
</script>

<div class="app">
  <header class="top">
    <button class="ib back" aria-label="Wróć" onclick={() => (AG.open = false)}><Icon name="chev" size={20} /></button>
    <div class="who"><b>Agent AI</b><small>{kind?.name}{AG.cfg.model ? ` · ${AG.cfg.model}` : ''}</small></div>
    <button class="ib" aria-label="Wyczyść rozmowę" disabled={chat('global').busy || !chat('global').items.length} onclick={() => clearChat('global')}><Icon name="chatplus" size={20} /></button>
    <button class="ib" aria-label="Ustawienia agenta" onclick={() => (AG.settings = true)}><Icon name="sliders" size={20} /></button>
  </header>
  <ChatView scope="global" tools={serverTools} {empty} />
</div>

<style>
  .app { height: 100%; display: flex; flex-direction: column; padding: var(--safe-t) 0 var(--safe-b); }
  .top { display: flex; align-items: center; gap: 4px; height: 56px; padding: 0 4px; flex: none; }
  .back :global(svg) { transform: rotate(180deg); }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .who b { font-weight: 600; }
  .who small { font-size: 12.5px; color: var(--muted-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
