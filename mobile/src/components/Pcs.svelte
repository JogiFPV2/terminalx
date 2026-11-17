<script lang="ts">
  import Icon from '../../../src/lib/Icon.svelte';
  import { S, open, forget } from '../lib/store.svelte';

  const ago = (t?: number) => {
    if (!t) return 'jeszcze nie';
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'przed chwilą' : m < 60 ? `${m} min temu` : m < 1440 ? `${Math.round(m / 60)} godz. temu` : new Date(t).toLocaleDateString('pl-PL');
  };
  const host = (url: string) => url.replace(/^https?:\/\//, '');
  let editing = $state<string | null>(null);
</script>

<main>
  <header>
    <div class="logo"><i><Icon name="logo" size={22} /></i>Hermitty</div>
    <button class="ib" aria-label="Ustawienia" onclick={() => (S.sheet = 'settings')}><Icon name="sliders" size={20} /></button>
  </header>

  <h1>Twoje komputery</h1>
  <p class="muted lede">Terminale, agent i workflow z Hermitty na komputerze, na telefonie.</p>

  {#if S.pcs.length}
    <ul class="pcs">
      {#each S.pcs as pc (pc.device)}
        <li>
          <button class="pc" onclick={() => open(pc.device)}>
            <i><Icon name="monitor" size={22} /></i>
            <span><b>{pc.name}</b><small class="mono">{host(pc.url)}</small><small>ostatnio: {ago(pc.lastSeen)}</small></span>
            <Icon name="chev" size={18} />
          </button>
          <button class="ib more" aria-label="Opcje: {pc.name}" onclick={() => (editing = editing === pc.device ? null : pc.device)}><Icon name="dots" size={18} /></button>
          {#if editing === pc.device}
            <div class="opts"><button class="btn ghost sm" onclick={() => { forget(pc.device); editing = null; }}><Icon name="trash" size={16} />Usuń z telefonu</button></div>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <div class="empty">
      <ol>
        <li>Na komputerze otwórz Hermitty → Ustawienia → <b>Zdalny dostęp</b> i włącz go.</li>
        <li>Kliknij <b>Sparuj telefon</b>, żeby pokazać kod QR.</li>
        <li>Tutaj stuknij <b>Dodaj komputer</b> i zeskanuj kod.</li>
      </ol>
    </div>
  {/if}

  <button class="btn pri add" onclick={() => (S.sheet = 'pair')}><Icon name="plus" size={18} />Dodaj komputer</button>
</main>

<style>
  main { min-height: 100%; padding: calc(8px + var(--safe-t)) 16px calc(24px + var(--safe-b)); display: flex; flex-direction: column; }
  header { display: flex; align-items: center; justify-content: space-between; height: 56px; }
  .logo { display: flex; align-items: center; gap: 10px; font: 500 18px var(--font-mono); }
  .logo i { width: 36px; height: 36px; border-radius: 50%; background: var(--primary); color: var(--primary-foreground); display: grid; place-items: center; }
  h1 { font: 500 34px/1.05 var(--font-mono); letter-spacing: -0.04em; margin: 22px 0 8px; }
  .lede { margin: 0 0 22px; }
  .pcs { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .pcs li { position: relative; display: grid; grid-template-columns: 1fr auto; align-items: center; background: var(--card); border-radius: 20px; }
  .pc { display: flex; align-items: center; gap: 14px; padding: 14px 4px 14px 14px; border: 0; background: none; text-align: left; min-width: 0; }
  .pc i { width: 48px; height: 48px; border-radius: 50%; background: var(--muted); display: grid; place-items: center; flex: none; }
  .pc span { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .pc b { font-weight: 600; font-size: 16px; }
  .pc small { color: var(--muted-foreground); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .opts { grid-column: 1 / -1; padding: 0 14px 14px; }
  .empty { background: var(--card); border-radius: 20px; padding: 18px 20px; }
  .empty ol { margin: 0; padding-left: 20px; display: grid; gap: 8px; }
  .add { margin-top: auto; width: 100%; min-height: 52px; font-size: 16px; }
</style>
