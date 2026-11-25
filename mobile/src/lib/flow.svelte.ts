// Workflow na telefonie: ten sam format grafu co w Hermitty na komputerze (nody, krawędzie, cfg), więc workflow
// można przenosić w obie strony (eksport/import JSON). Działają nody, które mają sens na telefonie; pozostałe
// (grafika, wideo, pliki na dysku komputera, git) są oznaczone jako niedostępne i przy uruchomieniu zgłaszają błąd.
import { invoke } from '@tauri-apps/api/core';
import { BUILTIN_NODES, DEFAULT_PROMPTS } from '../../../src/lib/defaults';
import { fill, nid, sleep } from '../../../src/lib/util';
import { evalCond, jsonPath, topoOrder, htmlText, importFlowJson, exportFlowJson } from '../../../src/lib/workflow/logic';
import type { Flow, FlowNode, NodeTypeDef } from '../../../src/lib/types';
import { ask, chat, send as agentSend } from './agent.svelte';
import { hostById, hostCfg, SSH } from './ssh.svelte';
import { ensureSshd, TERMUX_ID } from './termux.svelte';
import { WS, saveWs, wsTools, tabHost, type LWs } from './ws.svelte';
import { outputs, inputs, stripAnsi } from './termbus';
import { toast } from './store.svelte';

/** Nody działające na telefonie. Na telefonie „Uruchom komendę” idzie do Termuxa albo serwera SSH, nie do PowerShella. */
const PHONE = new Set(['manual', 'cron', 'webhook', 'term_match', 'run_cmd', 'send_tab', 'wait_out',
  'ai_prompt', 'ai_classify', 'ai_extract', 'ai_summary', 'ai_translate', 'ai_review', 'ai_agent',
  'if', 'switch', 'loop', 'parallel', 'delay', 'merge', 'template', 'jsonpath', 'regex', 'var', 'split_text', 'join',
  'http', 'fetch_page', 'preview', 'notify', 'to_note', 'clipboard', 'to_agent']);

const OVERRIDE: Record<string, Partial<NodeTypeDef>> = {
  run_cmd: { desc: 'Uruchamia komendę w Termuxie albo na serwerze SSH (osobna sesja) i zwraca wyjście.', fields: [['command', 'Komenda', 'echo {{input}}'], ['target', 'Gdzie: termux albo nazwa serwera/zakładki', 'termux']] },
  send_tab: { fields: [['tab', 'Zakładka (nazwa)', ''], ['text', 'Tekst', '{{input}}']] },
  to_note: { desc: 'Dopisuje wynik do zakładki notatek tego workspace\'u (tworzy ją, gdy jej nie ma).', fields: [['title', 'Nagłówek', 'Wynik workflow']] },
  to_agent: { desc: 'Dopisuje wynik do czatu agenta tego workspace\'u.' },
};

export const NODE_TYPES: (NodeTypeDef & { phone: boolean })[] = BUILTIN_NODES.map((t) => ({ ...t, ...(OVERRIDE[t.id] || {}), phone: PHONE.has(t.id) }));
export const nodeType = (id: string) => NODE_TYPES.find((t) => t.id === id) || NODE_TYPES[0];

export function makeNode(typeId: string, x: number, y: number): FlowNode {
  const ty = nodeType(typeId);
  const cfg = ty.ai
    ? { base: ty.base || '', prompt: '', provider: '', model: '', temperature: 0.3, maxTokens: 2048, topP: 1, results: 1, format: ty.format || 'text', ...(ty.defaults || {}) }
    : Object.fromEntries((ty.fields || []).map((f) => [f[0], f[2]]));
  return { id: nid('n'), type: ty.id, x: Math.round(x), y: Math.round(y), label: '', cfg };
}

export const newFlow = (): Flow => ({ id: nid('f'), nodes: [makeNode('manual', 40, 60)], edges: [] });

export const FR = $state({
  status: {} as Record<string, 'run' | 'ok' | 'err' | 'skip'>,
  out: {} as Record<string, string>,
  running: {} as Record<string, boolean>,
});

type Result = { text: string; items?: string[]; stop?: boolean; exit?: number };

const promptBody = (id: string) => DEFAULT_PROMPTS.find((p) => p.id === id && p.type === 'prompt')?.body || '';

function promptFor(cfg: Record<string, any>, input: string, vars: Record<string, string>) {
  const raw = [promptBody(cfg.base || ''), cfg.prompt || ''].filter((s) => s.trim()).join('\n\n');
  const usesInput = /\{\{\s*input\s*\}\}/.test(raw);
  let prompt = fill(raw, { ...vars, input });
  if (!prompt.trim()) prompt = input;
  else if (!usesInput && input) prompt += `\n\n${input}`;
  if (cfg.format === 'json') prompt += '\n\nOdpowiedz wyłącznie poprawnym JSON-em, bez komentarzy i bloków kodu.';
  if (cfg.format === 'list') prompt += '\n\nOdpowiedz listą: jedna pozycja w linii, bez numeracji i komentarzy.';
  return prompt;
}

function tabByName(ws: LWs, name: string) {
  const n = name.trim().toLowerCase();
  return ws.tabs.find((t) => (t.kind === 'termux' || t.kind === 'ssh') && (t.title.toLowerCase() === n || t.id === name))
    || (n ? null : ws.tabs.find((t) => t.kind === 'termux' || t.kind === 'ssh')) || null;
}

async function waitIn(tabId: string, pattern: string, timeoutSec: number) {
  let re: RegExp;
  try { re = new RegExp(pattern); } catch { throw new Error(`Niepoprawny regex: ${pattern}`); }
  let buf = '';
  const off = outputs.on(tabId, (d) => { buf += d; if (buf.length > 1 << 19) buf = buf.slice(-(1 << 18)); });
  const start = Date.now();
  try {
    while (Date.now() - start < timeoutSec * 1000) {
      const clean = stripAnsi(buf);
      if (re.test(clean)) return clean.split('\n').find((l) => re.test(l)) || clean;
      await sleep(300);
    }
  } finally { off(); }
  throw new Error(`Nie pojawiło się „${pattern}” w ${timeoutSec} s`);
}

async function exec(node: FlowNode, input: string, exitIn: number | undefined, vars: Record<string, string>, ws: LWs): Promise<Result> {
  const ty = nodeType(node.type);
  if (!ty.phone) throw new Error(`Node „${ty.name}” działa tylko w Hermitty na komputerze.`);
  const c = node.cfg;
  const f = (s: unknown) => fill(String(s ?? ''), { ...vars, input });
  if (ty.ai) return { text: await ask(promptFor(c, input, vars), undefined, Math.max(256, Math.min(8000, +c.maxTokens || 2048))) };
  switch (ty.id) {
    case 'manual': case 'cron': case 'parallel': case 'merge': case 'preview': return { text: input };
    case 'webhook': case 'fetch_page': case 'http': {
      const r = await invoke<{ status: number; text: string }>('http_fetch', { method: ty.id === 'http' ? String(c.method || 'GET') : 'GET', url: f(c.url), body: ty.id === 'http' ? f(c.body) : null, headers: null });
      if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 200)}`);
      return { text: ty.id === 'fetch_page' ? htmlText(r.text) : r.text };
    }
    case 'run_cmd': {
      const target = String(c.target || c.shell || 'termux').trim();
      const tab = tabByName(ws, target);
      const h = target.toLowerCase() === 'termux' ? hostById(TERMUX_ID)
        : tab ? tabHost(tab) : SSH.hosts.find((x) => x.name.toLowerCase() === target.toLowerCase() || x.id === target) || null;
      if (!h) throw new Error(target.toLowerCase() === 'termux' ? 'Termux nie jest skonfigurowany. Dodaj zakładkę Termux w workspace.' : `Nie ma serwera ani zakładki „${target}”`);
      if (h.termux) await ensureSshd();
      const r = await invoke<{ code: number | null; output: string }>('ssh_exec', { host: hostCfg(h), command: f(c.command), timeoutSecs: 300 });
      return { text: r.output.trim(), exit: r.code ?? undefined };
    }
    case 'send_tab': {
      const t = tabByName(ws, String(c.tab || ''));
      if (!t || !inputs.has(t.id)) throw new Error(`Zakładka „${c.tab}” nie jest otwarta`);
      inputs.emit(t.id, f(c.text || '{{input}}').replace(/\n/g, '\r') + '\r');
      return { text: input };
    }
    case 'term_match': case 'wait_out': {
      const t = tabByName(ws, String(c.tab || ''));
      if (!t) throw new Error(`Nie ma zakładki „${c.tab}”`);
      return { text: await waitIn(t.id, String(c.regex || '.'), +c.timeout || 60) };
    }
    case 'ai_agent': {
      const scope = `ws:${ws.id}`;
      if (chat(scope).busy) throw new Error('Agent tego workspace\'u jest zajęty.');
      const before = chat(scope).items.length;
      await agentSend(scope, f(c.task || '{{input}}'), wsTools(ws.id));
      return { text: chat(scope).items.slice(before).filter((m) => m.role === 'assistant').map((m) => m.text).join('\n\n') };
    }
    case 'if': return evalCond(String(c.expr || ''), input, exitIn) ? { text: input, exit: exitIn } : { text: input, stop: true };
    case 'switch': {
      const vals = String(c.values || '').split(',').map((s) => s.trim()).filter(Boolean);
      return vals.some((v) => input.includes(v)) ? { text: input } : { text: input, stop: true };
    }
    case 'loop': return { text: input, items: input.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, +c.max || 20) };
    case 'delay': await sleep(Math.min(3600, +c.sec || 1) * 1000); return { text: input };
    case 'template': return { text: f(c.tpl) };
    case 'jsonpath': return { text: jsonPath(input, String(c.path || '')) };
    case 'regex': {
      let re: RegExp;
      try { re = new RegExp(String(c.pattern || ''), String(c.flags || 'g').includes('g') ? String(c.flags) : `${c.flags || ''}g`); } catch { throw new Error('Niepoprawny regex'); }
      return { text: [...input.matchAll(re)].map((m) => m[1] ?? m[0]).join('\n') };
    }
    case 'var': vars[String(c.name || 'wynik')] = input; return { text: input };
    case 'split_text': { const sep = String(c.sep ?? '\\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t'); const items = input.split(sep).filter((s) => s.trim()); return { text: items.join('\n'), items }; }
    case 'join': return { text: input.split('\n').filter(Boolean).join(String(c.sep ?? ', ').replace(/\\n/g, '\n')) };
    case 'notify': toast(`${f(c.title)}${input ? ': ' + input.slice(0, 160) : ''}`); return { text: input };
    case 'clipboard': await navigator.clipboard.writeText(input).catch(() => {}); return { text: input };
    case 'to_note': {
      let t = ws.tabs.find((x) => x.kind === 'notes');
      if (!t) { t = { id: nid('t'), kind: 'notes', title: 'Notatki', note: '' }; ws.tabs.push(t); }
      t.note = `${t.note ? t.note.replace(/\n*$/, '\n\n') : ''}## ${f(c.title || 'Wynik workflow')}\n${input}`;
      saveWs();
      return { text: input };
    }
    case 'to_agent': {
      chat(`ws:${ws.id}`).items.push({ id: nid('m'), role: 'assistant', text: `Workflow: ${input}` });
      return { text: input };
    }
  }
  return { text: input };
}

/** Uruchamia workflow; `only` liczy jeden node (poprzedniki z udanym wynikiem bierze z ostatniego uruchomienia). */
export async function runFlow(flow: Flow, ws: LWs, only?: string): Promise<string> {
  if (FR.running[flow.id]) throw new Error('Ten workflow już działa');
  FR.running[flow.id] = true;
  const need = new Set<string>();
  if (only) { const up = (id: string) => { if (need.has(id)) return; need.add(id); for (const [a, b] of flow.edges) if (b === id) up(a); }; up(only); }
  for (const n of flow.nodes) if (!only || n.id === only || (need.has(n.id) && FR.status[n.id] !== 'ok')) { delete FR.status[n.id]; delete FR.out[n.id]; }
  const { order, cyclic } = topoOrder(flow.nodes.map((n) => n.id), flow.edges);
  if (cyclic.length) toast('Workflow ma cykl; nody w pętli zostały pominięte.');
  const results: Record<string, Result | null> = {};
  const vars: Record<string, string> = {};
  try {
    for (const id of order) {
      const node = flow.nodes.find((n) => n.id === id)!;
      if (only && !need.has(id)) continue;
      if (only && id !== only && FR.status[id] === 'ok') { results[id] = { text: FR.out[id] ?? '' }; continue; }
      const ups = flow.edges.filter(([, b]) => b === id).map(([a]) => a);
      const live = ups.map((u) => results[u]).filter((r): r is Result => !!r && !r.stop);
      if (ups.length && !live.length) { results[id] = null; FR.status[id] = 'skip'; continue; }
      const input = live.map((r) => r.text).join('\n\n');
      const exitIn = live.find((r) => r.exit !== undefined)?.exit;
      const items = live.length === 1 ? live[0].items : undefined;
      FR.status[id] = 'run';
      try {
        let res: Result;
        if (items && items.length && node.type !== 'join' && node.type !== 'merge') {
          const parts: string[] = [];
          for (const it of items) parts.push((await exec(node, it, exitIn, vars, ws)).text);
          res = { text: parts.join('\n') };
        } else res = await exec(node, input, exitIn, vars, ws);
        results[id] = res;
        FR.out[id] = res.text;
        FR.status[id] = res.stop ? 'skip' : 'ok';
      } catch (e) {
        results[id] = null;
        FR.out[id] = String((e as Error)?.message || e).replace(/^Error: /, '');
        FR.status[id] = 'err';
        toast(`Node „${node.label || nodeType(node.type).name}”: ${FR.out[id]}`);
        break;
      }
    }
  } finally { FR.running[flow.id] = false; }
  const sinks = flow.nodes.filter((n) => !flow.edges.some(([a]) => a === n.id) && results[n.id]);
  return sinks.map((n) => `${n.label || nodeType(n.type).name}: ${results[n.id]!.text}`).join('\n\n').slice(0, 8000) || '(brak wyników)';
}

/* ---------- harmonogram (gdy aplikacja jest otwarta) ---------- */

const lastRun: Record<string, number> = {};
let started = false;
export function startScheduler() {
  if (started) return;
  started = true;
  setInterval(() => {
    for (const ws of WS.list) for (const t of ws.tabs) {
      const flow = t.flow;
      if (!flow || FR.running[flow.id] || flow.byAgent) continue;
      for (const n of flow.nodes) {
        if (n.type !== 'cron' || flow.edges.some(([, b]) => b === n.id)) continue;
        const every = Math.max(1, +n.cfg.every || 60) * 60_000;
        lastRun[n.id] ??= Date.now();
        if (Date.now() - lastRun[n.id] >= every) { lastRun[n.id] = Date.now(); runFlow(flow, ws).catch(() => {}); }
      }
    }
  }, 30_000);
}

/** Workflow z JSON-a (eksport z komputera albo z telefonu) jako nowy workflow. */
export const importFlow = (text: string): Flow => ({ id: nid('f'), ...importFlowJson(text) });
export const exportFlow = (flow: Flow) => exportFlowJson(flow);
