<script lang="ts">
  // Pliki na serwerze SSH albo w Termuxie (SFTP): przeglądanie, podgląd i edycja tekstu, wysyłanie z telefonu,
  // pobieranie do Pobrane/Hermitty, nowy folder, zmiana nazwy, usuwanie.
  import { invoke } from '@tauri-apps/api/core';
  import { onMount } from 'svelte';
  import Icon from '../../../src/lib/Icon.svelte';
  import { hostCfg, type SshHost } from '../lib/ssh.svelte';
  import { ensureSshd, saveDownload } from '../lib/termux.svelte';
  import { toast, msg } from '../lib/store.svelte';

  let { host }: { host: SshHost } = $props();
  type Entry = { name: string; path: string; isDir: boolean; size: number; modified: number };
  let dir = $state('');
  let list = $state<Entry[]>([]);
  let busy = $state(false);
  let error = $state('');
  let view = $state<{ path: string; text: string; dirty: boolean } | null>(null);
  let menu = $state<string | null>(null);
  let picker = $state<HTMLInputElement>();

  const cfg = () => hostCfg(host);
  const call = async <T,>(cmd: string, a: Record<string, unknown>) => { if (host.termux) await ensureSshd(); return invoke<T>(cmd, { host: cfg(), ...a }); };
  const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const b64 = (u8: Uint8Array) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  const utf8 = (b: string) => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));

  async function load(path = dir) {
    busy = true; error = '';
    try { const [d, l] = await call<[string, Entry[]]>('sftp_list', { path }); dir = d; list = l; }
    catch (e) { error = msg(e); }
    finally { busy = false; }
  }
  onMount(() => { load(''); });

  const up = () => load(dir.replace(/\/[^/]+\/?$/, '') || '/');
  async function openFile(f: Entry) {
    if (f.size > 2 * 1024 * 1024) { toast('Plik jest duży: pobierz go zamiast otwierać.'); return; }
    try { view = { path: f.path, text: utf8(await call<string>('sftp_read', { path: f.path })), dirty: false }; }
    catch (e) { toast(String(e).includes('decode') || String(e).includes('TypeError') ? 'To nie jest plik tekstowy. Pobierz go.' : msg(e)); }
  }
  async function saveView() {
    if (!view) return;
    try { await call('sftp_write', { path: view.path, data: b64(new TextEncoder().encode(view.text)) }); view.dirty = false; toast('Zapisano'); }
    catch (e) { toast(msg(e)); }
  }
  async function download(f: Entry) {
    menu = null;
    try { const r = await saveDownload(f.name, await call<string>('sftp_read', { path: f.path })); toast(`Zapisano w ${r.path}`); }
    catch (e) { toast(msg(e)); }
  }
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    busy = true;
    try {
      for (const f of Array.from(files)) {
        if (f.size > 50 * 1024 * 1024) { toast(`${f.name}: większy niż 50 MB`); continue; }
        await call('sftp_write', { path: `${dir.replace(/\/$/, '')}/${f.name}`, data: b64(new Uint8Array(await f.arrayBuffer())) });
      }
      toast('Wysłano'); await load();
    } catch (e) { toast(msg(e)); } finally { busy = false; if (picker) picker.value = ""; }
  }
  async function op(o: 'mkdir' | 'rm' | 'rmdir' | 'rename', f?: Entry) {
    menu = null;
    try {
      if (o === 'mkdir') { const n = prompt('Nazwa folderu'); if (!n) return; await call('sftp_op', { op: 'mkdir', path: `${dir.replace(/\/$/, '')}/${n}`, to: null }); }
      else if (o === 'rename' && f) { const n = prompt('Nowa nazwa', f.name); if (!n || n === f.name) return; await call('sftp_op', { op: 'rename', path: f.path, to: f.path.replace(/[^/]+$/, n) }); }
      else if (f) { if (!confirm(`Usunąć ${f.name}?`)) return; await call('sftp_op', { op: f.isDir ? 'rmdir' : 'rm', path: f.path, to: null }); }
      await load();
    } catch (e) { toast(msg(e)); }
  }
</script>

<div class="sftp">
  {#if view}
    <div class="bar"><button class="ib" aria-label="Wróć do listy" onclick={() => (view = null)}><Icon name="x" size={18} /></button><code class="p mono">{view.path}</code><button class="btn sm pri" disabled={!view.dirty} onclick={saveView}>Zapisz</button></div>
    <textarea class="inp ed mono" bind:value={view.text} oninput={() => view && (view.dirty = true)} spellcheck="false" autocapitalize="off"></textarea>
  {:else}
    <div class="bar">
      <button class="ib" aria-label="W górę" disabled={dir === '/'} onclick={up}><Icon name="chev" size={18} /></button>
      <code class="p mono">{dir || '…'}</code>
      <button class="ib" aria-label="Nowy folder" onclick={() => op('mkdir')}><Icon name="plus" size={18} /></button>
      <button class="ib" aria-label="Wyślij z telefonu" onclick={() => picker?.click()}><Icon name="upload" size={18} /></button>
      <button class="ib" aria-label="Odśwież" onclick={() => load()}><Icon name="refresh" size={18} /></button>
    </div>
    <input bind:this={picker} type="file" multiple hidden onchange={(e) => upload(e.currentTarget.files)} />
    {#if error}<p class="err">{error}</p>{/if}
    <ul class="files">
      {#each list as f (f.path)}
        <li>
          <button class="f" onclick={() => (f.isDir ? load(f.path) : openFile(f))}>
            <Icon name={f.isDir ? 'folder' : 'file'} size={18} /><span>{f.name}</span>{#if !f.isDir}<small>{kb(f.size)}</small>{/if}
          </button>
          <button class="ib" aria-label="Opcje: {f.name}" onclick={() => (menu = menu === f.path ? null : f.path)}><Icon name="dots" size={16} /></button>
          {#if menu === f.path}
            <div class="menu">
              {#if !f.isDir}<button class="btn sm" onclick={() => download(f)}><Icon name="download" size={15} />Pobierz</button>{/if}
              <button class="btn sm ghost" onclick={() => op('rename', f)}>Zmień nazwę</button>
              <button class="btn sm ghost" onclick={() => op('rm', f)}><Icon name="trash" size={15} />Usuń</button>
            </div>
          {/if}
        </li>
      {:else}
        {#if !busy && !error}<li class="muted empty">Pusty folder.</li>{/if}
      {/each}
    </ul>
  {/if}
</div>

<style>
  .sftp { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 0 8px 8px; }
  .bar { display: flex; align-items: center; gap: 4px; padding: 4px 0 8px; }
  .bar .ib:first-child :global(svg) { transform: rotate(180deg); }
  .p { flex: 1; min-width: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
  .files { list-style: none; margin: 0; padding: 0; overflow: auto; flex: 1; background: var(--card); border-radius: 16px; }
  .files li { display: grid; grid-template-columns: 1fr auto; align-items: center; border-bottom: 1px solid var(--border); }
  .files li:last-child { border-bottom: 0; }
  .f { display: flex; align-items: center; gap: 10px; border: 0; background: none; padding: 12px; text-align: left; min-width: 0; font-size: 14.5px; }
  .f span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .f small { color: var(--muted-foreground); font-size: 12px; }
  .menu { grid-column: 1 / -1; display: flex; gap: 6px; flex-wrap: wrap; padding: 0 12px 12px; }
  .empty { padding: 16px; }
  .err { color: var(--destructive); font-size: 13px; margin: 0 4px 8px; }
  .ed { flex: 1; resize: none; font-size: 12.5px; line-height: 1.5; border-radius: 16px; padding: 12px; }
</style>
