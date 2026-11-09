// Zgody agenta: lista „zawsze pytaj” i łączenie trybów uprawnień. Czyste funkcje (testy: tests/approval.test.ts).
//
// Lista „zawsze pytaj” nie jest piaskownicą: zdeterminowany model obejdzie każdą listę (np. skryptem zakodowanym
// w base64). Dopasowanie ma jednak wyłapać zwykłe warianty tej samej komendy: inne spacje i wielkość liter,
// cudzysłowy, skrócone parametry PowerShell (`-r`, `-Rec`) i aliasy (`rm`, `del`, `ri`).

export type PermMode = 'read' | 'ask' | 'auto';

const RANK: Record<PermMode, number> = { read: 0, ask: 1, auto: 2 };

/** Ostrzejszy z dwóch trybów (podagent zlecony przez agenta nie może więcej niż ten agent). */
export function stricter(a: PermMode, b: PermMode): PermMode {
  return RANK[a] <= RANK[b] ? a : b;
}

/** Aliasy komend (PowerShell i cmd) sprowadzane do jednej nazwy. */
const ALIASES: Record<string, string> = {
  rm: 'remove-item', ri: 'remove-item', del: 'remove-item', erase: 'remove-item', rd: 'remove-item', rmdir: 'remove-item',
  'stop-computer': 'shutdown', 'restart-computer': 'shutdown',
  'format-volume': 'format',
};

/** Słowa komendy: małe litery, bez cudzysłowów i ścieżki programu, separatory komend jako osobne słowa. */
function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/["'`]/g, '')
    .replace(/([;&|(){}])/g, ' $1 ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const base = w.replace(/^.*[\\/]/, '').replace(/\.exe$/, '');
      return ALIASES[base] ?? base;
    });
}

const isParam = (w: string) => /^-[a-z]/.test(w);
/** Krótkie flagi w stylu uniksowym (`-rf`): każda litera może stać osobno albo w innej kolejności. */
const isBundle = (w: string) => /^-[a-z]{2,3}$/.test(w);

/** Słowo komendy pasuje do słowa wzorca: dokładnie albo jako skrócony parametr PowerShell (`-Rec` = `-Recurse`). */
function matchWord(cmd: string, pat: string): boolean {
  if (cmd === pat) return true;
  if (isParam(pat) && isParam(cmd) && pat.length > 3) return pat.startsWith(cmd.replace(/:.*$/, ''));
  // Długa opcja wzorca (`--force`) i jej krótka postać w komendzie (`-f`, także w grupie `-fu`).
  if (/^--[a-z]/.test(pat) && /^-[a-z]+$/.test(cmd)) return cmd.includes(pat[2]);
  return false;
}

/** Wzorzec pasuje, gdy pierwsze słowo wzorca występuje w komendzie, a dalsze słowa (parametry, argumenty)
 *  występują po nim w obrębie tej samej komendy (do najbliższego `;`, `&`, `|`, nawiasu). Słowo wzorca kończące
 *  się na `=` (np. `dd if=`) pasuje do początku słowa komendy. */
export function matchesPattern(command: string, pattern: string): boolean {
  const pat = words(pattern);
  if (!pat.length) return false;
  const cmd = words(command);
  const hit = (cw: string, pw: string) => matchWord(cw, pw) || (pw.endsWith('=') && cw.startsWith(pw));
  for (let i = 0; i < cmd.length; i++) {
    if (!hit(cmd[i], pat[0])) continue;
    let end = cmd.length;
    for (let j = i + 1; j < cmd.length; j++) if (/^[;&|(){}]$/.test(cmd[j])) { end = j; break; }
    const rest = cmd.slice(i + 1, end);
    const flags = rest.filter((w) => /^-[a-z]+$/.test(w)).map((w) => w.slice(1)).join('');
    const ok = pat.slice(1).every((pw) => rest.some((cw) => hit(cw, pw)) || (isBundle(pw) && [...pw.slice(1)].every((ch) => flags.includes(ch))));
    if (ok) return true;
  }
  // Zapasowo: zwykłe wyszukanie tekstu po ujednoliceniu spacji (np. `DROP TABLE` w zapytaniu SQL).
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  return norm(command).includes(norm(pattern));
}

/** Czy komenda wymaga zgody w danym trybie. W trybie „pytaj” zawsze; w „auto” tylko gdy pasuje do listy. */
export function needsApproval(perm: PermMode, command: string, alwaysAsk: string[]): boolean {
  if (perm === 'ask') return true;
  return alwaysAsk.some((p) => p.trim() && matchesPattern(command, p));
}
