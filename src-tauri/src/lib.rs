mod ai;
mod local;
mod media;
mod monitor;
mod pty;
mod remote;
mod ssh;
mod store;
mod sys;

use std::sync::Arc;
use tauri::Manager;

/// Ponowne uruchomienie po zainstalowaniu aktualizacji (macOS, Linux; w Windows instalator robi to sam).
#[tauri::command]
fn app_restart(app: tauri::AppHandle) {
    app.restart();
}

/// Otwarcie terminala z wiersza poleceń albo z menu Eksploratora („Otwórz w TerminalX”):
/// `--open-terminal-path <folder>` i `--open-terminal-shell <powłoka>`, albo sam folder jako argument.
#[derive(serde::Serialize, Clone, Default)]
struct CliOpen {
    path: Option<String>,
    shell: Option<String>,
}

fn parse_cli(argv: &[String]) -> Option<CliOpen> {
    let mut o = CliOpen::default();
    let mut it = argv.iter().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--open-terminal-path" => o.path = it.next().cloned(),
            "--open-terminal-shell" => o.shell = it.next().cloned(),
            _ if !a.starts_with('-') && std::path::Path::new(a).is_dir() => o.path = Some(a.clone()),
            _ => {}
        }
    }
    (o.path.is_some() || o.shell.is_some()).then_some(o)
}

static START_OPEN: std::sync::OnceLock<Option<CliOpen>> = std::sync::OnceLock::new();

/// Polecenie z argumentów startowych (frontend pyta raz, po wczytaniu stanu).
#[tauri::command]
fn cli_initial() -> Option<CliOpen> {
    START_OPEN.get().cloned().flatten()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let ptys = Arc::new(pty::Ptys::default());
    START_OPEN.get_or_init(|| parse_cli(&std::env::args().collect::<Vec<_>>()));
    let mut builder = tauri::Builder::default();
    // Jedna kopia aplikacji: kolejne uruchomienie (np. z Eksploratora) otwiera terminal w działającej.
    // Testy end-to-end (port DevTools) działają obok zwykłej kopii.
    if std::env::var("TERMINALX_DEVTOOLS_PORT").is_err() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use tauri::Emitter;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if let Some(o) = parse_cli(&argv) {
                let _ = app.emit("cli-open", o);
            }
        }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ptys)
        .manage(sys::SysState::default())
        .manage(Arc::new(ssh::SshState::default()))
        .manage(Arc::new(remote::RemoteState::default()))
        .manage(local::LocalState::default())
        .manage(monitor::MonState::default())
        .setup(|app| {
            // Okno tworzymy tutaj, żeby dało się dołożyć argumenty WebView2. Port DevTools tylko na żądanie
            // (zmienna TERMINALX_DEVTOOLS_PORT, testy end-to-end); domyślnie wyłączony.
            let config = app.config().app.windows.first().cloned().ok_or("brak konfiguracji okna")?;
            let mut args = String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
            // „Tryb lekki” (domyślnie włączony): WebView2 bez GPU zużywa około połowę mniej pamięci.
            let light = store::data_dir(app.handle())
                .ok()
                .and_then(|d| std::fs::read_to_string(d.join("state.json")).ok())
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| v.pointer("/settings/lightMode").and_then(|b| b.as_bool()))
                .unwrap_or(true);
            if light || std::env::var("TERMINALX_NO_GPU").is_ok() {
                args.push_str(" --disable-gpu --disable-gpu-compositing");
            }
            if let Ok(port) = std::env::var("TERMINALX_DEVTOOLS_PORT") {
                if port.parse::<u16>().is_ok() {
                    args.push_str(&format!(" --remote-debugging-port={port}"));
                }
            }
            // Wyniki workflow (grafika, wideo) i czcionki motywów są pokazywane przez protokół asset tylko z tych folderów.
            let scope = app.asset_protocol_scope();
            for dir in [media::media_root(app.handle()), media::fonts_root(app.handle())].into_iter().flatten() {
                let _ = scope.allow_directory(&dir, true);
            }
            tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?.additional_browser_args(&args).build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_restart,
            cli_initial,
            sys::explorer_menu,
            monitor::mon_local,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_info,
            sys::sys_stats,
            sys::sys_exec,
            sys::sys_run_script,
            sys::sys_shells,
            sys::http_request,
            sys::fs_read_text,
            sys::fs_write_text,
            sys::fs_list,
            sys::fs_list_detail,
            store::state_load,
            store::state_save,
            store::plugin_fs,
            store::plugins_installed,
            store::plugin_inspect,
            store::plugin_install,
            store::plugin_uninstall,
            ai::secret_set,
            ai::secret_has,
            ai::secret_delete,
            ai::ai_request,
            media::media_request,
            media::media_download,
            media::media_save_b64,
            media::media_import,
            media::media_dir,
            media::fonts_dir,
            media::fs_read_b64,
            media::fs_copy,
            media::font_fetch,
            local::local_hw,
            local::comfy_find,
            local::comfy_default_dir,
            local::comfy_start,
            local::comfy_stop,
            local::comfy_status,
            local::comfy_ws,
            local::comfy_ws_close,
            local::dl_start,
            local::dl_cancel,
            local::archive_extract,
            local::fs_sizes,
            local::comfy_model_remove,
            ssh::ssh_hostkey_answer,
            ssh::ssh_shell,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_close,
            ssh::ssh_disconnect,
            ssh::ssh_exec,
            ssh::ssh_connections,
            ssh::sftp_list,
            ssh::sftp_op,
            ssh::sftp_read_text,
            ssh::sftp_write_text,
            ssh::sftp_transfer,
            ssh::ssh_forward_start,
            ssh::ssh_forward_stop,
            ssh::ssh_forwards,
            remote::remote_start,
            remote::remote_stop,
            remote::remote_status,
            remote::remote_pair_begin,
            remote::remote_pair_decision,
            remote::remote_devices,
            remote::remote_set_perm,
            remote::remote_revoke,
            remote::remote_send,
        ])
        .on_window_event(|window, event| {
            // Zamknięcie okna kończy wszystkie procesy terminali, także te „w tle”.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(p) = window.app_handle().try_state::<Arc<pty::Ptys>>() {
                    pty::kill_all(&p);
                }
                if let Some(l) = window.app_handle().try_state::<local::LocalState>() {
                    local::stop_all(&l);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("błąd podczas uruchamiania aplikacji");
}
