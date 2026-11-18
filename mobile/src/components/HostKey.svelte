<script lang="ts">
  // Potwierdzenie klucza serwera SSH przy pierwszym połączeniu (albo gdy klucz się zmienił).
  import { SSH, answerHostKey } from '../lib/ssh.svelte';
  const p = $derived(SSH.prompts[0]);
</script>

{#if p}
  <div class="back" role="presentation"></div>
  <div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="hk-t">
    <h2 id="hk-t">{p.changed ? 'Klucz serwera się zmienił!' : 'Nowy serwer'}</h2>
    {#if p.changed}
      <p class="warn">Serwer <b class="mono">{p.host}:{p.port}</b> przedstawia się innym kluczem niż poprzednio. Tak bywa po reinstalacji serwera, ale może to też oznaczać podsłuch. Połącz się tylko, jeśli wiesz, skąd ta zmiana.</p>
    {:else}
      <p>Łączysz się pierwszy raz z <b class="mono">{p.host}:{p.port}</b>. Porównaj odcisk klucza z tym na serwerze (<span class="mono">ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub</span>).</p>
    {/if}
    <code class="fp mono">{p.algorithm}<br />{p.fingerprint}</code>
    <div class="acts">
      <button class="btn ghost" onclick={() => answerHostKey(p.reqId, false)}>Odrzuć</button>
      <button class="btn pri" onclick={() => answerHostKey(p.reqId, true)}>{p.changed ? 'Ufam nowemu kluczowi' : 'Ufam, połącz'}</button>
    </div>
  </div>
{/if}

<style>
  .back { position: fixed; inset: 0; z-index: 95; background: rgb(0 0 0 / .5); }
  .dlg { position: fixed; left: 16px; right: 16px; top: 50%; transform: translateY(-50%); z-index: 96; background: var(--card); border-radius: 24px; padding: 20px; }
  h2 { margin: 0 0 10px; font: 500 20px var(--font-mono); letter-spacing: -0.03em; }
  p { margin: 0 0 12px; font-size: 14.5px; line-height: 1.45; }
  .warn { color: var(--destructive); }
  .fp { display: block; font-size: 12.5px; word-break: break-all; background: var(--muted); border-radius: 12px; padding: 10px 12px; margin-bottom: 16px; }
  .acts { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
</style>
