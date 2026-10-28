// Aktualizacje z wydań na GitHubie (podpisane kluczem aplikacji). Sprawdzenie to jedno małe zapytanie:
// po starcie i co 6 godzin. Instalacja dopiero po kliknięciu.
import { call, isTauri } from './ipc';
import { notify, finalizeAll, saveNow } from './state.svelte';

export const upd = $state({ version: '', notes: '', busy: false, pct: 0 });
let found: any = null;

export async function checkUpdate(manual = false) {
  if (!isTauri) return;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const u = await check();
    if (u) { found = u; upd.version = u.version; upd.notes = u.body || ''; }
    else if (manual) notify('Masz najnowszą wersję', 'success');
  } catch (e) { if (manual) notify(`Nie udało się sprawdzić aktualizacji: ${e}`, 'error'); }
}

export async function installUpdate() {
  if (!found || upd.busy) return;
  upd.busy = true;
  let total = 0, done = 0;
  try {
    // W Windows instalator zamyka aplikację, więc najpierw zapisujemy stan.
    finalizeAll();
    await saveNow();
    await found.downloadAndInstall((ev: any) => {
      if (ev.event === 'Started') total = ev.data.contentLength || 0;
      else if (ev.event === 'Progress') { done += ev.data.chunkLength; upd.pct = total ? Math.round((done / total) * 100) : 0; }
    });
    await call('app_restart');
  } catch (e) {
    notify(`Aktualizacja nie powiodła się: ${e}`, 'error', 8000);
    upd.busy = false;
  }
}

export function startUpdates() {
  setTimeout(() => checkUpdate(), 15_000);
  setInterval(() => checkUpdate(), 6 * 3600_000);
}
