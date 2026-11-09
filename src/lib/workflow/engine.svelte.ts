// Silnik workflow: graf skierowany wykonywany w kolejności topologicznej.
// Każdy node dostaje połączone wyniki swoich poprzedników jako {{input}}.
import { BUILTIN_NODES } from '../defaults';
import { app, notify, curWs } from '../state.svelte';
import { call } from '../ipc';
import { complete, stripAnsi } from '../ai';
import * as sessions from '../terminal/sessions.svelte';
import { fill, nid, sleep, slug } from '../util';
import { MEDIA_DEFAULTS, generateOnce, kindOf, mediaFile, ffmpeg } from './media';
import { localKey } from '../gpu';
import type { Flow, FlowNode, NodeTypeDef, AiCfg, Media, MediaCfg } from '../types';

export const flowRun = $state({
  status: {} as Record<string, 'run' | 'ok' | 'err' | 'skip'>,
  out: {} as Record<string, string>,
  /** Obrazy i wideo z ostatniego uruchomienia noda. */
  media: {} as Record<string, Media[]>,
  /** Krótki stan długich zadań (kolejka, procent). */
  note: {} as Record<string, string>,
  /** Podgląd generowanego obrazu (modele lokalne). */
  preview: {} as Record<string, string>,
  running: {} as Record<string, boolean>,
  /** Nody, których wynik wzięto z pamięci (nic się nie zmieniło od ostatniego uruchomienia). */
  cached: {} as Record<string, boolean>,
});

export const allNodeTypes = (): NodeTypeDef[] => [...BUILTIN_NODES, ...app.nodeTypes];
export const nodeType = (id: string) => allNodeTypes().find((t) => t.id === id) || BUILTIN_NODES[0];

/** Nody, które coś zmieniają albo wysyłają poza aplikację. Agent uruchamia workflow z takimi nodami dopiero po zgodzie. */
export const EFFECT_NODES = new Set(['run_cmd', 'send_tab', 'snippet', 'write_file', 'http', 'fetch_page', 'webhook', 'media_save', 'to_note', 'clipboard']);

/** Opis nodów wykonawczych workflow (z ich ustawieniami, np. treścią komendy) do okna zgody. */
export function effectsOf(flow: Flow): string[] {
  return flow.nodes.filter((n) => EFFECT_NODES.has(n.type)).map((n) => {
    const ty = nodeType(n.type);
    const fields = (ty.fields || []).map(([k, label]) => (n.cfg[k] !== '' && n.cfg[k] != null ? `${label}: ${String(n.cfg[k]).slice(0, 300)}` : '')).filter(Boolean).join(' · ');
    return `${n.label || ty.name}${fields ? ` (${fields})` : ''}`;
  });
}

export function aiDefaults(ty: Partial<NodeTypeDef>): AiCfg {
  return { base: ty.base || '', prompt: '', provider: '', model: '', temperature: 0.3, maxTokens: 2048, topP: 1, results: 1, format: ty.format || 'text', ...(ty.defaults || {}) } as AiCfg;
}

export function makeNode(typeId: string, x: number, y: number, label = ''): FlowNode {
  const ty = nodeType(typeId);
  const cfg = ty.media ? { ...MEDIA_DEFAULTS, aspect: ty.media === 'video' || ty.media === 'i2v' ? '16:9' : '1:1', ...(ty.defaults || {}) }
    : ty.ai ? aiDefaults(ty) : Object.fromEntries((ty.fields || []).map((f) => [f[0], f[2]]));
  return { id: nid('n'), type: ty.id, x, y, label, cfg };
}

type Result = { text: string; items?: string[]; stop?: boolean; exit?: number; media?: Media[] };

/** Wyniki drogich nodów (AI, grafika, wideo) z ostatniego udanego uruchomienia. Ten sam node z tymi samymi
 *  ustawieniami i wejściem nie liczy się drugi raz: zmiana na końcu grafu nie generuje ponownie obrazów na początku. */
const memo = new Map<string, { key: string; res: Result }>();

function findTabByName(name: string) {
  const n = name.trim().toLowerCase();
  for (const ws of app.workspaces) for (const t of ws.tabs) if (t.kind === 'terminal' && (t.title.toLowerCase() === n || t.id === name)) return t;
  return curWs().tabs.find((t) => t.kind === 'terminal');
}

async function waitInTab(tabName: string, pattern: string, timeoutSec: number) {
  const tab = findTabByName(tabName);
  if (!tab) throw new Error(`Nie ma zakładki „${tabName}”`);
  const pane = tab.panes[0];
  let re: RegExp;
  try { re = new RegExp(pattern); } catch { throw new Error(`Niepoprawny regex: ${pattern}`); }
  let buf = '';
  // Ostatni 1 MB wyjścia wystarczy do szukania wzorca, a nie rośnie bez końca.
  const off = sessions.onOutput((id, d) => { if (id === pane.id) { buf += d; if (buf.length > 1 << 20) buf = buf.slice(-(1 << 19)); } });
  const start = Date.now();
  try {
    while (Date.now() - start < timeoutSec * 1000) {
      const clean = stripAnsi(buf);
      const m = clean.match(re);
      if (m) { const lines = clean.split('\n'); return lines.find((l) => re.test(l)) || m[0]; }
      await sleep(250);
    }
  } finally { off(); }
  throw new Error(`Nie pojawiło się „${pattern}” w ${timeoutSec} s`);
}

function promptFor(cfg: AiCfg, input: string, vars: Record<string, string>) {
  // Prompt bazowy z biblioteki, a po nim prompt dodatkowy noda. Gdy żaden nie używa {{input}}, wejście idzie na koniec.
  const base = cfg.base ? app.prompts.find((p) => p.id === cfg.base && p.type === 'prompt') : null;
  const raw = [base?.body || '', cfg.prompt || ''].filter((s) => s.trim()).join('\n\n');
  const usesInput = /\{\{\s*input\s*\}\}/.test(raw);
  let prompt = fill(raw, { ...vars, input });
  if (!prompt.trim()) prompt = input;
  else if (!usesInput && input) prompt += `\n\n${input}`;
  if (cfg.format === 'list') prompt += '\n\nOdpowiedz listą: jedna pozycja w linii, bez numeracji i komentarzy.';
  return prompt;
}

async function runAi(cfg: AiCfg, input: string, vars: Record<string, string>, media: Media[] = []): Promise<Result> {
  const prompt = promptFor(cfg, input, vars);
  const n = Math.max(1, Math.min(10, cfg.results || 1));
  // Obrazy z wejścia idą do modelu jako bloki obrazu (modele z obsługą wizji).
  const imgs = await Promise.all(media.filter((m) => m.kind === 'image').slice(0, 5).map(async (m) => ({
    type: 'image', source: { type: 'base64', media_type: /\.png$/i.test(m.path) ? 'image/png' : /\.webp$/i.test(m.path) ? 'image/webp' : 'image/jpeg', data: await call<string>('fs_read_b64', { path: m.path }) },
  })));
  const content = imgs.length ? [...imgs, { type: 'text', text: prompt }] : prompt;
  const one = () => complete({
    providerId: cfg.provider || null, model: cfg.model || null, messages: [{ role: 'user', content }],
    maxTokens: cfg.maxTokens || 2048, temperature: cfg.temperature, topP: cfg.topP, json: cfg.format === 'json',
  }).then((r) => r.text);
  // Model lokalny (Ollama) i tak czeka w kolejce GPU, więc wyniki liczymy po kolei; chmurowe – równolegle.
  const outs: string[] = [];
  if (localKey(cfg, false)) for (let i = 0; i < n; i++) outs.push(await one());
  else outs.push(...(await Promise.all(Array.from({ length: n }, one))));
  const text = n === 1 ? outs[0] : outs.map((o, i) => `--- wariant ${i + 1} ---\n${o}`).join('\n\n');
  return { text, items: cfg.format === 'list' ? outs.join('\n').split('\n').map((s) => s.trim()).filter(Boolean) : n > 1 ? outs : undefined };
}

function evalCond(expr: string, input: string, exit: number | undefined) {
  const e = expr.trim();
  let m: RegExpMatchArray | null;
  if ((m = e.match(/^exit\s*(==|!=)\s*(-?\d+)$/))) return m[1] === '==' ? exit === +m[2] : exit !== +m[2];
  if ((m = e.match(/^contains:\s*(.+)$/i))) return input.includes(m[1].trim());
  if ((m = e.match(/^!contains:\s*(.+)$/i))) return !input.includes(m[1].trim());
  if ((m = e.match(/^matches:\s*(.+)$/i))) { try { return new RegExp(m[1].trim()).test(input); } catch { return false; } }
  if (e === 'empty') return !input.trim();
  if (e === '!empty' || e === 'not empty') return !!input.trim();
  return !!input.trim();
}

function jsonPath(input: string, path: string) {
  let v: any = JSON.parse(input);
  for (const part of path.replace(/^\$\.?/, '').split(/\.|\[|\]/).filter(Boolean)) v = v?.[part];
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

async function runMedia(node: FlowNode, input: string, vars: Record<string, string>, media: Media[], flowId: string): Promise<Result> {
  const ty = nodeType(node.type);
  const cfg = { ...MEDIA_DEFAULTS, ...node.cfg } as MediaCfg;
  const prompt = promptFor({ ...aiDefaults({}), base: cfg.base, prompt: cfg.prompt }, input, vars).trim();
  const images = media.filter((m) => m.kind === 'image').map((m) => m.path);
  const n = Math.max(1, Math.min(8, +cfg.n || 1));
  let done = 0;
  const progress = (s: string, pv?: string) => { flowRun.note[node.id] = n > 1 ? `${s} · ${done}/${n}` : s; if (pv) flowRun.preview[node.id] = pv; };
  progress('wysyłam');
  // Stały seed: kolejne wyniki dostają seed+1, +2… (inaczej byłyby identyczne).
  const at = (i: number): MediaCfg => (cfg.seed && i ? { ...cfg, seed: String(+cfg.seed + i) } : cfg);
  try {
    const outs = await Promise.all(Array.from({ length: n }, (_, i) => generateOnce(ty.media!, at(i), prompt, images, progress).then((r) => { done++; return r; })));
    const all = outs.flat();
    logGallery(all, node, flowId, ty.media!, cfg, prompt);
    return { text: all.map((m) => m.path).join('\n'), media: all };
  } finally { delete flowRun.note[node.id]; delete flowRun.preview[node.id]; }
}

/** Wpis w galerii: plik z promptem, modelem i seedem (do powtórzenia z tym samym seedem). */
function logGallery(all: Media[], node: FlowNode, flowId: string, op: string, cfg: MediaCfg, prompt: string) {
  const provider = app.providers.find((p) => p.id === cfg.provider)?.name || cfg.provider || '';
  const at = Date.now();
  const entries = all.map((m) => ({ path: m.path, kind: m.kind, op, prompt: prompt.slice(0, 2000), provider, model: cfg.model || '', seed: m.seed ?? (cfg.seed ? +cfg.seed : null), aspect: cfg.aspect, flowId, nodeId: node.id, at }));
  call('gallery_add', { entries }).catch(() => {});
}

async function exec(node: FlowNode, input: string, exitIn: number | undefined, vars: Record<string, string>, media: Media[] = [], flowId = ''): Promise<Result> {
  const ty = nodeType(node.type);
  const c = node.cfg;
  const f = (s: unknown) => fill(String(s ?? ''), { ...vars, input });
  if (ty.media) return runMedia(node, input, vars, media, flowId);
  if (ty.ai) return runAi(c as AiCfg, input, vars, media);
  switch (ty.id) {
    case 'media_in': {
      if (!c.path) throw new Error('Wybierz plik w ustawieniach noda');
      const dir = await call<string>('media_dir');
      const path = String(c.path).startsWith(dir) ? String(c.path) : await call<string>('media_import', { path: f(c.path) });
      return { text: input, media: [{ kind: kindOf(path), path }] };
    }
    case 'vid_frame': {
      const vids = media.filter((m) => m.kind === 'video');
      if (!vids.length) throw new Error('Na wejściu nie ma wideo');
      const out: Media[] = [];
      for (const v of vids) { const path = await mediaFile('png'); await ffmpeg(['-sseof', '-0.25', '-i', v.path, '-frames:v', '1', '-update', '1', path]); out.push({ kind: 'image', path }); }
      return { text: out.map((m) => m.path).join('\n'), media: out };
    }
    case 'vid_concat': {
      const vids = media.filter((m) => m.kind === 'video');
      if (vids.length < 2) throw new Error('Połącz co najmniej dwa klipy (kilka wejść albo kilka wyników)');
      const list = await mediaFile('txt');
      await call('fs_write_text', { path: list, data: vids.map((v) => `file '${v.path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') });
      const path = await mediaFile('mp4');
      await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path]);
      return { text: path, media: [{ kind: 'video', path }] };
    }
    case 'media_save': {
      if (!media.length) throw new Error('Na wejściu nie ma obrazów ani wideo');
      if (!c.dir) throw new Error('Podaj folder docelowy');
      const saved: string[] = [];
      for (const [i, m] of media.entries()) {
        const ext = m.path.split('.').pop();
        const dst = `${f(c.dir).replace(/[\\/]$/, '')}\\${slug(f(c.name || 'wynik')) || 'wynik'}-${Date.now().toString(36)}${media.length > 1 ? '-' + (i + 1) : ''}.${ext}`;
        await call('fs_copy', { src: m.path, dst });
        saved.push(dst);
      }
      return { text: saved.join('\n'), media };
    }
    // Węzły startowe przekazują też media (obraz albo wideo z trybu partii).
    case 'manual': case 'cron': return { text: input, media: media.length ? media : undefined };
    case 'parallel': case 'merge': return { text: input };
    case 'git_push': {
      if (!c.repo) return { text: input };
      const r: any = await call('sys_exec', { cmd: 'git', args: ['-C', c.repo, 'log', '-1', '--format=%h %an: %s', c.branch || 'HEAD'], cwd: null, timeoutMs: 15000 });
      return { text: r.stdout.trim() || r.stderr.trim() };
    }
    case 'file_watch': case 'read_file': return { text: await call<string>('fs_read_text', { path: f(c.path) }) };
    case 'webhook': case 'fetch_page': case 'http': {
      const r: any = await call('http_request', { method: ty.id === 'http' ? (c.method || 'GET') : 'GET', url: f(c.url), headers: null, body: ty.id === 'http' && c.body ? f(c.body) : null });
      let text = r.body as string;
      if (ty.id === 'fetch_page') text = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return { text, exit: r.status >= 400 ? r.status : 0 };
    }
    case 'term_match': return { text: await waitInTab(c.tab || '', c.regex || '.', +c.timeout || 120) };
    case 'wait_out': return { text: await waitInTab(c.tab || '', c.regex || '.', +c.timeout || 60) };
    case 'run_cmd': {
      const r: any = await call('sys_run_script', { shell: c.shell || 'pwsh', script: f(c.command), cwd: c.cwd || null, timeoutMs: 600000 });
      return { text: `${r.stdout}${r.stderr ? (r.stdout ? '\n' : '') + r.stderr : ''}`.trim(), exit: r.code };
    }
    case 'send_tab': {
      const tab = findTabByName(c.tab || '');
      if (!tab) throw new Error('Nie znaleziono zakładki terminala');
      await sessions.write(tab.panes[0].id, f(c.text).replace(/\r?\n/g, '\r') + '\r');
      return { text: input };
    }
    case 'snippet': {
      const s = app.snippets.find((x) => x.name.toLowerCase() === String(c.snippet || '').toLowerCase());
      if (!s) throw new Error(`Nie ma snippetu „${c.snippet}”`);
      const body = fill(s.body, { ...vars, input });
      if (s.kind === 'ai') return runAi({ ...aiDefaults({}), prompt: body, provider: s.provider || '', model: s.model || '' }, input, vars);
      const tab = findTabByName(c.tab || '');
      if (!tab) throw new Error('Nie znaleziono zakładki terminala');
      await sessions.write(tab.panes[0].id, body + '\r');
      return { text: input };
    }
    case 'ai_agent': {
      const { sendToAgent } = await import('../agent.svelte');
      const ws = curWs();
      const before = ws.chat.length;
      await sendToAgent(ws, f(c.task || '{{input}}'));
      const reply = ws.chat.slice(before).filter((m) => m.role === 'agent').map((m) => m.text).join('\n\n');
      return { text: reply };
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
      const re = new RegExp(c.pattern || '.', String(c.flags || '').replace(/[^gimsuy]/g, ''));
      const ms = re.global ? [...input.matchAll(re)].map((m) => m[1] ?? m[0]) : [input.match(re)?.[1] ?? input.match(re)?.[0] ?? ''];
      return { text: ms.join('\n'), items: ms };
    }
    case 'var': vars[String(c.name || 'wynik')] = input; return { text: input };
    case 'split_text': { const sep = String(c.sep ?? '\\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t'); const items = input.split(sep).filter((s) => s.trim()); return { text: items.join('\n'), items }; }
    case 'join': return { text: input.split('\n').filter(Boolean).join(String(c.sep ?? ', ').replace(/\\n/g, '\n')) };
    case 'write_file': await call('fs_write_text', { path: f(c.path), data: f(c.text || '{{input}}') }); return { text: input };
    case 'list_files': return { text: (await call<string[]>('fs_list', { dir: f(c.dir) })).join('\n') };
    case 'preview': return { text: input };
    case 'notify': notify(`${f(c.title)}${input ? ': ' + input.slice(0, 160) : ''}`, 'success', 7000); return { text: input };
    case 'clipboard': await navigator.clipboard.writeText(input).catch(() => {}); return { text: input };
    case 'to_agent': {
      const ws = curWs();
      ws.chat.push({ id: nid('m'), role: 'agent', who: 'Workflow', text: input });
      app.layout.agentOpen = true;
      return { text: input };
    }
    case 'to_note': {
      const folder = String(c.folder || 'Workflow').replace(/[\\/:*?"<>|]/g, '_');
      const title = f(c.title || 'Wynik workflow');
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      const path = `notes/${folder}/${slug(title) || 'wynik'}-${stamp}.md`;
      await call('plugin_fs', { plugin: 'tx.notes', op: 'write', path, data: `---\ntitle: ${title}\n---\n${input}`, to: null });
      const { emitStorageChange } = await import('../plugins/host.svelte');
      emitStorageChange('tx.notes', [path]);
      return { text: input };
    }
    default: return { text: input };
  }
}

/** Wykonuje cały workflow albo (z `only`) jeden node: poprzedniki z udanym wynikiem nie są uruchamiane ponownie.
 *  `force` liczy wszystko od nowa, bez wyników z pamięci; `initialMedia` trafia do nodów startowych (tryb partii).
 *  Zwraca tekst wyników węzłów końcowych. */
export async function runFlow(flow: Flow, initial = '', only?: string, force = false, initialMedia: Media[] = []): Promise<string> {
  if (flowRun.running[flow.id]) throw new Error('Ten workflow już działa');
  flowRun.running[flow.id] = true;
  const need = new Set<string>();
  if (only) { const up = (id: string) => { if (need.has(id)) return; need.add(id); for (const [a, b] of flow.edges) if (b === id) up(a); }; up(only); }
  for (const n of flow.nodes) if (!only || n.id === only || (need.has(n.id) && flowRun.status[n.id] !== 'ok')) { delete flowRun.status[n.id]; delete flowRun.out[n.id]; delete flowRun.note[n.id]; delete flowRun.preview[n.id]; delete flowRun.cached[n.id]; }
  const indeg: Record<string, number> = Object.fromEntries(flow.nodes.map((n) => [n.id, 0]));
  for (const [, b] of flow.edges) if (b in indeg) indeg[b]++;
  const queue = flow.nodes.filter((n) => !indeg[n.id]).map((n) => n.id);
  const order: string[] = [];
  // Spośród gotowych nodów najpierw ten sam model lokalny co poprzednio, potem nody bez modelu lokalnego:
  // na karcie graficznej model zmienia się jak najrzadziej.
  const keyOf = (id: string) => { const n = flow.nodes.find((x) => x.id === id)!; const ty = nodeType(n.type); return ty.media || ty.ai ? localKey(n.cfg, !!ty.media) : ''; };
  let cur = '';
  while (queue.length) {
    let at = cur ? queue.findIndex((q) => keyOf(q) === cur) : -1;
    if (at < 0) at = queue.findIndex((q) => !keyOf(q));
    const [id] = queue.splice(Math.max(0, at), 1);
    cur = keyOf(id) || cur;
    order.push(id);
    for (const [a, b] of flow.edges) if (a === id && --indeg[b] === 0) queue.push(b);
  }
  if (order.length < flow.nodes.length) notify('Workflow ma cykl; nody w pętli zostały pominięte.', 'warning');

  const results: Record<string, Result | null> = {};
  const vars: Record<string, string> = {};
  try {
    for (const id of order) {
      const node = flow.nodes.find((n) => n.id === id)!;
      if (only && !need.has(id)) continue;
      if (only && id !== only && flowRun.status[id] === 'ok') { results[id] = { text: flowRun.out[id] ?? '', media: flowRun.media[id] }; continue; }
      const ups = flow.edges.filter(([, b]) => b === id).map(([a]) => a);
      const live = ups.map((u) => results[u]).filter((r): r is Result => !!r && !r.stop);
      if (ups.length && !live.length) { results[id] = null; flowRun.status[id] = 'skip'; continue; }
      const input = ups.length ? live.filter((r) => !r.media?.length).map((r) => r.text).join('\n\n') : initial;
      const media = ups.length ? live.flatMap((r) => r.media || []) : initialMedia;
      const exitIn = live.find((r) => r.exit !== undefined)?.exit;
      const items = live.length === 1 ? live[0].items : undefined;
      const ty = nodeType(node.type);
      const key = ty.ai || ty.media ? JSON.stringify([node.type, node.cfg, input, media.map((m) => m.path), items, exitIn, vars]) : '';
      const hit = key && !force && id !== only ? memo.get(id) : undefined;
      flowRun.status[id] = 'run';
      try {
        let res: Result;
        if (hit && hit.key === key) { res = hit.res; flowRun.cached[id] = true; }
        else if (items && items.length && ty.id !== 'join' && ty.id !== 'merge') {
          const parts: string[] = [];
          const got: Media[] = [];
          for (const it of items) { const r = await exec(node, it, exitIn, vars, media, flow.id); parts.push(r.text); got.push(...(r.media || [])); }
          res = { text: parts.join('\n'), media: got.length ? got : undefined };
        } else res = await exec(node, input, exitIn, vars, media, flow.id);
        if (key) memo.set(id, { key, res });
        results[id] = res;
        flowRun.out[id] = res.text;
        if (res.media?.length) flowRun.media[id] = res.media; else delete flowRun.media[id];
        flowRun.status[id] = res.stop ? 'skip' : 'ok';
      } catch (e) {
        results[id] = null;
        memo.delete(id);
        delete flowRun.note[id];
        flowRun.out[id] = String(e).replace(/^Error: /, '');
        flowRun.status[id] = 'err';
        notify(`Node „${node.label || nodeType(node.type).name}”: ${flowRun.out[id]}`, 'error', 7000);
        break;
      }
    }
  } finally { flowRun.running[flow.id] = false; }
  const sinks = flow.nodes.filter((n) => !flow.edges.some(([a]) => a === n.id) && results[n.id]);
  return sinks.map((n) => `${n.label || nodeType(n.type).name}: ${results[n.id]!.text}`).join('\n\n').slice(0, 8000) || '(brak wyników)';
}

/* ---------- tryb partii ---------- */

export const batchRun = $state({} as Record<string, { done: number; total: number; stop?: boolean }>);

/** Uruchamia workflow po kolei dla każdego wejścia: linii tekstu ({{input}} nodów startowych) albo pliku obrazu/wideo. */
export async function runBatch(flow: Flow, inputs: { text?: string; media?: Media }[]) {
  batchRun[flow.id] = { done: 0, total: inputs.length };
  const st = batchRun[flow.id]; // obiekt reaktywny (licznik w UI)
  let failed = 0;
  try {
    for (const it of inputs) {
      if (st.stop) break;
      await runFlow(flow, it.text || '', undefined, false, it.media ? [it.media] : []);
      if (flow.nodes.some((n) => flowRun.status[n.id] === 'err')) failed++;
      st.done++;
    }
  } finally { delete batchRun[flow.id]; }
  notify(st.stop ? `Partia zatrzymana po ${st.done} z ${st.total}` : `Partia gotowa: ${st.total - failed} z ${st.total}${failed ? `, błędy: ${failed}` : ''}`, failed ? 'warning' : 'success', 7000);
}

/* ---------- scheduler for triggers ---------- */

const lastRun: Record<string, number> = {};
const lastSeen: Record<string, string> = {};

async function tick() {
  for (const flow of Object.values(app.flows)) {
    // Workflow od agenta startuje sam dopiero po zatwierdzeniu przez użytkownika (baner w edytorze).
    if (flowRun.running[flow.id] || flow.byAgent) continue;
    for (const n of flow.nodes) {
      if (flow.edges.some(([, b]) => b === n.id)) continue; // tylko węzły startowe
      try {
        if (n.type === 'cron') {
          const every = Math.max(1, +n.cfg.every || 60) * 60_000;
          lastRun[n.id] ??= Date.now();
          if (Date.now() - lastRun[n.id] >= every) { lastRun[n.id] = Date.now(); runFlow(flow, '', undefined, true).catch(() => {}); }
        } else if (n.type === 'git_push' && n.cfg.repo) {
          const r: any = await call('sys_exec', { cmd: 'git', args: ['-C', n.cfg.repo, 'rev-parse', n.cfg.branch || 'HEAD'], cwd: null, timeoutMs: 10000 });
          const head = r.stdout.trim();
          if (head && lastSeen[n.id] && lastSeen[n.id] !== head) runFlow(flow, '', undefined, true).catch(() => {});
          if (head) lastSeen[n.id] = head;
        } else if (n.type === 'file_watch' && n.cfg.path) {
          const text = await call<string>('fs_read_text', { path: n.cfg.path }).catch(() => '');
          const h = `${text.length}:${text.slice(0, 64)}:${text.slice(-64)}`;
          if (lastSeen[n.id] !== undefined && lastSeen[n.id] !== h) runFlow(flow, '', undefined, true).catch(() => {});
          lastSeen[n.id] = h;
        }
      } catch { /* sprawdzimy przy następnym takcie */ }
    }
  }
}

let started = false;
export function startScheduler() {
  if (started) return;
  started = true;
  setInterval(tick, 30_000);
}
