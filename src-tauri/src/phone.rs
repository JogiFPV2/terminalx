//! Mostek do aplikacji Hermitty na Androida (plugin „Telefon”).
//! Telefon łączy się po TCP (ramki: 4 bajty długości + treść). Po powitaniu każda ramka jest szyfrowana
//! AES-256-GCM kluczem sesji wyprowadzonym z klucza urządzenia i losowych wyzwań obu stron, z licznikiem
//! w nonce, więc ramek nie da się powtórzyć ani przestawić. Klucz urządzenia telefon dostaje przy parowaniu,
//! zaszyfrowany kluczem z jednorazowego kodu (PBKDF2), który użytkownik przepisuje z ekranu komputera.
//! Ten sam port w UDP odpowiada na wyszukiwanie komputera w sieci lokalnej.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use rand::RngCore;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::{hmac, pbkdf2};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{mpsc, oneshot, Mutex};

const MAX_FRAME: usize = 8 * 1024 * 1024;
const PAIR_SALT: &[u8] = b"hermitty-phone-pair-v1";
const PAIR_ITER: u32 = 120_000;
/// Bez kropek i znaków mylonych ze sobą (0/O, 1/I/L).
const CODE_CHARS: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    id: String,
    name: String,
    #[serde(default)]
    model: String,
    added: u64,
    #[serde(default)]
    last_seen: Option<u64>,
    /// Ostatni adres telefonu w sieci: tu komputer puka, żeby telefon wrócił sam.
    #[serde(default)]
    addr: String,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Saved {
    pc_id: String,
    devices: Vec<Device>,
}

struct Running {
    shutdown: tokio::sync::watch::Sender<bool>,
    port: u16,
}

struct PairCode {
    key: [u8; 32],
    expires: Instant,
    fails: u8,
}

struct Conn {
    tx: mpsc::UnboundedSender<String>,
    /// Ostatnie informacje z telefonu (bateria, wersja Androida, uprawnienia).
    info: Value,
    addr: String,
}

#[derive(Default)]
pub struct PhoneState {
    running: Mutex<Option<Running>>,
    pair: Mutex<Option<PairCode>>,
    conns: Mutex<HashMap<String, Conn>>,
    waiting: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
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

/* ---------- zapis (urządzenia w pliku, klucze w magazynie poświadczeń) ---------- */

fn saved_path(app: &AppHandle) -> Option<PathBuf> {
    crate::store::data_dir(app).ok().map(|d| d.join("phone.json"))
}
fn load(app: &AppHandle) -> Saved {
    let mut s: Saved = saved_path(app).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    if s.pc_id.is_empty() {
        s.pc_id = URL_SAFE_NO_PAD.encode(rand_bytes::<9>());
        save(app, &s);
    }
    s
}
fn save(app: &AppHandle, s: &Saved) {
    if let Some(p) = saved_path(app) {
        let _ = crate::store::write_atomic(&p, serde_json::to_string_pretty(s).unwrap_or_default().as_bytes());
    }
}
fn key_ref(id: &str) -> String {
    format!("phone-device:{id}")
}
fn device_key(id: &str) -> Option<[u8; 32]> {
    crate::ai::secret(&key_ref(id)).and_then(|k| STANDARD.decode(k).ok()).and_then(|v| <[u8; 32]>::try_from(v).ok())
}
fn pc_name() -> String {
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "Komputer".into())
}

/// Folder nagrań i plików z telefonu (w danych aplikacji).
fn files_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::store::data_dir(app)?.join("phone"))
}

/* ---------- kryptografia ---------- */

fn pair_key(code: &str) -> [u8; 32] {
    let norm: String = code.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect();
    let mut out = [0u8; 32];
    pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256, NonZeroU32::new(PAIR_ITER).unwrap(), PAIR_SALT, norm.as_bytes(), &mut out);
    out
}

fn session_key(base: &[u8; 32], label: &[u8], cs: &[u8], cc: &[u8]) -> LessSafeKey {
    let k = hmac::Key::new(hmac::HMAC_SHA256, base);
    let mut msg = label.to_vec();
    msg.extend_from_slice(cs);
    msg.extend_from_slice(cc);
    let tag = hmac::sign(&k, &msg);
    LessSafeKey::new(UnboundKey::new(&AES_256_GCM, tag.as_ref()).expect("32 bajty"))
}

fn nonce(counter: u64) -> Nonce {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(&counter.to_be_bytes());
    Nonce::assume_unique_for_key(n)
}

/// Jeden kierunek szyfrowanego kanału: klucz i licznik ramek.
struct Dir {
    key: LessSafeKey,
    n: u64,
}
impl Dir {
    fn seal(&mut self, plain: &[u8]) -> Vec<u8> {
        let mut buf = plain.to_vec();
        self.key.seal_in_place_append_tag(nonce(self.n), Aad::empty(), &mut buf).expect("seal");
        self.n += 1;
        buf
    }
    fn open(&mut self, mut frame: Vec<u8>) -> Option<Vec<u8>> {
        let len = self.key.open_in_place(nonce(self.n), Aad::empty(), &mut frame).ok()?.len();
        self.n += 1;
        frame.truncate(len);
        Some(frame)
    }
}

/* ---------- ramki ---------- */

async fn read_frame(r: &mut OwnedReadHalf, timeout: Duration) -> Option<Vec<u8>> {
    let len = tokio::time::timeout(timeout, r.read_u32()).await.ok()?.ok()? as usize;
    if len > MAX_FRAME {
        return None;
    }
    let mut buf = vec![0u8; len];
    tokio::time::timeout(Duration::from_secs(60), r.read_exact(&mut buf)).await.ok()?.ok()?;
    Some(buf)
}
async fn write_frame(w: &mut OwnedWriteHalf, data: &[u8]) -> std::io::Result<()> {
    w.write_u32(data.len() as u32).await?;
    w.write_all(data).await?;
    w.flush().await
}

/* ---------- adresy ---------- */

fn addresses() -> Vec<String> {
    let mut out = Vec::new();
    for iface in if_addrs::get_if_addrs().unwrap_or_default() {
        if let IpAddr::V4(v4) = iface.ip() {
            let o = v4.octets();
            let private = o[0] == 10 || (o[0] == 172 && (16..=31).contains(&o[1])) || (o[0] == 192 && o[1] == 168);
            let tailscale = o[0] == 100 && (64..=127).contains(&o[1]);
            if !iface.is_loopback() && (private || tailscale) {
                out.push(v4.to_string());
            }
        }
    }
    // Najpierw sieć domowa, Tailscale na końcu.
    out.sort_by_key(|a| a.starts_with("100."));
    out
}

/* ---------- sesja ---------- */

async fn session(app: AppHandle, stream: TcpStream, addr: SocketAddr) -> Result<(), String> {
    let _ = stream.set_nodelay(true);
    let (mut r, mut w) = stream.into_split();
    let state = app.state::<Arc<PhoneState>>();
    let saved = load(&app);

    // 1. Wyzwanie komputera, odpowiedź telefonu (jawnie: kto i czy to parowanie).
    let cs = rand_bytes::<16>();
    let hi = json!({"t":"hi","v":1,"pc":saved.pc_id,"name":pc_name(),"c":STANDARD.encode(cs)});
    write_frame(&mut w, hi.to_string().as_bytes()).await.map_err(|e| e.to_string())?;
    let hello: Value = serde_json::from_slice(&read_frame(&mut r, Duration::from_secs(15)).await.ok_or("brak powitania")?).map_err(|e| e.to_string())?;
    let cc = hello["c"].as_str().and_then(|c| STANDARD.decode(c).ok()).filter(|c| c.len() == 16).ok_or("brak wyzwania telefonu")?;

    let pairing = hello["t"] == "pair";
    let (base, mut device_id) = if pairing {
        let p = state.pair.lock().await;
        match p.as_ref().filter(|p| p.expires > Instant::now()) {
            Some(p) => (p.key, String::new()),
            None => {
                write_frame(&mut w, json!({"t":"error","msg":"Kod parowania wygasł. Wygeneruj nowy w Hermitty na komputerze."}).to_string().as_bytes()).await.ok();
                return Ok(());
            }
        }
    } else {
        let id = hello["device"].as_str().unwrap_or("").to_string();
        let known = saved.devices.iter().any(|d| d.id == id);
        match known.then(|| device_key(&id)).flatten() {
            Some(k) => (k, id),
            None => {
                write_frame(&mut w, json!({"t":"error","msg":"Ten komputer nie zna już telefonu. Sparuj go ponownie.","code":"unknown"}).to_string().as_bytes()).await.ok();
                return Ok(());
            }
        }
    };
    let mut rx_dir = Dir { key: session_key(&base, b"c2s", &cs, &cc), n: 0 };
    let mut tx_dir = Dir { key: session_key(&base, b"s2c", &cs, &cc), n: 0 };

    // 2. Pierwsza zaszyfrowana ramka telefonu dowodzi znajomości klucza (albo kodu parowania).
    let auth = read_frame(&mut r, Duration::from_secs(15)).await.and_then(|f| rx_dir.open(f));
    let Some(auth) = auth.and_then(|a| serde_json::from_slice::<Value>(&a).ok()).filter(|a| a["t"] == "auth") else {
        if pairing {
            let mut p = state.pair.lock().await;
            if let Some(pc) = p.as_mut() {
                pc.fails += 1;
                if pc.fails >= 5 { *p = None; let _ = app.emit("phone:pair", json!({"state":"failed"})); }
            }
        }
        write_frame(&mut w, json!({"t":"error","msg":"Zły kod parowania."}).to_string().as_bytes()).await.ok();
        return Err("zły klucz".into());
    };
    let name: String = auth["name"].as_str().unwrap_or("Telefon").chars().take(40).collect();
    let model: String = auth["model"].as_str().unwrap_or("").chars().take(60).collect();

    let mut saved = load(&app);
    if pairing {
        // Kod jest jednorazowy: po udanym parowaniu znika.
        *state.pair.lock().await = None;
        device_id = URL_SAFE_NO_PAD.encode(rand_bytes::<12>());
        let key = rand_bytes::<32>();
        crate::ai::secret_store(&key_ref(&device_id), &STANDARD.encode(key))?;
        saved.devices.push(Device { id: device_id.clone(), name: name.clone(), model: model.clone(), added: now_ms(), last_seen: Some(now_ms()), addr: addr.ip().to_string() });
        save(&app, &saved);
        let msg = json!({"t":"paired","device":device_id,"key":STANDARD.encode(key),"pc":saved.pc_id,"name":pc_name()});
        write_frame(&mut w, &tx_dir.seal(msg.to_string().as_bytes())).await.map_err(|e| e.to_string())?;
        let _ = app.emit("phone:pair", json!({"state":"paired","device":device_id,"name":name}));
    } else if let Some(d) = saved.devices.iter_mut().find(|d| d.id == device_id) {
        d.name = name.clone();
        if !model.is_empty() { d.model = model.clone(); }
        d.last_seen = Some(now_ms());
        d.addr = addr.ip().to_string();
        save(&app, &saved);
    }
    write_frame(&mut w, &tx_dir.seal(json!({"t":"ready","name":pc_name()}).to_string().as_bytes())).await.map_err(|e| e.to_string())?;

    // 3. Sesja. Starsze połączenie tego samego telefonu zamykamy (zamknięcie kanału kończy jego pętlę).
    let (tx, mut out) = mpsc::unbounded_channel::<String>();
    state.conns.lock().await.insert(device_id.clone(), Conn { tx, info: auth["info"].clone(), addr: addr.ip().to_string() });
    let _ = app.emit("phone:devices", ());

    let dir = files_dir(&app)?.join(&device_id);
    let mut uploads: HashMap<String, (std::fs::File, PathBuf)> = HashMap::new();
    let mut ping = tokio::time::interval(Duration::from_secs(30));
    let mut last_rx = Instant::now();
    let result: Result<(), String> = async {
        loop {
            tokio::select! {
                f = read_frame(&mut r, Duration::from_secs(3600)) => {
                    let Some(plain) = f.and_then(|f| rx_dir.open(f)) else { break };
                    last_rx = Instant::now();
                    let msg: Value = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
                    match msg["t"].as_str().unwrap_or("") {
                        "res" => {
                            if let Some(id) = msg["id"].as_u64() {
                                if let Some(s) = state.waiting.lock().await.remove(&id) { let _ = s.send(msg); }
                            }
                        }
                        "ev" => {
                            if msg["e"] == "info" {
                                if let Some(c) = state.conns.lock().await.get_mut(&device_id) { c.info = msg["p"].clone(); }
                            }
                            let _ = app.emit("phone:event", json!({"device": device_id, "e": msg["e"], "p": msg["p"]}));
                        }
                        "file" => {
                            if let Some(saved) = receive_chunk(&dir, &mut uploads, &msg) {
                                let _ = app.emit("phone:event", json!({"device": device_id, "e": "file", "p": saved}));
                                let ack = json!({"t":"fileok","id":msg["id"]});
                                write_frame(&mut w, &tx_dir.seal(ack.to_string().as_bytes())).await.map_err(|e| e.to_string())?;
                            }
                        }
                        "ping" => write_frame(&mut w, &tx_dir.seal(br#"{"t":"pong"}"#)).await.map_err(|e| e.to_string())?,
                        _ => {}
                    }
                }
                o = out.recv() => match o {
                    Some(plain) => write_frame(&mut w, &tx_dir.seal(plain.as_bytes())).await.map_err(|e| e.to_string())?,
                    None => break,
                },
                _ = ping.tick() => {
                    // Komputer pinguje telefon: przychodzący pakiet budzi telefon w trybie uśpienia, jego własny zegar mógłby stać.
                    if last_rx.elapsed() > Duration::from_secs(100) { break; }
                    write_frame(&mut w, &tx_dir.seal(br#"{"t":"ping"}"#)).await.map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }.await;

    for (_, (_, part)) in uploads.drain() { let _ = std::fs::remove_file(part); }
    drop(out);
    {
        let mut conns = state.conns.lock().await;
        // Usuwamy tylko własne połączenie (nowsze mogło je już zastąpić).
        if conns.get(&device_id).map(|c| c.tx.is_closed()).unwrap_or(false) { conns.remove(&device_id); }
    }
    let mut saved = load(&app);
    if let Some(d) = saved.devices.iter_mut().find(|d| d.id == device_id) { d.last_seen = Some(now_ms()); }
    save(&app, &saved);
    let _ = app.emit("phone:devices", ());
    result
}

/// Plik z telefonu w kawałkach: zapis do własnego `.part` (osobny dla każdego przesyłania), po ostatnim kawałku
/// zmiana nazwy. Nazwa zajęta przez wcześniejszy plik dostaje numer („nagranie (2).m4a”) zamiast go nadpisać.
/// Zwraca opis gotowego pliku.
fn receive_chunk(dir: &Path, uploads: &mut HashMap<String, (std::fs::File, PathBuf)>, msg: &Value) -> Option<Value> {
    use std::io::Write;
    let id = msg["id"].as_str()?.to_string();
    let kind = if msg["kind"] == "recording" { "nagrania" } else { "pliki" };
    let name = safe_name(msg["name"].as_str().unwrap_or("plik"));
    let folder = dir.join(kind);
    if !uploads.contains_key(&id) {
        std::fs::create_dir_all(&folder).ok()?;
        let tag: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).take(24).collect();
        let part = folder.join(format!(".{tag}-{}.part", uploads.len()));
        uploads.insert(id.clone(), (std::fs::File::create(&part).ok()?, part));
    }
    let data = STANDARD.decode(msg["data"].as_str().unwrap_or("")).ok()?;
    let (file, _) = uploads.get_mut(&id)?;
    file.write_all(&data).ok()?;
    if msg["last"] != true {
        return None;
    }
    let (file, part) = uploads.remove(&id)?;
    drop(file);
    let target = free_path(&folder, &name);
    std::fs::rename(&part, &target).ok()?;
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(name);
    let size = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    Some(json!({"id": id, "kind": msg["kind"], "name": name, "path": target.to_string_lossy(), "size": size, "secs": msg["secs"]}))
}

/// Nazwa pliku z telefonu: tylko litery, cyfry, `._- `, bez nazw złożonych z samych kropek.
fn safe_name(raw: &str) -> String {
    let name: String = raw.chars().filter(|c| c.is_alphanumeric() || "._- ".contains(*c)).take(80).collect();
    if name.trim_matches('.').trim().is_empty() { "plik".to_string() } else { name }
}

/// Pierwsza wolna ścieżka: `nazwa.ext`, potem `nazwa (2).ext`, `nazwa (3).ext`…
fn free_path(folder: &Path, name: &str) -> PathBuf {
    let first = folder.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..).map(|n| folder.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap_or(first)
}

/// Wyszukiwanie w sieci lokalnej: telefon wysyła „HERMITTY?”, komputer odpowiada swoim id, nazwą i portem.
async fn discovery(sock: UdpSocket, pc_id: String, port: u16, mut stop: tokio::sync::watch::Receiver<bool>) {
    let mut buf = [0u8; 64];
    loop {
        tokio::select! {
            r = sock.recv_from(&mut buf) => {
                let Ok((n, from)) = r else { continue };
                if &buf[..n] == b"HERMITTY?" {
                    let reply = json!({"t":"hermitty","id":pc_id,"name":pc_name(),"port":port}).to_string();
                    let _ = sock.send_to(reply.as_bytes(), from).await;
                }
            }
            _ = stop.changed() => break,
        }
    }
}

/// Pukanie do telefonów offline: krótki pakiet UDP na ostatni adres telefonu i rozgłoszenie w sieci.
/// Telefon wstaje z uśpienia i łączy się od razu, zamiast czekać na swoją kolejną próbę.
async fn waker(app: AppHandle, state: Arc<PhoneState>, pc_id: String, port: u16, mut stop: tokio::sync::watch::Receiver<bool>) {
    let Ok(sock) = UdpSocket::bind(("0.0.0.0", 0)).await else { return };
    let _ = sock.set_broadcast(true);
    let msg = format!("HERMITTY!{pc_id}");
    let started = Instant::now();
    loop {
        let online: Vec<String> = state.conns.lock().await.keys().cloned().collect();
        let offline: Vec<String> = load(&app).devices.into_iter().filter(|d| !online.contains(&d.id)).map(|d| d.addr).collect();
        if !offline.is_empty() {
            let mut targets: Vec<std::net::Ipv4Addr> = offline.iter().filter_map(|a| a.parse().ok()).filter(|a: &std::net::Ipv4Addr| !a.is_loopback()).collect();
            targets.push(std::net::Ipv4Addr::BROADCAST);
            for iface in if_addrs::get_if_addrs().unwrap_or_default() {
                if let if_addrs::IfAddr::V4(v4) = &iface.addr { if let Some(b) = v4.broadcast { if !iface.is_loopback() { targets.push(b); } } }
            }
            targets.sort();
            targets.dedup();
            for t in targets { let _ = sock.send_to(msg.as_bytes(), (t, port)).await; }
        }
        // Po starcie komputera często, potem rzadziej.
        let every = if started.elapsed() < Duration::from_secs(120) { 3 } else { 10 };
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(every)) => {}
            _ = stop.changed() => break,
        }
    }
}

/* ---------- komendy ---------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus { id: String, name: String, model: String, added: u64, last_seen: Option<u64>, online: bool, addr: String, info: Value }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status { running: bool, port: u16, addrs: Vec<String>, pc_name: String, devices: Vec<DeviceStatus>, pairing: bool }

#[tauri::command]
pub async fn phone_start(app: AppHandle, state: State<'_, Arc<PhoneState>>, port: u16) -> Result<(), String> {
    let mut running = state.running.lock().await;
    if running.as_ref().map(|r| r.port) == Some(port) { return Ok(()); }
    if let Some(r) = running.take() { let _ = r.shutdown.send(true); }
    let listener = TcpListener::bind(("0.0.0.0", port)).await.map_err(|e| format!("Nie można nasłuchiwać na porcie {port}: {e}"))?;
    let udp = UdpSocket::bind(("0.0.0.0", port)).await.map_err(|e| format!("Port UDP {port} jest zajęty: {e}"))?;
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let pc_id = load(&app).pc_id;
    tauri::async_runtime::spawn(discovery(udp, pc_id.clone(), port, stop_rx.clone()));
    tauri::async_runtime::spawn(waker(app.clone(), state.inner().clone(), pc_id, port, stop_rx.clone()));
    let app2 = app.clone();
    let mut stop = stop_rx;
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                a = listener.accept() => if let Ok((s, addr)) = a {
                    let app = app2.clone();
                    tauri::async_runtime::spawn(async move { if let Err(e) = session(app, s, addr).await { eprintln!("phone session: {e}"); } });
                },
                _ = stop.changed() => break,
            }
        }
    });
    *running = Some(Running { shutdown: stop_tx, port });
    Ok(())
}

#[tauri::command]
pub async fn phone_stop(state: State<'_, Arc<PhoneState>>) -> Result<(), String> {
    if let Some(r) = state.running.lock().await.take() { let _ = r.shutdown.send(true); }
    state.conns.lock().await.clear();
    Ok(())
}

#[tauri::command]
pub async fn phone_status(app: AppHandle, state: State<'_, Arc<PhoneState>>) -> Result<Status, String> {
    let port = state.running.lock().await.as_ref().map(|r| r.port);
    let conns = state.conns.lock().await;
    let devices = load(&app).devices.into_iter().map(|d| {
        let c = conns.get(&d.id).filter(|c| !c.tx.is_closed());
        DeviceStatus { online: c.is_some(), addr: c.map(|c| c.addr.clone()).unwrap_or_default(), info: c.map(|c| c.info.clone()).unwrap_or(Value::Null), id: d.id, name: d.name, model: d.model, added: d.added, last_seen: d.last_seen }
    }).collect();
    let pairing = state.pair.lock().await.as_ref().is_some_and(|p| p.expires > Instant::now());
    Ok(Status { running: port.is_some(), port: port.unwrap_or(0), addrs: addresses(), pc_name: pc_name(), devices, pairing })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairInfo { code: String, link: String, expires_in: u64 }

#[tauri::command]
pub async fn phone_pair_begin(app: AppHandle, state: State<'_, Arc<PhoneState>>) -> Result<PairInfo, String> {
    let port = state.running.lock().await.as_ref().map(|r| r.port).ok_or("Mostek do telefonu nie działa.")?;
    // 12 znaków z 31 = ok. 59 bitów; z PBKDF2 i limitem 5 prób to dość na jednorazowy kod ważny 5 minut.
    let raw: String = rand_bytes::<12>().iter().map(|b| CODE_CHARS[(*b as usize) % CODE_CHARS.len()] as char).collect();
    let code = format!("{}-{}-{}", &raw[..4], &raw[4..8], &raw[8..]);
    let key = tokio::task::spawn_blocking({ let c = raw.clone(); move || pair_key(&c) }).await.map_err(|e| e.to_string())?;
    *state.pair.lock().await = Some(PairCode { key, expires: Instant::now() + Duration::from_secs(300), fails: 0 });
    let s = load(&app);
    let enc = |v: &str| v.replace('%', "%25").replace('&', "%26").replace(' ', "%20").replace('#', "%23");
    let link = format!("hermitty://pair?c={raw}&h={}&p={port}&id={}&n={}", addresses().join(","), s.pc_id, enc(&pc_name()));
    Ok(PairInfo { code, link, expires_in: 300 })
}

#[tauri::command]
pub async fn phone_pair_cancel(state: State<'_, Arc<PhoneState>>) -> Result<(), String> {
    *state.pair.lock().await = None;
    Ok(())
}

#[tauri::command]
pub async fn phone_unpair(app: AppHandle, state: State<'_, Arc<PhoneState>>, device: String) -> Result<(), String> {
    if let Some(c) = state.conns.lock().await.remove(&device) {
        let _ = c.tx.send(json!({"t":"unpaired"}).to_string());
    }
    let mut s = load(&app);
    s.devices.retain(|d| d.id != device);
    save(&app, &s);
    let _ = crate::ai::secret_remove(&key_ref(&device));
    let _ = app.emit("phone:devices", ());
    Ok(())
}

/// Żądanie do telefonu (SMS-y, powiadomienia, dyktafon…) i czekanie na odpowiedź.
#[tauri::command]
pub async fn phone_request(state: State<'_, Arc<PhoneState>>, device: String, method: String, params: Value, timeout_ms: Option<u64>) -> Result<Value, String> {
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = oneshot::channel();
    {
        let conns = state.conns.lock().await;
        let c = conns.get(&device).filter(|c| !c.tx.is_closed()).ok_or("Telefon jest offline.")?;
        state.waiting.lock().await.insert(id, tx);
        c.tx.send(json!({"t":"req","id":id,"m":method,"p":params}).to_string()).map_err(|_| "Telefon jest offline.")?;
    }
    let res = tokio::time::timeout(Duration::from_millis(timeout_ms.unwrap_or(20_000).min(120_000)), rx).await;
    state.waiting.lock().await.remove(&id);
    let msg = res.map_err(|_| "Telefon nie odpowiedział na czas.")?.map_err(|_| "Połączenie z telefonem zerwane.")?;
    if msg["ok"] == true { Ok(msg["v"].clone()) } else { Err(msg["error"].as_str().unwrap_or("Błąd na telefonie").to_string()) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFile { device: String, kind: String, name: String, path: String, size: u64, modified: u64 }

/// Pliki odebrane z telefonów (nagrania dyktafonu i inne), od najnowszych.
#[tauri::command(async)]
pub fn phone_files(app: AppHandle) -> Result<Vec<LocalFile>, String> {
    let root = files_dir(&app)?;
    let mut out = Vec::new();
    for dev in std::fs::read_dir(&root).into_iter().flatten().flatten() {
        for kind in ["nagrania", "pliki"] {
            for f in std::fs::read_dir(dev.path().join(kind)).into_iter().flatten().flatten() {
                let p = f.path();
                if p.extension().is_some_and(|e| e == "part") { continue; }
                let Ok(m) = f.metadata() else { continue };
                let modified = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
                out.push(LocalFile { device: dev.file_name().to_string_lossy().into(), kind: kind.into(), name: f.file_name().to_string_lossy().into(), path: p.to_string_lossy().into(), size: m.len(), modified });
            }
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

/// Ścieżka musi leżeć w folderze plików z telefonu.
fn inside(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let root = files_dir(app)?.canonicalize().map_err(|e| e.to_string())?;
    let p = Path::new(path).canonicalize().map_err(|_| "Nie ma takiego pliku.".to_string())?;
    if p.starts_with(&root) { Ok(p) } else { Err("Ścieżka spoza plików z telefonu.".into()) }
}

#[tauri::command(async)]
pub fn phone_file_read(app: AppHandle, path: String) -> Result<String, String> {
    let p = inside(&app, &path)?;
    std::fs::read(p).map(|b| STANDARD.encode(b)).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn phone_file_delete(app: AppHandle, path: String) -> Result<(), String> {
    std::fs::remove_file(inside(&app, &path)?).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn phone_file_reveal(app: AppHandle, path: String) -> Result<(), String> {
    let p = inside(&app, &path)?;
    #[cfg(windows)]
    {
        let s = p.to_string_lossy().trim_start_matches(r"\\?\").to_string();
        std::process::Command::new("explorer").arg(format!("/select,{s}")).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg("-R").arg(&p).spawn().map_err(|e| e.to_string())?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open").arg(p.parent().unwrap_or(&p)).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_keys_roundtrip_and_reject_replay() {
        let base = [7u8; 32];
        let (cs, cc) = ([1u8; 16], [2u8; 16]);
        let mut a = Dir { key: session_key(&base, b"c2s", &cs, &cc), n: 0 };
        let mut b = Dir { key: session_key(&base, b"c2s", &cs, &cc), n: 0 };
        let f1 = a.seal(b"pierwsza");
        let f2 = a.seal(b"druga");
        assert_eq!(b.open(f1.clone()).unwrap(), b"pierwsza");
        // Powtórzona ramka ma stary licznik: nie przechodzi.
        assert!(b.open(f1).is_none());
        let mut c = Dir { key: session_key(&base, b"c2s", &cs, &cc), n: 1 };
        assert_eq!(c.open(f2).unwrap(), b"druga");
        // Inny kierunek albo inne wyzwanie: inny klucz.
        let mut d = Dir { key: session_key(&base, b"s2c", &cs, &cc), n: 0 };
        assert!(d.open(Dir { key: session_key(&base, b"c2s", &cs, &cc), n: 0 }.seal(b"x")).is_none());
    }

    #[test]
    fn received_files_do_not_overwrite() {
        let dir = std::env::temp_dir().join(format!("hermitty-phone-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut up = HashMap::new();
        let chunk = |id: &str, data: &str, last: bool| json!({"id": id, "kind": "recording", "name": "nagranie.m4a", "data": STANDARD.encode(data), "last": last});
        // Dwa przesyłania o tej samej nazwie naraz: każde ma własny .part, drugie dostaje numer.
        assert!(receive_chunk(&dir, &mut up, &chunk("a", "AA", false)).is_none());
        assert!(receive_chunk(&dir, &mut up, &chunk("b", "BB", false)).is_none());
        let a = receive_chunk(&dir, &mut up, &chunk("a", "a", true)).unwrap();
        let b = receive_chunk(&dir, &mut up, &chunk("b", "b", true)).unwrap();
        assert_eq!(a["name"], "nagranie.m4a");
        assert_eq!(b["name"], "nagranie (2).m4a");
        assert_eq!(std::fs::read_to_string(a["path"].as_str().unwrap()).unwrap(), "AAa");
        assert_eq!(std::fs::read_to_string(b["path"].as_str().unwrap()).unwrap(), "BBb");
        assert_eq!(safe_name("../.."), "plik");
        assert_eq!(safe_name("a/b\\c.txt"), "abc.txt");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pair_key_ignores_format() {
        assert_eq!(pair_key("abcd-efgh-jkmn"), pair_key("ABCDEFGHJKMN"));
        assert_ne!(pair_key("ABCDEFGHJKMN"), pair_key("ABCDEFGHJKMP"));
    }
}
