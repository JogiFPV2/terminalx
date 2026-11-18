//! Hermitty na Androida. Połączenie z komputerem, szyfrowanie i interfejs są we frontendzie (mobile/src);
//! kod QR skanuje WebView (getUserMedia + jsQR), bez natywnej wtyczki aparatu.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default().run(tauri::generate_context!()).expect("błąd podczas uruchamiania aplikacji");
}
