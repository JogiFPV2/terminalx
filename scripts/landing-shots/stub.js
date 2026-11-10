// Atrapa rdzenia Tauri dla zrzutów: prawdziwy interfejs Hermitty z przykładowymi danymi.
(() => {
  if (window !== window.top) return;
  const cbs = new Map(); let nextCb = 1;
  const chans = new Map(); // ptyId -> {id, index}
  let nextPty = 1;
  const fs = {};
  window.__H = { chans, fs, panes: {} };
  const deliver = (ptyId, data) => {
    const c = chans.get(ptyId); if (!c) return;
    const cb = cbs.get(c.id); if (cb) cb({ index: c.index++, message: { type: 'data', data } });
  };
  window.__H.write = deliver;
  const MOD = { quota: false };
  const now = Date.now();
  const R = {
    state_load: () => window.__STATE || null,
    state_save: () => null,
    sys_locale: () => 'pl-PL',
    sys_shells: () => [
      { id: 'pwsh', name: 'PowerShell 7', kind: 'ps' }, { id: 'powershell', name: 'Windows PowerShell', kind: 'ps5' },
      { id: 'cmd', name: 'Wiersz poleceń', kind: 'cmd' }, { id: 'wsl:Ubuntu', name: 'WSL · Ubuntu', kind: 'wsl' },
      { id: 'wsl:Debian', name: 'WSL · Debian', kind: 'wsl' }, { id: 'gitbash', name: 'Git Bash', kind: 'bash' }],
    sys_stats: () => ({ cpu: 14, memUsed: 9.2e9, memTotal: 32e9, appMem: 58e6 }),
    pty_spawn: (a) => { const id = nextPty++; chans.set(id, { id: a.onEvent.id, index: 0 }); window.__H.panes[id] = a.shell; setTimeout(() => window.__onPty?.(id, a.shell, a.cwd), 50); return id; },
    ssh_shell: (a) => { const id = 1000 + nextPty++; chans.set(id, { id: a.onEvent.id, index: 0 }); setTimeout(() => window.__onPty?.(id, 'ssh', a.host), 50); return id; },
    pty_info: () => ({ pid: 4242, shell: 'pwsh', started: now - 3600e3, children: [] }),
    plugins_installed: () => [],
    plugin_fs: (a) => {
      const key = `${a.plugin}:${a.path}`;
      if (a.op === 'read') { if (!(key in fs)) throw new Error('ENOENT'); return fs[key]; }
      if (a.op === 'write') { fs[key] = a.data; return null; }
      if (a.op === 'exists') return key in fs || Object.keys(fs).some((k) => k.startsWith(key + '/'));
      if (a.op === 'mkdir') { fs[key + '/.dir'] = ''; return null; }
      if (a.op === 'list') {
        const pre = key.replace(/\/$/, '') + '/'; const seen = new Map();
        Object.keys(fs).filter((k) => k.startsWith(pre)).forEach((k) => { const rest = k.slice(pre.length); const name = rest.split('/')[0]; if (name === '.dir') return;
          seen.set(name, { name, path: `${a.path.replace(/\/$/, '')}/${name}`, kind: rest.includes('/') ? 'dir' : 'file', size: 100, modified: now - 3600e3 }); });
        return [...seen.values()];
      }
      return null;
    },
    secret_has: () => true,
    keyvault_masked: (a) => Object.fromEntries((a.refs || []).map((r) => [r, 'sk-a••••••••9XQ2'])),
    chat_list: () => [], chat_save: () => null,
    remote_status: () => ({ running: true, port: 7420, mode: 'lan', addrs: ['http://192.168.1.24:7420'], clients: [[1, 'd1']] }),
    remote_devices: () => [{ id: 'd1', name: 'Pixel 9', perm: 'control', added: now - 9e8, lastSeen: now }, { id: 'd2', name: 'iPad', perm: 'view', added: now - 5e9, lastSeen: now - 2e8 }],
    remote_start: () => ['http://192.168.1.24:7420'],
    remote_pair_begin: () => ({ pairId: 'x', key: 'k', urls: ['http://192.168.1.24:7420/#p=Qm9vdHN0cmFw&k=c2VjcmV0LWtleS1mb3ItZGVtbw'], expiresIn: 300 }),
    phone_status: () => ({ running: true, port: 8788, addrs: ['192.168.1.24'], pcName: 'PRACOWNIA', pairing: false,
      devices: [{ id: 'ph1', name: 'Pixel 9', model: 'Google Pixel 9', added: now - 9e8, lastSeen: now, online: true, addr: '192.168.1.31',
        info: { battery: 82, charging: false, android: 15, perms: { notifications: true, sms: true, mic: true }, mic: true, rec: { recording: false } } }] }),
    phone_start: () => null,
    phone_request: (a) => {
      if (a.method === 'notif.list') return [
        { key: 'n1', app: 'Slack', time: now - 4 * 60e3, title: 'Ola · #release', text: 'Build 0.2 przeszedł, wrzucam changelog?', clearable: true, actions: [{ i: 0, title: 'Odpowiedz', reply: true }, { i: 1, title: 'Oznacz jako przeczytane' }] },
        { key: 'n2', app: 'GitHub', time: now - 22 * 60e3, title: 'Review requested', text: 'terminalx #41: Agent: zgoda przed workflow', clearable: true, actions: [] },
        { key: 'n3', app: 'Kalendarz', time: now - 50 * 60e3, title: 'Stand-up za 10 min', text: 'Google Meet', clearable: true, actions: [] }];
      if (a.method === 'sms.threads') return [
        { thread: 1, name: 'Kasia', addr: '+48 600 100 200', date: now - 30 * 60e3, body: 'Odbierzesz paczkę o 17?', unread: 1 },
        { thread: 2, name: 'Bank', addr: 'BANK', date: now - 3 * 3600e3, body: 'Kod: •••••• Nie podawaj go nikomu.', out: false },
        { thread: 3, name: 'Tomek', addr: '+48 600 300 400', date: now - 26 * 3600e3, body: 'Jasne, do jutra', out: true }];
      if (a.method === 'rec.list') return [];
      return null;
    },
    phone_files: () => [
      { device: 'ph1', kind: 'nagrania', name: 'notatka-glosowa.m4a', path: 'x', size: 412000, modified: now - 2 * 3600e3 }],
    mcp_connect: (a) => [{ name: 'search_issues', annotations: { readOnlyHint: true } }, { name: 'create_pull_request' }, { name: 'get_file_contents', annotations: { readOnlyHint: true } }],
    aicli_detect: () => [
      { id: 'claude', name: 'Claude Code', installed: true, headless: true, version: '2.1.0' },
      { id: 'codex', name: 'Codex', installed: true, headless: true, version: '0.9.2' },
      { id: 'gemini', name: 'Gemini CLI', installed: false, headless: true }],
    aicli_status: () => ({ loggedIn: true, text: 'zalogowano (Max)' }),
    plan_usage: () => null,
    fs_list_detail: (a) => [a.dir || 'C:\\Users\\dev\\projekty\\api', [
      { name: 'src', path: 'x', isDir: true, size: 0, modified: now - 3600e3 }, { name: 'tests', path: 'x', isDir: true, size: 0, modified: now - 7200e3 },
      { name: 'package.json', path: 'x', isDir: false, size: 1840, modified: now - 86400e3 }, { name: 'README.md', path: 'x', isDir: false, size: 5120, modified: now - 5 * 86400e3 }]],
    sftp_list: () => ['/home/deploy/app', [
      { name: 'releases', path: '/home/deploy/app/releases', isDir: true, size: 0, modified: now - 3600e3 },
      { name: 'shared', path: '/home/deploy/app/shared', isDir: true, size: 0, modified: now - 86400e3 },
      { name: 'docker-compose.yml', path: 'x', isDir: false, size: 2310, modified: now - 2 * 86400e3 },
      { name: '.env', path: 'x', isDir: false, size: 412, modified: now - 9 * 86400e3 }]],
    ssh_connections: () => [], ssh_forwards: () => [],
    gallery_list: () => [], media_dir: () => 'C:\\media', fonts_dir: () => null,
    local_hw: () => null, comfy_status: () => ({ running: false }),
    'plugin:window|is_maximized': () => false,
    'plugin:event|listen': () => nextCb++,
    'plugin:event|unlisten': () => null,
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    plugins: {},
    transformCallback: (cb) => { const id = nextCb++; cbs.set(id, cb); return id; },
    unregisterCallback: (id) => cbs.delete(id),
    convertFileSrc: (p) => p,
    invoke: async (cmd, args) => {
      const f = R[cmd];
      if (!f) { (window.__unk ||= new Set()).add(cmd); return null; }
      return f(args || {});
    },
  };
})();
