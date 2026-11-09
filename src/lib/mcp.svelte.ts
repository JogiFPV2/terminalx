// Serwery MCP jako narzędzia agentów. Rdzeń trzyma połączenia (mcp.rs); tu powstają definicje narzędzi
// dla modelu (`<serwer>__<narzędzie>`) i zamiana wyników MCP na bloki rozmowy.
import { call } from './ipc';
import { app } from './state.svelte';
import type { AgentProfile, McpServer } from './types';
import type { Block, ToolDef } from './ai';

export interface McpTool { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; title?: string } }
export interface Bound { server: McpServer; tool: McpTool }

const cfgOf = (s: McpServer) => ({
  kind: s.kind, command: s.command.trim(), args: s.args, env: s.env, cwd: s.cwd || null, url: s.url.trim(), headers: s.headers,
  keyRef: s.hasKey ? s.keyRef : null, secretEnv: s.secretEnv || null,
});

/** Ostatnia lista narzędzi albo błąd każdego serwera (do pokazania w ustawieniach). */
export const mcpStatus = $state<Record<string, { tools?: McpTool[]; error?: string }>>({});

export async function connect(s: McpServer): Promise<McpTool[]> {
  try {
    const tools = await call<McpTool[]>('mcp_connect', { id: s.id, cfg: cfgOf(s) });
    mcpStatus[s.id] = { tools };
    return tools;
  } catch (e) {
    mcpStatus[s.id] = { error: String(e).replace(/^Error: /, '') };
    throw e;
  }
}

export const disconnect = (id: string) => call('mcp_disconnect', { id }).catch(() => {});

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'mcp';

/** Serwery dostępne dla profilu: włączone i (jeśli profil ma listę) wybrane w nim. */
export const serversFor = (p: AgentProfile) => app.mcp.filter((s) => s.enabled && (p.mcp == null || p.mcp.includes(s.id)));

/**
 * Narzędzia MCP dla profilu. Profil „tylko odczyt” dostaje wyłącznie narzędzia oznaczone przez serwer jako
 * tylko do odczytu. Serwer, który nie wstał, trafia do `errors` i nie blokuje pozostałych.
 */
export async function toolsFor(p: AgentProfile): Promise<{ defs: ToolDef[]; bound: Map<string, Bound>; errors: string[] }> {
  const defs: ToolDef[] = [], bound = new Map<string, Bound>(), errors: string[] = [];
  const servers = serversFor(p);
  const lists = await Promise.all(servers.map((s) => connect(s).catch((e) => { errors.push(`${s.name}: ${String(e).replace(/^Error: /, '')}`); return [] as McpTool[]; })));
  servers.forEach((s, i) => {
    for (const t of lists[i]) {
      // Profil tylko do odczytu: wyłącznie narzędzia oznaczone jako tylko do odczytu na serwerze, któremu użytkownik ufa.
      if (p.perm === 'read' && !(s.trustReadOnly && t.annotations?.readOnlyHint)) continue;
      let name = `${slug(s.name).slice(0, 20)}__${t.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);
      for (let n = 2; bound.has(name); n++) name = `${name.slice(0, 60)}_${n}`;
      bound.set(name, { server: s, tool: t });
      const schema = t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : {};
      defs.push({ name, description: `[MCP: ${s.name}] ${t.description || t.annotations?.title || t.name}`.slice(0, 1024), input_schema: { type: 'object', properties: {}, ...schema } });
    }
  });
  return { defs, bound, errors };
}

const TEXT_MAX = 20_000;

/** Wywołuje narzędzie i zwraca treść wyniku: tekst, a obrazy jako bloki obrazu. */
export async function invoke(b: Bound, args: unknown): Promise<string | Block[]> {
  const r: any = await call('mcp_call', { id: b.server.id, cfg: cfgOf(b.server), name: b.tool.name, args: args || {} });
  const blocks: Block[] = [];
  const texts: string[] = [];
  for (const c of r?.content || []) {
    if (c.type === 'text') texts.push(c.text);
    else if (c.type === 'image' && c.data) blocks.push({ type: 'image', source: { type: 'base64', media_type: c.mimeType || 'image/png', data: c.data } });
    else if (c.type === 'resource') texts.push(c.resource?.text ?? `[zasób ${c.resource?.uri || ''}]`);
    else if (c.type === 'resource_link') texts.push(`[zasób ${c.name || ''} ${c.uri || ''}]`);
    else if (c.type === 'audio') texts.push('[dźwięk pominięty]');
  }
  if (!texts.length && r?.structuredContent) texts.push(JSON.stringify(r.structuredContent));
  let text = texts.join('\n').trim() || (blocks.length ? '' : '(pusty wynik)');
  if (text.length > TEXT_MAX) text = text.slice(0, TEXT_MAX) + `\n… (ucięto, wynik ma ${text.length} znaków)`;
  if (r?.isError) text = `Narzędzie zwróciło błąd: ${text}`;
  return blocks.length ? [...(text ? [{ type: 'text', text }] : []), ...blocks] : text;
}

export { parseImport, splitArgs, joinArgs } from './mcpcfg';
