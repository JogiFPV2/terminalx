//! Klucze API w systemowym magazynie poświadczeń i zapytania do providerów AI.
//! Frontend nigdy nie dostaje klucza z powrotem: zapisuje go tutaj i woła `ai_request`,
//! a rdzeń sam dokłada nagłówek uwierzytelnienia.

use serde::Deserialize;
use std::time::Duration;

const SERVICE: &str = "Hermitty";
/// Nazwa usługi w magazynie poświadczeń sprzed zmiany nazwy aplikacji.
const LEGACY: &str = "TerminalX";

fn entry(key_ref: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key_ref).map_err(|e| e.to_string())
}

/// Sekret z magazynu. Wpis zapisany jeszcze pod starą nazwą aplikacji jest przy pierwszym odczycie
/// przepisywany pod nową (stary zostaje, żeby poprzednia wersja dalej działała).
pub(crate) fn secret(key_ref: &str) -> Option<String> {
    let e = entry(key_ref).ok()?;
    if let Ok(v) = e.get_password() {
        return Some(v);
    }
    let v = keyring::Entry::new(LEGACY, key_ref).ok()?.get_password().ok()?;
    let _ = e.set_password(&v);
    Some(v)
}

pub(crate) fn secret_store(key_ref: &str, value: &str) -> Result<(), String> {
    entry(key_ref)?.set_password(value).map_err(|e| format!("Nie udało się zapisać klucza: {e}"))
}

/// Usuwa sekret pod obiema nazwami.
pub(crate) fn secret_remove(key_ref: &str) -> Result<(), String> {
    if let Ok(old) = keyring::Entry::new(LEGACY, key_ref) {
        let _ = old.delete_credential();
    }
    match entry(key_ref)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command(async)]
pub fn secret_set(key_ref: String, value: String) -> Result<(), String> {
    secret_store(&key_ref, &value)
}

#[tauri::command(async)]
pub fn secret_has(key_ref: String) -> bool {
    secret(&key_ref).is_some()
}

#[tauri::command(async)]
pub fn secret_delete(key_ref: String) -> Result<(), String> {
    secret_remove(&key_ref)
}

/* ---------- sejf kluczy (plugin „Klucze API”) ----------
 * Klucze wpisane przez użytkownika do sejfu. Plugin widzi tylko wersję zamaskowaną; pełny klucz
 * odczytuje wyłącznie host, gdy użytkownik kliknie „kopiuj”. Odczyt działa tylko w przestrzeni
 * `keyvault:`, więc nie da się nim wyciągnąć kluczy providerów AI ani haseł SSH. */

const VAULT: &str = "keyvault:";

fn vault_entry(key_ref: &str) -> Result<keyring::Entry, String> {
    if !key_ref.starts_with(VAULT) || key_ref.len() > 200 {
        return Err("Niedozwolony identyfikator klucza".into());
    }
    entry(key_ref)
}

/// Pierwsze i ostatnie 4 znaki; krótkie klucze w całości ukryte.
pub(crate) fn mask(key: &str) -> String {
    let c: Vec<char> = key.chars().collect();
    if c.len() <= 12 {
        return "•".repeat(8);
    }
    format!("{}••••••••{}", c[..4].iter().collect::<String>(), c[c.len() - 4..].iter().collect::<String>())
}

#[tauri::command(async)]
pub fn keyvault_set(key_ref: String, value: String) -> Result<String, String> {
    let v = value.trim();
    if v.is_empty() {
        return Err("Pusty klucz".into());
    }
    vault_entry(&key_ref)?.set_password(v).map_err(|e| format!("Nie udało się zapisać klucza: {e}"))?;
    Ok(mask(v))
}

#[tauri::command(async)]
pub fn keyvault_masked(refs: Vec<String>) -> std::collections::HashMap<String, String> {
    refs.into_iter()
        .filter_map(|r| {
            vault_entry(&r).ok()?;
            let k = secret(&r)?;
            Some((r, mask(&k)))
        })
        .collect()
}

#[tauri::command(async)]
pub fn keyvault_get(key_ref: String) -> Result<String, String> {
    vault_entry(&key_ref)?;
    secret(&key_ref).ok_or_else(|| "Nie ma takiego klucza w sejfie".to_string())
}

#[tauri::command(async)]
pub fn keyvault_delete(key_ref: String) -> Result<(), String> {
    vault_entry(&key_ref)?;
    secret_remove(&key_ref)
}

#[cfg(test)]
mod tests {
    #[test]
    fn mask_hides_middle() {
        assert_eq!(super::mask("sk-ant-api03-abcdefXYZ9"), "sk-a••••••••XYZ9");
        assert_eq!(super::mask("krótki"), "••••••••");
        assert!(super::vault_entry("openai-key").is_err());
    }

    #[test]
    fn legacy_secret_moves_to_new_name() {
        let r = format!("test-legacy-{}", std::process::id());
        keyring::Entry::new(super::LEGACY, &r).unwrap().set_password("v1").unwrap();
        assert_eq!(super::secret(&r).as_deref(), Some("v1"));
        assert_eq!(super::entry(&r).unwrap().get_password().unwrap(), "v1");
        super::secret_remove(&r).unwrap();
        assert!(super::secret(&r).is_none());
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
        Some(r) if !r.is_empty() => secret(r),
        _ => None,
    };
    let client = reqwest::Client::builder().timeout(Duration::from_secs(600)).build().map_err(|e| e.to_string())?;
    let url = format!("{}{}", base(&provider.url), path);
    let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client.request(method, &url).header("content-type", "application/json");

    match provider.kind.as_str() {
        "anthropic" => {
            let key = key.ok_or("Brak klucza API dla Anthropic. Dodaj go w Ustawienia → Konta i providerzy.")?;
            req = req.header("x-api-key", key).header("anthropic-version", "2023-06-01");
        }
        "ollama" => {
            if let Some(k) = key {
                req = req.header("authorization", format!("Bearer {k}"));
            }
        }
        _ => {
            let key = key.ok_or("Brak klucza API dla tego providera. Dodaj go w Ustawienia → Konta i providerzy.")?;
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
    // Limity z nagłówków (Anthropic: anthropic-ratelimit-*, OpenAI i zgodni: x-ratelimit-*) dla licznika zużycia.
    let limits: serde_json::Map<String, serde_json::Value> = res
        .headers()
        .iter()
        .filter(|(k, _)| k.as_str().starts_with("anthropic-ratelimit-") || k.as_str().starts_with("x-ratelimit-"))
        .filter_map(|(k, v)| Some((k.as_str().to_string(), serde_json::Value::String(v.to_str().ok()?.to_string()))))
        .collect();
    let text = res.text().await.map_err(|e| e.to_string())?;
    let mut json: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text.clone()));
    if let (Some(obj), false) = (json.as_object_mut(), limits.is_empty()) {
        obj.insert("__ratelimit".into(), serde_json::Value::Object(limits));
    }
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
