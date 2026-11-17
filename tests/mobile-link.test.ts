// Aplikacja na Androida ↔ serwer zdalnego dostępu: parowanie, ponowne połączenie, zapytania, zdarzenia,
// uprawnienia. Serwer to atrapa (mobile/dev/fake-pc.mjs) z tym samym protokołem co src-tauri/src/remote.rs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Link, type SavedPc, type LinkState } from '../mobile/src/lib/link.ts';
// @ts-ignore: moduł JS bez typów
import { startFakePc } from '../mobile/dev/fake-pc.mjs';

const until = (fn: () => boolean, ms = 3000) => new Promise<void>((res, rej) => {
  const t0 = Date.now();
  const tick = () => (fn() ? res() : Date.now() - t0 > ms ? rej(new Error('timeout')) : setTimeout(tick, 15));
  tick();
});

test('parowanie z linku QR, potem ponowne połączenie zapisanym urządzeniem', async () => {
  const pc = await startFakePc({ approve: async () => 'control' });
  try {
    const states: LinkState[] = []; let saved: SavedPc | null = null;
    const pairLink = Link.fromPairLink(pc.pairLink(), { state: (s) => states.push(s), paired: (p) => (saved = p) }, 'Nothing Phone (3a)');
    assert.ok(pairLink);
    pairLink!.connect();
    await until(() => states.includes('ready'));
    assert.ok(states.includes('waiting'), 'czeka na zgodę na komputerze');
    assert.ok(saved, 'dostał id urządzenia');
    assert.equal(pairLink!.perm, 'control');
    assert.equal(saved!.name, 'PRACOWNIA', 'nazwa komputera z powitania');
    assert.equal(pc.devices.get(saved!.device).name, 'Nothing Phone (3a)');
    pairLink!.close();

    // Drugie połączenie: zapisany klucz, nowe wyzwania.
    const st: LinkState[] = [];
    const again = new Link(saved!, { state: (s) => st.push(s) });
    again.connect();
    await until(() => again.state === 'ready');
    const state = await again.req('state');
    assert.equal(state.v, 2);
    assert.equal(state.workspaces[0].tabs[0].label, 'PS');
    again.close();
  } finally { await pc.close(); }
});

test('kod parowania jest jednorazowy, odrzucenie na komputerze kończy parowanie', async () => {
  const pc = await startFakePc({ approve: async () => null });
  try {
    const url = pc.pairLink();
    const a = Link.fromPairLink(url, {})!; a.connect();
    await until(() => a.state === 'denied');
    const b = Link.fromPairLink(url, {})!; b.connect();
    await until(() => b.state === 'error');
    assert.match(b.error, /wygasł albo został już użyty/);
  } finally { await pc.close(); }
});

test('zapytania, zdarzenia terminala i uprawnienia urządzenia', async () => {
  const pc = await startFakePc();
  try {
    const key = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='; // 32 bajty
    pc.devices.set('d-view', { key, perm: 'view' });
    pc.devices.set('d-full', { key, perm: 'full' });
    const out: string[] = [];
    const full = new Link({ device: 'd-full', url: `http://127.0.0.1:${pc.port}`, key, name: 'pc', added: 0 }, { ev: (e, d) => e === 'out' && out.push(d.data) });
    full.connect(); await until(() => full.state === 'ready');
    const sub = await full.req('subscribe', { tab: 't1' });
    assert.equal(sub.cols, 92);
    await full.req('write', { tab: 't1', data: 'git status\r' });
    await until(() => out.some((o) => o.includes('git status')));
    const flows = await full.req('flows');
    assert.equal(flows.length, 2);

    const view = new Link({ device: 'd-view', url: `http://127.0.0.1:${pc.port}`, key, name: 'pc', added: 0 }, {});
    view.connect(); await until(() => view.state === 'ready');
    assert.ok(await view.req('chat', { ws: 'w1' }));
    await assert.rejects(view.req('write', { tab: 't1', data: 'x' }), /nie ma uprawnień/);
    full.close(); view.close();
  } finally { await pc.close(); }
});

test('nieznane urządzenie: komunikat i sygnał do usunięcia z listy', async () => {
  const pc = await startFakePc();
  try {
    let forgotten = false;
    const l = new Link({ device: 'nie-ma', url: `http://127.0.0.1:${pc.port}`, key: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=', name: 'pc', added: 0 }, { forgotten: () => (forgotten = true) });
    l.connect();
    await until(() => l.state === 'error');
    assert.ok(forgotten);
  } finally { await pc.close(); }
});
