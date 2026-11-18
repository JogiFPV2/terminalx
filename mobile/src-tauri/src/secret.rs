//! Sekrety telefonu (klucze sparowanych komputerów, klucz API AI, hasła SSH).
//! Na Androidzie szyfruje je klucz z Android Keystore (KeystorePlugin.kt); w podglądzie na komputerze
//! trafiają do pliku w katalogu danych aplikacji, bo to tylko wersja do pracy nad interfejsem.

#[cfg(target_os = "android")]
use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Wry,
};

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct KeyArgs<'a> {
    name: &'a str,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct SetArgs<'a> {
    name: &'a str,
    value: &'a str,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct GetRes {
    value: Option<String>,
}

fn valid(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 120 || !name.chars().all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c)) {
        return Err(format!("Niepoprawna nazwa sekretu: {name}"));
    }
    Ok(())
}

#[cfg(target_os = "android")]
pub struct Vault(tauri::plugin::PluginHandle<Wry>);

#[cfg(target_os = "android")]
impl Vault {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        self.0.run_mobile_plugin::<GetRes>("get", KeyArgs { name }).map(|r| r.value).map_err(|e| e.to_string())
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        self.0.run_mobile_plugin::<()>("set", SetArgs { name, value }).map_err(|e| e.to_string())
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        self.0.run_mobile_plugin::<()>("delete", KeyArgs { name }).map_err(|e| e.to_string())
    }
}

#[cfg(not(target_os = "android"))]
pub struct Vault(std::path::PathBuf, std::sync::Mutex<()>);

#[cfg(not(target_os = "android"))]
impl Vault {
    fn all(&self) -> std::collections::BTreeMap<String, String> {
        std::fs::read(&self.0).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }
    fn write(&self, m: &std::collections::BTreeMap<String, String>) -> Result<(), String> {
        if let Some(d) = self.0.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        std::fs::write(&self.0, serde_json::to_vec(m).unwrap()).map_err(|e| e.to_string())
    }
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        let _g = self.1.lock().unwrap();
        Ok(self.all().remove(name))
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let _g = self.1.lock().unwrap();
        let mut m = self.all();
        m.insert(name.into(), value.into());
        self.write(&m)
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        let _g = self.1.lock().unwrap();
        let mut m = self.all();
        m.remove(name);
        self.write(&m)
    }
}

#[tauri::command]
fn get(vault: tauri::State<'_, Vault>, name: String) -> Result<Option<String>, String> {
    valid(&name)?;
    vault.get(&name)
}

#[tauri::command]
fn set(vault: tauri::State<'_, Vault>, name: String, value: String) -> Result<(), String> {
    valid(&name)?;
    if value.len() > 64 * 1024 {
        return Err("Sekret jest za duży".into());
    }
    vault.set(&name, &value)
}

#[tauri::command]
fn delete(vault: tauri::State<'_, Vault>, name: String) -> Result<(), String> {
    valid(&name)?;
    vault.delete(&name)
}

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("secret")
        .invoke_handler(tauri::generate_handler![get, set, delete])
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            let vault = Vault(_api.register_android_plugin("app.hermitty.mobile", "KeystorePlugin")?);
            #[cfg(not(target_os = "android"))]
            let vault = Vault(app.path().app_data_dir()?.join("secrets-dev.json"), Default::default());
            app.manage(vault);
            Ok(())
        })
        .build()
}
