// Konfiguracja serwerów MCP bez zależności od stanu aplikacji (testowana w tests/mcpcfg.test.ts).
import type { McpServer } from './types';

/* ---------- import konfiguracji w formacie Claude Desktop / Cursor / VS Code ---------- */

/** `{"mcpServers": {...}}`, `{"servers": {...}}` albo sama mapa serwerów. */
export function parseImport(json: string): Omit<McpServer, 'id' | 'keyRef' | 'hasKey'>[] {
  const v = JSON.parse(json);
  const map = v?.mcpServers || v?.servers || v?.mcp?.servers || v;
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('Oczekuję obiektu {"mcpServers": {...}}');
  return Object.entries<any>(map).filter(([, c]) => c && typeof c === 'object' && (c.command || c.url || c.serverUrl)).map(([name, c]) => ({
    name,
    kind: c.command ? 'stdio' : 'http',
    command: String(c.command || ''),
    args: Array.isArray(c.args) ? c.args.map(String) : [],
    env: Object.fromEntries(Object.entries(c.env || {}).map(([k, x]) => [k, String(x)])),
    cwd: String(c.cwd || ''),
    url: String(c.url || c.serverUrl || ''),
    headers: Object.fromEntries(Object.entries(c.headers || {}).map(([k, x]) => [k, String(x)])),
    secretEnv: '',
    enabled: c.disabled !== true,
  }));
}

/** Argumenty z jednej linii: spacje rozdzielają, cudzysłowy grupują. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
export const joinArgs = (a: string[]) => a.map((x) => (/\s/.test(x) || !x ? `"${x}"` : x)).join(' ');
