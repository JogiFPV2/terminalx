//! Import skilli: folder albo archiwum zip z plikiem SKILL.md (nagłówek YAML z `name` i `description`,
//! dalej instrukcje) i plikami pomocniczymi. Do aplikacji trafia tylko tekst: SKILL.md jako treść
//! skilla, a pliki tekstowe obok niego jako zasoby, które agent czyta na żądanie.

use serde::Serialize;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

/// Rozszerzenia plików, które bierzemy jako zasoby skilla.
const TEXT: &[&str] = &["md", "txt", "py", "js", "ts", "json", "sh", "ps1", "yaml", "yml", "toml", "csv", "sql", "html", "css", "xml"];
const MAX_FILE: usize = 256 * 1024;
const MAX_TOTAL: usize = 2 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
pub struct Imported {
    name: String,
    description: String,
    body: String,
    files: BTreeMap<String, String>,
}

/// Nagłówek `---` … `---` z prostymi polami `klucz: wartość`; reszta to treść.
fn front_matter(text: &str) -> (BTreeMap<String, String>, String) {
    let t = text.trim_start_matches('\u{feff}');
    let mut meta = BTreeMap::new();
    let Some(rest) = t.strip_prefix("---") else { return (meta, t.trim().to_string()) };
    let Some(end) = rest.find("\n---") else { return (meta, t.trim().to_string()) };
    let lines: Vec<&str> = rest[..end].lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        i += 1;
        let Some((k, v)) = line.split_once(':') else { continue };
        if k.starts_with(' ') || k.starts_with('\t') {
            continue;
        }
        let v = v.trim();
        // Wartość blokowa YAML (`>`, `>-`, `|`, `|-`) albo pusta: dalsze wcięte linie to treść pola.
        let block = matches!(v, ">" | ">-" | ">+" | "|" | "|-" | "|+");
        if block || v.is_empty() {
            let mut parts = vec![];
            while i < lines.len() && (lines[i].starts_with(' ') || lines[i].starts_with('\t') || lines[i].trim().is_empty()) {
                parts.push(lines[i].trim());
                i += 1;
            }
            let text = if v.starts_with('|') { parts.join("\n") } else { parts.iter().filter(|p| !p.is_empty()).copied().collect::<Vec<_>>().join(" ") };
            // Zagnieżdżone mapy (np. `metadata:` z polami `x: 1`) pomijamy.
            if block || !parts.iter().any(|p| p.contains(": ")) {
                if !text.trim().is_empty() {
                    meta.insert(k.trim().to_lowercase(), text.trim().to_string());
                }
            }
            continue;
        }
        let v = v.trim_matches(|c| c == '"' || c == '\'');
        if !v.is_empty() {
            meta.insert(k.trim().to_lowercase(), v.to_string());
        }
    }
    let body = rest[end + 4..].trim_start_matches(['-', '\r', '\n']).trim().to_string();
    (meta, body)
}

/// Z listy (ścieżka względna, treść) robi skill: najpłytszy SKILL.md wyznacza katalog skilla.
fn build(entries: Vec<(String, Vec<u8>)>, fallback_name: &str) -> Result<Imported, String> {
    let skill = entries
        .iter()
        .filter(|(p, _)| p.rsplit('/').next().is_some_and(|f| f.eq_ignore_ascii_case("SKILL.md")))
        .min_by_key(|(p, _)| p.matches('/').count())
        .ok_or("Nie ma pliku SKILL.md")?;
    let root = skill.0.rsplit_once('/').map(|(d, _)| format!("{d}/")).unwrap_or_default();
    let (meta, body) = front_matter(&String::from_utf8_lossy(&skill.1));
    if body.is_empty() {
        return Err("SKILL.md jest pusty".into());
    }
    let mut files = BTreeMap::new();
    let mut total = 0;
    for (p, data) in &entries {
        let Some(rel) = p.strip_prefix(&root) else { continue };
        let ext = rel.rsplit('.').next().unwrap_or("").to_lowercase();
        if rel.eq_ignore_ascii_case("SKILL.md") || !TEXT.contains(&ext.as_str()) || data.len() > MAX_FILE || total + data.len() > MAX_TOTAL {
            continue;
        }
        let Ok(text) = String::from_utf8(data.clone()) else { continue };
        total += data.len();
        files.insert(rel.to_string(), text);
    }
    Ok(Imported {
        name: meta.get("name").cloned().unwrap_or_else(|| fallback_name.to_string()),
        description: meta.get("description").cloned().unwrap_or_default(),
        body,
        files,
    })
}

fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, Vec<u8>)>, depth: usize) -> Result<(), String> {
    if depth > 6 {
        return Ok(());
    }
    for e in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        if p.is_dir() {
            walk(&p, base, out, depth + 1)?;
        } else if e.metadata().map(|m| m.len() as usize <= MAX_FILE).unwrap_or(false) {
            let rel = p.strip_prefix(base).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
            out.push((rel, std::fs::read(&p).map_err(|e| e.to_string())?));
        }
    }
    Ok(())
}

/// Skill z folderu, pliku SKILL.md (bierze jego folder) albo archiwum .zip.
#[tauri::command(async)]
pub fn skill_import(path: String) -> Result<Imported, String> {
    let p = Path::new(&path);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "skill".into());
    let mut entries = vec![];
    if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip")) {
        let file = std::fs::File::open(p).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("To nie jest poprawne archiwum zip: {e}"))?;
        for i in 0..zip.len() {
            let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
            let Some(name) = f.enclosed_name().map(|n| n.to_string_lossy().replace('\\', "/")) else { continue };
            if f.is_dir() || f.size() as usize > MAX_FILE {
                continue;
            }
            let mut data = vec![];
            f.read_to_end(&mut data).map_err(|e| e.to_string())?;
            entries.push((name, data));
        }
        return build(entries, &stem);
    }
    let dir = if p.is_dir() { p.to_path_buf() } else { p.parent().ok_or("Nieznany folder")?.to_path_buf() };
    let name = dir.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or(stem);
    walk(&dir, &dir, &mut entries, 0)?;
    build(entries, &name)
}

/* ---------- skille z ekosystemu `npx skills add …` ---------- */

/// Źródło z komendy `npx skills add`: `owner/repo`, adres URL (także `git@…`) albo nazwa. Na Windows komenda idzie
/// przez `cmd /C`, więc dopuszczamy tylko znaki bez znaczenia dla powłoki i nic, co udaje opcję.
fn valid_source(s: &str) -> bool {
    !s.is_empty() && s.len() <= 300 && !s.starts_with('-') && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:@#~+=?".contains(c))
}

fn valid_skill(s: &str) -> bool {
    s == "*" || (!s.is_empty() && s.len() <= 100 && !s.starts_with('-') && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c)))
}

#[derive(Serialize)]
pub struct Fetched {
    skills: Vec<Imported>,
    /// Skille, których narzędzie nie zainstalowało albo których nie dało się odczytać (nazwa: powód).
    skipped: Vec<String>,
}

/// Wynik `skills add --json`: jeden wpis na skill albo jeden wpis z błędem.
#[derive(serde::Deserialize)]
struct CliItem {
    name: Option<String>,
    status: String,
    path: Option<String>,
    error: Option<String>,
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::new();
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\u{1b}' {
            if it.peek() == Some(&'[') {
                it.next();
                while let Some(&n) = it.peek() {
                    it.next();
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Uruchamia prawdziwe `npx skills add <źródło>` w pustym folderze tymczasowym (instalacja na poziomie projektu,
/// kopie plików dla Claude Code), czyta zainstalowane SKILL.md i usuwa folder. Nic nie trafia do globalnych
/// folderów agentów; do Hermitty importuje frontend wybrane przez użytkownika skille.
#[tauri::command]
pub async fn skills_fetch(app: tauri::AppHandle, source: String, skills: Vec<String>) -> Result<Fetched, String> {
    let source = source.trim().to_string();
    if !valid_source(&source) {
        return Err("Niepoprawne źródło. Podaj np. mattpocock/skills albo adres repozytorium.".into());
    }
    if let Some(bad) = skills.iter().find(|s| !valid_skill(s)) {
        return Err(format!("Niepoprawna nazwa skilla: {bad}"));
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let dir = crate::store::data_dir(&app)?.join("tmp").join(format!("skills-{stamp}"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let r = fetch_into(&dir, &source, &skills);
        let _ = std::fs::remove_dir_all(&dir);
        r
    })
    .await
    .map_err(|e| e.to_string())?
}

fn fetch_into(dir: &Path, source: &str, skills: &[String]) -> Result<Fetched, String> {
    let mut args: Vec<String> = ["-y", "skills", "add", source, "--skill"].iter().map(|s| s.to_string()).collect();
    if skills.is_empty() { args.push("*".into()) } else { args.extend(skills.iter().cloned()) }
    args.extend(["--agent", "claude-code", "--copy", "-y", "--json"].iter().map(|s| s.to_string()));
    // npx na Windows to plik .cmd, który uruchamia się przez cmd.exe.
    let (program, args) = if cfg!(windows) {
        ("cmd.exe", [vec!["/C".to_string(), "npx".to_string()], args].concat())
    } else {
        ("npx", args)
    };
    let env = [("DISABLE_TELEMETRY", "1"), ("DO_NOT_TRACK", "1"), ("CI", "1"), ("NO_COLOR", "1")];
    let out = crate::sys::exec_env(program, &args, dir.to_str(), 300_000, &env)
        .map_err(|e| if e.contains("uruchomić") { "Nie znaleziono npx. Zainstaluj Node.js (nodejs.org) i spróbuj ponownie.".to_string() } else { e })?;
    let json_start = out.stdout.find('[');
    let items: Vec<CliItem> = json_start.and_then(|i| serde_json::from_str(&out.stdout[i..]).ok()).ok_or_else(|| {
        let err = strip_ansi(&format!("{}\n{}", out.stderr, out.stdout));
        let tail: Vec<&str> = err.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        format!("npx skills nie zwróciło wyniku (kod {}). {}", out.code, tail[tail.len().saturating_sub(4)..].join(" "))
    })?;
    let root = dir.canonicalize().map_err(|e| e.to_string())?;
    let (mut found, mut skipped) = (vec![], vec![]);
    for it in items {
        let name = it.name.clone().unwrap_or_default();
        if it.status != "installed" {
            let why = it.error.unwrap_or_else(|| it.status.clone());
            if name.is_empty() && found.is_empty() && skipped.is_empty() {
                // Jeden wpis bez nazwy: błąd całego polecenia (np. repozytorium nie istnieje).
                return Err(why.lines().next().unwrap_or("Błąd npx skills").to_string());
            }
            skipped.push(format!("{}: {}", if name.is_empty() { "?" } else { &name }, why.lines().next().unwrap_or("")));
            continue;
        }
        // Czytamy tylko z folderu tymczasowego, nawet gdyby narzędzie podało inną ścieżkę.
        let Some(path) = it.path.as_deref().and_then(|p| Path::new(p).canonicalize().ok()).filter(|p| p.starts_with(&root)) else {
            skipped.push(format!("{name}: brak plików skilla"));
            continue;
        };
        let mut entries = vec![];
        match walk(&path, &path, &mut entries, 0).and_then(|_| build(entries, &name)) {
            Ok(s) => found.push(s),
            Err(e) => skipped.push(format!("{name}: {e}")),
        }
    }
    if found.is_empty() && skipped.is_empty() {
        return Err("W tym źródle nie znaleziono skilli.".into());
    }
    Ok(Fetched { skills: found, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_skill_with_resources() {
        let md = "---\nname: pdf-tools\ndescription: \"Praca z PDF\"\nmetadata:\n  x: 1\n---\n\n# PDF\nUżyj skryptu.\n";
        let r = build(
            vec![
                ("pkg/pdf/SKILL.md".into(), md.as_bytes().to_vec()),
                ("pkg/pdf/scripts/fill.py".into(), b"print(1)".to_vec()),
                ("pkg/pdf/logo.png".into(), vec![0, 159, 146]),
                ("pkg/other.md".into(), b"poza skillem".to_vec()),
            ],
            "x",
        )
        .unwrap();
        assert_eq!((r.name.as_str(), r.description.as_str()), ("pdf-tools", "Praca z PDF"));
        assert_eq!(r.body, "# PDF\nUżyj skryptu.");
        assert_eq!(r.files.keys().collect::<Vec<_>>(), ["scripts/fill.py"]);
    }

    #[test]
    fn folded_description_and_safe_sources() {
        let md = "---\nname: tdd\ndescription: >-\n  Test-driven development.\n  Use when testing.\nmetadata:\n  author: x\n---\nBody";
        let r = build(vec![("SKILL.md".into(), md.as_bytes().to_vec())], "x").unwrap();
        assert_eq!(r.description, "Test-driven development. Use when testing.");
        assert_eq!(r.body, "Body");
        for ok in ["mattpocock/skills", "https://github.com/vercel-labs/agent-skills", "git@github.com:a/b.git", "notion", "a/b#main"] {
            assert!(valid_source(ok), "{ok}");
        }
        for bad in ["", "-g", "a/b & calc", "a/b|x", "a\"b", "a/b;rm", "%PATH%", "a b"] {
            assert!(!valid_source(bad), "{bad}");
        }
        assert!(valid_skill("*") && valid_skill("code-review") && !valid_skill("-a") && !valid_skill("x&y"));
        assert_eq!(strip_ansi("\u{1b}[1mBłąd\u{1b}[0m"), "Błąd");
    }

    /// Prawdziwe `npx skills add` (sieć i Node.js): cargo test -- --ignored skills_from_npx
    #[test]
    #[ignore]
    fn skills_from_npx() {
        let dir = std::env::temp_dir().join(format!("hermitty-skills-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let r = fetch_into(&dir, "mattpocock/skills", &["tdd".into(), "retro".into(), "nie-ma-takiego".into()]).unwrap();
        let mut names: Vec<_> = r.skills.iter().map(|s| s.name.as_str()).collect();
        names.sort();
        assert_eq!(names, ["retro", "tdd"]);
        assert!(r.skills.iter().all(|s| !s.body.is_empty() && !s.description.is_empty()));
        assert!(fetch_into(&dir, "nie-istnieje-xyz/brak-repo-123", &[]).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plain_markdown_without_header() {
        let r = build(vec![("SKILL.md".into(), b"Tylko instrukcje".to_vec())], "moj").unwrap();
        assert_eq!((r.name.as_str(), r.body.as_str()), ("moj", "Tylko instrukcje"));
        assert!(build(vec![("README.md".into(), b"x".to_vec())], "a").is_err());
    }
}
