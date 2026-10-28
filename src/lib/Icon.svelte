<script lang="ts">
  import { ICONS } from './icons';
  let { name, size = 16 }: { name: string; size?: number } = $props();
</script>

<svg class="i" viewBox="0 0 24 24" width={size} height={size} style:width="{size}px" style:height="{size}px" aria-hidden="true">{@html ICONS[name] || ICONS.puzzle}</svg>
