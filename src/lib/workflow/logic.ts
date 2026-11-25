// Czysta logika nodów workflow, wspólna dla Hermitty na komputerze i aplikacji na Androida (mobile/src/lib/flow).
// Bez zależności od stanu aplikacji. Testy: tests/flow-logic.test.ts

/** Warunek noda „Warunek”: exit == 0, contains: X, !contains: X, matches: regex, empty, !empty. */
export function evalCond(expr: string, input: string, exit: number | undefined) {
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

/** Wartość z JSON-a po ścieżce (items.0.name, $.a[1].b). */
export function jsonPath(input: string, path: string) {
  let v: any = JSON.parse(input);
  for (const part of path.replace(/^\$\.?/, '').split(/\.|\[|\]/).filter(Boolean)) v = v?.[part];
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

/** Kolejność topologiczna; nody w cyklu zostają pominięte (zwracane osobno). */
export function topoOrder(ids: string[], edges: [string, string][]) {
  const indeg: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  for (const [, b] of edges) if (b in indeg) indeg[b]++;
  const queue = ids.filter((id) => !indeg[id]);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const [a, b] of edges) if (a === id && --indeg[b] === 0) queue.push(b);
  }
  return { order, cyclic: ids.filter((id) => !order.includes(id)) };
}

/** Tekst bez HTML (node „Pobierz stronę”). */
export function htmlText(html: string) {
  return html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}
