//! Klucze API w systemowym magazynie poświadczeń i zapytania do providerów AI.
//! Frontend nigdy nie dostaje klucza z powrotem: zapisuje go tutaj i woła `ai_request`,
//! a rdzeń sam dokłada nagłówek uwierzytelnienia.

use serde::Deserialize;
use std::time::Duration;

const SERVICE: &str = "TerminalX";

fn entry(key_ref: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key_ref).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_set(key_ref: String, value: String) -> Result<(), String> {
    entry(&key_ref)?.set_password(&value).map_err(|e| format!("Nie udało się zapisać klucza: {e}"))
}

#[tauri::command]
pub fn secret_has(key_ref: String) -> bool {
    entry(&key_ref).and_then(|e| e.get_password().map_err(|e| e.to_string())).is_ok()
}

#[tauri::command]
pub fn secret_delete(key_ref: String) -> Result<(), String> {
    match entry(&key_ref)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRef {
    #[serde(rename = "type")]
    kind: String,
    url: String,
    key_ref: Option<String>,
}

fn base(url: &str) -> String {
    url.trim_end_matches('/').to_string()
}

/// Wysyła zapytanie do providera. `path` to np. "/v1/messages", "/chat/completions", "/v1/models".
/// Zwraca surowy JSON odpowiedzi; błędy HTTP wracają jako czytelny komunikat.
#[tauri::command]
pub async fn ai_request(
    provider: ProviderRef,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
    headers: Option<std::collections::HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    let key = match provider.key_ref.as_deref() {
        Some(r) if !r.is_empty() => entry(r)?.get_password().ok(),
        _ => None,
    };
    let client = reqwest::Client::builder().timeout(Duration::from_secs(600)).build().map_err(|e| e.to_string())?;
    let url = format!("{}{}", base(&provider.url), path);
    let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client.request(method, &url).header("content-type", "application/json");

    match provider.kind.as_str() {
        "anthropic" => {
            let key = key.ok_or("Brak klucza API dla Anthropic. Dodaj go w Ustawienia → Providerzy.")?;
            req = req.header("x-api-key", key).header("anthropic-version", "2023-06-01");
        }
        "ollama" => {
            if let Some(k) = key {
                req = req.header("authorization", format!("Bearer {k}"));
            }
        }
        _ => {
            let key = key.ok_or("Brak klucza API dla tego providera. Dodaj go w Ustawienia → Providerzy.")?;
            req = req.header("authorization", format!("Bearer {key}"));
        }
    }

    for (k, v) in headers.unwrap_or_default() {
        // Nagłówków uwierzytelnienia nie da się nadpisać z frontendu.
        let lower = k.to_lowercase();
        if lower != "x-api-key" && lower != "authorization" {
            req = req.header(k, v);
        }
    }
    if let Some(b) = &body {
        req = req.json(b);
    }

    let res = req.send().await.map_err(|e| format!("Błąd połączenia z {url}: {e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text.clone()));
    if !status.is_success() {
        let msg = json
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| text.chars().take(400).collect());
        return Err(format!("{} {}: {msg}", status.as_u16(), status.canonical_reason().unwrap_or("")));
    }
    Ok(json)
}
