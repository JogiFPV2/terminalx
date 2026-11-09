mod ai;
mod local;
mod media;
mod monitor;
mod plans;
mod chats;
mod mcp;
mod phone;
mod aicli;
mod pty;
mod remote;
mod remote_crypto;
mod skills;
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

/// Otwarcie terminala z wiersza poleceń albo z menu Eksploratora („Otwórz w Hermitty”):
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

/// Zmienna środowiskowa `HERMITTY_<name>`; dawna nazwa `TERMINALX_<name>` działa dalej.
fn env_var(name: &str) -> Option<String> {
    std::env::var(format!("HERMITTY_{name}")).or_else(|_| std::env::var(format!("TERMINALX_{name}"))).ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let ptys = Arc::new(pty::Ptys::default());
    START_OPEN.get_or_init(|| parse_cli(&std::env::args().collect::<Vec<_>>()));
    let mut builder = tauri::Builder::default();
    // Jedna kopia aplikacji: kolejne uruchomienie (np. z Eksploratora) otwiera terminal w działającej.
    // Testy end-to-end (port DevTools) działają obok zwykłej kopii.
    if env_var("DEVTOOLS_PORT").is_none() {
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
        .manage(Arc::new(phone::PhoneState::default()))
        .manage(Arc::new(aicli::CliState::default()))
        .manage(local::LocalState::default())
        .manage(monitor::MonState::default())
        .manage(mcp::McpState::default())
        .setup(|app| {
            // Okno tworzymy tutaj, żeby dało się dołożyć argumenty WebView2. Port DevTools tylko na żądanie
            // (zmienna HERMITTY_DEVTOOLS_PORT, testy end-to-end); domyślnie wyłączony.
            let config = app.config().app.windows.first().cloned().ok_or("brak konfiguracji okna")?;
            let mut args = String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
            // „Tryb lekki” (domyślnie włączony): WebView2 bez GPU zużywa około połowę mniej pamięci.
            let light = store::data_dir(app.handle())
                .ok()
                .and_then(|d| std::fs::read_to_string(d.join("state.json")).ok())
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| v.pointer("/settings/lightMode").and_then(|b| b.as_bool()))
                .unwrap_or(true);
            if light || env_var("NO_GPU").is_some() {
                args.push_str(" --disable-gpu --disable-gpu-compositing");
            }
            if let Some(port) = env_var("DEVTOOLS_PORT") {
                if port.parse::<u16>().is_ok() {
                    args.push_str(&format!(" --remote-debugging-port={port}"));
                }
            }
            // Wyniki workflow (grafika, wideo) i czcionki motywów są pokazywane przez protokół asset tylko z tych folderów.
            let scope = app.asset_protocol_scope();
            for dir in [media::media_root(app.handle()), media::fonts_root(app.handle()), chats::att_root(app.handle())].into_iter().flatten() {
                let _ = scope.allow_directory(&dir, true);
            }
            let mut win = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?.additional_browser_args(&args);
            // Tryb portable: także dane WebView2 w folderze `data` (nic w profilu użytkownika, a kopie
            // z różnych folderów nie blokują sobie nawzajem wspólnego katalogu WebView2).
            if let Some(d) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("data"))).filter(|d| d.is_dir()) {
                win = win.data_directory(d.join("webview"));
            }
            let win = win.build()?;
            // Awaria procesu WebView2 (padł renderer, zabrakło pamięci): bez tego zostaje puste okno,
            // a powłoki działają dalej w tle. Przeładowanie odtwarza interfejs ze stanu zapisanego
            // na dysku; frontend przy starcie zamyka stare sesje (pty_reset), więc nic nie wisi w tle.
            #[cfg(windows)]
            {
                let handle = app.handle().clone();
                let _ = win.with_webview(move |pw| unsafe {
                    use webview2_com::Microsoft::Web::WebView2::Win32::*;
                    let Ok(core) = pw.controller().CoreWebView2() else { return };
                    let mut token = Default::default();
                    let _ = core.add_ProcessFailed(
                        &webview2_com::ProcessFailedEventHandler::create(Box::new(move |wv, args| {
                            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                            if let Some(a) = args {
                                let _ = a.ProcessFailedKind(&mut kind);
                            }
                            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                                handle.restart();
                            } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                                if let Some(wv) = wv {
                                    let _ = wv.Reload();
                                }
                            }
                            Ok(())
                        })),
                        &mut token,
                    );
                    // Mikrofon (dyktowanie w panelu agenta) bez systemowego pytania, ale tylko dla
                    // samej aplikacji. Ramki pluginów są w piaskownicy bez dostępu do mikrofonu.
                    let _ = core.add_PermissionRequested(
                        &webview2_com::PermissionRequestedEventHandler::create(Box::new(|_, args| {
                            let Some(a) = args else { return Ok(()) };
                            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                            let mut uri = Default::default();
                            a.PermissionKind(&mut kind)?;
                            a.Uri(&mut uri)?;
                            let uri = webview2_com::take_pwstr(uri);
                            let own = ["http://tauri.localhost/", "https://tauri.localhost/", "tauri://localhost/", "http://localhost:1420/"];
                            if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE && own.iter().any(|o| uri.starts_with(o)) {
                                a.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                            }
                            Ok(())
                        })),
                        &mut token,
                    );
                });
            }
            Ok(())
        })
        // Komendy synchroniczne mają #[tauri::command(async)]: bez tego Tauri wykonuje je w głównym
        // wątku okna, a wtedy każda wolniejsza (dysk, sejf, lista procesów) wstrzymuje całe IPC.
        .invoke_handler(tauri::generate_handler![
            app_restart,
            cli_initial,
            sys::explorer_menu,
            sys::sys_locale,
            monitor::mon_local,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_ack,
            pty::pty_reset,
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
            store::account_remove,
            skills::skill_import,
            ai::secret_set,
            plans::plan_usage,
            chats::chat_save,
            chats::chat_list,
            chats::chat_load,
            chats::chat_delete,
            chats::att_save,
            mcp::mcp_connect,
            mcp::mcp_call,
            mcp::mcp_disconnect,
            ai::keyvault_set,
            ai::keyvault_masked,
            ai::keyvault_get,
            ai::keyvault_delete,
            ai::secret_has,
            ai::secret_delete,
            ai::ai_request,
            ai::ai_transcribe,
            ai::ai_speech,
            media::media_request,
            media::media_download,
            media::media_save_b64,
            media::media_import,
            media::media_dir,
            media::fonts_dir,
            media::fs_read_b64,
            media::gallery_add,
            media::gallery_list,
            media::gallery_remove,
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
            aicli::aicli_detect,
            aicli::aicli_status,
            aicli::aicli_models,
            aicli::aicli_run,
            aicli::aicli_cancel,
            phone::phone_start,
            phone::phone_stop,
            phone::phone_status,
            phone::phone_pair_begin,
            phone::phone_pair_cancel,
            phone::phone_unpair,
            phone::phone_request,
            phone::phone_files,
            phone::phone_file_read,
            phone::phone_file_delete,
            phone::phone_file_reveal,
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
                if let Some(m) = window.app_handle().try_state::<mcp::McpState>() {
                    mcp::stop_all(&m);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("błąd podczas uruchamiania aplikacji");
}
