// Bieżący katalog z sekwencji OSC zgłaszanych przez powłokę (integracja ustawiana w pty.rs).

const unescape = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/** OSC 7 (file://host/ścieżka) → katalog. Host wsl.localhost: pierwszy segment to dystrybucja. */
export function parseOsc7(data: string): { cwd: string; dir: string } | null {
  const m = /^file:\/\/([^/]*)(\/.*)$/.exec(data);
  if (!m) return null;
  const host = m[1].toLowerCase(), path = unescape(m[2]);
  if (host === 'wsl.localhost' || host === 'wsl$') {
    const [, distro, rest = ''] = /^\/([^/]+)(\/.*)?$/.exec(path) || [];
    if (!distro) return null;
    // Dyski Windows w WSL (/mnt/c/...) czytamy wprost, bez sieciowej ścieżki \\wsl.localhost.
    const mnt = /^\/mnt\/([a-z])(\/.*)?$/i.exec(rest);
    if (mnt) return { cwd: rest, dir: `${mnt[1].toUpperCase()}:${(mnt[2] || '\\').replace(/\//g, '\\')}` };
    return { cwd: rest || '/', dir: `\\\\wsl.localhost\\${distro}${(rest || '').replace(/\//g, '\\')}` };
  }
  if (/^\/[A-Za-z]:/.test(path)) { const p = path.slice(1).replace(/\//g, '\\'); const w = /^[A-Za-z]:$/.test(p) ? p + '\\' : p; return { cwd: w, dir: w }; }
  if (path.startsWith('///')) { const p = path.slice(1).replace(/\//g, '\\'); return { cwd: p, dir: p }; } // UNC
  return { cwd: path, dir: path };
}
