// Budowanie workflow przez agenta: katalog typów nodów (zwięzły opis dla modelu) i utworzenie
// zakładki workflow z opisu {nodes, edges}. Układ kanwy liczony automatycznie (warstwy od nodów startowych).
import { app, newTab } from '../state.svelte';
import { allNodeTypes, makeNode } from './engine.svelte';
import type { FlowNode } from '../types';

/** Jedna linia na typ: id, nazwa, kategoria i pola cfg z domyślnymi wartościami. */
export function nodeCatalog(): string {
  return allNodeTypes().map((t) => {
    const fields = t.media ? 'prompt, aspect (np. 16:9), n, duration (s, wideo), seed, negative, provider, model'
      : t.ai ? 'prompt (może zawierać {{input}}), provider, model, results, format (text|list|json)'
      : (t.fields || []).map(([k, , def]) => `${k}${def !== '' && def != null ? `=${def}` : ''}`).join(', ');
    return `${t.id} · ${t.name} · ${t.cat}${t.desc ? ` · ${t.desc}` : ''}${fields ? ` · cfg: ${fields}` : ''}`;
  }).join('\n');
}

export interface FlowSpec { title?: string; nodes: { key: string; type: string; label?: string; cfg?: Record<string, unknown> }[]; edges?: [string, string][] }

/** Tworzy zakładkę workflow z opisu. Zwraca id zakładki albo rzuca błąd z listą problemów (model może je poprawić). */
export function buildFlow(spec: FlowSpec): { tabId: string; summary: string } {
  const types = new Map(allNodeTypes().map((t) => [t.id, t]));
  const nodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
  const edges = (Array.isArray(spec?.edges) ? spec.edges : []).filter((e) => Array.isArray(e) && e.length === 2);
  const problems: string[] = [];
  if (!nodes.length) problems.push('Brak nodów.');
  const keys = new Set<string>();
  for (const n of nodes) {
    if (!n?.key || keys.has(n.key)) problems.push(`Powtórzony albo pusty klucz noda: ${n?.key}`);
    keys.add(n?.key);
    if (!types.has(n?.type)) problems.push(`Nieznany typ noda „${n?.type}” (użyj list_node_types).`);
  }
  for (const [a, b] of edges) if (!keys.has(a) || !keys.has(b)) problems.push(`Krawędź ${a} → ${b} wskazuje nieistniejący node.`);
  if (problems.length) throw new Error(problems.join('\n'));

  // Bez wyzwalacza dokładamy „Ręczny start” przed nodami startowymi.
  const all = [...nodes];
  const links = [...edges];
  if (!nodes.some((n) => types.get(n.type)?.cat === 'Wyzwalacze')) {
    const roots = nodes.filter((n) => !edges.some(([, b]) => b === n.key));
    all.unshift({ key: '__start', type: 'manual' });
    for (const r of roots) links.push(['__start', r.key]);
  }
  // Warstwa = najdłuższa ścieżka od nodów startowych.
  const layer: Record<string, number> = {};
  const depth = (k: string, seen = new Set<string>()): number => {
    if (layer[k] != null) return layer[k];
    if (seen.has(k)) return 0;
    seen.add(k);
    const ups = links.filter(([, b]) => b === k).map(([a]) => a);
    return (layer[k] = ups.length ? Math.max(...ups.map((u) => depth(u, seen) + 1)) : 0);
  };
  const row: Record<number, number> = {};
  const ids: Record<string, string> = {};
  const made: FlowNode[] = all.map((n) => {
    const l = depth(n.key);
    const i = (row[l] = (row[l] ?? -1) + 1);
    const node = makeNode(n.type, 40 + l * 250, 60 + i * 170, n.label || '');
    if (n.cfg && typeof n.cfg === 'object') Object.assign(node.cfg, n.cfg);
    ids[n.key] = node.id;
    return node;
  });

  const tab = newTab('flow');
  if (spec.title) tab.title = String(spec.title).slice(0, 60);
  const flow = app.flows[tab.flowId!];
  flow.nodes = made;
  flow.edges = links.map(([a, b]) => [ids[a], ids[b]] as [string, string]);
  flow.byAgent = true;
  const trig = made.some((n) => ['cron', 'git_push', 'file_watch'].includes(n.type));
  return { tabId: tab.id, summary: `Utworzono workflow „${tab.title}” (zakładka ${tab.id}): ${made.length} nodów, ${flow.edges.length} połączeń.${trig ? ' Wyzwalacze zadziałają dopiero, gdy użytkownik zatwierdzi workflow w edytorze.' : ''}` };
}
