//! Trwały stan aplikacji (JSON w katalogu danych) i pliki pluginów.
//! Każdy plugin widzi tylko `plugins/<id>/data`; ścieżki z `..` albo absolutne są odrzucane.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // Tryb portable: folder `data` obok pliku exe ma pierwszeństwo.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let portable = dir.join("data");
            if portable.is_dir() {
                return Ok(portable);
            }
        }
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn state_load(app: AppHandle) -> Result<Option<String>, String> {
    let path = data_dir(&app)?.join("state.json");
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn state_save(app: AppHandle, json: String) -> Result<(), String> {
    let path = data_dir(&app)?.join("state.json");
    if path.exists() {
        let _ = fs::copy(&path, path.with_extension("bak"));
    }
    write_atomic(&path, json.as_bytes())
}

/* ---------- plugin files ---------- */

fn valid_plugin_id(id: &str) -> bool {
    !id.is_empty() && id.len() < 100 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

fn safe_join(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.replace('\\', "/");
    let p = Path::new(rel.trim_start_matches('/'));
    for c in p.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(format!("Niedozwolona ścieżka: {rel}")),
        }
    }
    Ok(base.join(p))
}

fn plugin_data(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if !valid_plugin_id(id) {
        return Err("Niepoprawny identyfikator pluginu".into());
    }
    let dir = data_dir(app)?.join("plugins").join(id).join("data");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[derive(Serialize)]
pub struct FsEntry {
    name: String,
    path: String,
    kind: &'static str,
    size: u64,
    modified: u64,
}

#[tauri::command(async)]
pub fn plugin_fs(app: AppHandle, plugin: String, op: String, path: String, data: Option<String>, to: Option<String>) -> Result<serde_json::Value, String> {
    let base = plugin_data(&app, &plugin)?;
    let target = safe_join(&base, &path)?;
    let rel = |p: &Path| p.strip_prefix(&base).unwrap_or(p).to_string_lossy().replace('\\', "/");
    match op.as_str() {
        "read" => fs::read_to_string(&target).map(serde_json::Value::from).map_err(|e| format!("{path}: {e}")),
        "write" => write_atomic(&target, data.unwrap_or_default().as_bytes()).map(|_| serde_json::Value::Null),
        "exists" => Ok(serde_json::Value::from(target.exists())),
        "mkdir" => fs::create_dir_all(&target).map(|_| serde_json::Value::Null).map_err(|e| e.to_string()),
        "remove" => {
            if target.is_dir() { fs::remove_dir_all(&target) } else if target.exists() { fs::remove_file(&target) } else { Ok(()) }
                .map(|_| serde_json::Value::Null)
                .map_err(|e| e.to_string())
        }
        "move" => {
            let dest = safe_join(&base, &to.ok_or("Brak ścieżki docelowej")?)?;
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::rename(&target, &dest).map(|_| serde_json::Value::Null).map_err(|e| e.to_string())
        }
        "list" => {
            let mut out = Vec::new();
            if target.is_dir() {
                for e in fs::read_dir(&target).map_err(|e| e.to_string())?.flatten() {
                    let meta = e.metadata().map_err(|e| e.to_string())?;
                    let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
                    out.push(FsEntry {
                        name: e.file_name().to_string_lossy().into_owned(),
                        path: rel(&e.path()),
                        kind: if meta.is_dir() { "dir" } else { "file" },
                        size: meta.len(),
                        modified,
                    });
                }
            }
            serde_json::to_value(out).map_err(|e| e.to_string())
        }
        other => Err(format!("Nieznana operacja: {other}")),
    }
}

/* ---------- plugin install ---------- */

#[derive(Serialize)]
pub struct InstalledPlugin {
    manifest: String,
    code: String,
}

/// Zainstalowane (zaimportowane) pluginy: `plugins/<id>/code/plugin.json` + plik main.
#[tauri::command(async)]
pub fn plugins_installed(app: AppHandle) -> Result<Vec<InstalledPlugin>, String> {
    let dir = data_dir(&app)?.join("plugins");
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let code_dir = e.path().join("code");
            let Ok(manifest) = fs::read_to_string(code_dir.join("plugin.json")) else { continue };
            let main = serde_json::from_str::<serde_json::Value>(&manifest)
                .ok()
                .and_then(|m| m.get("main").and_then(|v| v.as_str()).map(String::from))
                .unwrap_or_else(|| "main.js".into());
            let Ok(path) = safe_join(&code_dir, &main) else { continue };
            if let Ok(code) = fs::read_to_string(path) {
                out.push(InstalledPlugin { manifest, code });
            }
        }
    }
    Ok(out)
}

fn find_manifest(zip: &mut zip::ZipArchive<fs::File>) -> Result<(String, String), String> {
    let mut best: Option<String> = None;
    for i in 0..zip.len() {
        let name = zip.by_index(i).map_err(|e| e.to_string())?.name().to_string();
        if name == "plugin.json" || name.ends_with("/plugin.json") {
            if best.as_ref().map_or(true, |b| name.matches('/').count() < b.matches('/').count()) {
                best = Some(name);
            }
        }
    }
    let name = best.ok_or("W archiwum nie ma pliku plugin.json.")?;
    let mut s = String::new();
    zip.by_name(&name).map_err(|e| e.to_string())?.read_to_string(&mut s).map_err(|e| e.to_string())?;
    let prefix = name.trim_end_matches("plugin.json").to_string();
    Ok((s, prefix))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspected {
    manifest: String,
    files: usize,
    has_main: bool,
}

#[tauri::command(async)]
pub fn plugin_inspect(path: String) -> Result<Inspected, String> {
    let file = fs::File::open(&path).map_err(|e| format!("Nie można otworzyć pliku: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("To nie jest poprawne archiwum .zip: {e}"))?;
    let (manifest, prefix) = find_manifest(&mut zip)?;
    let main = serde_json::from_str::<serde_json::Value>(&manifest)
        .map_err(|e| format!("plugin.json nie jest poprawnym JSON-em: {e}"))?
        .get("main").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let has_main = !main.is_empty() && zip.by_name(&format!("{prefix}{main}")).is_ok();
    let files = (0..zip.len()).filter(|i| zip.by_index(*i).map(|f| !f.is_dir()).unwrap_or(false)).count();
    Ok(Inspected { manifest, files, has_main })
}

#[tauri::command(async)]
pub fn plugin_install(app: AppHandle, path: String, id: String) -> Result<(), String> {
    if !valid_plugin_id(&id) {
        return Err("Niepoprawny identyfikator pluginu".into());
    }
    let file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let (_, prefix) = find_manifest(&mut zip)?;
    let code_dir = data_dir(&app)?.join("plugins").join(&id).join("code");
    if code_dir.exists() {
        fs::remove_dir_all(&code_dir).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&code_dir).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().to_string();
        let Some(rel) = name.strip_prefix(&prefix) else { continue };
        if rel.is_empty() || f.is_dir() {
            continue;
        }
        let dest = safe_join(&code_dir, rel)?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        write_atomic(&dest, &buf)?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn plugin_uninstall(app: AppHandle, id: String, keep_data: bool) -> Result<(), String> {
    if !valid_plugin_id(&id) {
        return Err("Niepoprawny identyfikator pluginu".into());
    }
    let dir = data_dir(&app)?.join("plugins").join(&id);
    let target = if keep_data { dir.join("code") } else { dir };
    if target.exists() {
        fs::remove_dir_all(target).map_err(|e| e.to_string())?;
    }
    Ok(())
}
