//! Zapytania do dostawców AI z telefonu. Klucz API jest w sejfie (secret.rs, nazwa ai.<id>.key)
//! i dokleja go tylko ta funkcja; interfejs podaje rodzaj dostawcy, adres i id.

use serde::Deserialize;
use std::time::Duration;
use tauri::AppHandle;

#[derive(Deserialize)]
pub struct ProviderRef {
    pub id: String,
    /// "anthropic" | "openai" | "google" | "openrouter" | "ollama" | "custom"
    pub kind: String,
    pub url: String,
}

pub fn key_name(id: &str) -> String {
    let id: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' }).take(60).collect();
    format!("ai.{id}.key")
}

#[tauri::command]
pub async fn ai_request(app: AppHandle, provider: ProviderRef, method: String, path: String, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    if !path.starts_with('/') || path.contains("..") {
        return Err("Niepoprawna ścieżka".into());
    }
    let key = crate::secret::read(&app, key_name(&provider.id)).await?.filter(|k| !k.is_empty());
    let client = reqwest::Client::builder().timeout(Duration::from_secs(300)).build().map_err(|e| e.to_string())?;
    let url = format!("{}{}", provider.url.trim_end_matches('/'), path);
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Adres dostawcy musi zaczynać się od https:// albo http://".into());
    }
    let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client.request(method, &url).header("content-type", "application/json");
    req = match provider.kind.as_str() {
        "anthropic" => req
            .header("x-api-key", key.ok_or("Brak klucza API. Dodaj go w ustawieniach agenta.")?)
            .header("anthropic-version", "2023-06-01"),
        "ollama" | "custom" => match key {
            Some(k) => req.header("authorization", format!("Bearer {k}")),
            None => req,
        },
        _ => req.header("authorization", format!("Bearer {}", key.ok_or("Brak klucza API. Dodaj go w ustawieniach agenta.")?)),
    };
    if let Some(b) = &body {
        req = req.json(b);
    }
    let res = req.send().await.map_err(|e| format!("Błąd połączenia z {url}: {e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text.clone()));
    if !status.is_success() {
        let msg = json.pointer("/error/message").and_then(|v| v.as_str()).map(String::from).unwrap_or_else(|| text.chars().take(400).collect());
        return Err(format!("{} {}: {msg}", status.as_u16(), status.canonical_reason().unwrap_or("")));
    }
    Ok(json)
}

#[derive(serde::Serialize)]
pub struct HttpOut {
    status: u16,
    text: String,
}

/// Żądanie HTTP dla nodów workflow (Żądanie HTTP, Pobierz stronę). Odpowiedź do 2 MB tekstu.
#[tauri::command]
pub async fn http_fetch(method: String, url: String, body: Option<String>, headers: Option<std::collections::HashMap<String, String>>) -> Result<HttpOut, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Adres musi zaczynać się od https:// albo http://".into());
    }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(60)).user_agent("Hermitty").build().map_err(|e| e.to_string())?;
    let m = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client.request(m, &url);
    for (k, v) in headers.unwrap_or_default() {
        req = req.header(k, v);
    }
    if let Some(b) = body.filter(|b| !b.is_empty()) {
        req = req.body(b);
    }
    let res = req.send().await.map_err(|e| format!("Błąd połączenia z {url}: {e}"))?;
    let status = res.status().as_u16();
    let mut text = res.text().await.map_err(|e| e.to_string())?;
    if text.len() > 2 * 1024 * 1024 {
        let mut cut = 2 * 1024 * 1024;
        while !text.is_char_boundary(cut) { cut -= 1; }
        text.truncate(cut);
    }
    Ok(HttpOut { status, text })
}
