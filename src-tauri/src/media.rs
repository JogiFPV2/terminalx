//! Grafika i wideo z workflow: zapytania do providerów mediów (fal.ai, Replicate, OpenAI, Google)
//! z kluczem dokładanym w rdzeniu, pobieranie wyników do folderu `media` i czcionki motywów w `fonts`.
//! Klucz trafia tylko do hosta providera; innym adresom (np. CDN z wynikami) wysyłamy zapytanie bez niego.

use base64::Engine;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;

use crate::store::data_dir;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProvider {
    #[serde(rename = "type")]
    kind: String,
    url: String,
    key_ref: Option<String>,
}

#[derive(Deserialize)]
pub struct Part {
    name: String,
    value: Option<String>,
    file: Option<String>,
}

fn host(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1)?;
    Some(rest.split(['/', '?', '#']).next()?.rsplit('@').next()?.split(':').next()?.to_lowercase())
}

/// Czy klucz providera może pójść pod ten adres.
fn trusted(p: &MediaProvider, url: &str) -> bool {
    let (Some(h), Some(base)) = (host(url), host(&p.url)) else { return false };
    if h == base {
        return true;
    }
    match p.kind.as_str() {
        "fal" => h == "fal.run" || h.ends_with(".fal.run") || h.ends_with(".fal.ai"),
        "replicate" => h == "api.replicate.com",
        "google" => h == "generativelanguage.googleapis.com",
        "openai" => h == "api.openai.com",
        _ => false,
    }
}

fn auth(req: reqwest::RequestBuilder, p: &MediaProvider) -> Result<reqwest::RequestBuilder, String> {
    let key = match p.key_ref.as_deref() {
        Some(r) if !r.is_empty() => keyring::Entry::new("TerminalX", r).ok().and_then(|e| e.get_password().ok()),
        _ => None,
    };
    // Lokalny ComfyUI zwykle działa bez klucza; gdy jest za serwerem z hasłem, klucz idzie jako Bearer.
    let Some(key) = key else {
        return if p.kind == "comfy" { Ok(req) } else { Err("Brak klucza API dla providera mediów. Dodaj go w Ustawienia → Providerzy.".into()) };
    };
    Ok(match p.kind.as_str() {
        "fal" => req.header("authorization", format!("Key {key}")),
        "google" => req.header("x-goog-api-key", key),
        _ => req.header("authorization", format!("Bearer {key}")),
    })
}

fn client(secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(secs)).build().map_err(|e| e.to_string())
}

pub fn media_root(app: &AppHandle) -> Result<PathBuf, String> {
    let d = data_dir(app)?.join("media");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

pub fn fonts_root(app: &AppHandle) -> Result<PathBuf, String> {
    let d = data_dir(app)?.join("fonts");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn new_file(app: &AppHandle, ext: &str) -> Result<PathBuf, String> {
    let ext: String = ext.trim_start_matches('.').chars().filter(|c| c.is_ascii_alphanumeric()).take(5).collect();
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let rnd: u32 = rand::random();
    Ok(media_root(app)?.join(format!("{stamp}-{rnd:08x}.{}", if ext.is_empty() { "bin" } else { &ext })))
}

fn ext_from(mime: &str, url: &str) -> String {
    let m = mime.split(';').next().unwrap_or("").trim();
    let by_mime = match m {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        _ => "",
    };
    if !by_mime.is_empty() {
        return by_mime.into();
    }
    let path = url.split(['?', '#']).next().unwrap_or("");
    let e = path.rsplit('.').next().unwrap_or("").to_lowercase();
    if ["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm", "mov"].contains(&e.as_str()) { e } else { "bin".into() }
}

/// Zapytanie JSON albo multipart do providera mediów. Zwraca surowy JSON (albo tekst jako string).
#[tauri::command]
pub async fn media_request(
    provider: MediaProvider,
    method: String,
    url: String,
    body: Option<serde_json::Value>,
    multipart: Option<Vec<Part>>,
    headers: Option<std::collections::HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Obsługiwane są tylko adresy http(s)".into());
    }
    let m = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client(300)?.request(m, &url);
    if trusted(&provider, &url) {
        req = auth(req, &provider)?;
    }
    for (k, v) in headers.unwrap_or_default() {
        let l = k.to_lowercase();
        if l != "authorization" && l != "x-goog-api-key" {
            req = req.header(k, v);
        }
    }
    if let Some(parts) = multipart {
        let mut form = reqwest::multipart::Form::new();
        for p in parts {
            if let Some(f) = p.file {
                let data = std::fs::read(&f).map_err(|e| format!("Nie mogę odczytać {f}: {e}"))?;
                let name = Path::new(&f).file_name().and_then(|n| n.to_str()).unwrap_or("plik").to_string();
                let mime = match ext_from("", &name).as_str() {
                    "png" => "image/png",
                    "jpg" | "jpeg" => "image/jpeg",
                    "webp" => "image/webp",
                    "mp4" => "video/mp4",
                    _ => "application/octet-stream",
                };
                let part = reqwest::multipart::Part::bytes(data).file_name(name).mime_str(mime).map_err(|e| e.to_string())?;
                form = form.part(p.name, part);
            } else {
                form = form.text(p.name, p.value.unwrap_or_default());
            }
        }
        req = req.multipart(form);
    } else if let Some(b) = &body {
        req = req.json(b);
    }
    let res = req.send().await.map_err(|e| format!("Błąd połączenia z {url}: {e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text.clone()));
    if !status.is_success() {
        let msg = ["/error/message", "/detail", "/error", "/message", "/title"]
            .iter()
            .find_map(|p| json.pointer(p).map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())))
            .unwrap_or_else(|| text.chars().take(400).collect());
        // ComfyUI: szczegóły błędów walidacji są w node_errors.
        let detail = json.get("node_errors").and_then(|n| n.as_object()).and_then(|m| m.values().next()).map(|e| {
            let class = e.get("class_type").and_then(|c| c.as_str()).unwrap_or("");
            let first = e.pointer("/errors/0");
            let m = first.and_then(|f| f.get("message")).and_then(|v| v.as_str()).unwrap_or("");
            let d = first.and_then(|f| f.get("details")).and_then(|v| v.as_str()).unwrap_or("");
            format!(" ({class}: {m}{}{d})", if d.is_empty() { "" } else { " – " })
        }).unwrap_or_default();
        let msg = format!("{msg}{detail}");
        return Err(format!("{} {}: {msg}", status.as_u16(), status.canonical_reason().unwrap_or("")));
    }
    Ok(json)
}

/// Pobiera wynik (adres http(s) albo `data:`) do folderu media. Zwraca ścieżkę pliku.
#[tauri::command]
pub async fn media_download(app: AppHandle, provider: Option<MediaProvider>, url: String, ext: Option<String>) -> Result<String, String> {
    if let Some(rest) = url.strip_prefix("data:") {
        let (meta, data) = rest.split_once(',').ok_or("Niepoprawny adres data:")?;
        let bytes = B64.decode(data.trim()).map_err(|e| e.to_string())?;
        let path = new_file(&app, &ext.unwrap_or_else(|| ext_from(meta, "")))?;
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        return Ok(path.to_string_lossy().into_owned());
    }
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Obsługiwane są tylko adresy http(s)".into());
    }
    let mut req = client(900)?.get(&url);
    if let Some(p) = &provider {
        if trusted(p, &url) {
            req = auth(req, p)?;
        }
    }
    let mut res = req.send().await.map_err(|e| format!("Błąd pobierania: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Pobieranie wyniku: HTTP {}", res.status().as_u16()));
    }
    let mime = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let path = new_file(&app, &ext.unwrap_or_else(|| ext_from(&mime, &url)))?;
    let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut total = 0usize;
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        total += chunk.len();
        if total > 2_000_000_000 {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err("Plik jest większy niż 2 GB".into());
        }
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Zapisuje dane base64 (bez prefiksu `data:`) jako nowy plik w folderze media.
#[tauri::command]
pub fn media_save_b64(app: AppHandle, data: String, ext: String) -> Result<String, String> {
    let bytes = B64.decode(data.trim()).map_err(|e| e.to_string())?;
    let path = new_file(&app, &ext)?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Kopiuje plik z dysku do folderu media (wejście workflow), żeby dało się go pokazać w aplikacji.
#[tauri::command]
pub fn media_import(app: AppHandle, path: String) -> Result<String, String> {
    let ext = Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or("bin").to_lowercase();
    let dst = new_file(&app, &ext)?;
    std::fs::copy(&path, &dst).map_err(|e| format!("Nie mogę skopiować {path}: {e}"))?;
    Ok(dst.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn media_dir(app: AppHandle) -> Result<String, String> {
    Ok(media_root(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn fonts_dir(app: AppHandle) -> Result<String, String> {
    Ok(fonts_root(&app)?.to_string_lossy().into_owned())
}

/// Plik jako base64 (obrazy wejściowe dla providerów, którzy chcą danych w JSON). Limit 40 MB.
#[tauri::command]
pub fn fs_read_b64(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 40 * 1024 * 1024 {
        return Err("Plik jest za duży (limit 40 MB)".into());
    }
    Ok(B64.encode(std::fs::read(&path).map_err(|e| e.to_string())?))
}

#[tauri::command]
pub fn fs_copy(src: String, dst: String) -> Result<(), String> {
    if let Some(dir) = Path::new(&dst).parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::copy(&src, &dst).map(|_| ()).map_err(|e| e.to_string())
}

/// Pobiera czcionkę z Google Fonts (tylko podzbiory latin i latin-ext) do `fonts/<slug>/`.
/// Zwraca CSS z @font-face, w którym adresy są nazwami plików względem tego folderu.
#[tauri::command]
pub async fn font_fetch(app: AppHandle, family: String) -> Result<String, String> {
    let slug: String = family.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    if slug.trim_matches('-').is_empty() {
        return Err("Pusta nazwa czcionki".into());
    }
    let dir = fonts_root(&app)?.join(&slug);
    let css_path = dir.join("font.css");
    if let Ok(css) = std::fs::read_to_string(&css_path) {
        return Ok(css);
    }
    let fam = family.trim().replace(' ', "+");
    let c = client(60)?;
    // Nowoczesny User-Agent, żeby Google zwrócił woff2 zamiast ttf.
    let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
    let mut css = String::new();
    for q in [format!("{fam}:wght@300;400;500;600;700"), format!("{fam}:wght@400;700"), fam.clone()] {
        let r = c.get(format!("https://fonts.googleapis.com/css2?family={q}&display=swap")).header("user-agent", ua).send().await.map_err(|e| format!("Google Fonts: {e}"))?;
        if r.status().is_success() {
            css = r.text().await.map_err(|e| e.to_string())?;
            break;
        }
    }
    if css.is_empty() {
        return Err(format!("Google Fonts nie zna czcionki „{family}”"));
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Bloki: "/* latin */ @font-face { ... }" — zostawiamy latin i latin-ext (polskie znaki).
    let mut out = String::new();
    let mut saved: std::collections::HashMap<String, String> = Default::default();
    for chunk in css.split("/* ").skip(1) {
        let (subset, rest) = chunk.split_once(" */").unwrap_or(("", chunk));
        if subset != "latin" && subset != "latin-ext" {
            continue;
        }
        let Some(start) = rest.find("url(") else { continue };
        let Some(end) = rest[start..].find(')') else { continue };
        let url = rest[start + 4..start + end].trim_matches(['\'', '"']).to_string();
        let name = match saved.get(&url) {
            Some(n) => n.clone(),
            None => {
                let bytes = c.get(&url).send().await.map_err(|e| e.to_string())?.bytes().await.map_err(|e| e.to_string())?;
                let n = format!("{}-{}.woff2", subset, saved.len());
                std::fs::write(dir.join(&n), &bytes).map_err(|e| e.to_string())?;
                saved.insert(url.clone(), n.clone());
                n
            }
        };
        out.push_str(&rest.replace(&url, &name));
        out.push('\n');
    }
    if out.is_empty() {
        return Err(format!("Brak podzbioru latin dla „{family}”"));
    }
    std::fs::write(&css_path, &out).map_err(|e| e.to_string())?;
    Ok(out)
}
