// Tłumaczenie interfejsu. Kod aplikacji pisze teksty po polsku; dla innego języka warstwa nad DOM
// podmienia teksty i atrybuty (title, placeholder, aria-label) według słownika. Nie dotyka terminali,
// edytorów, pól tekstowych ani treści użytkownika (tłumaczy tylko dokładne dopasowania ze słownika).
// Słownik: src/lib/i18n/<język>.json  { "exact": { "polski": "english" }, "patterns": [["polski {0}", "english {0}"]] }

import { call } from './ipc';

type Dict = { exact: Record<string, string>; patterns: [string, string][] };

const SKIP = '.xterm, textarea, pre, code, .cm-editor, [contenteditable], [data-no-i18n]';
// Atrybuty (podpowiedź, opis) pól tekstowych to część interfejsu; pomijamy je tylko w terminalu i edytorze.
const SKIP_ATTR = '.xterm, .cm-editor, [data-no-i18n]';
const ATTRS = ['title', 'placeholder', 'aria-label'];

let dict: Dict | null = null;
let res: { re: RegExp; to: string }[] = [];
let lang = 'pl';

export const currentLang = () => lang;

/** Język interfejsu: zapisany w ustawieniach albo z systemu (polski, gdy format regionalny lub języki
 *  przeglądarki są polskie; w pozostałych przypadkach angielski). */
export async function pickLang(setting?: string) {
  if (setting && setting !== 'auto') return setting;
  const sys = await call<string>('sys_locale').catch(() => '');
  return [sys, ...navigator.languages].some((l) => /^pl\b/i.test(l)) ? 'pl' : 'en';
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function translate(text: string): string | null {
  if (!dict) return null;
  const t = text.trim();
  if (!t || !/[a-ząćęłńóśźż]/i.test(t)) return null;
  const hit = dict.exact[t];
  if (hit != null) return text.replace(t, hit);
  for (const p of res) {
    const m = t.match(p.re);
    if (m) return text.replace(t, p.to.replace(/\{(\d)\}/g, (_, i) => translate(m[+i + 1]) ?? m[+i + 1]));
  }
  return null;
}

/** Tłumaczy pojedynczy tekst (np. powiadomienia budowane w kodzie). */
export const tr = (s: string) => translate(s) ?? s;

const done = new WeakMap<Node, string>();

function visitText(n: Text) {
  const v = n.nodeValue || '';
  if (done.get(n) === v) return;
  const t = translate(v);
  if (t != null && t !== v) n.nodeValue = t;
  done.set(n, n.nodeValue || '');
}

function visitEl(el: Element) {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v) { const t = translate(v); if (t != null && t !== v) el.setAttribute(a, t); }
  }
}

function walk(root: Node) {
  if (root.nodeType === 3) { if (!(root.parentElement?.closest(SKIP))) visitText(root as Text); return; }
  if (root.nodeType !== 1) return;
  const el = root as Element;
  if (!el.closest(SKIP_ATTR)) visitEl(el);
  if (el.closest(SKIP)) return;
  const it = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (n.nodeType !== 1 || !(n as Element).matches(SKIP)) return NodeFilter.FILTER_ACCEPT;
      if (!(n as Element).matches(SKIP_ATTR)) visitEl(n as Element);
      return NodeFilter.FILTER_REJECT;
    },
  });
  for (let n = it.nextNode(); n; n = it.nextNode()) n.nodeType === 3 ? visitText(n as Text) : visitEl(n as Element);
}

/** Włącza tłumaczenie dla języka innego niż polski. Słownik ładuje się leniwie (osobny plik w paczce). */
export async function startI18n(setting?: string) {
  lang = await pickLang(setting);
  document.documentElement.lang = lang;
  if (lang === 'pl') return;
  const mods = import.meta.glob<{ default: Dict }>('./i18n/*.json');
  const load = mods[`./i18n/${lang}.json`];
  if (!load) return;
  dict = (await load()).default;
  res = dict.patterns.map(([from, to]) => ({ re: new RegExp(`^${esc(from).replace(/\\\{\d\\\}/g, '(.+?)')}$`, 's'), to }));
  walk(document.body);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') { const p = m.target.parentElement; if (p && !p.closest(SKIP)) visitText(m.target as Text); }
      else if (m.type === 'attributes') { const el = m.target as Element; if (!el.closest(SKIP_ATTR)) visitEl(el); }
      else for (const n of m.addedNodes) walk(n);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
