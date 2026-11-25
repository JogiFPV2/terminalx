<script lang="ts">
  import { onMount } from 'svelte';
  import { S, theme } from './lib/store.svelte';
  import Pcs from './components/Pcs.svelte';
  import Session from './components/Session.svelte';
  import Sheet from './components/Sheet.svelte';
  import Pair from './components/Pair.svelte';
  import Settings from './components/Settings.svelte';
  import LocalTerm from './components/LocalTerm.svelte';
  import SshHost from './components/SshHost.svelte';
  import HostKey from './components/HostKey.svelte';
  import { SSH, hostById } from './lib/ssh.svelte';
  import LocalAgent from './components/LocalAgent.svelte';
  import AgentSettings from './components/AgentSettings.svelte';
  import { AG } from './lib/agent.svelte';
  import Bridge from './components/Bridge.svelte';
  import Workspace from './components/Workspace.svelte';
  import { WS } from './lib/ws.svelte';
  import { BR, pendingLink } from './lib/bridge.svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { inTauri } from './lib/ssh.svelte';

  onMount(() => {
    theme();
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => S.settings.mode === 'system' && theme();
    mq.addEventListener('change', on);
    // Aplikację otworzył link hermitty://pair z kodu wtyczki Telefon: od razu ekran mostka.
    if (inTauri()) invoke<{ v: { link: unknown } }>('plugin:bridge|status').then((r) => { if (r?.v?.link) BR.open = true; }).catch(() => {});
    return () => mq.removeEventListener('change', on);
  });
</script>

{#if WS.open}<Workspace />{:else if BR.open}<Bridge />{:else if AG.open}<LocalAgent />{:else if SSH.open && hostById(SSH.open)}{#key SSH.open}<LocalTerm />{/key}{:else if S.cur && !S.quiet}<Session />{:else}<Pcs />{/if}

{#if S.sheet === 'pair'}<Sheet title="Dodaj komputer" onclose={() => (S.sheet = null)}><Pair /></Sheet>{/if}
{#if S.sheet === 'settings'}<Sheet title="Ustawienia" onclose={() => (S.sheet = null)}><Settings /></Sheet>{/if}
{#if SSH.edit}<Sheet title={SSH.edit === 'new' ? 'Nowy serwer SSH' : 'Serwer SSH'} onclose={() => (SSH.edit = null)}><SshHost /></Sheet>{/if}
{#if AG.settings}<Sheet title="Agent AI" onclose={() => (AG.settings = false)}><AgentSettings /></Sheet>{/if}
<HostKey />
{#if S.toast}<div class="toast" role="status">{S.toast}</div>{/if}

<style>
  .toast { position: fixed; left: 16px; right: 16px; bottom: calc(84px + var(--safe-b)); z-index: 90; background: var(--foreground); color: var(--background); padding: 12px 16px; border-radius: 14px; font-size: 14px; animation: up .25s ease; }
  @keyframes up { from { transform: translateY(10px); opacity: 0; } }
</style>
