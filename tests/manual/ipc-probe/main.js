// Test ręczny: czy kod w ramce pluginu może wołać komendy rdzenia bez hosta (window.__TAURI_INTERNALS__,
// kanał WebView2). Plugin ma tylko ui:sidebar; każda udana próba poniżej oznacza obejście uprawnień.
// Instrukcja: tests/manual/ipc-probe/README.md

/** @type {import('../../../plugins/sdk/hermitty-plugin').TxApi} */
export async function activate(tx) {
  const rows = [];
  const add = (name, bad, detail) => rows.push({ name, bad, detail });

  const internals = window.__TAURI_INTERNALS__;
  add('window.__TAURI_INTERNALS__', !!internals, internals ? 'jest' : 'brak');
  add('window.__TAURI__', !!window.__TAURI__, window.__TAURI__ ? 'jest' : 'brak');
  add('window.chrome.webview (kanał WebView2)', !!window.chrome?.webview, window.chrome?.webview ? 'jest' : 'brak');

  if (internals?.invoke) {
    try {
      const r = await internals.invoke('sys_stats');
      add('invoke("sys_stats") przez IPC', true, `UDAŁO SIĘ: ${JSON.stringify(r).slice(0, 80)}`);
    } catch (e) {
      add('invoke("sys_stats") przez IPC', false, `odrzucone: ${String(e).slice(0, 120)}`);
    }
  }
  if (window.chrome?.webview?.postMessage) {
    try { window.chrome.webview.postMessage('{}'); add('chrome.webview.postMessage', true, 'wysłano (sprawdź, czy rdzeń zareagował)'); }
    catch (e) { add('chrome.webview.postMessage', false, `błąd: ${String(e).slice(0, 120)}`); }
  }

  const bad = rows.some((r) => r.bad);
  tx.ui.sidebar.registerSection({
    id: 'probe',
    title: 'Test IPC',
    render(el) {
      el.innerHTML = `<div style="padding:6px 10px;font-size:12px;line-height:1.5">
        <b style="color:${bad ? 'var(--destructive)' : 'var(--chart-1)'}">${bad ? 'PROBLEM: ramka pluginu ma dostęp do rdzenia' : 'OK: brak bezpośredniego dostępu do rdzenia'}</b>
        ${rows.map((r) => `<div>${r.bad ? '✗' : '✓'} ${r.name}: <span style="opacity:.75"></span></div>`).join('')}
      </div>`;
      el.querySelectorAll('span').forEach((s, i) => { s.textContent = rows[i].detail; });
    },
  });
}
