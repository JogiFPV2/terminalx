<script lang="ts">
  import { plug } from '../../plugins/host.svelte';
  const KEYS: [string, string][] = [
    ['Ctrl+T', 'Nowa zakładka z domyślną powłoką'], ['Ctrl+Shift+1 / 2 / 3', 'PowerShell / CMD / pierwsza dystrybucja WSL'], ['Ctrl+Shift+E', 'Nowy workflow'],
    ['Ctrl+Shift+W', 'Zamknij zakładkę'], ['Ctrl+Shift+T', 'Przywróć ostatnio zamknięty element'], ['Ctrl+Tab / Ctrl+Shift+Tab', 'Następna / poprzednia zakładka'],
    ['Ctrl+Shift+N', 'Nowy workspace'], ['Ctrl+Shift+D', 'Podziel / scal panel'], ['Ctrl+Shift+F', 'Szukaj w terminalu'], ['Ctrl+Shift+A', 'Panel agenta'],
    ['Ctrl+K', 'Paleta komend'], ['Ctrl+,', 'Ustawienia'], ['F2', 'Zmień nazwę zakładki'], ['Ctrl+C / Ctrl+V', 'Kopiuj (z zaznaczeniem) / wklej'], ['PPM w terminalu', 'Kopiuj zaznaczenie albo wklej'],
  ];
</script>

<h2>Skróty klawiszowe</h2>
<div class="list">
  {#each KEYS as [k, d]}<div class="lrow"><kbd>{k}</kbd><span>{d}</span></div>{/each}
  {#each plug.commands.filter((c) => c.keybinding) as c}<div class="lrow"><kbd>{c.keybinding}</kbd><span>{c.title}</span></div>{/each}
</div>

<style>
  kbd { font-family: var(--font-mono); font-size: 11.5px; background: var(--muted); border: 1px solid var(--border); border-radius: 5px; padding: 2px 6px; min-width: 190px; }
</style>
