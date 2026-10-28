//! Zdalny dostęp z telefonu: serwer HTTP + WebSocket w sieci lokalnej albo Tailscale.
//! Każda wiadomość po powitaniu jest szyfrowana kluczem urządzenia (NaCl secretbox, XSalsa20-Poly1305),
//! więc nawet bez TLS treść jest nieczytelna w sieci. Klucz trafia na telefon wyłącznie przez kod QR
//! (w części `#…` adresu, której przeglądarka nie wysyła do serwera). Nowe urządzenie wymaga zgody na komputerze.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State as AxState};
use axum::http::header;
use axum::response::{Html, IntoResponse};
use axum::routing::get;
use axum::Router;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use crypto_secretbox::aead::{Aead, KeyInit};
use crypto_secretbox::{Key, Nonce, XSalsa20Poly1305};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, oneshot, Mutex};

const INDEX: &str = include_str!("../remote/index.html");
const XTERM_JS: &str = include_str!("../../node_modules/@xterm/xterm/lib/xterm.js");
const XTERM_CSS: &str = include_str!("../../node_modules/@xterm/xterm/css/xterm.css");
const FIT_JS: &str = include_str!("../../node_modules/@xterm/addon-fit/lib/addon-fit.js");
const NACL_JS: &str = include_str!("../../node_modules/tweetnacl/nacl-fast.min.js");

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    id: String,
    name: String,
    perm: String,
    added: u64,
    last_seen: Option<u64>,
}

struct Running {
    shutdown: oneshot::Sender<()>,
    port: u16,
    addrs: Vec<String>,
    mode: String,
}

struct Pending {
    key: [u8; 32],
    expires: Instant,
}

struct Client {
    device: String,
    tx: mpsc::UnboundedSender<String>,
}

#[derive(Default)]
pub struct RemoteState {
    running: Mutex<Option<Running>>,
    pairs: Mutex<HashMap<String, Pending>>,
    decisions: Mutex<HashMap<String, oneshot::Sender<Option<String>>>>,
    conns: Mutex<HashMap<u64, Client>>,
    next: AtomicU64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn rand_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b
}

/* ---------- devices (metadata in a file, keys in the system vault) ---------- */

fn devices_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    crate::store::data_dir(app).ok().map(|d| d.join("remote-devices.json"))
}
fn load_devices(app: &AppHandle) -> Vec<Device> {
    devices_path(app).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}
fn save_devices(app: &AppHandle, list: &[Device]) {
    if let Some(p) = devices_path(app) {
        let _ = std::fs::write(p, serde_json::to_string_pretty(list).unwrap_or_default());
    }
}
fn key_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("TerminalX", &format!("remote-device:{id}")).map_err(|e| e.to_string())
}

/* ---------- crypto ---------- */

fn seal(key: &[u8; 32], plain: &str) -> String {
    let cipher = XSalsa20Poly1305::new(Key::from_slice(key));
    let nonce = rand_bytes::<24>();
    let ct = cipher.encrypt(Nonce::from_slice(&nonce), plain.as_bytes()).unwrap_or_default();
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    STANDARD.encode(out)
}
fn open(key: &[u8; 32], frame: &str) -> Option<String> {
    let raw = STANDARD.decode(frame.trim()).ok()?;
    if raw.len() < 24 + 16 {
        return None;
    }
    let cipher = XSalsa20Poly1305::new(Key::from_slice(key));
    let pt = cipher.decrypt(Nonce::from_slice(&raw[..24]), &raw[24..]).ok()?;
    String::from_utf8(pt).ok()
}

/* ---------- addresses ---------- */

fn is_private(ip: &std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 10 || (o[0] == 172 && (16..=31).contains(&o[1])) || (o[0] == 192 && o[1] == 168)
}
fn is_tailscale(ip: &std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (64..=127).contains(&o[1])
}
fn addresses(mode: &str) -> Vec<IpAddr> {
    let mut out = Vec::new();
    for iface in if_addrs::get_if_addrs().unwrap_or_default() {
        if let IpAddr::V4(v4) = iface.ip() {
            if iface.is_loopback() { continue; }
            if (mode == "tailscale" && is_tailscale(&v4)) || (mode != "tailscale" && is_private(&v4)) {
                out.push(IpAddr::V4(v4));
            }
        }
    }
    out
}

/* ---------- permissions ---------- */

fn level(perm: &str) -> u8 {
    match perm { "full" => 3, "control" => 2, _ => 1 }
}
fn needed(method: &str) -> u8 {
    match method {
        "state" | "tail" | "subscribe" | "unsubscribe" | "chat" | "ping" => 1,
        "write" | "resize" | "approve" | "park" | "unpark" | "focus" => 2,
        _ => 3, // agent, newTab, closeTab, runFlow i wszystko nowe
    }
}

/* ---------- HTTP ---------- */

async fn asset(path: &'static str, body: &'static str) -> impl IntoResponse {
    let ct = if path.ends_with(".css") { "text/css; charset=utf-8" } else { "application/javascript; charset=utf-8" };
    ([(header::CONTENT_TYPE, ct), (header::CACHE_CONTROL, "max-age=3600")], body)
}

async fn ws_upgrade(ws: WebSocketUpgrade, ConnectInfo(addr): ConnectInfo<SocketAddr>, AxState(app): AxState<AppHandle>) -> impl IntoResponse {
    ws.max_message_size(4 * 1024 * 1024).on_upgrade(move |socket| async move {
        if let Err(e) = session(app, socket, addr).await {
            eprintln!("remote session: {e}");
        }
    })
}

async fn recv_text(ws: &mut WebSocket) -> Option<String> {
    loop {
        match tokio::time::timeout(Duration::from_secs(60), ws.recv()).await.ok()?? {
            Ok(Message::Text(t)) => return Some(t.to_string()),
            Ok(Message::Close(_)) | Err(_) => return None,
            _ => continue,
        }
    }
}

async fn session(app: AppHandle, mut ws: WebSocket, addr: SocketAddr) -> Result<(), String> {
    use tauri::Manager;
    let state = app.state::<Arc<RemoteState>>();
    let hello: Value = serde_json::from_str(&recv_text(&mut ws).await.ok_or("brak powitania")?).map_err(|e| e.to_string())?;

    // 1. Klucz: znane urządzenie albo jednorazowe parowanie z kodu QR.
    let (key, mut device_id, pairing) = match hello["t"].as_str() {
        Some("hello") => {
            let id = hello["device"].as_str().unwrap_or("").to_string();
            let known = load_devices(&app).into_iter().any(|d| d.id == id);
            let k = if known { key_entry(&id).ok().and_then(|e| e.get_password().ok()) } else { None };
            match k.and_then(|k| STANDARD.decode(k).ok()).and_then(|v| <[u8; 32]>::try_from(v).ok()) {
                Some(k) => (k, id, None),
                None => {
                    let _ = ws.send(Message::Text(json!({"t":"error","msg":"Nieznane urządzenie. Sparuj telefon ponownie."}).to_string().into())).await;
                    return Ok(());
                }
            }
        }
        Some("pair") => {
            let pid = hello["pair"].as_str().unwrap_or("").to_string();
            let p = state.pairs.lock().await.remove(&pid);
            match p.filter(|p| p.expires > Instant::now()) {
                Some(p) => (p.key, String::new(), Some((pid, hello["name"].as_str().unwrap_or("Telefon").chars().take(40).collect::<String>()))),
                None => {
                    let _ = ws.send(Message::Text(json!({"t":"error","msg":"Kod parowania wygasł albo został już użyty. Wygeneruj nowy na komputerze."}).to_string().into())).await;
                    return Ok(());
                }
            }
        }
        _ => return Err("nieznane powitanie".into()),
    };

    // 2. Dowód posiadania klucza: pierwsza zaszyfrowana wiadomość musi się poprawnie odszyfrować.
    let proof = recv_text(&mut ws).await.and_then(|f| open(&key, &f)).ok_or("zły klucz")?;
    if serde_json::from_str::<Value>(&proof).ok().and_then(|v| v["t"].as_str().map(String::from)).as_deref() != Some("auth") {
        return Err("brak uwierzytelnienia".into());
    }

    // 3. Nowe urządzenie: decyzja użytkownika na komputerze.
    if let Some((pid, name)) = pairing {
        let (tx, rx) = oneshot::channel();
        state.decisions.lock().await.insert(pid.clone(), tx);
        let _ = app.emit("remote:pair-request", json!({ "pairId": pid, "name": name, "addr": addr.ip().to_string() }));
        let _ = ws.send(Message::Text(seal(&key, &json!({"t":"waiting"}).to_string()).into())).await;
        let decision = tokio::time::timeout(Duration::from_secs(180), rx).await.ok().and_then(|r| r.ok()).flatten();
        state.decisions.lock().await.remove(&pid);
        let Some(perm) = decision else {
            let _ = ws.send(Message::Text(seal(&key, &json!({"t":"denied"}).to_string()).into())).await;
            return Ok(());
        };
        device_id = URL_SAFE_NO_PAD.encode(rand_bytes::<12>());
        key_entry(&device_id)?.set_password(&STANDARD.encode(key)).map_err(|e| e.to_string())?;
        let mut list = load_devices(&app);
        list.push(Device { id: device_id.clone(), name, perm, added: now_ms(), last_seen: Some(now_ms()) });
        save_devices(&app, &list);
        let _ = app.emit("remote:devices", ());
        ws.send(Message::Text(seal(&key, &json!({"t":"paired","device":device_id}).to_string()).into())).await.map_err(|e| e.to_string())?;
    }

    // 4. Sesja: żądania telefonu idą do interfejsu aplikacji, odpowiedzi i zdarzenia wracają zaszyfrowane.
    let conn = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    state.conns.lock().await.insert(conn, Client { device: device_id.clone(), tx });
    let perm_of = |app: &AppHandle, id: &str| load_devices(app).into_iter().find(|d| d.id == id).map(|d| d.perm).unwrap_or_else(|| "view".into());
    let _ = ws.send(Message::Text(seal(&key, &json!({"t":"ready","perm":perm_of(&app, &device_id),"device":device_id}).to_string()).into())).await;
    let _ = app.emit("remote:clients", ());

    let result: Result<(), String> = async {
        loop {
            tokio::select! {
                msg = ws.recv() => {
                    let text = match msg {
                        Some(Ok(Message::Text(t))) => t.to_string(),
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                        _ => continue,
                    };
                    let Some(plain) = open(&key, &text) else { break };
                    let req: Value = serde_json::from_str(&plain).map_err(|e| e.to_string())?;
                    if req["t"] != "req" { continue; }
                    let method = req["m"].as_str().unwrap_or("").to_string();
                    let perm = perm_of(&app, &device_id);
                    if perm == "revoked" { break; }
                    if level(&perm) < needed(&method) {
                        let res = json!({"t":"res","id":req["id"],"ok":false,"error":"To urządzenie nie ma uprawnień do tej operacji."});
                        ws.send(Message::Text(seal(&key, &res.to_string()).into())).await.map_err(|e| e.to_string())?;
                        continue;
                    }
                    let _ = app.emit("remote:req", json!({"conn": conn, "device": device_id, "perm": perm, "id": req["id"], "m": method, "p": req["p"]}));
                }
                out = rx.recv() => match out {
                    Some(plain) => ws.send(Message::Text(seal(&key, &plain).into())).await.map_err(|e| e.to_string())?,
                    None => break,
                }
            }
        }
        Ok(())
    }.await;

    state.conns.lock().await.remove(&conn);
    let mut list = load_devices(&app);
    if let Some(d) = list.iter_mut().find(|d| d.id == device_id) { d.last_seen = Some(now_ms()); }
    save_devices(&app, &list);
    let _ = app.emit("remote:clients", ());
    let _ = app.emit("remote:closed", json!({ "conn": conn }));
    result
}

/* ---------- commands ---------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status { running: bool, port: u16, mode: String, addrs: Vec<String>, clients: Vec<(u64, String)> }

#[tauri::command]
pub async fn remote_start(app: AppHandle, state: State<'_, Arc<RemoteState>>, port: u16, mode: String) -> Result<Vec<String>, String> {
    let mut running = state.running.lock().await;
    if let Some(r) = running.take() { let _ = r.shutdown.send(()); }
    let ips = addresses(&mode);
    let bind: IpAddr = if mode == "tailscale" {
        *ips.first().ok_or("Nie znaleziono adresu Tailscale (100.x.x.x). Uruchom Tailscale na tym komputerze.")?
    } else {
        IpAddr::from([0, 0, 0, 0])
    };
    let listener = tokio::net::TcpListener::bind((bind, port)).await.map_err(|e| format!("Nie można nasłuchiwać na porcie {port}: {e}"))?;
    let router = Router::new()
        .route("/", get(|| async { Html(INDEX) }))
        .route("/xterm.js", get(|| asset("xterm.js", XTERM_JS)))
        .route("/xterm.css", get(|| asset("xterm.css", XTERM_CSS)))
        .route("/fit.js", get(|| asset("fit.js", FIT_JS)))
        .route("/nacl.js", get(|| asset("nacl.js", NACL_JS)))
        .route("/ws", get(ws_upgrade))
        .with_state(app.clone());
    let (tx, rx) = oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
            .with_graceful_shutdown(async { let _ = rx.await; })
            .await;
    });
    let addrs: Vec<String> = ips.iter().map(|ip| format!("http://{ip}:{port}")).collect();
    *running = Some(Running { shutdown: tx, port, addrs: addrs.clone(), mode });
    Ok(addrs)
}

#[tauri::command]
pub async fn remote_stop(state: State<'_, Arc<RemoteState>>) -> Result<(), String> {
    if let Some(r) = state.running.lock().await.take() { let _ = r.shutdown.send(()); }
    state.conns.lock().await.clear();
    Ok(())
}

#[tauri::command]
pub async fn remote_status(state: State<'_, Arc<RemoteState>>) -> Result<Status, String> {
    let r = state.running.lock().await;
    let clients = state.conns.lock().await.iter().map(|(k, c)| (*k, c.device.clone())).collect();
    Ok(match r.as_ref() {
        Some(r) => Status { running: true, port: r.port, mode: r.mode.clone(), addrs: r.addrs.clone(), clients },
        None => Status { running: false, port: 0, mode: String::new(), addrs: vec![], clients },
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairInfo { pair_id: String, key: String, urls: Vec<String>, expires_in: u64 }

#[tauri::command]
pub async fn remote_pair_begin(state: State<'_, Arc<RemoteState>>) -> Result<PairInfo, String> {
    let addrs = state.running.lock().await.as_ref().map(|r| r.addrs.clone()).ok_or("Najpierw włącz zdalny dostęp.")?;
    let pair_id = URL_SAFE_NO_PAD.encode(rand_bytes::<12>());
    let key = rand_bytes::<32>();
    let mut pairs = state.pairs.lock().await;
    pairs.retain(|_, p| p.expires > Instant::now());
    pairs.insert(pair_id.clone(), Pending { key, expires: Instant::now() + Duration::from_secs(300) });
    let k = URL_SAFE_NO_PAD.encode(key);
    let urls = addrs.iter().map(|a| format!("{a}/#p={pair_id}&k={k}")).collect();
    Ok(PairInfo { pair_id, key: k, urls, expires_in: 300 })
}

#[tauri::command]
pub async fn remote_pair_decision(state: State<'_, Arc<RemoteState>>, pair_id: String, ok: bool, perm: String) -> Result<(), String> {
    if let Some(tx) = state.decisions.lock().await.remove(&pair_id) {
        let _ = tx.send(if ok { Some(if ["view", "control", "full"].contains(&perm.as_str()) { perm } else { "view".into() }) } else { None });
    }
    Ok(())
}

#[tauri::command]
pub fn remote_devices(app: AppHandle) -> Vec<Device> { load_devices(&app) }

#[tauri::command]
pub fn remote_set_perm(app: AppHandle, device_id: String, perm: String) -> Result<(), String> {
    if !["view", "control", "full"].contains(&perm.as_str()) { return Err("Nieznane uprawnienie".into()); }
    let mut list = load_devices(&app);
    if let Some(d) = list.iter_mut().find(|d| d.id == device_id) { d.perm = perm; }
    save_devices(&app, &list);
    Ok(())
}

#[tauri::command]
pub async fn remote_revoke(app: AppHandle, state: State<'_, Arc<RemoteState>>, device_id: String) -> Result<(), String> {
    let mut list = load_devices(&app);
    list.retain(|d| d.id != device_id);
    save_devices(&app, &list);
    if let Ok(e) = key_entry(&device_id) { let _ = e.delete_credential(); }
    state.conns.lock().await.retain(|_, c| c.device != device_id); // zamknięcie kanału kończy sesję
    Ok(())
}

/// Odpowiedź albo zdarzenie z interfejsu do jednego połączenia (conn) albo do wszystkich.
#[tauri::command]
pub async fn remote_send(state: State<'_, Arc<RemoteState>>, conn: Option<u64>, msg: String) -> Result<(), String> {
    let conns = state.conns.lock().await;
    match conn {
        Some(c) => { if let Some(cl) = conns.get(&c) { let _ = cl.tx.send(msg); } }
        None => for cl in conns.values() { let _ = cl.tx.send(msg.clone()); },
    }
    Ok(())
}
