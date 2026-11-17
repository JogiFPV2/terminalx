// Atrapa Hermitty na komputerze dla aplikacji mobilnej: serwer zdalnego dostępu z tym samym protokołem co
// src-tauri/src/remote.rs (powitanie z wyzwaniami, szyfrowane ramki z licznikiem, parowanie, poziomy uprawnień)
// i przykładowymi danymi. Do testów (tests/mobile-link.test.ts) i rozwijania interfejsu: npm run mobile:fake
import { WebSocketServer } from 'ws';
import { Dir, b64, unb64, sessionKey, randomBytes } from '../../src/lib/remote-crypto.ts';

const LEVEL = { view: 1, control: 2, full: 3 };
const NEED = (m) => (['state', 'tail', 'subscribe', 'unsubscribe', 'chat', 'ping', 'info', 'shells', 'flows'].includes(m) ? 1
  : ['write', 'resize', 'approve', 'park', 'unpark', 'focus', 'stopAgent'].includes(m) ? 2 : 3);

const E = '\x1b[', g = (s) => E + '32m' + s + E + '0m', r = (s) => E + '31m' + s + E + '0m', d = (s) => E + '2m' + s + E + '0m', y = (s) => E + '33m' + s + E + '0m', B = (s) => E + '1m' + s + E + '0m';
const N = '\r\n';

export function demoData() {
  const t = Date.now();
  return {
    workspaces: [
      { id: 'w1', name: 'api', color: '#5E87A8', activeTab: 't1', busy: false, tabs: [
        { id: 't1', title: 'api', kind: 'terminal', label: 'PS', color: '#5E87A8' },
        { id: 't2', title: 'ubuntu', kind: 'terminal', label: 'WSL', color: '#D08A2E' },
        { id: 't3', title: 'deploy@prod-web-1', kind: 'terminal', label: 'SSH', color: '#2E8B7A' },
        { id: 't4', title: 'Raport poranny', kind: 'flow', label: 'FLOW', color: '#9B6BB5' }] },
      { id: 'w2', name: 'Infra', color: '#C2563F', activeTab: 't5', busy: false, tabs: [{ id: 't5', title: 'pwsh', kind: 'terminal', label: 'PS', color: '#5E87A8' }] },
    ],
    parked: [{ id: 't9', title: 'web · dev', ws: 'api' }],
    screens: {
      t1: [g('PS ') + 'C:\\dev\\api> npm test', '', d('> api@1.4.0 test'), d('> vitest run'), '', ' ' + g('✓') + ' tests/users.test.ts ' + d('(18)'), ' ' + g('✓') + ' tests/orders.test.ts ' + d('(23)'), ' ' + r('❯') + ' tests/auth.test.ts ' + d('(11)') + ' ' + r('1 failed'), '   ' + r('× token wygasa po 60 s'), '', d('      Tests ') + ' ' + r(B('1 failed')) + d(' | ') + g(B('51 passed')), g('PS ') + 'C:\\dev\\api> '].join(N),
      t2: [g(B('dev@PRACOWNIA')) + ':' + E + '34m~/app' + E + '0m$ docker compose ps', B('NAME          STATUS'), 'app-web-1     ' + g('Up 2 hours'), 'app-db-1      ' + g('Up 2 hours'), g(B('dev@PRACOWNIA')) + ':' + E + '34m~/app' + E + '0m$ '].join(N),
      t3: [g(B('deploy@prod-web-1')) + ':~$ systemctl status api --no-pager', g('●') + ' api.service - API (Node.js)', '     Active: ' + g(B('active (running)')) + ' since 06:02; 2h 41min ago', g(B('deploy@prod-web-1')) + ':~$ '].join(N),
      t5: g('PS ') + 'C:\\infra> ',
    },
    chat: { w1: [
      { id: 'm1', role: 'user', who: 'Ty', text: 'Testy w zakładce api nie przechodzą. Sprawdź dlaczego.' },
      { id: 'm2', role: 'sub', who: 'Podagent „api”', text: 'Test czeka 61 s na token ważny 60 s (`tests/auth.test.ts:58`). Skrócę czekanie do 59 s.' },
      { id: 'm3', role: 'sub', who: 'Podagent „api”', text: 'Chcę uruchomić w „api”:', approve: { tabId: 't1', command: 'git apply fix-token-wait.patch; npm test', state: 'pending' } }], w2: [] },
    flows: [{ id: 't4', title: 'Raport poranny', ws: 'w1', wsName: 'api', nodes: 7, running: false, byAgent: false },
      { id: 't8', title: 'Kopia bazy', ws: 'w2', wsName: 'Infra', nodes: 4, running: false, byAgent: true }],
    shells: { shells: [{ id: 'pwsh', name: 'PowerShell 7', kind: 'ps' }, { id: 'powershell', name: 'Windows PowerShell', kind: 'ps5' }, { id: 'cmd', name: 'Wiersz poleceń', kind: 'cmd' }, { id: 'wsl:Ubuntu', name: 'WSL · Ubuntu', kind: 'wsl' }],
      hosts: [{ id: 'h1', name: 'prod-web-1', addr: 'deploy@10.0.0.21', group: 'Produkcja' }, { id: 'h2', name: 'staging', addr: 'deploy@staging.example.dev', group: 'Testy' }] },
    t,
  };
}

/**
 * devices: Map id → { key (base64), perm }; pairs: Map pairId → key (base64).
 * approve(name) decyduje o parowaniu (domyślnie zgoda z uprawnieniem 'full').
 */
export function startFakePc({ port = 0, devices = new Map(), pairs = new Map(), approve = async () => 'full', data = demoData() } = {}) {
  const wss = new WebSocketServer({ port, path: '/ws' });
  const conns = new Set();
  wss.on('connection', (ws) => {
    let rx = null, tx = null, device = '', key = null, authed = false;
    const subs = new Set();
    const cs = randomBytes(16);
    const sendEnc = (o) => ws.readyState === 1 && ws.send(tx.seal(JSON.stringify(o)));
    const ev = (e, d) => sendEnc({ t: 'ev', e, d });
    const conn = { ev, subs }; conns.add(conn);
    ws.on('close', () => conns.delete(conn));
    ws.send(JSON.stringify({ t: 'hi', v: 2, c: b64(cs), name: 'PRACOWNIA' }));
    let pairing = null, dead = false;
    // Jak w remote.rs: po odrzuceniu powitania sesja się kończy, kolejne ramki są ignorowane.
    const reject = (msg) => { dead = true; ws.send(JSON.stringify({ t: 'error', msg })); ws.close(); };
    ws.on('message', async (raw) => {
      if (dead) return;
      const text = raw.toString();
      if (!rx) {
        let h; try { h = JSON.parse(text); } catch { dead = true; return ws.close(); }
        const cc = h.c ? unb64(h.c) : null;
        if (!cc || cc.length !== 16) return reject('Stara wersja strony. Odśwież stronę na telefonie.');
        if (h.t === 'hello') {
          const dev = devices.get(h.device);
          if (!dev) return reject('Nieznane urządzenie. Sparuj telefon ponownie.');
          key = unb64(dev.key); device = h.device;
        } else if (h.t === 'pair') {
          const k = pairs.get(h.pair);
          if (!k) return reject('Kod parowania wygasł albo został już użyty. Wygeneruj nowy na komputerze.');
          pairs.delete(h.pair); key = unb64(k); pairing = h.name || 'Telefon';
        } else return ws.close();
        rx = new Dir(sessionKey(key, 'c2s', cs, cc)); tx = new Dir(sessionKey(key, 's2c', cs, cc));
        return;
      }
      const plain = rx.open(text);
      if (plain === null) return ws.close();
      const msg = JSON.parse(plain);
      if (!authed) {
        if (msg.t !== 'auth') return ws.close();
        authed = true;
        if (pairing !== null) {
          sendEnc({ t: 'waiting' });
          const perm = await approve(pairing);
          if (!perm) { sendEnc({ t: 'denied' }); return ws.close(); }
          device = 'dev' + Math.random().toString(36).slice(2, 10);
          devices.set(device, { key: b64(key), perm, name: pairing });
          sendEnc({ t: 'paired', device });
        }
        return sendEnc({ t: 'ready', perm: devices.get(device).perm, device });
      }
      if (msg.t !== 'req') return;
      const perm = devices.get(device)?.perm || 'view';
      const res = (ok, v) => sendEnc(ok ? { t: 'res', id: msg.id, ok: true, r: v ?? null } : { t: 'res', id: msg.id, ok: false, error: v });
      if (LEVEL[perm] < NEED(msg.m)) return res(false, 'To urządzenie nie ma uprawnień do tej operacji.');
      const p = msg.p || {};
      const allTabs = () => data.workspaces.flatMap((w) => w.tabs);
      switch (msg.m) {
        case 'ping': return res(true, 'pong');
        case 'info': return res(true, { v: 2, app: 'Hermitty', version: '0.1.0', defaultShell: 'pwsh' });
        case 'state': return res(true, { v: 2, activeWs: data.workspaces[0].id, workspaces: data.workspaces, parked: data.parked });
        case 'shells': return res(true, data.shells);
        case 'chat': return res(true, data.chat[p.ws] || []);
        case 'flows': return res(true, data.flows);
        case 'subscribe': subs.add(p.tab); return res(true, { cols: 92, rows: 26, screen: data.screens[p.tab] || '' });
        case 'unsubscribe': subs.delete(p.tab); return res(true);
        case 'tail': return res(true, data.screens[p.tab] || '');
        case 'write': {
          // Echo jak w powłoce: Enter kończy linię i pokazuje znak zachęty.
          const out = String(p.data).replace(/\r/g, N + g('PS ') + 'C:\\dev\\api> ');
          for (const c of conns) if (c.subs.has(p.tab)) c.ev('out', { tab: p.tab, data: out });
          return res(true);
        }
        case 'approve': {
          const m = (data.chat[p.ws] || []).find((x) => x.id === p.msg);
          if (m?.approve) m.approve.state = p.ok ? 'approved' : 'rejected';
          for (const c of conns) c.ev('chat', { ws: p.ws, messages: data.chat[p.ws] });
          return res(true);
        }
        case 'agent': {
          res(true);
          const list = (data.chat[p.ws] ||= []);
          list.push({ id: 'u' + Date.now(), role: 'user', who: 'Ty', text: String(p.text) });
          const w = data.workspaces.find((x) => x.id === p.ws); if (w) w.busy = true;
          for (const c of conns) { c.ev('chat', { ws: p.ws, messages: list }); c.ev('state', { v: 2, activeWs: data.workspaces[0].id, workspaces: data.workspaces, parked: data.parked }); }
          setTimeout(() => {
            list.push({ id: 'a' + Date.now(), role: 'agent', who: 'Szef (domyślny)', text: 'Sprawdzam zakładki workspace\u2019u i zaraz wracam z odpowiedzią.' });
            if (w) w.busy = false;
            for (const c of conns) { c.ev('chat', { ws: p.ws, messages: list }); c.ev('state', { v: 2, activeWs: data.workspaces[0].id, workspaces: data.workspaces, parked: data.parked }); }
          }, 600);
          return;
        }
        case 'stopAgent': return res(true);
        case 'newTab': {
          const w = data.workspaces.find((x) => x.id === p.ws) || data.workspaces[0];
          const id = 'n' + Date.now(); const sh = data.shells.shells.find((s) => s.id === p.shell);
          w.tabs.push({ id, title: sh ? sh.id : 'ssh', kind: 'terminal', label: sh?.kind === 'wsl' ? 'WSL' : p.shell?.startsWith('ssh:') ? 'SSH' : 'PS', color: '#5E87A8' });
          w.activeTab = id; data.screens[id] = g('PS ') + 'C:\\Users\\dev> ';
          for (const c of conns) c.ev('state', { v: 2, activeWs: w.id, workspaces: data.workspaces, parked: data.parked });
          return res(true, { tab: id });
        }
        case 'closeTab': for (const w of data.workspaces) w.tabs = w.tabs.filter((t) => t.id !== p.tab); for (const c of conns) c.ev('state', { v: 2, activeWs: data.workspaces[0].id, workspaces: data.workspaces, parked: data.parked }); return res(true);
        case 'park': case 'unpark': return res(true);
        case 'runFlow': {
          const f = data.flows.find((x) => x.id === p.tab);
          if (!f) return res(false, 'Nie ma takiego workflow.');
          res(true); ev('flow', { tab: p.tab, state: 'running' });
          setTimeout(() => ev('flow', { tab: p.tab, state: 'done', result: 'Streszczenie: 4 commity, testy przeszły (52/52). Notatka „Raport” zapisana.' }), 900);
          return;
        }
        default: return res(false, `Nieznana operacja ${msg.m}`);
      }
    });
  });
  return new Promise((resolve) => wss.on('listening', () => resolve({
    port: wss.address().port, devices, pairs, data,
    /** Zdarzenie do wszystkich połączonych telefonów (np. wyjście terminala). */
    broadcast: (e, d) => { for (const c of conns) c.ev(e, d); },
    pairLink: (host = '127.0.0.1') => {
      // Jak w remote.rs: id i klucz w base64 bezpiecznym dla adresów (bez +, / i =).
      const url = (u) => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const id = url(randomBytes(12)), k = url(randomBytes(32)); pairs.set(id, k);
      return `http://${host}:${wss.address().port}/#p=${id}&k=${k}`;
    },
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }),
  })));
}

// Uruchomione bezpośrednio: atrapa z linkiem do parowania i strumieniem wyjścia w zakładce api.
if (import.meta.url === `file://${process.argv[1]}`) {
  const pc = await startFakePc({ port: Number(process.env.PORT || 7420) });
  console.log(`Atrapa Hermitty na porcie ${pc.port}. Link do parowania:\n${pc.pairLink()}`);
  let n = 0;
  setInterval(() => pc.broadcast('out', { tab: 't3', data: `GET /health 200 ${2 + (n++ % 5)}ms\r\n` }), 2500);
}
