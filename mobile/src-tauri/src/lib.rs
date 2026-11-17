//! Hermitty na Androida, etap 1: pilot do Hermitty na komputerze. Cała logika (połączenie, szyfrowanie,
//! interfejs) jest we frontendzie (mobile/src); rdzeń dokłada tylko skaner kodów QR do parowania.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder.run(tauri::generate_context!()).expect("błąd podczas uruchamiania aplikacji");
}
