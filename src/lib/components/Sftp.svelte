<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../Icon.svelte';
  import { ui, notify } from '../state.svelte';
  import { hostById, hostCfg } from '../hosts.svelte';
  import { call, isTauri } from '../ipc';
  import { nid } from '../util';
  import type { Tab } from '../types';

  let { tab }: { tab: Tab } = $props();
  type E = { name: string; path: string; isDir: boolean; size: number; modified: number };
  const host = $derived(hostById(tab.hostId || ''));

  let lpath = $state(''), rpath = $state('');
  let local = $state<E[]>([]), remote = $state<E[]>([]);
  let lsel = $state<string[]>([]), rsel = $state<string[]>([]);
  let lerr = $state(''), rerr = $state(''), busy = $state(false);
  let transfers = $state<{ id: string; name: string; dir: 'up' | 'down'; done: number; total: number; state: 'run' | 'ok' | 'err'; msg?: string }[]>([]);
  let editor = $state<{ path: string; text: string; saving: boolean } | null>(null);

  const sep = (p: string) => (p.includes('\\') ? '\\' : '/');
  const parentLocal = (p: string) => { const s = sep(p); const i = p.replace(/[\\/]$/, '').lastIndexOf(s); return i <= 2 ? p.slice(0, 3) : p.slice(0, i); };
  const parentRemote = (p: string) => { const i = p.replace(/\/$/, '').lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
  const joinLocal = (d: string, n: string) => (d.endsWith('\\') ? d + n : `${d}\\${n}`);
  const joinRemote = (d: string, n: string) => (d.endsWith('/') ? d + n : `${d}/${n}`);
  const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
  const date = (ms: number) => (ms ? new Date(ms).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' }) : '');

  async function loadLocal(p = lpath) {
    lerr = '';
    try { const [d, list] = await call<[string, E[]]>('fs_list_detail', { dir: p }); lpath = d; local = list; lsel = []; }
    catch (e) { lerr = String(e).replace(/^Error: /, ''); }
  }
  async function loadRemote(p = rpath) {
    if (!host) { rerr = 'Tego hosta nie ma już w Vault.'; return; }
    rerr = ''; busy = true;
    try { const [d, list] = await call<[string, E[]]>('sftp_list', { host: hostCfg(host), path: p }); rpath = d; remote = list; rsel = []; }
    catch (e) { rerr = String(e).replace(/^Error: /, ''); }
    busy = false;
  }

  onMount(() => {
    loadLocal('');
    loadRemote('');
    let off: (() => void) | undefined;
    if (isTauri) import('@tauri-apps/api/event').then(async ({ listen }) => {
      off = await listen<{ id: string; done: number; total: number }>('sftp:progress', (e) => {
        const t = transfers.find((x) => x.id === e.payload.id);
        if (t) { t.done = e.payload.done; t.total = e.payload.total; }
      });
    });
    return () => off?.();
  });

  async function transfer(dir: 'up' | 'down', items: E[]) {
    if (!host) return;
    for (const it of items) {
      const id = nid('x');
      transfers.unshift({ id, name: it.name, dir, done: 0, total: it.size, state: 'run' });
      const t = transfers[0];
      try {
        await call('sftp_transfer', dir === 'down'
          ? { host: hostCfg(host), id, direction: 'download', remote: it.path, local: joinLocal(lpath, it.name) }
          : { host: hostCfg(host), id, direction: 'upload', remote: joinRemote(rpath, it.name), local: it.path });
        t.state = 'ok';
      } catch (e) { t.state = 'err'; t.msg = String(e).replace(/^Error: /, ''); }
    }
    dir === 'down' ? loadLocal() : loadRemote();
  }

  async function ask(title: string, label: string, value = ''): Promise<string | null> {
    return new Promise((resolve) => { ui.confirm = { title, message: '', input: { label, value }, confirmLabel: 'OK', resolve }; });
  }
  async function confirm(title: string, message: string): Promise<boolean> {
    return new Promise((resolve) => { ui.confirm = { title, message, confirmLabel: 'Usuń', danger: true, resolve: (v) => resolve(!!v) }; });
  }
  async function remoteOp(op: string, path: string, to?: string) {
    if (!host) return;
    try { await call('sftp_op', { host: hostCfg(host), op, path, to: to ?? null }); await loadRemote(); }
    catch (e) { notify(String(e).replace(/^Error: /, ''), 'error'); }
  }
  async function mkdir() { const n = await ask('Nowy folder', 'Nazwa'); if (n) remoteOp('mkdir', joinRemote(rpath, n)); }
  async function rename() {
    const it = remote.find((e) => e.path === rsel[0]); if (!it) return;
    const n = await ask('Zmień nazwę', 'Nowa nazwa', it.name); if (n && n !== it.name) remoteOp('rename', it.path, joinRemote(rpath, n));
  }
  async function del() {
    const items = remote.filter((e) => rsel.includes(e.path)); if (!items.length) return;
    if (!(await confirm('Usunąć z serwera?', `${items.map((i) => i.name).join(', ')}${items.some((i) => i.isDir) ? '\n\nFoldery zostaną usunięte razem z zawartością.' : ''}\n\nTej operacji nie da się cofnąć.`))) return;
    for (const it of items) await remoteOp(it.isDir ? 'rmdir' : 'rm', it.path);
  }
  async function openEditor(it: E) {
    if (!host) return;
    try { editor = { path: it.path, text: await call<string>('sftp_read_text', { host: hostCfg(host), path: it.path }), saving: false }; }
    catch (e) { notify(String(e).replace(/^Error: /, ''), 'error'); }
  }
  async function saveEditor() {
    if (!host || !editor) return;
    editor.saving = true;
    try { await call('sftp_write_text', { host: hostCfg(host), path: editor.path, data: editor.text }); notify('Zapisano na serwerze', 'success'); editor = null; loadRemote(); }
    catch (e) { notify(String(e).replace(/^Error: /, ''), 'error'); if (editor) editor.saving = false; }
  }

  function pick(list: string[], path: string, e: MouseEvent) {
    if (e.ctrlKey) return list.includes(path) ? list.filter((p) => p !== path) : [...list, path];
    return [path];
  }
  let dragFrom: 'local' | 'remote' | null = null;
</script>

{#snippet pane(side: 'local' | 'remote')}
  {@const isL = side === 'local'}
  {@const list = isL ? local : remote}
  {@const sel = isL ? lsel : rsel}
  <section class="pane" role="region" aria-label={isL ? 'Ten komputer' : 'Serwer'}
    ondragover={(e) => { if (dragFrom && dragFrom !== side) e.preventDefault(); }}
    ondrop={(e) => { e.preventDefault(); if (dragFrom === 'remote' && isL) transfer('down', remote.filter((x) => rsel.includes(x.path))); if (dragFrom === 'local' && !isL) transfer('up', local.filter((x) => lsel.includes(x.path))); dragFrom = null; }}>
    <header>
      <span class="label">{isL ? 'Ten komputer' : host ? `${host.user}@${host.host}` : 'Serwer'}</span>
      <span class="spacer"></span>
      {#if !isL}
        <button class="icobtn" title="Nowy folder" onclick={mkdir}><Icon name="folder-plus" size={14} /></button>
        <button class="icobtn" title="Zmień nazwę" disabled={rsel.length !== 1} onclick={rename}><Icon name="edit" size={14} /></button>
        <button class="icobtn" title="Usuń" disabled={!rsel.length} onclick={del}><Icon name="trash" size={14} /></button>
      {/if}
      <button class="icobtn" title="Odśwież" onclick={() => (isL ? loadLocal() : loadRemote())}><Icon name="refresh" size={14} /></button>
    </header>
    <div class="path">
      <button class="icobtn" title="W górę" onclick={() => (isL ? loadLocal(parentLocal(lpath)) : loadRemote(parentRemote(rpath)))}><Icon name="undo" size={13} /></button>
      <input class="inp" value={isL ? lpath : rpath} aria-label="Ścieżka" spellcheck="false" onkeydown={(e) => { if (e.key === 'Enter') isL ? loadLocal(e.currentTarget.value) : loadRemote(e.currentTarget.value); }} />
    </div>
    {#if isL ? lerr : rerr}<div class="err-box">{isL ? lerr : rerr}</div>{/if}
    <div class="files" class:busy={!isL && busy}>
      {#each list as it (it.path)}
        <div class="row" class:sel={sel.includes(it.path)} draggable="true" role="option" aria-selected={sel.includes(it.path)} tabindex="-1"
          ondragstart={() => { dragFrom = side; if (!sel.includes(it.path)) { if (isL) lsel = [it.path]; else rsel = [it.path]; } }}
          onclick={(e) => { if (isL) lsel = pick(lsel, it.path, e); else rsel = pick(rsel, it.path, e); }}
          ondblclick={() => { if (it.isDir) isL ? loadLocal(it.path) : loadRemote(it.path); else if (!isL) openEditor(it); }}>
          <Icon name={it.isDir ? 'folder' : 'file'} size={14} />
          <span class="nm">{it.name}</span>
          <span class="sz">{it.isDir ? '' : size(it.size)}</span>
          <span class="dt">{date(it.modified)}</span>
        </div>
      {:else}
        <div class="none">{!isL && busy ? 'Łączenie…' : 'Pusty folder'}</div>
      {/each}
    </div>
  </section>
{/snippet}

<div class="sftp">
  {@render pane('local')}
  <div class="mid">
    <button class="btn" title="Wyślij zaznaczone na serwer" disabled={!lsel.length} onclick={() => transfer('up', local.filter((x) => lsel.includes(x.path)))}><Icon name="send" /></button>
    <button class="btn" title="Pobierz zaznaczone" disabled={!rsel.length} onclick={() => transfer('down', remote.filter((x) => rsel.includes(x.path)))}><span style="display:inline-flex;transform:rotate(180deg)"><Icon name="send" /></span></button>
  </div>
  {@render pane('remote')}
  {#if transfers.length}
    <div class="transfers">
      {#each transfers.slice(0, 6) as t (t.id)}
        <div class="tr" class:err={t.state === 'err'}>
          <Icon name={t.state === 'ok' ? 'check' : t.state === 'err' ? 'x' : t.dir === 'up' ? 'upload' : 'send'} size={13} />
          <span class="nm">{t.name}</span>
          <span class="sz">{t.state === 'err' ? t.msg : `${size(t.done)} / ${size(t.total)}`}</span>
          <div class="bar"><i style:width="{t.total ? Math.min(100, (t.done / t.total) * 100) : t.state === 'ok' ? 100 : 0}%"></i></div>
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if editor}
  <div class="overlay" role="presentation">
    <div class="dialog ed" role="dialog" aria-label="Edytor pliku">
      <header><Icon name="file" /><code>{editor.path}</code></header>
      <textarea bind:value={editor.text} spellcheck="false" aria-label="Treść pliku" onkeydown={(e) => { if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveEditor(); } }}></textarea>
      <footer><small>Ctrl+S zapisuje na serwerze</small><button class="btn" onclick={() => (editor = null)}>Zamknij</button><button class="btn pri" disabled={editor.saving} onclick={saveEditor}>{editor.saving ? 'Zapisuję…' : 'Zapisz'}</button></footer>
    </div>
  </div>
{/if}

<style>
  .sftp { position: relative; display: grid; grid-template-columns: 1fr auto 1fr; height: 100%; min-height: 0; background: var(--background); }
  .pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-right: 1px solid var(--border); }
  .pane:last-of-type { border-right: 0; border-left: 1px solid var(--border); }
  header { display: flex; align-items: center; gap: 4px; padding: 8px 8px 4px 12px; }
  .path { display: flex; gap: 4px; padding: 0 8px 8px; }
  .path .inp { font-family: var(--font-mono); font-size: 11.5px; padding: 4px 8px; }
  .files { overflow: auto; flex: 1; min-height: 0; padding: 0 4px 60px; }
  .files.busy { opacity: .6; }
  .row { display: grid; grid-template-columns: 16px 1fr 70px 110px; gap: 8px; align-items: center; height: 26px; padding: 0 8px; border-radius: 5px; user-select: none; cursor: default; }
  .row:hover { background: var(--accent); }
  .row.sel { background: color-mix(in oklab, var(--primary) 18%, transparent); }
  .row :global(svg) { color: var(--muted-foreground); }
  .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sz, .dt { color: var(--muted-foreground); font-size: 11px; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .none { padding: 16px; color: var(--muted-foreground); text-align: center; }
  .mid { display: flex; flex-direction: column; justify-content: center; gap: 8px; padding: 0 8px; }
  .err-box { margin: 0 8px 8px; }
  .transfers { position: absolute; left: 12px; bottom: 12px; width: min(420px, 45%); background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 6px; display: flex; flex-direction: column; gap: 4px; box-shadow: 0 10px 30px -14px rgb(0 0 0 / .5); }
  .tr { display: grid; grid-template-columns: 16px 1fr auto; gap: 6px; align-items: center; font-size: 12px; }
  .tr.err { color: var(--destructive); }
  .tr .bar { grid-column: 1 / -1; height: 3px; background: var(--muted); border-radius: 3px; overflow: hidden; }
  .tr .bar i { display: block; height: 100%; background: var(--primary); }
  .dialog.ed { width: min(900px, 100%); height: min(640px, 100%); }
  .dialog.ed textarea { flex: 1; border: 0; outline: none; resize: none; background: var(--term-bg); color: var(--foreground); font: 12.5px/1.55 var(--font-mono); padding: 12px 14px; }
  .dialog.ed code { font-family: var(--font-mono); font-size: 12px; font-weight: 400; }
</style>
