//! SSH prosto z telefonu (bez komputera): powłoka interaktywna przez russh.
//! Hasła i klucze prywatne są w sejfie (secret.rs, Android Keystore); interfejs zna tylko id hosta.
//! Klucz hosta: przy pierwszym połączeniu pyta użytkownik (TOFU), potem porównanie z known_hosts.json.

use russh::client::{self, Handle};
use russh::keys::{HashAlg, PrivateKey, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot, Mutex};

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HostCfg {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// "password" | "key"
    pub auth: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ShellEvent {
    Data { data: String },
    Exit { code: Option<u32>, error: Option<String> },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HostKeyPrompt {
    req_id: u32,
    host: String,
    port: u16,
    fingerprint: String,
    algorithm: String,
    changed: bool,
}

enum ShellCmd {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

#[derive(Default)]
pub struct SshState {
    next: AtomicU32,
    shells: Mutex<HashMap<u32, mpsc::UnboundedSender<ShellCmd>>>,
    prompts: Mutex<HashMap<u32, oneshot::Sender<bool>>>,
}

/// Nazwy sekretów hosta w sejfie.
pub fn secret_name(id: &str, what: &str) -> String {
    let id: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' }).take(60).collect();
    format!("ssh.{id}.{what}")
}

fn known_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("known_hosts.json"))
}
fn load_known(app: &AppHandle) -> HashMap<String, String> {
    known_path(app).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}
fn save_known(app: &AppHandle, map: &HashMap<String, String>) {
    if let Some(p) = known_path(app) {
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let tmp = p.with_extension("tmp");
        if std::fs::write(&tmp, serde_json::to_vec_pretty(map).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }
}

struct Client {
    app: AppHandle,
    host: String,
    port: u16,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let pk = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(c) => c.public_key().clone().into(),
        };
        let fp = pk.fingerprint(HashAlg::Sha256).to_string();
        let id = format!("[{}]:{}", self.host, self.port);
        let known = load_known(&self.app);
        if known.get(&id) == Some(&fp) {
            return Ok(true);
        }
        let state = self.app.state::<Arc<SshState>>();
        let req_id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        state.prompts.lock().await.insert(req_id, tx);
        let _ = self.app.emit(
            "ssh:hostkey",
            HostKeyPrompt { req_id, host: self.host.clone(), port: self.port, fingerprint: fp.clone(), algorithm: pk.algorithm().to_string(), changed: known.contains_key(&id) },
        );
        let ok = tokio::time::timeout(Duration::from_secs(300), rx).await.ok().and_then(|r| r.ok()).unwrap_or(false);
        state.prompts.lock().await.remove(&req_id);
        if ok {
            let mut known = load_known(&self.app);
            known.insert(id, fp);
            save_known(&self.app, &known);
        }
        Ok(ok)
    }
}

async fn connect(app: &AppHandle, cfg: &HostCfg) -> Result<Handle<Client>, String> {
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 4,
        ..Default::default()
    });
    let handler = Client { app: app.clone(), host: cfg.host.clone(), port: cfg.port };
    let mut handle = tokio::time::timeout(Duration::from_secs(20), client::connect(config, (cfg.host.as_str(), cfg.port), handler))
        .await
        .map_err(|_| format!("Przekroczono czas łączenia z {}:{}", cfg.host, cfg.port))?
        .map_err(|e| match e {
            russh::Error::UnknownKey => "Odrzucono klucz serwera.".to_string(),
            other => format!("Nie udało się połączyć z {}:{}: {other}", cfg.host, cfg.port),
        })?;

    let ok = if cfg.auth == "key" {
        let pem = crate::secret::read(app, secret_name(&cfg.id, "key")).await?.ok_or("Brak klucza prywatnego dla tego serwera. Wygeneruj albo wklej go w ustawieniach serwera.")?;
        let pass = crate::secret::read(app, secret_name(&cfg.id, "keypass")).await?.filter(|s| !s.is_empty());
        let key = russh::keys::decode_secret_key(&pem, pass.as_deref()).map_err(|e| format!("Nie można odczytać klucza: {e}"))?;
        let hash = handle.best_supported_rsa_hash().await.map_err(|e| e.to_string())?.flatten();
        handle.authenticate_publickey(&cfg.user, russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await.map_err(|e| e.to_string())?.success()
    } else {
        let pass = crate::secret::read(app, secret_name(&cfg.id, "pass")).await?.ok_or("Brak zapisanego hasła dla tego serwera.")?;
        handle.authenticate_password(&cfg.user, pass).await.map_err(|e| e.to_string())?.success()
    };
    if !ok {
        return Err(format!("Logowanie {}@{} nie powiodło się.", cfg.user, cfg.host));
    }
    Ok(handle)
}

#[tauri::command]
pub async fn ssh_hostkey_answer(state: State<'_, Arc<SshState>>, req_id: u32, ok: bool) -> Result<(), String> {
    answer(&state, req_id, ok).await;
    Ok(())
}

pub async fn answer(st: &SshState, req_id: u32, ok: bool) {
    if let Some(tx) = st.prompts.lock().await.remove(&req_id) {
        let _ = tx.send(ok);
    }
}

#[allow(dead_code)]
pub async fn send(st: &SshState, id: u32, data: &str) {
    if let Some(tx) = st.shells.lock().await.get(&id) {
        let _ = tx.send(ShellCmd::Data(data.as_bytes().to_vec()));
    }
}

/// Otwiera powłokę i od razu zwraca id; łączenie i logowanie idą w tle, a błąd przychodzi jako zdarzenie Exit.
#[tauri::command]
pub async fn ssh_shell(app: AppHandle, state: State<'_, Arc<SshState>>, host: HostCfg, cols: u32, rows: u32, on_event: Channel<ShellEvent>) -> Result<u32, String> {
    start_shell(app, state.inner().clone(), host, cols, rows, move |e| on_event.send(e).is_ok()).await
}

/// Rdzeń powłoki; `emit` zwraca false, gdy odbiorca zniknął (wtedy sesja się kończy).
pub async fn start_shell(app: AppHandle, st: Arc<SshState>, host: HostCfg, cols: u32, rows: u32, emit: impl Fn(ShellEvent) -> bool + Send + 'static) -> Result<u32, String> {
    if host.host.trim().is_empty() || host.user.trim().is_empty() {
        return Err("Uzupełnij adres i użytkownika".into());
    }
    let id = st.next.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, mut rx) = mpsc::unbounded_channel::<ShellCmd>();
    st.shells.lock().await.insert(id, tx);
    tauri::async_runtime::spawn(async move {
        let opened = async {
            let handle = connect(&app, &host).await?;
            let ch = handle.channel_open_session().await.map_err(|e| e.to_string())?;
            ch.request_pty(false, "xterm-256color", cols.max(10), rows.max(2), 0, 0, &[]).await.map_err(|e| e.to_string())?;
            ch.request_shell(false).await.map_err(|e| e.to_string())?;
            Ok::<_, String>((handle, ch))
        }
        .await;
        let (handle, mut ch) = match opened {
            Ok(v) => v,
            Err(e) => {
                st.shells.lock().await.remove(&id);
                emit(ShellEvent::Exit { code: None, error: Some(e) });
                return;
            }
        };
        let mut carry: Vec<u8> = Vec::new();
        let mut code: Option<u32> = None;
        loop {
            tokio::select! {
                msg = ch.wait() => match msg {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        carry.extend_from_slice(&data);
                        let valid = match std::str::from_utf8(&carry) {
                            Ok(_) => carry.len(),
                            Err(e) if e.error_len().is_none() => e.valid_up_to(),
                            Err(_) => carry.len(),
                        };
                        if valid > 0 {
                            let text = String::from_utf8_lossy(&carry[..valid]).into_owned();
                            carry.drain(..valid);
                            if !emit(ShellEvent::Data { data: text }) { break; }
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
                cmd = rx.recv() => match cmd {
                    Some(ShellCmd::Data(d)) => { if ch.data(&d[..]).await.is_err() { break; } }
                    Some(ShellCmd::Resize(c, r)) => { let _ = ch.window_change(c, r, 0, 0).await; }
                    Some(ShellCmd::Close) | None => { let _ = ch.close().await; break; }
                }
            }
        }
        let _ = handle.disconnect(Disconnect::ByApplication, "", "pl").await;
        st.shells.lock().await.remove(&id);
        emit(ShellEvent::Exit { code, error: None });
    });
    Ok(id)
}

#[tauri::command]
pub async fn ssh_write(state: State<'_, Arc<SshState>>, id: u32, data: String) -> Result<(), String> {
    let map = state.shells.lock().await;
    map.get(&id).ok_or("Sesja SSH jest zamknięta")?.send(ShellCmd::Data(data.into_bytes())).map_err(|_| "Sesja SSH jest zamknięta".to_string())
}

#[tauri::command]
pub async fn ssh_resize(state: State<'_, Arc<SshState>>, id: u32, cols: u32, rows: u32) -> Result<(), String> {
    if let Some(tx) = state.shells.lock().await.get(&id) {
        let _ = tx.send(ShellCmd::Resize(cols.max(10), rows.max(2)));
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_close(state: State<'_, Arc<SshState>>, id: u32) -> Result<(), String> {
    if let Some(tx) = state.shells.lock().await.remove(&id) {
        let _ = tx.send(ShellCmd::Close);
    }
    Ok(())
}

/// Generuje klucz ed25519 dla hosta, zapisuje go w sejfie i zwraca klucz publiczny do authorized_keys.
#[tauri::command]
pub async fn ssh_keygen(app: AppHandle, id: String, comment: String) -> Result<String, String> {
    let mut seed = [0u8; 32];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut seed).map_err(|_| "Brak źródła losowości".to_string())?;
    let pair = russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&seed);
    let mut key = PrivateKey::from(pair);
    key.set_comment(comment.chars().filter(|c| !c.is_control()).take(60).collect::<String>());
    let pem = key.to_openssh(russh::keys::ssh_key::LineEnding::LF).map_err(|e| e.to_string())?;
    let public = key.public_key().to_openssh().map_err(|e| e.to_string())?;
    crate::secret::write(&app, secret_name(&id, "key"), pem.to_string()).await?;
    crate::secret::write(&app, secret_name(&id, "keypass"), String::new()).await?;
    Ok(public)
}

/// Klucz publiczny z klucza zapisanego w sejfie (do ponownego skopiowania). None, gdy klucza nie ma.
#[tauri::command]
pub async fn ssh_pubkey(app: AppHandle, id: String) -> Result<Option<String>, String> {
    let Some(pem) = crate::secret::read(&app, secret_name(&id, "key")).await? else { return Ok(None) };
    let pass = crate::secret::read(&app, secret_name(&id, "keypass")).await?.filter(|s| !s.is_empty());
    let key = russh::keys::decode_secret_key(&pem, pass.as_deref()).map_err(|e| format!("Nie można odczytać klucza: {e}"))?;
    key.public_key().to_openssh().map(Some).map_err(|e| e.to_string())
}

/// Sprawdza wklejony klucz prywatny (i hasło do niego) i zapisuje go w sejfie.
#[tauri::command]
pub async fn ssh_import_key(app: AppHandle, id: String, pem: String, pass: String) -> Result<String, String> {
    let key = russh::keys::decode_secret_key(pem.trim(), if pass.is_empty() { None } else { Some(&pass) }).map_err(|e| format!("To nie jest poprawny klucz prywatny (albo złe hasło): {e}"))?;
    let public = key.public_key().to_openssh().map_err(|e| e.to_string())?;
    crate::secret::write(&app, secret_name(&id, "key"), format!("{}\n", pem.trim())).await?;
    crate::secret::write(&app, secret_name(&id, "keypass"), pass).await?;
    Ok(public)
}

/// Zapomina klucz serwera (np. po reinstalacji serwera); następne połączenie zapyta od nowa.
#[tauri::command]
pub async fn ssh_forget_hostkey(app: AppHandle, host: String, port: u16) -> Result<(), String> {
    let mut known = load_known(&app);
    known.remove(&format!("[{host}]:{port}"));
    save_known(&app, &known);
    Ok(())
}

#[derive(Serialize)]
pub struct ExecOut {
    pub code: Option<u32>,
    pub output: String,
    pub truncated: bool,
}

/// Jedna komenda bez interaktywnej powłoki (dla agenta AI). Wyjście łączone (stdout + stderr), ucięte do 60 kB.
#[tauri::command]
pub async fn ssh_exec(app: AppHandle, host: HostCfg, command: String, timeout_secs: Option<u64>) -> Result<ExecOut, String> {
    const MAX: usize = 60 * 1024;
    let handle = connect(&app, &host).await?;
    let mut ch = handle.channel_open_session().await.map_err(|e| e.to_string())?;
    ch.exec(true, command.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut out: Vec<u8> = Vec::new();
    let mut code = None;
    let mut truncated = false;
    let limit = Duration::from_secs(timeout_secs.unwrap_or(120).clamp(5, 900));
    let res = tokio::time::timeout(limit, async {
        while let Some(msg) = ch.wait().await {
            match msg {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    if out.len() < MAX { out.extend_from_slice(&data[..data.len().min(MAX - out.len())]); }
                    if out.len() >= MAX { truncated = true; }
                }
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                _ => {}
            }
        }
    })
    .await;
    let _ = handle.disconnect(Disconnect::ByApplication, "", "pl").await;
    let mut output = String::from_utf8_lossy(&out).into_owned();
    if res.is_err() {
        output.push_str(&format!("\n[przerwano po {} s]", limit.as_secs()));
    }
    Ok(ExecOut { code, output, truncated })
}
