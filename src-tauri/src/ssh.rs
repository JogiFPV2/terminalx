//! SSH: połączenia (russh), powłoki interaktywne, SFTP i przekierowania portów.
//! Hasła i hasła do kluczy są w magazynie systemowym; frontend przekazuje tylko odwołanie (keyRef).
//! Klucz hosta: przy pierwszym połączeniu pytamy użytkownika (TOFU), potem porównujemy z known_hosts.json.

use crate::pty::PtyEvent;
use russh::client::{self, Handle};
use russh::keys::{HashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
    pub key_path: Option<String>,
    /// Odwołanie do hasła albo hasła klucza w magazynie systemowym.
    pub secret_ref: Option<String>,
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

type RemoteTargets = Arc<StdMutex<HashMap<u32, (String, u16)>>>;

struct Client {
    app: AppHandle,
    host: String,
    port: u16,
    remote_targets: RemoteTargets,
}

fn known_hosts_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    crate::store::data_dir(app).ok().map(|d| d.join("known_hosts.json"))
}
fn load_known(app: &AppHandle) -> HashMap<String, String> {
    known_hosts_path(app).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}
fn save_known(app: &AppHandle, map: &HashMap<String, String>) {
    if let Some(p) = known_hosts_path(app) {
        let _ = std::fs::write(p, serde_json::to_string_pretty(map).unwrap_or_default());
    }
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
        // Nieznany albo zmieniony klucz: decyduje użytkownik.
        let state = self.app.state::<Arc<SshState>>();
        let req_id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        state.prompts.lock().await.insert(req_id, tx);
        let _ = self.app.emit("ssh:hostkey", HostKeyPrompt {
            req_id,
            host: self.host.clone(),
            port: self.port,
            fingerprint: fp.clone(),
            algorithm: pk.algorithm().to_string(),
            changed: known.contains_key(&id),
        });
        let ok = tokio::time::timeout(Duration::from_secs(300), rx).await.ok().and_then(|r| r.ok()).unwrap_or(false);
        if ok {
            let mut known = load_known(&self.app);
            known.insert(id, fp);
            save_known(&self.app, &known);
        }
        Ok(ok)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let target = self.remote_targets.lock().unwrap().get(&connected_port).cloned();
        match target {
            Some((host, port)) => {
                reply.accept().await;
                tokio::spawn(async move {
                    if let Ok(mut local) = tokio::net::TcpStream::connect((host.as_str(), port)).await {
                        let mut stream = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut local, &mut stream).await;
                    }
                });
            }
            None => drop(reply),
        }
        Ok(())
    }
}

struct Conn {
    handle: Arc<Handle<Client>>,
    sftp: Mutex<Option<Arc<SftpSession>>>,
    remote_targets: RemoteTargets,
    label: String,
}

enum ShellCmd {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

struct Forward {
    task: tokio::task::JoinHandle<()>,
    conn: String,
}

#[derive(Default)]
pub struct SshState {
    next: AtomicU32,
    conns: Mutex<HashMap<String, Arc<Conn>>>,
    shells: Mutex<HashMap<u32, mpsc::UnboundedSender<ShellCmd>>>,
    prompts: Mutex<HashMap<u32, oneshot::Sender<bool>>>,
    forwards: Mutex<HashMap<String, Forward>>,
}

fn secret(r: &Option<String>) -> Option<String> {
    let r = r.as_deref().filter(|s| !s.is_empty())?;
    keyring::Entry::new("TerminalX", r).ok()?.get_password().ok()
}

fn expand_home(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~") {
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            return format!("{}{}", home.to_string_lossy(), rest);
        }
    }
    p.to_string()
}

/// Połączenie jest współdzielone przez powłoki, SFTP i przekierowania tego samego hosta.
async fn connect(app: &AppHandle, state: &SshState, cfg: &HostCfg) -> Result<Arc<Conn>, String> {
    if let Some(c) = state.conns.lock().await.get(&cfg.id) {
        if !c.handle.is_closed() {
            return Ok(c.clone());
        }
    }
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 4,
        ..Default::default()
    });
    let remote_targets: RemoteTargets = Default::default();
    let handler = Client { app: app.clone(), host: cfg.host.clone(), port: cfg.port, remote_targets: remote_targets.clone() };
    let mut handle = tokio::time::timeout(Duration::from_secs(20), client::connect(config, (cfg.host.as_str(), cfg.port), handler))
        .await
        .map_err(|_| format!("Przekroczono czas łączenia z {}:{}", cfg.host, cfg.port))?
        .map_err(|e| match e {
            russh::Error::UnknownKey => "Odrzucono klucz hosta.".to_string(),
            other => format!("Nie udało się połączyć z {}:{}: {other}", cfg.host, cfg.port),
        })?;

    let ok = if cfg.auth == "agent" {
        agent_auth(&mut handle, &cfg.user).await?
    } else if cfg.auth == "key" {
        let path = expand_home(cfg.key_path.as_deref().unwrap_or("~/.ssh/id_ed25519"));
        let pass = secret(&cfg.secret_ref);
        let key = russh::keys::load_secret_key(&path, pass.as_deref()).map_err(|e| format!("Nie można wczytać klucza {path}: {e}"))?;
        let hash = handle.best_supported_rsa_hash().await.map_err(|e| e.to_string())?.flatten();
        handle
            .authenticate_publickey(&cfg.user, russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await
            .map_err(|e| e.to_string())?
            .success()
    } else {
        let pass = secret(&cfg.secret_ref).ok_or("Brak zapisanego hasła dla tego hosta. Uzupełnij je w Vault.")?;
        handle.authenticate_password(&cfg.user, pass).await.map_err(|e| e.to_string())?.success()
    };
    if !ok {
        return Err(format!("Uwierzytelnienie {}@{} nie powiodło się.", cfg.user, cfg.host));
    }
    let conn = Arc::new(Conn { handle: Arc::new(handle), sftp: Mutex::new(None), remote_targets, label: format!("{}@{}", cfg.user, cfg.host) });
    state.conns.lock().await.insert(cfg.id.clone(), conn.clone());
    Ok(conn)
}

#[tauri::command]
pub async fn ssh_hostkey_answer(state: State<'_, Arc<SshState>>, req_id: u32, ok: bool) -> Result<(), String> {
    if let Some(tx) = state.prompts.lock().await.remove(&req_id) {
        let _ = tx.send(ok);
    }
    Ok(())
}

/// Otwiera interaktywną powłokę. Zdarzenia mają ten sam format co lokalne PTY.
#[tauri::command]
pub async fn ssh_shell(app: AppHandle, state: State<'_, Arc<SshState>>, host: HostCfg, cols: u32, rows: u32, on_event: Channel<PtyEvent>) -> Result<u32, String> {
    let conn = connect(&app, &state, &host).await?;
    let mut ch = conn.handle.channel_open_session().await.map_err(|e| e.to_string())?;
    ch.request_pty(false, "xterm-256color", cols.max(10), rows.max(2), 0, 0, &[]).await.map_err(|e| e.to_string())?;
    ch.request_shell(false).await.map_err(|e| e.to_string())?;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, mut rx) = mpsc::unbounded_channel::<ShellCmd>();
    state.shells.lock().await.insert(id, tx);
    let st = state.inner().clone();
    tokio::spawn(async move {
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
                            if on_event.send(PtyEvent::Data { data: text }).is_err() { break; }
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
                cmd = rx.recv() => match cmd {
                    Some(ShellCmd::Data(d)) => { if ch.data_bytes(d).await.is_err() { break; } }
                    Some(ShellCmd::Resize(c, r)) => { let _ = ch.window_change(c, r, 0, 0).await; }
                    Some(ShellCmd::Close) | None => { let _ = ch.close().await; break; }
                }
            }
        }
        st.shells.lock().await.remove(&id);
        let _ = on_event.send(PtyEvent::Exit { code });
    });
    Ok(id)
}

#[tauri::command]
pub async fn ssh_write(state: State<'_, Arc<SshState>>, id: u32, data: String) -> Result<(), String> {
    let map = state.shells.lock().await;
    map.get(&id).ok_or("Sesja SSH nie istnieje")?.send(ShellCmd::Data(data.into_bytes())).map_err(|_| "Sesja SSH zakończona".to_string())
}

#[tauri::command]
pub async fn ssh_resize(state: State<'_, Arc<SshState>>, id: u32, cols: u32, rows: u32) -> Result<(), String> {
    if let Some(tx) = state.shells.lock().await.get(&id) {
        let _ = tx.send(ShellCmd::Resize(cols, rows));
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

/// Rozłącza host (wszystkie powłoki, SFTP i przekierowania tego hosta).
#[tauri::command]
pub async fn ssh_disconnect(state: State<'_, Arc<SshState>>, host_id: String) -> Result<(), String> {
    let mut fw = state.forwards.lock().await;
    let ids: Vec<String> = fw.iter().filter(|(_, f)| f.conn == host_id).map(|(k, _)| k.clone()).collect();
    for id in ids { if let Some(f) = fw.remove(&id) { f.task.abort(); } }
    drop(fw);
    if let Some(c) = state.conns.lock().await.remove(&host_id) {
        let _ = c.handle.disconnect(Disconnect::ByApplication, "", "pl").await;
    }
    Ok(())
}

/// Logowanie kluczami z agenta SSH: w Windows agent OpenSSH (usługa ssh-agent) albo Pageant,
/// w Linux i macOS gniazdo z SSH_AUTH_SOCK. Klucze prywatne nie opuszczają agenta.
async fn agent_auth(handle: &mut client::Handle<Client>, user: &str) -> Result<bool, String> {
    #[cfg(windows)]
    {
        use russh::keys::agent::client::AgentClient;
        if let Ok(a) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            if try_agent(handle, user, a).await? {
                return Ok(true);
            }
        }
        match AgentClient::connect_pageant().await {
            Ok(a) => try_agent(handle, user, a).await,
            Err(_) => Err("Nie znaleziono agenta SSH. Uruchom usługę „OpenSSH Authentication Agent” (ssh-add) albo Pageant.".into()),
        }
    }
    #[cfg(not(windows))]
    {
        let a = russh::keys::agent::client::AgentClient::connect_env().await.map_err(|_| "Nie znaleziono agenta SSH (zmienna SSH_AUTH_SOCK).".to_string())?;
        try_agent(handle, user, a).await
    }
}

async fn try_agent<S>(handle: &mut client::Handle<Client>, user: &str, mut agent: russh::keys::agent::client::AgentClient<S>) -> Result<bool, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let ids = agent.request_identities().await.map_err(|e| format!("Agent SSH: {e}"))?;
    if ids.is_empty() {
        return Err("Agent SSH nie ma żadnych kluczy (dodaj je poleceniem ssh-add).".into());
    }
    let hash = handle.best_supported_rsa_hash().await.map_err(|e| e.to_string())?.flatten();
    for id in ids {
        let key = id.public_key().into_owned();
        if let Ok(r) = handle.authenticate_publickey_with(user, key, hash, &mut agent).await {
            if r.success() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Jedna komenda bez PTY (np. wykrycie dystrybucji z /etc/os-release).
#[tauri::command]
pub async fn ssh_exec(app: AppHandle, state: State<'_, Arc<SshState>>, host: HostCfg, command: String) -> Result<crate::sys::ExecOut, String> {
    let conn = connect(&app, &state, &host).await?;
    let mut ch = conn.handle.channel_open_session().await.map_err(|e| e.to_string())?;
    ch.exec(true, command).await.map_err(|e| e.to_string())?;
    let (mut out, mut err, mut code) = (Vec::new(), Vec::new(), -1i32);
    let fut = async {
        while let Some(msg) = ch.wait().await {
            match msg {
                ChannelMsg::Data { data } => out.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => err.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => code = exit_status as i32,
                ChannelMsg::Close => break,
                _ => {}
            }
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(60), fut).await;
    Ok(crate::sys::ExecOut { code, stdout: String::from_utf8_lossy(&out).into_owned(), stderr: String::from_utf8_lossy(&err).into_owned() })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnInfo { host_id: String, label: String }

#[tauri::command]
pub async fn ssh_connections(state: State<'_, Arc<SshState>>) -> Result<Vec<ConnInfo>, String> {
    Ok(state.conns.lock().await.iter().filter(|(_, c)| !c.handle.is_closed()).map(|(k, c)| ConnInfo { host_id: k.clone(), label: c.label.clone() }).collect())
}

/* ---------- SFTP ---------- */

async fn sftp(app: &AppHandle, state: &SshState, host: &HostCfg) -> Result<Arc<SftpSession>, String> {
    let conn = connect(app, state, host).await?;
    let mut guard = conn.sftp.lock().await;
    if let Some(s) = guard.as_ref() {
        return Ok(s.clone());
    }
    let ch = conn.handle.channel_open_session().await.map_err(|e| e.to_string())?;
    ch.request_subsystem(true, "sftp").await.map_err(|e| e.to_string())?;
    let s = Arc::new(SftpSession::new(ch.into_stream()).await.map_err(|e| format!("SFTP: {e}"))?);
    *guard = Some(s.clone());
    Ok(s)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry { name: String, path: String, is_dir: bool, size: u64, modified: u64 }

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}

#[tauri::command]
pub async fn sftp_list(app: AppHandle, state: State<'_, Arc<SshState>>, host: HostCfg, path: String) -> Result<(String, Vec<Entry>), String> {
    let s = sftp(&app, &state, &host).await?;
    let dir = s.canonicalize(if path.is_empty() { ".".to_string() } else { path }).await.map_err(|e| e.to_string())?;
    let mut out: Vec<Entry> = s.read_dir(dir.clone()).await.map_err(|e| e.to_string())?
        .map(|e| {
            let m = e.metadata();
            Entry { name: e.file_name(), path: join(&dir, &e.file_name()), is_dir: m.is_dir(), size: m.size.unwrap_or(0), modified: m.mtime.unwrap_or(0) as u64 * 1000 }
        })
        .filter(|e| e.name != "." && e.name != "..")
        .collect();
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok((dir, out))
}

#[tauri::command]
pub async fn sftp_op(app: AppHandle, state: State<'_, Arc<SshState>>, host: HostCfg, op: String, path: String, to: Option<String>) -> Result<(), String> {
    let s = sftp(&app, &state, &host).await?;
    let r = match op.as_str() {
        "mkdir" => s.create_dir(path).await,
        "rmdir" => return remove_tree(&s, &path).await,
        "rm" => s.remove_file(path).await,
        "rename" => s.rename(path, to.ok_or("Brak nowej nazwy")?).await,
        other => return Err(format!("Nieznana operacja {other}")),
    };
    r.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_read_text(app: AppHandle, state: State<'_, Arc<SshState>>, host: HostCfg, path: String) -> Result<String, String> {
    let s = sftp(&app, &state, &host).await?;
    let meta = s.metadata(path.clone()).await.map_err(|e| e.to_string())?;
    if meta.size.unwrap_or(0) > 5 * 1024 * 1024 {
        return Err("Plik jest większy niż 5 MB; pobierz go zamiast edytować.".into());
    }
    let bytes = s.read(path).await.map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "To nie jest plik tekstowy UTF-8.".to_string())
}

#[tauri::command]
pub async fn sftp_write_text(app: AppHandle, state: State<'_, Arc<SshState>>, host: HostCfg, path: String, data: String) -> Result<(), String> {
    let s = sftp(&app, &state, &host).await?;
    let mut f = s.create(path).await.map_err(|e| e.to_string())?;
    f.write_all(data.as_bytes()).await.map_err(|e| e.to_string())?;
    f.shutdown().await.map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress { id: String, done: u64, total: u64 }

/// Lista plików do przeniesienia: (ścieżka źródłowa, ścieżka docelowa, rozmiar). Foldery są tworzone po drodze.
async fn plan_download(s: &SftpSession, remote: &str, local: &std::path::Path, out: &mut Vec<(String, std::path::PathBuf, u64)>) -> Result<(), String> {
    let meta = s.metadata(remote.to_string()).await.map_err(|e| format!("{remote}: {e}"))?;
    if !meta.is_dir() {
        out.push((remote.to_string(), local.to_path_buf(), meta.size.unwrap_or(0)));
        return Ok(());
    }
    tokio::fs::create_dir_all(local).await.map_err(|e| format!("{}: {e}", local.display()))?;
    for e in s.read_dir(remote.to_string()).await.map_err(|e| e.to_string())? {
        let name = e.file_name();
        if name == "." || name == ".." || name.contains(['/', '\\']) {
            continue;
        }
        Box::pin(plan_download(s, &join(remote, &name), &local.join(&name), out)).await?;
    }
    Ok(())
}

async fn plan_upload(s: &SftpSession, local: &std::path::Path, remote: &str, out: &mut Vec<(String, std::path::PathBuf, u64)>) -> Result<(), String> {
    let meta = tokio::fs::metadata(local).await.map_err(|e| format!("{}: {e}", local.display()))?;
    if !meta.is_dir() {
        out.push((remote.to_string(), local.to_path_buf(), meta.len()));
        return Ok(());
    }
    if s.metadata(remote.to_string()).await.is_err() {
        s.create_dir(remote.to_string()).await.map_err(|e| format!("{remote}: {e}"))?;
    }
    let mut rd = tokio::fs::read_dir(local).await.map_err(|e| e.to_string())?;
    while let Some(e) = rd.next_entry().await.map_err(|e| e.to_string())? {
        let name = e.file_name().to_string_lossy().into_owned();
        Box::pin(plan_upload(s, &e.path(), &join(remote, &name), out)).await?;
    }
    Ok(())
}

/// Pobiera albo wysyła plik lub cały folder strumieniowo, z łącznym postępem w zdarzeniu `sftp:progress`.
#[tauri::command]
pub async fn sftp_transfer(app: AppHandle, state: State<'_, Arc<SshState>>, host: HostCfg, id: String, direction: String, remote: String, local: String) -> Result<(), String> {
    let s = sftp(&app, &state, &host).await?;
    let down = direction == "download";
    let mut files = Vec::new();
    if down {
        plan_download(&s, &remote, std::path::Path::new(&local), &mut files).await?;
    } else {
        plan_upload(&s, std::path::Path::new(&local), &remote, &mut files).await?;
    }
    let total: u64 = files.iter().map(|f| f.2).sum();
    let mut buf = vec![0u8; 256 * 1024];
    let mut done = 0u64;
    let mut last = std::time::Instant::now();
    for (rpath, lpath, _) in files {
        if down {
            let mut src = s.open(rpath).await.map_err(|e| e.to_string())?;
            let mut dst = tokio::fs::File::create(&lpath).await.map_err(|e| format!("{}: {e}", lpath.display()))?;
            loop {
                let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
                if n == 0 { break; }
                dst.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
                done += n as u64;
                if last.elapsed() > Duration::from_millis(200) { last = std::time::Instant::now(); let _ = app.emit("sftp:progress", Progress { id: id.clone(), done, total }); }
            }
            dst.flush().await.map_err(|e| e.to_string())?;
        } else {
            let mut src = tokio::fs::File::open(&lpath).await.map_err(|e| e.to_string())?;
            let mut dst = s.create(rpath).await.map_err(|e| e.to_string())?;
            loop {
                let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
                if n == 0 { break; }
                dst.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
                done += n as u64;
                if last.elapsed() > Duration::from_millis(200) { last = std::time::Instant::now(); let _ = app.emit("sftp:progress", Progress { id: id.clone(), done, total }); }
            }
            dst.shutdown().await.map_err(|e| e.to_string())?;
        }
    }
    let _ = app.emit("sftp:progress", Progress { id, done, total });
    Ok(())
}

/// Usuwa folder razem z zawartością.
async fn remove_tree(s: &SftpSession, path: &str) -> Result<(), String> {
    for e in s.read_dir(path.to_string()).await.map_err(|e| e.to_string())? {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let p = join(path, &name);
        if e.metadata().is_dir() {
            Box::pin(remove_tree(s, &p)).await?;
        } else {
            s.remove_file(p).await.map_err(|e| e.to_string())?;
        }
    }
    s.remove_dir(path.to_string()).await.map_err(|e| e.to_string())
}

/* ---------- port forwarding ---------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardCfg {
    /// "local" | "remote" | "dynamic"
    kind: String,
    bind_port: u16,
    target_host: Option<String>,
    target_port: Option<u16>,
}

async fn socks5(mut s: tokio::net::TcpStream) -> std::io::Result<(tokio::net::TcpStream, String, u16)> {
    let mut head = [0u8; 2];
    s.read_exact(&mut head).await?;
    let mut methods = vec![0u8; head[1] as usize];
    s.read_exact(&mut methods).await?;
    s.write_all(&[5, 0]).await?; // bez uwierzytelnienia (nasłuch tylko na 127.0.0.1)
    let mut req = [0u8; 4];
    s.read_exact(&mut req).await?;
    if req[1] != 1 {
        s.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        return Err(std::io::Error::other("tylko CONNECT"));
    }
    let host = match req[3] {
        1 => { let mut a = [0u8; 4]; s.read_exact(&mut a).await?; std::net::Ipv4Addr::from(a).to_string() }
        3 => { let mut l = [0u8; 1]; s.read_exact(&mut l).await?; let mut d = vec![0u8; l[0] as usize]; s.read_exact(&mut d).await?; String::from_utf8_lossy(&d).into_owned() }
        4 => { let mut a = [0u8; 16]; s.read_exact(&mut a).await?; std::net::Ipv6Addr::from(a).to_string() }
        _ => return Err(std::io::Error::other("zły adres")),
    };
    let mut p = [0u8; 2];
    s.read_exact(&mut p).await?;
    Ok((s, host, u16::from_be_bytes(p)))
}

/// Uruchamia przekierowanie i zwraca jego id. Nasłuch lokalny zawsze na 127.0.0.1.
#[tauri::command]
pub async fn ssh_forward_start(app: AppHandle, state: State<'_, Arc<SshState>>, host: HostCfg, fwd: ForwardCfg) -> Result<String, String> {
    let conn = connect(&app, &state, &host).await?;
    let fid = format!("{}:{}:{}", host.id, fwd.kind, fwd.bind_port);
    if state.forwards.lock().await.contains_key(&fid) {
        return Ok(fid);
    }
    let task = match fwd.kind.as_str() {
        "remote" => {
            let th = fwd.target_host.clone().unwrap_or_else(|| "127.0.0.1".into());
            let tp = fwd.target_port.ok_or("Brak portu docelowego")?;
            conn.remote_targets.lock().unwrap().insert(fwd.bind_port as u32, (th, tp));
            conn.handle.tcpip_forward("127.0.0.1", fwd.bind_port as u32).await.map_err(|e| format!("Serwer odrzucił przekierowanie: {e}"))?;
            tokio::spawn(async {})
        }
        kind => {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", fwd.bind_port)).await.map_err(|e| format!("Port {} jest zajęty: {e}", fwd.bind_port))?;
            let dynamic = kind == "dynamic";
            let (th, tp) = (fwd.target_host.clone().unwrap_or_default(), fwd.target_port.unwrap_or(0));
            if !dynamic && (th.is_empty() || tp == 0) {
                return Err("Podaj host i port docelowy".into());
            }
            let handle = conn.handle.clone();
            tokio::spawn(async move {
                while let Ok((sock, peer)) = listener.accept().await {
                    let handle = handle.clone();
                    let (th, tp) = (th.clone(), tp);
                    tokio::spawn(async move {
                        let (mut sock, host, port) = if dynamic {
                            match socks5(sock).await { Ok(x) => x, Err(_) => return }
                        } else { (sock, th, tp) };
                        match handle.channel_open_direct_tcpip(host, port as u32, peer.ip().to_string(), peer.port() as u32).await {
                            Ok(ch) => {
                                if dynamic { let _ = sock.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await; }
                                let mut stream = ch.into_stream();
                                let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
                            }
                            Err(_) => { if dynamic { let _ = sock.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await; } }
                        }
                    });
                }
            })
        }
    };
    state.forwards.lock().await.insert(fid.clone(), Forward { task, conn: host.id.clone() });
    Ok(fid)
}

#[tauri::command]
pub async fn ssh_forward_stop(state: State<'_, Arc<SshState>>, id: String) -> Result<(), String> {
    if let Some(f) = state.forwards.lock().await.remove(&id) {
        f.task.abort();
        let parts: Vec<&str> = id.rsplitn(3, ':').collect();
        if parts.len() == 3 && parts[1] == "remote" {
            if let (Some(c), Ok(port)) = (state.conns.lock().await.get(parts[2]).cloned(), parts[0].parse::<u32>()) {
                let _ = c.handle.cancel_tcpip_forward("127.0.0.1", port).await;
                c.remote_targets.lock().unwrap().remove(&port);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_forwards(state: State<'_, Arc<SshState>>) -> Result<Vec<String>, String> {
    Ok(state.forwards.lock().await.keys().cloned().collect())
}
