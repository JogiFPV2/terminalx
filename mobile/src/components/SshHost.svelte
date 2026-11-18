<script lang="ts">
  // Dodawanie i edycja serwera SSH na telefonie. Hasło i klucz prywatny idą prosto do sejfu (Keystore).
  import Icon from '../../../src/lib/Icon.svelte';
  import { SSH, hostById, upsertHost, removeHost, setPassword, keygen, pubkey, importKey, forgetHostKey, type SshHost } from '../lib/ssh.svelte';
  import { S, toast, msg } from '../lib/store.svelte';

  const old = hostById(SSH.edit);
  const id = old?.id || `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let name = $state(old?.name || '');
  let host = $state(old?.host || '');
  let port = $state(old?.port || 22);
  let user = $state(old?.user || '');
  let auth = $state<'password' | 'key'>(old?.auth || 'password');
  let pass = $state('');
  let pub = $state<string | null>(null);
  let pasting = $state(false);
  let pem = $state('');
  let pemPass = $state('');
  let busy = $state(false);

  if (old && old.auth === 'key') pubkey(id).then((p) => (pub = p)).catch(() => {});

  const close = () => (SSH.edit = null);
  const valid = $derived(!!host.trim() && !!user.trim() && port > 0 && port < 65536);

  async function save() {
    if (!valid || busy) return;
    busy = true;
    try {
      if (auth === 'password' && pass) await setPassword(id, pass);
      if (auth === 'password' && !pass && !old) throw new Error('Wpisz hasło');
      if (auth === 'key' && !pub) throw new Error('Wygeneruj albo wklej klucz');
      const h: SshHost = { id, name: name.trim() || `${user.trim()}@${host.trim()}`, host: host.trim(), port: Number(port), user: user.trim(), auth, added: old?.added || Date.now(), lastUsed: old?.lastUsed };
      upsertHost(h);
      close();
      toast(old ? 'Zapisano serwer' : 'Dodano serwer');
    } catch (e) { toast(msg(e)); } finally { busy = false; }
  }

  async function gen() {
    busy = true;
    try { pub = await keygen(id, `${S.settings.name || 'telefon'} (Hermitty)`); } catch (e) { toast(msg(e)); } finally { busy = false; }
  }
  async function doImport() {
    busy = true;
    try { pub = await importKey(id, pem, pemPass); pasting = false; pem = ''; pemPass = ''; } catch (e) { toast(msg(e)); } finally { busy = false; }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(pub || ''); toast('Skopiowano klucz publiczny'); } catch { toast('Nie udało się skopiować. Zaznacz klucz ręcznie.'); }
  }
</script>

<form onsubmit={(e) => { e.preventDefault(); save(); }}>
  <div class="field"><label for="sn">Nazwa</label><input id="sn" class="inp" bind:value={name} placeholder="np. Serwer domowy" maxlength="40" /></div>
  <div class="row">
    <div class="field grow"><label for="sh">Adres</label><input id="sh" class="inp mono" bind:value={host} placeholder="192.168.1.10" autocapitalize="off" autocomplete="off" spellcheck="false" inputmode="url" /></div>
    <div class="field port"><label for="sp">Port</label><input id="sp" class="inp mono" type="number" min="1" max="65535" bind:value={port} /></div>
  </div>
  <div class="field"><label for="su">Użytkownik</label><input id="su" class="inp mono" bind:value={user} placeholder="root" autocapitalize="off" autocomplete="off" spellcheck="false" /></div>

  <div class="field"><span class="lbl">Logowanie</span>
    <div class="seg">{#each [['password', 'Hasło'], ['key', 'Klucz']] as [v, l]}<button type="button" class:on={auth === v} onclick={() => (auth = v as 'password' | 'key')}>{l}</button>{/each}</div></div>

  {#if auth === 'password'}
    <div class="field"><label for="spw">Hasło</label><input id="spw" class="inp" type="password" bind:value={pass} placeholder={old ? 'bez zmian' : ''} autocomplete="off" />
      <small class="muted">Trafia do sejfu telefonu (Android Keystore), nie do zwykłej pamięci aplikacji.</small></div>
  {:else}
    {#if pub}
      <div class="field"><span class="lbl">Klucz publiczny: dopisz go na serwerze do ~/.ssh/authorized_keys</span>
        <code class="pub mono">{pub}</code>
        <div class="acts"><button type="button" class="btn sm" onclick={copy}><Icon name="copy" size={16} />Kopiuj</button><button type="button" class="btn ghost sm" onclick={() => (pasting = true)}>Zmień klucz</button></div></div>
    {/if}
    {#if !pub || pasting}
      {#if pasting}
        <div class="field"><label for="spem">Klucz prywatny (OpenSSH albo PuTTY)</label>
          <textarea id="spem" class="inp mono pem" bind:value={pem} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellcheck="false" autocapitalize="off"></textarea></div>
        <div class="field"><label for="spp">Hasło klucza (jeśli jest)</label><input id="spp" class="inp" type="password" bind:value={pemPass} autocomplete="off" /></div>
        <div class="acts"><button type="button" class="btn sm" disabled={!pem.trim() || busy} onclick={doImport}>Zapisz klucz</button><button type="button" class="btn ghost sm" onclick={() => (pasting = false)}>Anuluj</button></div>
      {:else}
        <div class="acts"><button type="button" class="btn sm" disabled={busy} onclick={gen}><Icon name="key" size={16} />Wygeneruj klucz</button><button type="button" class="btn ghost sm" onclick={() => (pasting = true)}>Wklej klucz</button></div>
      {/if}
    {/if}
  {/if}

  <button class="btn pri save" disabled={!valid || busy}>{old ? 'Zapisz' : 'Dodaj serwer'}</button>
  {#if old}
    <div class="acts end">
      <button type="button" class="btn ghost sm" onclick={() => forgetHostKey(old.host, old.port).then(() => toast('Następne połączenie zapyta o klucz serwera'), (e) => toast(msg(e)))}>Zapomnij klucz serwera</button>
      <button type="button" class="btn ghost sm" onclick={() => { removeHost(old.id); close(); }}><Icon name="trash" size={16} />Usuń</button>
    </div>
  {/if}
</form>

<style>
  .field { display: grid; gap: 6px; margin-bottom: 14px; }
  label, .lbl { font-size: 13px; color: var(--muted-foreground); }
  small { font-size: 12.5px; }
  .row { display: flex; gap: 10px; }
  .grow { flex: 1; min-width: 0; }
  .port { width: 96px; }
  .seg { display: flex; gap: 6px; }
  .seg button { border: 0; border-radius: 999px; padding: 8px 16px; min-height: 40px; background: var(--muted); }
  .seg button.on { background: var(--foreground); color: var(--background); }
  .pub { display: block; font-size: 12px; word-break: break-all; background: var(--muted); border-radius: 12px; padding: 10px 12px; user-select: all; }
  .pem { min-height: 120px; font-size: 12px; resize: vertical; }
  .acts { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
  .acts.end { justify-content: space-between; margin: 12px 0 0; }
  .save { width: 100%; min-height: 50px; font-size: 16px; }
</style>
