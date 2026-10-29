//! Historia rozmów z agentami i załączniki wiadomości.
//! Każda rozmowa to `chats/<id>.json`, a `chats/index.json` trzyma krótkie opisy do listy.
//! Załączniki rozmowy leżą w `attachments/<id>/` i znikają razem z nią.

use crate::store::data_dir;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::AppHandle;

static INDEX_LOCK: Mutex<()> = Mutex::new(());

fn valid_id(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.len() < 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) {
        Ok(())
    } else {
        Err("Niepoprawny identyfikator rozmowy".into())
    }
}

fn chats_root(app: &AppHandle) -> Result<PathBuf, String> {
    let d = data_dir(app)?.join("chats");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

pub fn att_root(app: &AppHandle) -> Result<PathBuf, String> {
    let d = data_dir(app)?.join("attachments");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn read_index(root: &std::path::Path) -> Map<String, Value> {
    fs::read_to_string(root.join("index.json")).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

fn write_index(root: &std::path::Path, idx: &Map<String, Value>) -> Result<(), String> {
    let tmp = root.join("index.tmp");
    fs::write(&tmp, serde_json::to_vec(idx).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, root.join("index.json")).map_err(|e| e.to_string())
}

/// Zapisuje rozmowę i jej opis w indeksie (tytuł, workspace, uczestnicy, daty, liczba wiadomości).
#[tauri::command]
pub fn chat_save(app: AppHandle, id: String, meta: Value, json: String) -> Result<(), String> {
    valid_id(&id)?;
    let root = chats_root(&app)?;
    let tmp = root.join(format!("{id}.tmp"));
    fs::write(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, root.join(format!("{id}.json"))).map_err(|e| e.to_string())?;
    let _g = INDEX_LOCK.lock().unwrap();
    let mut idx = read_index(&root);
    idx.insert(id, meta);
    write_index(&root, &idx)
}

/// Lista rozmów od najnowszej. Z `query` przeszukuje też treść (bez względu na wielkość liter).
#[tauri::command]
pub fn chat_list(app: AppHandle, query: Option<String>) -> Result<Vec<Value>, String> {
    let root = chats_root(&app)?;
    let idx = {
        let _g = INDEX_LOCK.lock().unwrap();
        read_index(&root)
    };
    let q = query.map(|q| q.trim().to_lowercase()).filter(|q| !q.is_empty());
    let mut out: Vec<Value> = idx
        .into_iter()
        .filter(|(id, meta)| match &q {
            None => true,
            Some(q) => {
                meta.to_string().to_lowercase().contains(q)
                    || fs::read_to_string(root.join(format!("{id}.json"))).map(|s| s.to_lowercase().contains(q)).unwrap_or(false)
            }
        })
        .map(|(id, mut meta)| {
            if let Some(o) = meta.as_object_mut() {
                o.insert("id".into(), Value::String(id));
            }
            meta
        })
        .collect();
    out.sort_by_key(|m| std::cmp::Reverse(m.get("updated").and_then(Value::as_i64).unwrap_or(0)));
    Ok(out)
}

#[tauri::command]
pub fn chat_load(app: AppHandle, id: String) -> Result<String, String> {
    valid_id(&id)?;
    fs::read_to_string(chats_root(&app)?.join(format!("{id}.json"))).map_err(|_| "Nie ma już tej rozmowy".to_string())
}

#[tauri::command]
pub fn chat_delete(app: AppHandle, id: String) -> Result<(), String> {
    valid_id(&id)?;
    let root = chats_root(&app)?;
    let _ = fs::remove_file(root.join(format!("{id}.json")));
    let _ = fs::remove_dir_all(att_root(&app)?.join(&id));
    let _g = INDEX_LOCK.lock().unwrap();
    let mut idx = read_index(&root);
    idx.remove(&id);
    write_index(&root, &idx)
}

/// Zapisuje załącznik rozmowy (base64) i zwraca ścieżkę. Nazwa pliku zostaje czytelna dla agenta.
#[tauri::command]
pub fn att_save(app: AppHandle, chat: String, name: String, data: String) -> Result<String, String> {
    valid_id(&chat)?;
    let bytes = B64.decode(data.trim()).map_err(|e| e.to_string())?;
    if bytes.len() > 100 * 1024 * 1024 {
        return Err("Załącznik jest za duży (limit 100 MB)".into());
    }
    let dir = att_root(&app)?.join(&chat);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let clean: String = name.chars().map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') { c } else { '_' }).collect();
    let clean = clean.trim().trim_start_matches('.');
    let clean = if clean.is_empty() { "plik".to_string() } else { clean.chars().take(80).collect() };
    let mut path = dir.join(&clean);
    let mut n = 1;
    while path.exists() {
        n += 1;
        let p = std::path::Path::new(&clean);
        let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("plik");
        path = dir.join(match p.extension().and_then(|e| e.to_str()) {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        });
    }
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::valid_id;

    #[test]
    fn ids() {
        assert!(valid_id("c_ab12-x").is_ok());
        assert!(valid_id("../x").is_err());
        assert!(valid_id("").is_err());
    }
}
