//! Android przez ADB (wtyczka „Android (ADB)”): parowanie bezprzewodowe (kod QR jak w Android Studio albo kod
//! z telefonu), lista urządzeń, zrzut ekranu, podgląd na żywo przez scrcpy, pliki i instalacja APK.
//! ADB i scrcpy: z PATH, z Android SDK albo pobrane przez aplikację do folderu danych (tools/).
//! Uzupełnia mostek Telefon (phone.rs): ten działa bez debugowania, ADB daje pełny dostęp deweloperski.

use base64::Engine;
use rand::Rng;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const EXE: &str = if cfg!(windows) { ".exe" } else { "" };

fn tools_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::store::data_dir(app)?.join("tools"))
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(format!("{name}{EXE}"))).find(|p| p.is_file())
}

/// adb: najpierw pobrany przez aplikację, potem PATH, potem typowe miejsca Android SDK.
fn adb_path(app: &AppHandle) -> Option<PathBuf> {
    let own = tools_dir(app).ok()?.join("platform-tools").join(format!("adb{EXE}"));
    if own.is_file() {
        return Some(own);
    }
    if let Some(p) = which("adb") {
        return Some(p);
    }
    let mut roots: Vec<PathBuf> = ["ANDROID_HOME", "ANDROID_SDK_ROOT"].iter().filter_map(|v| std::env::var_os(v)).map(PathBuf::from).collect();
    if let Some(l) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(l).join("Android").join("Sdk"));
    }
    if let Some(h) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(&h).join("Android").join("Sdk"));
        roots.push(PathBuf::from(&h).join("Library").join("Android").join("sdk"));
    }
    roots.into_iter().map(|r| r.join("platform-tools").join(format!("adb{EXE}"))).find(|p| p.is_file())
}

fn scrcpy_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = tools_dir(app).ok()?.join("scrcpy");
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path().join(format!("scrcpy{EXE}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let flat = dir.join(format!("scrcpy{EXE}"));
    if flat.is_file() {
        return Some(flat);
    }
    which("scrcpy")
}

fn valid_serial(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 120 || !s.chars().all(|c| c.is_ascii_alphanumeric() || "._:-[]%".contains(c)) {
        return Err(format!("Niepoprawny identyfikator urządzenia: {s}"));
    }
    Ok(())
}

/// Ścieżka w powłoce telefonu w apostrofach (sh), z obsługą apostrofów w nazwie.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[derive(Serialize)]
pub struct Out {
    code: Option<i32>,
    output: String,
}

async fn run(app: &AppHandle, args: &[&str], secs: u64) -> Result<Out, String> {
    let adb = adb_path(app).ok_or("Nie znaleziono ADB. Kliknij „Pobierz ADB” w sekcji Android.")?;
    let mut cmd = tokio::process::Command::new(adb);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let child = cmd.spawn().map_err(|e| format!("Nie udało się uruchomić ADB: {e}"))?;
    let out = tokio::time::timeout(Duration::from_secs(secs), child.wait_with_output())
        .await
        .map_err(|_| format!("ADB nie odpowiedział w {secs} s"))?
        .map_err(|e| e.to_string())?;
    let mut output = String::from_utf8_lossy(&out.stdout).into_owned();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(&err);
    }
    Ok(Out { code: out.status.code(), output })
}

/// Jak `run`, ale niezerowy kod wyjścia (albo typowy komunikat błędu adb) staje się błędem.
async fn run_ok(app: &AppHandle, args: &[&str], secs: u64) -> Result<String, String> {
    let o = run(app, args, secs).await?;
    let low = o.output.to_lowercase();
    if o.code != Some(0) || low.starts_with("error") || low.contains("failed to") || low.contains("unable to") {
        return Err(o.output.trim().to_string());
    }
    Ok(o.output)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    adb: Option<String>,
    version: String,
    scrcpy: Option<String>,
    can_download_scrcpy: bool,
}

#[tauri::command]
pub async fn adb_status(app: AppHandle) -> Result<Status, String> {
    let adb = adb_path(&app);
    let version = if adb.is_some() {
        run(&app, &["version"], 10).await.map(|o| o.output.lines().next().unwrap_or("").to_string()).unwrap_or_default()
    } else {
        String::new()
    };
    Ok(Status {
        adb: adb.map(|p| p.display().to_string()),
        version,
        scrcpy: scrcpy_path(&app).map(|p| p.display().to_string()),
        can_download_scrcpy: cfg!(windows),
    })
}

async fn download(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder().user_agent("Hermitty").timeout(Duration::from_secs(600)).build().map_err(|e| e.to_string())?;
    let res = client.get(url).send().await.map_err(|e| format!("Błąd pobierania {url}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Pobieranie {url}: {}", res.status()));
    }
    Ok(res.bytes().await.map_err(|e| e.to_string())?.to_vec())
}

fn unzip(data: &[u8], into: &Path) -> Result<(), String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(data)).map_err(|e| e.to_string())?;
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = f.enclosed_name() else { continue };
        let out = into.join(rel);
        if f.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(d) = out.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        let mut w = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut w).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        if let Some(mode) = f.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode));
        }
    }
    Ok(())
}

/// Pobiera oficjalne platform-tools Google (adb) albo scrcpy (Windows, najnowsze wydanie z GitHuba) do folderu danych.
#[tauri::command]
pub async fn adb_get_tools(app: AppHandle, which: String) -> Result<String, String> {
    let dir = tools_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    match which.as_str() {
        "adb" => {
            let os = if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" };
            let data = download(&format!("https://dl.google.com/android/repository/platform-tools-latest-{os}.zip")).await?;
            let _ = std::fs::remove_dir_all(dir.join("platform-tools"));
            unzip(&data, &dir)?;
            adb_path(&app).map(|p| p.display().to_string()).ok_or("Pobrano, ale nie znaleziono adb w archiwum.".into())
        }
        "scrcpy" => {
            if !cfg!(windows) {
                return Err("Na tym systemie zainstaluj scrcpy z menedżera pakietów (np. apt install scrcpy, brew install scrcpy).".into());
            }
            let client = reqwest::Client::builder().user_agent("Hermitty").build().map_err(|e| e.to_string())?;
            let rel: serde_json::Value = client
                .get("https://api.github.com/repos/Genymobile/scrcpy/releases/latest")
                .send()
                .await
                .map_err(|e| e.to_string())?
                .json()
                .await
                .map_err(|e| e.to_string())?;
            let url = rel["assets"]
                .as_array()
                .and_then(|a| a.iter().find(|x| x["name"].as_str().is_some_and(|n| n.contains("win64") && n.ends_with(".zip"))))
                .and_then(|x| x["browser_download_url"].as_str())
                .ok_or("Nie znaleziono scrcpy dla Windows w najnowszym wydaniu.")?
                .to_string();
            let data = download(&url).await?;
            let _ = std::fs::remove_dir_all(dir.join("scrcpy"));
            unzip(&data, &dir.join("scrcpy"))?;
            scrcpy_path(&app).map(|p| p.display().to_string()).ok_or("Pobrano, ale nie znaleziono scrcpy w archiwum.".into())
        }
        _ => Err("Nieznane narzędzie".into()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    serial: String,
    state: String,
    model: String,
    product: String,
    wifi: bool,
}

/// Wynik `adb devices -l`.
fn parse_devices(text: &str) -> Vec<Device> {
    text.lines()
        .skip_while(|l| !l.starts_with("List of devices"))
        .skip(1)
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let serial = it.next()?.to_string();
            let state = it.next()?.to_string();
            let mut model = String::new();
            let mut product = String::new();
            for kv in it {
                if let Some(v) = kv.strip_prefix("model:") { model = v.replace('_', " "); }
                if let Some(v) = kv.strip_prefix("product:") { product = v.to_string(); }
            }
            let wifi = serial.contains(':') || serial.contains("._adb-tls-connect");
            Some(Device { serial, state, model, product, wifi })
        })
        .collect()
}

#[tauri::command]
pub async fn adb_devices(app: AppHandle) -> Result<Vec<Device>, String> {
    Ok(parse_devices(&run_ok(&app, &["devices", "-l"], 20).await?))
}

fn valid_addr(a: &str) -> Result<(), String> {
    let ok = a.rsplit_once(':').is_some_and(|(h, p)| !h.is_empty() && p.parse::<u16>().is_ok() && h.chars().all(|c| c.is_ascii_alphanumeric() || ".-[]:%".contains(c)));
    if ok { Ok(()) } else { Err(format!("Podaj adres w postaci IP:port, np. 192.168.1.30:37123 (jest: {a})")) }
}

/// Parowanie kodem: Ustawienia telefonu → Opcje programistyczne → Debugowanie bezprzewodowe → „Sparuj urządzenie za pomocą kodu”.
#[tauri::command]
pub async fn adb_pair(app: AppHandle, addr: String, code: String) -> Result<String, String> {
    valid_addr(&addr)?;
    if code.is_empty() || code.len() > 64 || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Kod parowania to cyfry z ekranu telefonu.".into());
    }
    let out = run_ok(&app, &["pair", &addr, &code], 40).await?;
    if !out.to_lowercase().contains("success") {
        return Err(out.trim().to_string());
    }
    // Po parowaniu adb sam łączy się przez mDNS; na wszelki wypadek łączymy znalezione usługi.
    let _ = connect_known(&app).await;
    Ok(out.trim().to_string())
}

#[tauri::command]
pub async fn adb_connect(app: AppHandle, addr: String) -> Result<String, String> {
    valid_addr(&addr)?;
    let out = run_ok(&app, &["connect", &addr], 30).await?;
    if out.contains("cannot") || out.contains("failed") {
        return Err(out.trim().to_string());
    }
    Ok(out.trim().to_string())
}

#[tauri::command]
pub async fn adb_disconnect(app: AppHandle, serial: String) -> Result<(), String> {
    valid_serial(&serial)?;
    run(&app, &["disconnect", &serial], 15).await.map(|_| ())
}

/// Usługi z `adb mdns services`: (nazwa instancji, typ, adres).
fn parse_mdns(text: &str) -> Vec<(String, String, String)> {
    text.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let name = it.next()?.to_string();
            let kind = it.next()?.to_string();
            let addr = it.next()?.to_string();
            kind.starts_with("_adb").then_some((name, kind, addr))
        })
        .collect()
}

async fn connect_known(app: &AppHandle) -> Result<(), String> {
    let out = run(app, &["mdns", "services"], 10).await?;
    for (_, kind, addr) in parse_mdns(&out.output) {
        if kind.starts_with("_adb-tls-connect") && valid_addr(&addr).is_ok() {
            let _ = run(app, &["connect", &addr], 10).await;
        }
    }
    Ok(())
}

#[derive(Serialize)]
pub struct QrPair {
    name: String,
    password: String,
    qr: String,
}

/// Kod QR do „Sparuj urządzenie za pomocą kodu QR” na telefonie (format Android Studio).
#[tauri::command]
pub fn adb_qr_begin() -> QrPair {
    const CH: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
    let mut r = rand::thread_rng();
    let mut pick = |n: usize| (0..n).map(|_| CH[r.gen_range(0..CH.len())] as char).collect::<String>();
    let name = format!("hermitty-{}", pick(6));
    let password = pick(10);
    let qr = format!("WIFI:T:ADB;S:{name};P:{password};;");
    QrPair { name, password, qr }
}

/// Po zeskanowaniu telefon ogłasza usługę parowania z nazwą z kodu; wtedy parujemy hasłem z kodu.
/// Zwraca None, dopóki telefon się nie pojawi.
#[tauri::command]
pub async fn adb_qr_poll(app: AppHandle, name: String, password: String) -> Result<Option<String>, String> {
    if !name.starts_with("hermitty-") || !password.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Niepoprawny kod".into());
    }
    let out = run(&app, &["mdns", "services"], 10).await?;
    let Some((_, _, addr)) = parse_mdns(&out.output).into_iter().find(|(n, k, _)| n == &name && k.starts_with("_adb-tls-pairing")) else {
        return Ok(None);
    };
    let res = run_ok(&app, &["pair", &addr, &password], 40).await?;
    if !res.to_lowercase().contains("success") {
        return Err(res.trim().to_string());
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    let _ = connect_known(&app).await;
    Ok(Some(res.trim().to_string()))
}

#[tauri::command]
pub async fn adb_shell(app: AppHandle, serial: String, command: String) -> Result<Out, String> {
    valid_serial(&serial)?;
    run(&app, &["-s", &serial, "shell", &command], 120).await
}

/// Krótkie informacje o urządzeniu: model, Android, bateria, ekran.
#[tauri::command]
pub async fn adb_info(app: AppHandle, serial: String) -> Result<serde_json::Value, String> {
    valid_serial(&serial)?;
    let q = "getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.build.version.release; dumpsys battery | grep -E 'level|status|temperature' ; wm size";
    let o = run_ok(&app, &["-s", &serial, "shell", q], 20).await?;
    let lines: Vec<&str> = o.lines().map(|l| l.trim()).collect();
    let find = |k: &str| lines.iter().find_map(|l| l.strip_prefix(k).map(|v| v.trim().to_string())).unwrap_or_default();
    Ok(serde_json::json!({
        "maker": lines.first().copied().unwrap_or(""),
        "model": lines.get(1).copied().unwrap_or(""),
        "android": lines.get(2).copied().unwrap_or(""),
        "battery": find("level:"),
        "status": find("status:"),
        "screen": find("Physical size:"),
    }))
}

/// Zrzut ekranu jako PNG w base64.
#[tauri::command]
pub async fn adb_screenshot(app: AppHandle, serial: String) -> Result<String, String> {
    valid_serial(&serial)?;
    let adb = adb_path(&app).ok_or("Nie znaleziono ADB.")?;
    let mut cmd = tokio::process::Command::new(adb);
    cmd.args(["-s", &serial, "exec-out", "screencap", "-p"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let out = tokio::time::timeout(Duration::from_secs(30), cmd.output()).await.map_err(|_| "Zrzut trwał za długo".to_string())?.map_err(|e| e.to_string())?;
    if !out.stdout.starts_with(b"\x89PNG") {
        return Err(format!("Nie udało się zrobić zrzutu: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(out.stdout))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

/// Zawartość folderu na telefonie (domyślnie pamięć wewnętrzna /sdcard).
#[tauri::command]
pub async fn adb_ls(app: AppHandle, serial: String, path: String) -> Result<Vec<Entry>, String> {
    valid_serial(&serial)?;
    let dir = if path.trim().is_empty() { "/sdcard".to_string() } else { path.trim_end_matches('/').to_string() };
    let dir = if dir.is_empty() { "/".to_string() } else { dir };
    let out = run(&app, &["-s", &serial, "shell", &format!("cd {} && ls -1p -A", sh_quote(&dir))], 30).await?;
    if out.code != Some(0) {
        return Err(out.output.trim().to_string());
    }
    let mut v: Vec<Entry> = out
        .output
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| {
            let is_dir = l.ends_with('/');
            let name = l.trim_end_matches('/').to_string();
            let path = if dir == "/" { format!("/{name}") } else { format!("{dir}/{name}") };
            Entry { name, path, is_dir }
        })
        .collect();
    v.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(v)
}

/// Pobiera plik albo folder z telefonu do Pobrane/Hermitty; zwraca ścieżkę na komputerze.
#[tauri::command]
pub async fn adb_pull(app: AppHandle, serial: String, remote: String) -> Result<String, String> {
    valid_serial(&serial)?;
    if !remote.starts_with('/') {
        return Err("Podaj pełną ścieżkę na telefonie".into());
    }
    let base = app.path().download_dir().map_err(|e| e.to_string())?.join("Hermitty");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let name = Path::new(&remote).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "plik".into());
    let mut target = base.join(&name);
    let mut n = 2;
    while target.exists() {
        target = base.join(format!("{n} {name}"));
        n += 1;
    }
    let t = target.display().to_string();
    run_ok(&app, &["-s", &serial, "pull", &remote, &t], 1800).await?;
    Ok(t)
}

/// Wybór plików na komputerze i wysłanie ich do folderu na telefonie.
#[tauri::command]
pub async fn adb_push(app: AppHandle, serial: String, remote_dir: String) -> Result<Vec<String>, String> {
    valid_serial(&serial)?;
    if !remote_dir.starts_with('/') {
        return Err("Podaj pełną ścieżkę folderu na telefonie".into());
    }
    let a = app.clone();
    let files = tauri::async_runtime::spawn_blocking(move || a.dialog().file().set_title("Wyślij na telefon").blocking_pick_files())
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let mut sent = Vec::new();
    for f in files {
        let p = f.into_path().map_err(|e| e.to_string())?;
        let s = p.display().to_string();
        run_ok(&app, &["-s", &serial, "push", &s, &format!("{}/", remote_dir.trim_end_matches('/'))], 1800).await?;
        sent.push(p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(s));
    }
    Ok(sent)
}

/// Wybór pliku APK na komputerze i instalacja (z aktualizacją, -r).
#[tauri::command]
pub async fn adb_install(app: AppHandle, serial: String) -> Result<Option<String>, String> {
    valid_serial(&serial)?;
    let a = app.clone();
    let file = tauri::async_runtime::spawn_blocking(move || a.dialog().file().set_title("Zainstaluj APK na telefonie").add_filter("Aplikacja Android", &["apk"]).blocking_pick_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(file) = file else { return Ok(None) };
    let p = file.into_path().map_err(|e| e.to_string())?.display().to_string();
    let out = run_ok(&app, &["-s", &serial, "install", "-r", &p], 600).await?;
    if !out.contains("Success") {
        return Err(out.trim().to_string());
    }
    Ok(Some(Path::new(&p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(p)))
}

/// Podgląd i sterowanie ekranem w osobnym oknie scrcpy.
#[tauri::command]
pub async fn adb_mirror(app: AppHandle, serial: String) -> Result<(), String> {
    valid_serial(&serial)?;
    let scrcpy = scrcpy_path(&app).ok_or("Brak scrcpy. Kliknij „Pobierz scrcpy”.")?;
    let mut cmd = std::process::Command::new(&scrcpy);
    cmd.args(["-s", &serial, "--window-title", &format!("Hermitty · {serial}")]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    if let Some(adb) = adb_path(&app) {
        cmd.env("ADB", adb);
    }
    if let Some(d) = scrcpy.parent() {
        cmd.current_dir(d);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn().map_err(|e| format!("Nie udało się uruchomić scrcpy: {e}"))?;
    Ok(())
}

/// Pokazuje pobrany plik w Eksploratorze (tylko z folderu Pobrane/Hermitty).
#[tauri::command]
pub fn adb_reveal(app: AppHandle, path: String) -> Result<(), String> {
    let base = app.path().download_dir().map_err(|e| e.to_string())?.join("Hermitty");
    let p = PathBuf::from(&path);
    let (Ok(base), Ok(full)) = (base.canonicalize(), p.canonicalize()) else { return Err("Nie ma takiego pliku".into()) };
    if !full.starts_with(&base) {
        return Err("Ten plik nie pochodzi z telefonu".into());
    }
    #[cfg(windows)]
    {
        let s = full.to_string_lossy().trim_start_matches(r"\\?\").to_string();
        std::process::Command::new("explorer").arg(format!("/select,{s}")).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let dir = full.parent().unwrap_or(&full);
        let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(opener).arg(dir).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices_parse() {
        let t = "* daemon started successfully\nList of devices attached\n192.168.1.30:41235  device product:Asteroids model:A059 device:Asteroids transport_id:3\nR5CT  unauthorized usb:1-1 transport_id:1\n\n";
        let d = parse_devices(t);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].serial, "192.168.1.30:41235");
        assert!(d[0].wifi);
        assert_eq!(d[0].model, "A059");
        assert_eq!(d[1].state, "unauthorized");
        assert!(!d[1].wifi);
    }

    #[test]
    fn mdns_parse() {
        let t = "List of discovered mdns services\nhermitty-abc123\t_adb-tls-pairing._tcp\t192.168.1.30:37019\nadb-XYZ-1a2b\t_adb-tls-connect._tcp\t192.168.1.30:41235\n";
        let m = parse_mdns(t);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0], ("hermitty-abc123".into(), "_adb-tls-pairing._tcp".into(), "192.168.1.30:37019".into()));
    }

    #[test]
    fn quoting_and_validation() {
        assert_eq!(sh_quote("/sdcard/it's"), "'/sdcard/it'\\''s'");
        assert!(valid_serial("192.168.1.30:41235").is_ok());
        assert!(valid_serial("adb-XYZ._adb-tls-connect._tcp").is_ok());
        assert!(valid_serial("x; rm -rf /").is_err());
        assert!(valid_addr("192.168.1.30:37019").is_ok());
        assert!(valid_addr("192.168.1.30").is_err());
        assert!(valid_addr("a b:1").is_err());
        let q = adb_qr_begin();
        assert!(q.qr.starts_with("WIFI:T:ADB;S:hermitty-") && q.qr.ends_with(";;"));
    }
}
