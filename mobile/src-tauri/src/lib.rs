//! Hermitty na Androida. Połączenie z komputerem, szyfrowanie i interfejs są we frontendzie (mobile/src);
//! kod QR skanuje WebView (getUserMedia + jsQR), bez natywnej wtyczki aparatu.
//! Sekrety (klucze komputerów, klucz AI, hasła SSH) trzyma `secret` w Android Keystore.

mod secret;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(secret::init())
        .run(tauri::generate_context!())
        .expect("błąd podczas uruchamiania aplikacji");
}
