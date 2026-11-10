// Przykładowe dane: wyjście terminali (po katalogu startowym), notatki i klucze API.
(() => {
  if (window !== window.top) return;
  const E = '\x1b[', g = (s) => E + '32m' + s + E + '0m', r = (s) => E + '31m' + s + E + '0m', y = (s) => E + '33m' + s + E + '0m',
    b = (s) => E + '34m' + s + E + '0m', c = (s) => E + '36m' + s + E + '0m', m = (s) => E + '35m' + s + E + '0m', d = (s) => E + '2m' + s + E + '0m', B = (s) => E + '1m' + s + E + '0m';
  const N = '\r\n';
  const ps = (dir) => g('PS ') + dir + '> ';
  const OUT = {
    'C:\\dev\\api': [
      ps('C:\\dev\\api') + 'git status -sb', y('## main') + '...' + r('origin/main') + ' [ahead 2]', ' ' + r('M') + ' src/auth/token.ts', r('??') + ' tests/auth.test.ts',
      ps('C:\\dev\\api') + 'npm test', '', d('> api@1.4.0 test'), d('> vitest run'), '',
      ' ' + g('✓') + ' tests/users.test.ts ' + d('(18)') + ' 412ms', ' ' + g('✓') + ' tests/orders.test.ts ' + d('(23)') + ' 655ms',
      ' ' + r('❯') + ' tests/auth.test.ts ' + d('(11)') + ' ' + r('1 failed'), '   ' + r('× token wygasa po 60 s'), '     ' + d('→ expected 401 to be 200'), '',
      d(' Test Files ') + ' ' + r(B('1 failed')) + d(' | ') + g(B('2 passed')) + d(' (3)'), d('      Tests ') + ' ' + r(B('1 failed')) + d(' | ') + g(B('51 passed')) + d(' (52)'),
      d('   Duration ') + ' 2.14s', ps('C:\\dev\\api')].join(N),
    '~/app': [
      g(B('dev@PRACOWNIA')) + ':' + b(B('~/app')) + '$ docker compose ps',
      B('NAME          IMAGE            STATUS         PORTS'),
      'app-web-1     app-web          ' + g('Up 2 hours') + '     0.0.0.0:3000->3000/tcp',
      'app-db-1      postgres:16      ' + g('Up 2 hours') + '     5432/tcp',
      'app-redis-1   redis:7-alpine   ' + g('Up 2 hours') + '     6379/tcp',
      g(B('dev@PRACOWNIA')) + ':' + b(B('~/app')) + '$ uname -sr', 'Linux 5.15.167.4-microsoft-standard-WSL2',
      g(B('dev@PRACOWNIA')) + ':' + b(B('~/app')) + '$ git log --oneline -4',
      y('f51114e') + ' ' + c('(HEAD -> main)') + ' Kolejka zadań: ponawianie z backoffem', y('86f8a62') + ' Health-check dla Redis', y('1066449') + ' Migracja: indeks na orders.created_at', y('c9b7c24') + ' Docker: obraz na Node 22',
      g(B('dev@PRACOWNIA')) + ':' + b(B('~/app')) + '$ '].join(N),
    'ssh': [
      'Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-49-generic x86_64)', '', d('Last login: Mon Nov 10 08:41:12 2026 from 10.0.0.12'),
      g(B('deploy@prod-web-1')) + ':' + b(B('~')) + '$ systemctl status api --no-pager',
      g('●') + ' api.service - API (Node.js)', '     Loaded: loaded (/etc/systemd/system/api.service; enabled)', '     Active: ' + g(B('active (running)')) + ' since Mon 2026-11-10 06:02:31 UTC; 2h 41min ago',
      '   Main PID: 1842 (node)', '     Memory: 212.4M', '',
      g(B('deploy@prod-web-1')) + ':' + b(B('~')) + '$ journalctl -u api -n 3 --no-pager -o cat',
      'GET /health 200 2ms', 'POST /orders 201 48ms', y('WARN') + ' slow query orders_by_customer 812ms',
      g(B('deploy@prod-web-1')) + ':' + b(B('~')) + '$ '].join(N),
    'C:\\dev\\api\\cmd': ['Microsoft Windows [Version 10.0.26100.2314]', '(c) Microsoft Corporation. Wszelkie prawa zastrzeżone.', '', 'C:\\dev\\api>where node', 'C:\\Program Files\\nodejs\\node.exe', '', 'C:\\dev\\api>'].join(N),
    'C:\\dev\\web': [ps('C:\\dev\\web') + 'npm run dev', '', d('> web@0.9.0 dev'), d('> vite'), '', '  ' + g(B('VITE v6.3.5')) + '  ready in ' + B('312') + ' ms', '', '  ' + g('➜') + '  ' + B('Local') + ':   ' + c('http://localhost:5173/'), '  ' + g('➜') + '  ' + d('Network: use --host to expose')].join(N),
  };
  window.__onPty = (id, shell, cwd) => {
    const key = shell === 'ssh' ? 'ssh' : shell === 'cmd' ? 'C:\\dev\\api\\cmd' : cwd || (shell.startsWith('wsl') ? '~/app' : 'C:\\dev\\api');
    window.__H.write(id, (OUT[key] || ps(cwd || 'C:\\Users\\dev')) + (key === 'C:\\dev\\web' ? N : ''));
  };
  const fs = window.__H.fs;
  const note = (path, title, body) => { fs['tx.notes:' + path] = `---\ntitle: ${title}\n---\n${body}`; };
  fs['tx.notes:notes/.dir'] = ''; fs['tx.notes:notes/Wdrożenia/.dir'] = '';
  note('notes/Wdrożenia/checklista-release.md', 'Checklista release', '- [x] testy\n- [ ] changelog');
  note('notes/Wdrożenia/prod-rollback.md', 'Rollback na produkcji', 'docker compose up -d --no-deps web');
  note('notes/pomysly-na-0.2.md', 'Pomysły na 0.2', 'Workflow z harmonogramem');
  note('notes/komendy-wsl.md', 'Komendy WSL', 'wsl --shutdown');
  fs['tx.notes:.state.json'] = JSON.stringify({ open: ['notes/Wdrożenia'] });
  fs['tx.keys:providers.json'] = JSON.stringify({ providers: [
    { id: 'p1', name: 'Anthropic', url: 'https://console.anthropic.com/settings/keys', open: true, keys: [{ id: 'k1', label: 'Prywatny' }, { id: 'k2', label: 'Firma' }] },
    { id: 'p2', name: 'OpenAI', url: 'https://platform.openai.com/api-keys', open: false, keys: [{ id: 'k3', label: '' }] },
    { id: 'p3', name: 'Stripe', url: 'https://dashboard.stripe.com/apikeys', open: false, keys: [{ id: 'k4', label: 'test' }] }] });
  // Czcionki motywu Pinsy (w aplikacji pobierane z Google Fonts przy pierwszym użyciu).
  const link = document.createElement('link'); link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=block';
  document.addEventListener('DOMContentLoaded', () => document.head.appendChild(link));
})();
