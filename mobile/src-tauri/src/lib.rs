//! Hermitty na Androida. Połączenie z komputerem, szyfrowanie i interfejs są we frontendzie (mobile/src);
//! kod QR skanuje WebView (getUserMedia + jsQR), bez natywnej wtyczki aparatu.
//! Sekrety (klucze komputerów, klucz AI, hasła SSH) trzyma `secret` w Android Keystore.
//! `ssh` łączy telefon z serwerami bezpośrednio, bez komputera.

mod ai;
mod secret;
mod ssh;
#[cfg(all(debug_assertions, desktop))]
mod selftest;

use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(secret::init())
        .manage(Arc::new(ssh::SshState::default()))
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_shell,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_close,
            ssh::ssh_hostkey_answer,
            ssh::ssh_keygen,
            ssh::ssh_pubkey,
            ssh::ssh_import_key,
            ssh::ssh_forget_hostkey,
            ssh::ssh_exec,
            ai::ai_request,
        ])
        .setup(|_app| {
            #[cfg(all(debug_assertions, desktop))]
            if let Ok(spec) = std::env::var("HERMITTY_SSH_SELFTEST") {
                selftest::run(_app.handle().clone(), spec);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("błąd podczas uruchamiania aplikacji");
}
