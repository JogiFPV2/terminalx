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
    for line in rest[..end].lines() {
        if let Some((k, v)) = line.split_once(':') {
            let v = v.trim().trim_matches(|c| c == '"' || c == '\'');
            if !k.starts_with(' ') && !v.is_empty() {
                meta.insert(k.trim().to_lowercase(), v.to_string());
            }
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
    fn plain_markdown_without_header() {
        let r = build(vec![("SKILL.md".into(), b"Tylko instrukcje".to_vec())], "moj").unwrap();
        assert_eq!((r.name.as_str(), r.body.as_str()), ("moj", "Tylko instrukcje"));
        assert!(build(vec![("README.md".into(), b"x".to_vec())], "a").is_err());
    }
}
