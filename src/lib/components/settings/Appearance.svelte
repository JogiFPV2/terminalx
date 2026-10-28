<script lang="ts">
  import Icon from '../../Icon.svelte';
  import { app, notify } from '../../state.svelte';
  import { BUILTIN, DEFAULT, isDarkMode, parseTweakcnCss, parseTweakcnJson, tweakcnUrl, ensureFonts, themeFonts } from '../../theme';
  import { call } from '../../ipc';
  import type { ThemeDef } from '../../types';

  // Gotowe motywy z galerii tweakcn: import jednym kliknięciem.
  const GALLERY = ['amethyst-haze', 'catppuccin', 'cyberpunk', 'claude', 'vercel', 'supabase', 'mocha-mousse', 'bubblegum', 'doom-64', 'kodama-grove', 'cosmic-night',
    'quantum-rose', 'nature', 'elegant-luxury', 'neo-brutalism', 'solar-dusk', 'claymorphism', 'pastel-dreams', 'caffeine', 'ocean-breeze', 'retro-arcade', 'midnight-bloom',
    'northern-lights', 'vintage-paper', 'sunset-horizon', 'starry-night', 'soft-pop', 'sage-garden', 'violet-bloom', 'tangerine', 'graphite', 'darkmatter', 'mono', 'notebook', 'bold-tech', 't3-chat'];

  const all = $derived({ ...BUILTIN, ...app.settings.customThemes } as Record<string, ThemeDef | null>);
  const pal = $derived(isDarkMode(app.settings.themeMode) ? 'dark' : 'light');
  let link = $state('');
  let code = $state('');
  let msg = $state('');
  let busy = $state('');

  // Podgląd nazw w czcionkach motywów (pobierane raz, potem z dysku).
  $effect(() => { for (const t of Object.values(all)) if (t) ensureFonts(themeFonts(t)); });

  function vars(name: string) {
    const t = all[name];
    const s = (t ? (t[pal] || t.dark || t.light) : DEFAULT[pal]) || {};
    return (k: string) => s[k] || (t?.light?.[k] ?? t?.dark?.[k]) || DEFAULT[pal][k];
  }
  function uniqueName(base: string) { let n = base, i = 1; while (n in all) n = `${base} ${++i}`; return n; }
  const pretty = (s: string) => s.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

  async function importLink(input = link) {
    const url = tweakcnUrl(input);
    if (!url) { msg = 'Wklej link do motywu z tweakcn.com albo jego nazwę.'; return; }
    busy = input; msg = '';
    try {
      const r = await call<{ status: number; body: string }>('http_request', { method: 'GET', url, headers: null, body: null });
      if (r.status >= 400) throw new Error(`tweakcn zwrócił ${r.status}. Sprawdź nazwę motywu.`);
      const json = JSON.parse(r.body);
      const def = parseTweakcnJson(json);
      if (!def) throw new Error('To nie wygląda na motyw tweakcn (brak cssVars).');
      const name = uniqueName(json.name ? pretty(String(json.name)) : 'Import');
      app.settings.customThemes[name] = def;
      app.settings.themeName = name;
      link = '';
      notify(`Zaimportowano „${name}”`, 'success');
    } catch (e) { msg = String(e).replace(/^Error: /, ''); }
    busy = '';
  }
  function importCode() {
    const def = parseTweakcnCss(code);
    if (!def) { msg = 'Nie znaleziono bloków :root ani .dark ze zmiennymi --background, --primary…'; return; }
    const name = uniqueName('Import');
    app.settings.customThemes[name] = def;
    app.settings.themeName = name;
    code = '';
    msg = '';
    notify(def.fonts?.length ? `Zaimportowano „${name}” z czcionkami: ${def.fonts.join(', ')}` : `Zaimportowano „${name}”`, 'success');
  }
  function remove(name: string) {
    delete app.settings.customThemes[name];
    if (app.settings.themeName === name) app.settings.themeName = 'Domyślny';
  }
  const imported = $derived(new Set(Object.keys(app.settings.customThemes).map((n) => n.toLowerCase())));
</script>

<div class="pagehead"><h2>Wygląd</h2>
  <div class="seg" role="group" aria-label="Tryb">
    {#each [['light', 'sun', 'Jasny'], ['dark', 'moon', 'Ciemny'], ['system', 'monitor', 'Jak w systemie']] as [m, ic, l]}
      <button class:on={app.settings.themeMode === m} title={l} aria-label={l} onclick={() => (app.settings.themeMode = m as any)}><Icon name={ic} size={14} /></button>
    {/each}
  </div>
</div>

<div class="themes">
  {#each Object.keys(all) as n (n)}
    {@const v = vars(n)}
    <div class="th" class:on={n === app.settings.themeName} style:--tb={v('background')} style:--tf={v('foreground')} style:--tp={v('primary')} style:--tm={v('muted-foreground')} style:--tr={v('radius') || '.5rem'}>
      <button class="pick" onclick={() => (app.settings.themeName = n)} aria-label="Motyw {n}" title={all[n]?.fonts?.join(', ') || n}>
        <span class="nm" style:font-family={v('font-sans')}>{n}</span>
        <span class="sw">{#each ['primary', 'chart-1', 'chart-2', 'chart-3', 'chart-4'] as k}<i style:background={v(k)}></i>{/each}</span>
      </button>
      {#if all[n]?.imported}<button class="del" title="Usuń motyw" aria-label="Usuń motyw {n}" onclick={() => remove(n)}><Icon name="x" size={12} /></button>{/if}
    </div>
  {/each}
</div>

<div class="imp">
  <div class="row">
    <span class="ic" title="tweakcn.com"><Icon name="palette" size={14} /></span>
    <input bind:value={link} placeholder="Link albo nazwa motywu z tweakcn.com" aria-label="Link do motywu tweakcn" onkeydown={(e) => e.key === 'Enter' && importLink()} />
    <button class="icobtn" title="Importuj" disabled={!!busy || !link.trim()} onclick={() => importLink()}>{#if busy === link && busy}<span class="spin"></span>{:else}<Icon name="upload" size={14} />{/if}</button>
  </div>
  <div class="gallery">
    {#each GALLERY as g}
      <button class="chip" class:have={imported.has(pretty(g).toLowerCase())} disabled={!!busy} onclick={() => importLink(g)}>{#if busy === g}<span class="spin"></span>{/if}{pretty(g)}</button>
    {/each}
  </div>
  <details>
    <summary>Wklej kod z tweakcn (CSS i layout.tsx z czcionkami)</summary>
    <textarea class="inp" bind:value={code} spellcheck="false" placeholder={':root { --background: …; --font-sans: …; }\n.dark { … }\n\nimport { Geist, Geist_Mono } from "next/font/google";\nconst sans = Geist({ variable: "--font-sans" });'}></textarea>
    <button class="btn" style="margin-top:8px" disabled={!code.trim()} onclick={importCode}><Icon name="upload" />Importuj</button>
  </details>
  {#if msg}<p class="err">{msg}</p>{/if}
</div>

<div class="field" style="max-width:420px">
  <label for="dim">Jasność nieaktywnych okien w trybie „Okna”: {Math.round(app.settings.inactiveDim * 100)}%</label>
  <input type="range" id="dim" min="0.3" max="1" step="0.05" bind:value={app.settings.inactiveDim} />
</div>

<style>
  .themes { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
  .th { position: relative; border-radius: 10px; background: var(--tb); color: var(--tf); border: 1px solid color-mix(in oklab, var(--tf) 14%, transparent); overflow: hidden; }
  .th.on { outline: 2px solid var(--primary); outline-offset: 2px; }
  .pick { display: flex; flex-direction: column; gap: 10px; width: 100%; padding: 12px; text-align: left; color: inherit; }
  .nm { font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sw { display: flex; gap: 4px; }
  .sw i { width: 14px; height: 14px; border-radius: min(var(--tr), 7px); }
  .sw i:first-child { width: 28px; }
  .del { position: absolute; right: 6px; top: 6px; width: 20px; height: 20px; display: grid; place-items: center; border-radius: 5px; color: var(--tm); opacity: 0; }
  .th:hover .del { opacity: 1; }
  .del:hover { background: color-mix(in oklab, var(--tf) 12%, transparent); color: var(--tf); }
  .imp { display: flex; flex-direction: column; gap: 10px; }
  .row { display: flex; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: 8px; padding: 2px 2px 2px 10px; background: var(--card); max-width: 560px; }
  .row input { flex: 1; min-width: 0; border: 0; background: none; font: inherit; color: inherit; outline: none; padding: 6px 0; }
  .ic { color: var(--muted-foreground); display: grid; }
  .gallery { display: flex; flex-wrap: wrap; gap: 5px; }
  .gallery .chip { cursor: pointer; }
  .gallery .chip:hover:not(:disabled) { color: var(--foreground); border-color: var(--muted-foreground); }
  .gallery .chip.have { color: var(--primary); border-color: color-mix(in oklab, var(--primary) 40%, var(--border)); }
  details summary { cursor: pointer; font-size: 12px; color: var(--muted-foreground); margin-bottom: 8px; }
  .err { color: var(--destructive); font-size: 12px; margin: 0; }
  .spin { width: 11px; height: 11px; border-radius: 50%; border: 1.5px solid color-mix(in oklab, var(--primary) 25%, transparent); border-top-color: var(--primary); animation: rot .8s linear infinite; display: inline-block; }
  @keyframes rot { to { transform: rotate(360deg); } }
</style>
