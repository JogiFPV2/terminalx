//! Mostek z Hermitty na komputerze (wtyczka „Telefon”: powiadomienia, SMS-y, dyktafon) działa w Kotlinie:
//! gen/android/.../BridgePlugin.kt i pakiet bridge. Tu tylko rejestracja; polecenia `plugin:bridge|…`
//! bez obsługi w Ruście Tauri przekazuje prosto do Kotlina. Na komputerze (podgląd) mostka nie ma.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Wry;

/// Termux (TermuxPlugin.kt): komendy przez RUN_COMMAND, konfiguracja sshd, zapis do Pobranych.
pub fn init_termux() -> TauriPlugin<Wry> {
    Builder::new("termux")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            if let Err(e) = _api.register_android_plugin("app.hermitty.mobile", "TermuxPlugin") {
                eprintln!("Hermitty: Termux niedostępny: {e}");
            }
            Ok(())
        })
        .build()
}

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("bridge")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            if let Err(e) = _api.register_android_plugin("app.hermitty.mobile", "BridgePlugin") {
                eprintln!("Hermitty: mostek niedostępny: {e}");
            }
            Ok(())
        })
        .build()
}
