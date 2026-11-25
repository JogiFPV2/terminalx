<script lang="ts">
  // Notatki w zakładce workspace'u (markdown jako zwykły tekst). Agent i workflow mogą do nich dopisywać.
  import { saveWs, type LTab } from '../lib/ws.svelte';
  let { tab }: { tab: LTab } = $props();
</script>

<div class="notes">
  <textarea class="inp" bind:value={tab.note} oninput={() => saveWs()} placeholder="Notatki tego workspace'u…" spellcheck="true"></textarea>
</div>

<style>
  .notes { flex: 1; min-height: 0; display: flex; padding: 0 8px 8px; }
  textarea { flex: 1; resize: none; font: 14px/1.55 var(--font-mono); padding: 14px; border-radius: 16px; }
</style>
