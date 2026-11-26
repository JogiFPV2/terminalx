//! Zdalny dostęp z telefonu: serwer HTTP + WebSocket w sieci lokalnej albo Tailscale.
//! Po powitaniu każda wiadomość jest szyfrowana kluczem sesji wyprowadzonym z klucza urządzenia i wyzwań
//! obu stron, z licznikiem ramek w nonce (remote_crypto.rs). Bez TLS treść jest więc nieczytelna w sieci,
//! a nagranych ramek nie da się powtórzyć ani przestawić. Klucz trafia na telefon wyłącznie przez kod QR
//! (w części `#…` adresu, której przeglądarka nie wysyła do serwera). Nowe urządzenie wymaga zgody na komputerze.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State as AxState};
use axum::http::header;
use axum::response::{Html, IntoResponse};
use axum::routing::get;
use axum::Router;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use crate::remote_crypto::{session_key, Dir};
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
    /// Odpowiadanie na wyszukiwanie komputera w sieci (UDP na tym samym porcie).
    discovery: tauri::async_runtime::JoinHandle<()>,
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
    /// Do kiedy komputer przyjmuje parowanie kodem bez QR (otwiera je „Sparuj telefon”).
    near_until: Mutex<Option<Instant>>,
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
        let _ = crate::store::write_atomic(&p, serde_json::to_string_pretty(list).unwrap_or_default().as_bytes());
    }
}
fn key_ref(id: &str) -> String {
    format!("remote-device:{id}")
}

/// Stały identyfikator tego komputera: telefon szuka go w sieci, gdy komputer zmieni adres IP.
fn pc_id(app: &AppHandle) -> String {
    let Some(path) = crate::store::data_dir(app).ok().map(|d| d.join("remote-pc-id")) else { return "hermitty".into() };
    if let Ok(id) = std::fs::read_to_string(&path) {
        let id = id.trim().to_string();
        if id.len() >= 8 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return id;
        }
    }
    let id = URL_SAFE_NO_PAD.encode(rand_bytes::<12>());
    let _ = crate::store::write_atomic(&path, id.as_bytes());
    id
}

/// Nazwa komputera pokazywana na telefonie (Windows: COMPUTERNAME).
fn pc_name() -> String {
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "Komputer".into())
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
/// Kolejność adresów: najpierw zwykła sieć domowa (192.168, 10.x), na końcu karty wirtualne
/// (WSL, Hyper-V, Docker, VirtualBox, VMware), których telefon i tak nie widzi.
fn rank(name: &str, ip: &std::net::Ipv4Addr) -> u8 {
    let n = name.to_lowercase();
    let virt = ["vethernet", "wsl", "hyper-v", "docker", "virtualbox", "vmware", "vmnet", "vbox", "veth", "br-", "virbr", "zerotier", "hamachi"].iter().any(|v| n.contains(v));
    let o = ip.octets();
    let net = if o[0] == 192 && o[1] == 168 { 0 } else if o[0] == 10 { 1 } else { 2 };
    if virt { 10 + net } else { net }
}

fn addresses(mode: &str) -> Vec<IpAddr> {
    let mut out: Vec<(u8, IpAddr)> = Vec::new();
    for iface in if_addrs::get_if_addrs().unwrap_or_default() {
        if let IpAddr::V4(v4) = iface.ip() {
            if iface.is_loopback() { continue; }
            if (mode == "tailscale" && is_tailscale(&v4)) || (mode != "tailscale" && is_private(&v4)) {
                out.push((rank(&iface.name, &v4), IpAddr::V4(v4)));
            }
        }
    }
    out.sort_by_key(|(r, _)| *r);
    out.dedup_by_key(|(_, ip)| *ip);
    out.into_iter().map(|(_, ip)| ip).collect()
}

/* ---------- permissions ---------- */

fn level(perm: &str) -> u8 {
    match perm { "full" => 3, "control" => 2, _ => 1 }
}
fn needed(method: &str) -> u8 {
    match method {
        "state" | "tail" | "subscribe" | "unsubscribe" | "chat" | "ping" | "info" | "shells" | "flows" => 1,
        "write" | "resize" | "approve" | "park" | "unpark" | "focus" | "stopAgent" | "bridgePair" => 2,
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
    // 0. Wyzwanie komputera (jawnie). Klucze sesji zależą od niego, więc nagrana sesja nie zadziała ponownie.
    let cs = rand_bytes::<16>();
    ws.send(Message::Text(json!({"t":"hi","v":2,"c":STANDARD.encode(cs),"name":pc_name(),"pc":pc_id(&app)}).to_string().into())).await.map_err(|e| e.to_string())?;
    let hello: Value = serde_json::from_str(&recv_text(&mut ws).await.ok_or("brak powitania")?).map_err(|e| e.to_string())?;
    let Some(cc) = hello["c"].as_str().and_then(|c| STANDARD.decode(c).ok()).filter(|c| c.len() == 16) else {
        let _ = ws.send(Message::Text(json!({"t":"error","msg":"Stara wersja strony. Odśwież stronę na telefonie."}).to_string().into())).await;
        return Ok(());
    };

    // 1. Klucz: znane urządzenie, jednorazowe parowanie z kodu QR albo parowanie kodem (X25519).
    let mut near_sas: Option<String> = None;
    let (key, mut device_id, pairing) = match hello["t"].as_str() {
        Some("hello") => {
            let id = hello["device"].as_str().unwrap_or("").to_string();
            let known = load_devices(&app).into_iter().any(|d| d.id == id);
            let k = if known { crate::ai::secret(&key_ref(&id)) } else { None };
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
        Some("near") => {
            // Parowanie kodem bez QR: tylko gdy użytkownik kliknął na komputerze „Sparuj telefon” (inaczej każdy
            // w sieci mógłby wywoływać okna zgody). Klucz urządzenia powstaje z wymiany X25519; ten sam 6-cyfrowy
            // kod pokazują telefon i okno zgody, więc podmiana kluczy po drodze byłaby widoczna.
            let open = state.near_until.lock().await.is_some_and(|t| t > Instant::now());
            if !open {
                let _ = ws.send(Message::Text(json!({"t":"error","msg":"Na komputerze otwórz Ustawienia → Zdalny dostęp i kliknij „Pokaż kod QR” (Sparuj telefon), żeby przyjąć nowe urządzenie."}).to_string().into())).await;
                return Ok(());
            }
            let pk_phone = hello["pk"].as_str().and_then(|p| STANDARD.decode(p).ok()).unwrap_or_default();
            let (pk_pc, key, sas) = crate::remote_crypto::near_pc(&pk_phone, &cs, &cc)?;
            ws.send(Message::Text(json!({"t":"near","pk":STANDARD.encode(pk_pc)}).to_string().into())).await.map_err(|e| e.to_string())?;
            let pid = format!("near-{}", URL_SAFE_NO_PAD.encode(rand_bytes::<9>()));
            near_sas = Some(sas);
            (key, String::new(), Some((pid, hello["name"].as_str().unwrap_or("Telefon").chars().take(40).collect::<String>())))
        }
        _ => return Err("nieznane powitanie".into()),
    };

    let mut inbound = Dir::new(&session_key(&key, b"c2s", &cs, &cc));
    let mut outbound = Dir::new(&session_key(&key, b"s2c", &cs, &cc));

    // 2. Dowód posiadania klucza: pierwsza zaszyfrowana wiadomość (ramka nr 0 tej sesji) musi się odszyfrować.
    let proof = recv_text(&mut ws).await.and_then(|f| inbound.open(&f)).ok_or("zły klucz")?;
    if serde_json::from_str::<Value>(&proof).ok().and_then(|v| v["t"].as_str().map(String::from)).as_deref() != Some("auth") {
        return Err("brak uwierzytelnienia".into());
    }

    // 3. Nowe urządzenie: decyzja użytkownika na komputerze.
    if let Some((pid, name)) = pairing {
        let (tx, rx) = oneshot::channel();
        state.decisions.lock().await.insert(pid.clone(), tx);
        let _ = app.emit("remote:pair-request", json!({ "pairId": pid, "name": name, "addr": addr.ip().to_string(), "sas": near_sas }));
        let _ = ws.send(Message::Text(outbound.seal(&json!({"t":"waiting"}).to_string()).into())).await;
        let decision = tokio::time::timeout(Duration::from_secs(180), rx).await.ok().and_then(|r| r.ok()).flatten();
        state.decisions.lock().await.remove(&pid);
        let Some(perm) = decision else {
            let _ = ws.send(Message::Text(outbound.seal(&json!({"t":"denied"}).to_string()).into())).await;
            return Ok(());
        };
        device_id = URL_SAFE_NO_PAD.encode(rand_bytes::<12>());
        crate::ai::secret_store(&key_ref(&device_id), &STANDARD.encode(key))?;
        let mut list = load_devices(&app);
        list.push(Device { id: device_id.clone(), name, perm, added: now_ms(), last_seen: Some(now_ms()) });
        save_devices(&app, &list);
        let _ = app.emit("remote:devices", ());
        ws.send(Message::Text(outbound.seal(&json!({"t":"paired","device":device_id}).to_string()).into())).await.map_err(|e| e.to_string())?;
    }

    // 4. Sesja: żądania telefonu idą do interfejsu aplikacji, odpowiedzi i zdarzenia wracają zaszyfrowane.
    let conn = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    state.conns.lock().await.insert(conn, Client { device: device_id.clone(), tx });
    let perm_of = |app: &AppHandle, id: &str| load_devices(app).into_iter().find(|d| d.id == id).map(|d| d.perm).unwrap_or_else(|| "view".into());
    let _ = ws.send(Message::Text(outbound.seal(&json!({"t":"ready","perm":perm_of(&app, &device_id),"device":device_id}).to_string()).into())).await;
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
                    let Some(plain) = inbound.open(&text) else { break };
                    let req: Value = serde_json::from_str(&plain).map_err(|e| e.to_string())?;
                    if req["t"] != "req" { continue; }
                    let method = req["m"].as_str().unwrap_or("").to_string();
                    let perm = perm_of(&app, &device_id);
                    if perm == "revoked" { break; }
                    if level(&perm) < needed(&method) {
                        let res = json!({"t":"res","id":req["id"],"ok":false,"error":"To urządzenie nie ma uprawnień do tej operacji."});
                        ws.send(Message::Text(outbound.seal(&res.to_string()).into())).await.map_err(|e| e.to_string())?;
                        continue;
                    }
                    let _ = app.emit("remote:req", json!({"conn": conn, "device": device_id, "perm": perm, "id": req["id"], "m": method, "p": req["p"]}));
                }
                out = rx.recv() => match out {
                    Some(plain) => ws.send(Message::Text(outbound.seal(&plain).into())).await.map_err(|e| e.to_string())?,
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
    if let Some(r) = running.take() { let _ = r.shutdown.send(()); r.discovery.abort(); }
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
    // Wyszukiwanie w sieci: telefon wysyła „HERMITTY-REMOTE?” (UDP, ten sam port), komputer odpowiada nazwą i id.
    let discovery = match tokio::net::UdpSocket::bind((bind, port)).await {
        Ok(sock) => {
            let (name, id) = (pc_name(), pc_id(&app));
            tauri::async_runtime::spawn(async move {
                let reply = json!({"t":"hermitty-remote","v":2,"name":name,"id":id,"port":port}).to_string();
                let mut buf = [0u8; 64];
                loop {
                    let Ok((n, from)) = sock.recv_from(&mut buf).await else { continue };
                    if &buf[..n] == b"HERMITTY-REMOTE?" {
                        let _ = sock.send_to(reply.as_bytes(), from).await;
                    }
                }
            })
        }
        // Bez wyszukiwania nadal działa kod QR; nie blokujemy startu zdalnego dostępu.
        Err(_) => tauri::async_runtime::spawn(async {}),
    };
    *running = Some(Running { shutdown: tx, discovery, port, addrs: addrs.clone(), mode });
    Ok(addrs)
}

#[tauri::command]
pub async fn remote_stop(state: State<'_, Arc<RemoteState>>) -> Result<(), String> {
    if let Some(r) = state.running.lock().await.take() { let _ = r.shutdown.send(()); r.discovery.abort(); }
    state.conns.lock().await.clear();
    *state.near_until.lock().await = None;
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
    // Przez te same 5 minut komputer przyjmuje też parowanie kodem z telefonu, który znalazł go w sieci.
    *state.near_until.lock().await = Some(Instant::now() + Duration::from_secs(300));
    let k = URL_SAFE_NO_PAD.encode(key);
    // W każdym linku także pozostałe adresy: telefon spróbuje wszystkich i zostanie przy tym, który odpowie.
    let hosts: Vec<String> = addrs.iter().map(|a| a.trim_start_matches("http://").to_string()).collect();
    let urls = addrs
        .iter()
        .map(|a| {
            let me = a.trim_start_matches("http://");
            let alt: Vec<&str> = hosts.iter().map(|h| h.as_str()).filter(|h| *h != me).collect();
            if alt.is_empty() { format!("{a}/#p={pair_id}&k={k}") } else { format!("{a}/#p={pair_id}&k={k}&a={}", alt.join(",")) }
        })
        .collect();
    Ok(PairInfo { pair_id, key: k, urls, expires_in: 300 })
}

#[tauri::command]
pub async fn remote_pair_decision(state: State<'_, Arc<RemoteState>>, pair_id: String, ok: bool, perm: String) -> Result<(), String> {
    if let Some(tx) = state.decisions.lock().await.remove(&pair_id) {
        let _ = tx.send(if ok { Some(if ["view", "control", "full"].contains(&perm.as_str()) { perm } else { "view".into() }) } else { None });
    }
    Ok(())
}

#[tauri::command(async)]
pub fn remote_devices(app: AppHandle) -> Vec<Device> { load_devices(&app) }

#[tauri::command(async)]
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
    let _ = crate::ai::secret_remove(&key_ref(&device_id));
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

/// Reguły Zapory Windows (sieci prywatne): zdalny dostęp (TCP) i wyszukiwanie komputera (UDP) na `port`,
/// mostek Telefon na 47390 (TCP i UDP). Windows pyta raz o zgodę administratora (UAC).
#[tauri::command]
pub async fn remote_firewall_rule(port: u16) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let rule = |proto: &str| format!("netsh advfirewall firewall add rule name=Hermitty-{proto}-{port} dir=in action=allow protocol={proto} localport={port},47390 profile=private");
        let args = format!("/c {} & {}", rule("TCP"), rule("UDP"));
        let ps = format!("Start-Process -FilePath cmd -ArgumentList '{args}' -Verb RunAs -Wait -WindowStyle Hidden");
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
            .creation_flags(0x0800_0000)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(if err.contains("canceled") || err.contains("anulowan") { "Anulowano zgodę administratora.".into() } else { format!("Nie udało się dodać reguły: {}", err.trim()) });
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = port;
        Err("Reguła zapory jest potrzebna tylko na Windows.".into())
    }
}
