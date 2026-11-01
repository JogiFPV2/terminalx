<script lang="ts">
  // Element paska od pluginu (górny albo dolny): ikona, opcjonalny krótki pasek zużycia i tekst.
  import Icon from '../Icon.svelte';
  import { emit, type StatusReg } from '../plugins/host.svelte';
  let { s }: { s: StatusReg } = $props();
</script>

<button class="pitem {s.variant}" class:hasbar={s.bar != null} title={s.tooltip} disabled={!s.clickable} onclick={() => emit(s.pluginId, 'statusClick', { id: s.id })}>
  {#if s.icon}<Icon name={s.icon} size={12} />{/if}
  {#if s.bar != null}<span class="bar"><i style:width="{s.bar}%"></i></span>{/if}
  {s.text}
</button>

<style>
  .bar { width: 34px; height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--muted-foreground) 25%, transparent); overflow: hidden; flex: none; }
  .bar i { display: block; height: 100%; border-radius: 2px; background: var(--chart-1, var(--primary)); min-width: 2px; }
  .warning .bar i { background: var(--chart-3); }
  .error .bar i { background: var(--destructive); }
</style>
