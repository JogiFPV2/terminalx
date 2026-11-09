// Komenda ekosystemu skilli wklejona w Ustawienia → Skille: `npx skills add mattpocock/skills`, `pnpm dlx skills add …`,
// `bunx skills add …`, samo `owner/repo` albo link. Wynik: źródło i ewentualna lista skilli (`--skill`).
// Testy: tests/skillcmd.test.ts

export interface SkillCmd { source: string; skills: string[] }

/** Podział na słowa z obsługą cudzysłowów ('…' i "…"). */
function tokens(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of s.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Opcje `skills add` z wartościami (pomijamy je razem z wartościami). */
const WITH_VALUES = new Set(['-a', '--agent', '--subagent']);
const WITH_ONE_VALUE = new Set(['--metadata']);

export function parseSkillCommand(input: string): SkillCmd | { error: string } {
  let t = tokens(input.trim().replace(/^\$\s+/, ''));
  if (!t.length) return { error: 'Wpisz komendę, np. npx skills add mattpocock/skills' };

  // Uruchamiacz pakietów: npx [-y], pnpm dlx, pnpx, bunx, yarn dlx.
  if (t[0] === 'npx' || t[0] === 'pnpx' || t[0] === 'bunx') { t = t.slice(1); while (t[0]?.startsWith('-')) t = t.slice(1); }
  else if ((t[0] === 'pnpm' || t[0] === 'yarn') && t[1] === 'dlx') t = t.slice(2);

  const isCli = (w?: string) => !!w && /^(skills|add-skill)(@[\w.-]+)?$/.test(w);
  if (isCli(t[0])) {
    const cli = t[0];
    t = t.slice(1);
    if (!cli.startsWith('add-skill')) {
      if (t[0] !== 'add' && t[0] !== 'a') return { error: 'Obsługiwana jest tylko komenda „skills add”.' };
      t = t.slice(1);
    }
  } else if (t.length > 1 && !t[1].startsWith('-')) {
    return { error: 'Nie rozpoznano komendy. Przykład: npx skills add mattpocock/skills' };
  }

  let source = '';
  const skills: string[] = [];
  for (let i = 0; i < t.length; i++) {
    const w = t[i];
    if (w === '-s' || w === '--skill') {
      while (i + 1 < t.length && !t[i + 1].startsWith('-')) skills.push(...t[++i].split(',').map((x) => x.trim()).filter(Boolean));
    } else if (w.startsWith('--skill=')) {
      skills.push(...w.slice(8).split(',').map((x) => x.trim()).filter(Boolean));
    } else if (WITH_VALUES.has(w)) {
      while (i + 1 < t.length && !t[i + 1].startsWith('-')) i++;
    } else if (WITH_ONE_VALUE.has(w)) {
      i++;
    } else if (w.startsWith('-')) {
      // -g, -y, --copy, --all, --full-depth…: Hermitty i tak instaluje u siebie.
    } else if (!source) {
      source = w;
    } else {
      return { error: `Nieoczekiwany argument „${w}”. Źródło jest jedno: ${source}` };
    }
  }
  if (!source) return { error: 'Brak źródła skilli, np. mattpocock/skills' };
  if (!/^[A-Za-z0-9._/:@#~+=?-]+$/.test(source) || source.length > 300) return { error: `Niepoprawne źródło: ${source}` };
  const bad = skills.find((s) => s !== '*' && !/^[A-Za-z0-9._:-]+$/.test(s));
  if (bad) return { error: `Niepoprawna nazwa skilla: ${bad}` };
  return { source, skills: skills.includes('*') ? [] : [...new Set(skills)] };
}
