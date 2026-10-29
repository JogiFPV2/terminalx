//! Lokalne AI: proces ComfyUI uruchamiany na żądanie, kanał postępu (WebSocket), pobieranie modeli
//! i rozpoznanie sprzętu (karta graficzna, pamięć). Nic tu nie działa w tle, dopóki workflow tego nie potrzebuje.

use futures_util::StreamExt;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use sha2::{Digest, Sha256};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};

struct ComfyProc {
    child: Child,
    root: String,
    log: Arc<Mutex<VecDeque<String>>>,
}

#[derive(Default)]
pub struct LocalState {
    comfy: Mutex<Option<ComfyProc>>,
    downloads: Mutex<HashMap<String, Arc<AtomicBool>>>,
    sockets: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let _ = cmd;
}

/* ---------- sprzęt ---------- */

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    name: String,
    vram_mb: u64,
    vendor: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    gpus: Vec<Gpu>,
    ram_mb: u64,
    /// Pamięć współdzielona (Apple Silicon): karta korzysta z RAM.
    unified: bool,
}

pub(crate) fn run_out(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stderr(Stdio::null());
    no_window(&mut cmd);
    let out = cmd.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn vendor_of(name: &str) -> String {
    let l = name.to_lowercase();
    if l.contains("nvidia") || l.contains("geforce") || l.contains("rtx") || l.contains("quadro") { "nvidia" }
    else if l.contains("amd") || l.contains("radeon") { "amd" }
    else if l.contains("intel") || l.contains("arc") { "intel" }
    else if l.contains("apple") { "apple" }
    else { "other" }
    .into()
}

#[tauri::command]
pub async fn local_hw() -> Hardware {
    tauri::async_runtime::spawn_blocking(|| {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        let ram_mb = sys.total_memory() / 1024 / 1024;
        let mut gpus = Vec::new();
        // NVIDIA: dokładna pamięć z nvidia-smi (Windows i Linux).
        if let Some(out) = run_out("nvidia-smi", &["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]) {
            for line in out.lines() {
                if let Some((name, mem)) = line.rsplit_once(',') {
                    gpus.push(Gpu { name: name.trim().into(), vram_mb: mem.trim().parse().unwrap_or(0), vendor: "nvidia".into() });
                }
            }
        }
        #[cfg(windows)]
        if gpus.is_empty() {
            // Pozostałe karty: rozmiar pamięci z rejestru sterownika (AdapterRAM z WMI kończy się na 4 GB).
            let ps = "Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.DriverDesc)|$($_.'HardwareInformation.qwMemorySize')\" }";
            if let Some(out) = run_out("powershell", &["-NoProfile", "-Command", ps]) {
                for line in out.lines() {
                    if let Some((name, mem)) = line.split_once('|') {
                        let bytes: u64 = mem.trim().parse().unwrap_or(0);
                        if !name.trim().is_empty() && bytes > 0 {
                            gpus.push(Gpu { name: name.trim().into(), vram_mb: bytes / 1024 / 1024, vendor: vendor_of(name) });
                        }
                    }
                }
            }
        }
        let unified = cfg!(target_os = "macos") && std::env::consts::ARCH == "aarch64";
        if unified {
            gpus.push(Gpu { name: "Apple Silicon".into(), vram_mb: ram_mb * 7 / 10, vendor: "apple".into() });
        }
        gpus.sort_by(|a, b| b.vram_mb.cmp(&a.vram_mb));
        Hardware { gpus, ram_mb, unified }
    })
    .await
    .unwrap_or(Hardware { gpus: vec![], ram_mb: 0, unified: false })
}

/* ---------- ComfyUI: wykrycie instalacji i proces ---------- */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ComfyInstall {
    /// Folder z main.py.
    comfy: String,
    python: String,
    models: String,
    portable: bool,
}

fn find_install(dir: &Path) -> Option<ComfyInstall> {
    let exe = if cfg!(windows) { "python.exe" } else { "python" };
    let bin = if cfg!(windows) { "Scripts" } else { "bin" };
    let mut roots = vec![dir.to_path_buf(), dir.join("ComfyUI_windows_portable")];
    roots.extend(std::fs::read_dir(dir).ok().into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()));
    for root in roots {
        // Wersja przenośna dla Windows: python_embeded + ComfyUI/main.py.
        let py = root.join("python_embeded").join(exe);
        if py.is_file() && root.join("ComfyUI").join("main.py").is_file() {
            let c = root.join("ComfyUI");
            return Some(ComfyInstall { models: c.join("models").to_string_lossy().into(), comfy: c.to_string_lossy().into(), python: py.to_string_lossy().into(), portable: true });
        }
        // Instalacja z repozytorium: main.py + venv (albo Python z PATH).
        if root.join("main.py").is_file() && root.join("comfy").is_dir() {
            let py = [".venv", "venv"].iter().map(|v| root.join(v).join(bin).join(exe)).find(|p| p.is_file());
            let py = py.map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| if cfg!(windows) { "python".into() } else { "python3".into() });
            return Some(ComfyInstall { models: root.join("models").to_string_lossy().into(), comfy: root.to_string_lossy().into(), python: py, portable: false });
        }
    }
    None
}

#[tauri::command(async)]
pub fn comfy_find(dir: String) -> Option<ComfyInstall> {
    if dir.trim().is_empty() { None } else { find_install(Path::new(&dir)) }
}

/// Domyślny folder instalacji: obok exe w trybie portable, inaczej w danych lokalnych użytkownika.
#[tauri::command(async)]
pub fn comfy_default_dir(app: AppHandle) -> Result<String, String> {
    let data = crate::store::data_dir(&app)?;
    let portable = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("data"))).is_some_and(|d| d == data);
    let dir = if portable {
        data.join("comfyui")
    } else {
        tauri::Manager::path(&app).local_data_dir().map_err(|e| e.to_string())?.join("Hermitty").join("ComfyUI")
    };
    Ok(dir.to_string_lossy().into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfyStatus {
    running: bool,
    pid: u32,
    root: String,
    log: Vec<String>,
}

fn alive(p: &mut ComfyProc) -> bool {
    matches!(p.child.try_wait(), Ok(None))
}

#[tauri::command(async)]
pub fn comfy_start(state: tauri::State<'_, LocalState>, dir: String, port: u16, args: Vec<String>) -> Result<u32, String> {
    let mut guard = state.comfy.lock().unwrap();
    if let Some(p) = guard.as_mut() {
        if alive(p) {
            return Ok(p.child.id());
        }
    }
    let inst = find_install(Path::new(&dir)).ok_or("Nie znaleziono ComfyUI w tym folderze. Zainstaluj go albo wskaż folder z main.py.")?;
    let mut cmd = Command::new(&inst.python);
    cmd.arg("-s").arg(Path::new(&inst.comfy).join("main.py"));
    if inst.portable {
        cmd.arg("--windows-standalone-build");
    }
    cmd.args(["--listen", "127.0.0.1", "--port", &port.to_string(), "--preview-method", "auto", "--disable-auto-launch"]);
    cmd.args(args.iter().filter(|a| !a.trim().is_empty()));
    cmd.current_dir(&inst.comfy).env("PYTHONIOENCODING", "utf-8").env("PYTHONUNBUFFERED", "1");
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Nie udało się uruchomić ComfyUI ({}): {e}", inst.python))?;
    let log: Arc<Mutex<VecDeque<String>>> = Arc::default();
    for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>)].into_iter().flatten() {
        let log = log.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let mut l = log.lock().unwrap();
                if l.len() >= 400 {
                    l.pop_front();
                }
                l.push_back(line);
            }
        });
    }
    let pid = child.id();
    *guard = Some(ComfyProc { child, root: dir, log });
    Ok(pid)
}

fn kill_tree(p: &mut ComfyProc) {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &p.child.id().to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null());
        no_window(&mut cmd);
        let _ = cmd.status();
    }
    let _ = p.child.kill();
    let _ = p.child.wait();
}

#[tauri::command(async)]
pub fn comfy_stop(state: tauri::State<'_, LocalState>) {
    if let Some(mut p) = state.comfy.lock().unwrap().take() {
        kill_tree(&mut p);
    }
}

pub fn stop_all(state: &LocalState) {
    if let Some(mut p) = state.comfy.lock().unwrap().take() {
        kill_tree(&mut p);
    }
    for flag in state.downloads.lock().unwrap().values() {
        flag.store(true, Ordering::Relaxed);
    }
}

#[tauri::command(async)]
pub fn comfy_status(state: tauri::State<'_, LocalState>) -> ComfyStatus {
    let mut guard = state.comfy.lock().unwrap();
    match guard.as_mut() {
        Some(p) => {
            let running = alive(p);
            let log = p.log.lock().unwrap().iter().cloned().collect();
            ComfyStatus { running, pid: p.child.id(), root: p.root.clone(), log }
        }
        None => ComfyStatus { running: false, pid: 0, root: String::new(), log: vec![] },
    }
}

/* ---------- kanał postępu ComfyUI (WebSocket) ---------- */

/// Łączy się z /ws ComfyUI i przekazuje komunikaty kanałem: JSON bez zmian, podgląd jako surowe bajty obrazu
/// (bez base64, maks. 3 na sekundę). Na końcu wysyła {"type":"tx_closed"}.
#[tauri::command]
pub async fn comfy_ws(state: tauri::State<'_, LocalState>, url: String, id: String, on: Channel<InvokeResponseBody>) -> Result<(), String> {
    if !url.starts_with("ws://") && !url.starts_with("wss://") {
        return Err("Niepoprawny adres WebSocket".into());
    }
    let (ws, _) = tokio_tungstenite::connect_async(&url).await.map_err(|e| format!("ComfyUI (WebSocket): {e}"))?;
    let stop = Arc::new(AtomicBool::new(false));
    state.sockets.lock().unwrap().insert(id, stop.clone());
    tauri::async_runtime::spawn(async move {
        use tokio_tungstenite::tungstenite::Message;
        let (_, mut read) = ws.split();
        let mut last_preview = Instant::now() - Duration::from_secs(1);
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let msg = match tokio::time::timeout(Duration::from_millis(500), read.next()).await {
                Err(_) => continue,
                Ok(None) | Ok(Some(Err(_))) => break,
                Ok(Some(Ok(m))) => m,
            };
            match msg {
                Message::Text(t) => {
                    let _ = on.send(InvokeResponseBody::Json(t.as_str().to_owned()));
                }
                Message::Binary(b) => {
                    if b.len() < 8 || last_preview.elapsed() < Duration::from_millis(330) {
                        continue;
                    }
                    let img: &[u8] = match u32::from_be_bytes([b[0], b[1], b[2], b[3]]) {
                        1 => &b[8..],
                        4 => {
                            let n = u32::from_be_bytes([b[4], b[5], b[6], b[7]]) as usize;
                            if b.len() < 8 + n { continue; }
                            &b[8 + n..]
                        }
                        _ => continue,
                    };
                    last_preview = Instant::now();
                    let _ = on.send(InvokeResponseBody::Raw(img.to_vec()));
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = on.send(InvokeResponseBody::Json(r#"{"type":"tx_closed"}"#.into()));
    });
    Ok(())
}

#[tauri::command(async)]
pub fn comfy_ws_close(state: tauri::State<'_, LocalState>, id: String) {
    if let Some(flag) = state.sockets.lock().unwrap().remove(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

/* ---------- pobieranie modeli i instalatora ---------- */

#[derive(Serialize, Clone)]
struct DlEvent {
    id: String,
    done: u64,
    total: u64,
    state: &'static str,
    error: Option<String>,
}

fn safe_dest(dest: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(dest);
    if !p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("Niepoprawna ścieżka docelowa".into());
    }
    Ok(p)
}

/// Suma SHA-256 pliku z Hugging Face (nagłówek X-Linked-Etag przed przekierowaniem do CDN).
async fn expected_sha(url: &str) -> Option<String> {
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(15)).build().ok()?;
    let res = client.head(url).header("user-agent", "Hermitty").send().await.ok()?;
    let tag = res.headers().get("x-linked-etag")?.to_str().ok()?.trim_matches('"').to_lowercase();
    (tag.len() == 64 && tag.bytes().all(|c| c.is_ascii_hexdigit())).then_some(tag)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn download(app: &AppHandle, id: &str, url: &str, dest: &Path, sha256: Option<String>, stop: &AtomicBool) -> Result<(), String> {
    let part = dest.with_extension(format!("{}.part", dest.extension().and_then(|e| e.to_str()).unwrap_or("bin")));
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let expected = match sha256 {
        Some(s) => Some(s.to_lowercase()),
        None => expected_sha(url).await,
    };
    // Wznawianie przerwanego pobierania.
    let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
    let mut req = client.get(url).header("user-agent", "Hermitty");
    if have > 0 {
        req = req.header("range", format!("bytes={have}-"));
    }
    let mut res = req.send().await.map_err(|e| format!("Błąd pobierania: {e}"))?;
    let status = res.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("Ten plik wymaga logowania albo akceptacji licencji na stronie modelu.".into());
    }
    if !status.is_success() {
        return Err(format!("Pobieranie: HTTP {}", status.as_u16()));
    }
    let resumed = status.as_u16() == 206;
    let mut done = if resumed { have } else { 0 };
    let total = res.content_length().map(|l| l + done).unwrap_or(0);
    let mut hasher = Sha256::new();
    if resumed && expected.is_some() {
        // Suma obejmuje też część pobraną wcześniej.
        let mut f = std::fs::File::open(&part).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut hasher).map_err(|e| e.to_string())?;
    }
    let mut file = std::fs::OpenOptions::new().create(true).write(true).append(resumed).truncate(!resumed).open(&part).map_err(|e| e.to_string())?;
    let mut last = Instant::now();
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("Przerwane pobieranie: {e}"))? {
        if stop.load(Ordering::Relaxed) {
            return Err("Anulowano".into());
        }
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
        if expected.is_some() {
            hasher.update(&chunk);
        }
        done += chunk.len() as u64;
        if last.elapsed() > Duration::from_millis(300) {
            last = Instant::now();
            let _ = app.emit("dl", DlEvent { id: id.into(), done, total, state: "run", error: None });
        }
    }
    drop(file);
    if total > 0 && done < total {
        return Err("Pobieranie przerwane przed końcem pliku".into());
    }
    if let Some(want) = expected {
        if hex(&hasher.finalize()) != want {
            let _ = std::fs::remove_file(&part);
            return Err("Pobrany plik jest uszkodzony (suma SHA-256 się nie zgadza). Pobierz ponownie.".into());
        }
    }
    std::fs::rename(&part, dest).map_err(|e| e.to_string())
}

/// Pobiera plik w tle; postęp przychodzi zdarzeniami `dl`. Przerwane pobieranie wznawia się od miejsca przerwania,
/// a gotowy plik jest sprawdzany sumą SHA-256 (podaną albo z Hugging Face).
#[tauri::command(async)]
pub fn dl_start(app: AppHandle, state: tauri::State<'_, LocalState>, id: String, url: String, dest: String, sha256: Option<String>) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Pobieranie tylko przez https".into());
    }
    let dest = safe_dest(&dest)?;
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut dls = state.downloads.lock().unwrap();
        if dls.contains_key(&id) {
            return Ok(());
        }
        dls.insert(id.clone(), stop.clone());
    }
    tauri::async_runtime::spawn(async move {
        let r = download(&app, &id, &url, &dest, sha256, &stop).await;
        if let Some(s) = tauri::Manager::try_state::<LocalState>(&app) {
            s.downloads.lock().unwrap().remove(&id);
        }
        let ev = match r {
            Ok(()) => DlEvent { id, done: 0, total: 0, state: "done", error: None },
            Err(e) => DlEvent { id, done: 0, total: 0, state: "error", error: Some(e) },
        };
        let _ = app.emit("dl", ev);
    });
    Ok(())
}

#[tauri::command(async)]
pub fn dl_cancel(state: tauri::State<'_, LocalState>, id: String) {
    if let Some(flag) = state.downloads.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Rozpakowuje archiwum (7z, zip, tar) systemowym tar (bsdtar w Windows 10+ i macOS) i usuwa archiwum.
#[tauri::command]
pub async fn archive_extract(archive: String, dest: String) -> Result<(), String> {
    let dest = safe_dest(&dest)?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        let tar = if cfg!(windows) { std::env::var("windir").map(|w| format!("{w}\\System32\\tar.exe")).unwrap_or("tar".into()) } else { "tar".into() };
        let mut cmd = Command::new(tar);
        cmd.arg("-xf").arg(&archive).arg("-C").arg(&dest).stdout(Stdio::null()).stderr(Stdio::piped());
        no_window(&mut cmd);
        let out = cmd.output().map_err(|e| format!("Nie mogę uruchomić tar: {e}"))?;
        if !out.status.success() {
            return Err(format!("Rozpakowanie nie powiodło się: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        let _ = std::fs::remove_file(&archive);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Rozmiary plików (None, gdy brak). Do sprawdzania, które modele są już pobrane.
#[tauri::command(async)]
pub fn fs_sizes(paths: Vec<String>) -> Vec<Option<u64>> {
    paths.iter().map(|p| std::fs::metadata(p).ok().filter(|m| m.is_file()).map(|m| m.len())).collect()
}

/// Usuwa plik modelu; tylko wewnątrz folderu models wskazanej instalacji ComfyUI.
#[tauri::command(async)]
pub fn comfy_model_remove(dir: String, rel: String) -> Result<(), String> {
    let inst = find_install(Path::new(&dir)).ok_or("Nie znaleziono ComfyUI")?;
    let rel = Path::new(&rel);
    if rel.is_absolute() || rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return Err("Niepoprawna ścieżka modelu".into());
    }
    let path = Path::new(&inst.models).join(rel);
    std::fs::remove_file(&path).map_err(|e| format!("Nie mogę usunąć {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rozpoznaje_producenta_karty() {
        assert_eq!(vendor_of("NVIDIA GeForce RTX 3060"), "nvidia");
        assert_eq!(vendor_of("AMD Radeon RX 7900 XTX"), "amd");
        assert_eq!(vendor_of("Intel(R) Arc(TM) A770"), "intel");
    }

    #[test]
    fn sciezka_docelowa_bez_wyjscia_poza_folder() {
        assert!(safe_dest("relative/file.bin").is_err());
        let base = std::env::temp_dir();
        assert!(safe_dest(base.join("a").join("..").join("b").to_str().unwrap()).is_err());
        assert!(safe_dest(base.join("models").join("x.safetensors").to_str().unwrap()).is_ok());
    }

    #[test]
    fn sha256_hex() {
        assert_eq!(hex(&Sha256::digest(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
