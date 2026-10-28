//! Informacje o systemie, uruchamianie komend i zapytania HTTP dla workflow i pluginów.

use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessesToUpdate, System};

pub struct SysState(Mutex<System>);

impl Default for SysState {
    fn default() -> Self {
        SysState(Mutex::new(System::new()))
    }
}

impl SysState {
    /// Nazwy procesów potomnych (w dół drzewa), bez pomocniczych procesów konsoli.
    pub fn children_of(&self, root: u32) -> Vec<String> {
        let mut sys = self.0.lock().unwrap();
        sys.refresh_processes(ProcessesToUpdate::All, true);
        let mut by_parent: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for (pid, p) in sys.processes() {
            if let Some(parent) = p.parent() {
                by_parent.entry(parent).or_default().push(*pid);
            }
        }
        let mut out = Vec::new();
        let mut stack = vec![Pid::from_u32(root)];
        while let Some(pid) = stack.pop() {
            for child in by_parent.get(&pid).cloned().unwrap_or_default() {
                if let Some(p) = sys.process(child) {
                    let name = p.name().to_string_lossy().to_string();
                    let lower = name.to_lowercase();
                    if !matches!(lower.as_str(), "conhost.exe" | "openconsole.exe") {
                        out.push(name);
                    }
                }
                stack.push(child);
            }
        }
        out
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    cpu: f32,
    mem_used: u64,
    mem_total: u64,
    app_mem: u64,
}

#[tauri::command]
pub fn sys_stats(state: tauri::State<'_, SysState>) -> Stats {
    let mut sys = state.0.lock().unwrap();
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    let me = Pid::from_u32(std::process::id());
    sys.refresh_processes(ProcessesToUpdate::Some(&[me]), true);
    // WebView2 działa w osobnych procesach; tu liczymy tylko rdzeń aplikacji.
    let app_mem = sys.process(me).map(|p| p.memory()).unwrap_or(0);
    Stats { cpu: sys.global_cpu_usage(), mem_used: sys.used_memory(), mem_total: sys.total_memory(), app_mem }
}

#[derive(Serialize)]
pub struct ExecResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}
pub type ExecOut = ExecResult;

fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let _ = cmd;
}

fn decode(bytes: &[u8]) -> String {
    // wsl.exe -l zwraca UTF-16LE; reszta to UTF-8 albo strona kodowa konsoli.
    if bytes.len() >= 2 && bytes.len() % 2 == 0 && bytes.iter().skip(1).step_by(2).filter(|b| **b == 0).count() > bytes.len() / 4 {
        let words: Vec<u16> = bytes.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&words).replace('\u{feff}', "");
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn exec_blocking(program: &str, args: &[String], cwd: Option<&str>, timeout_ms: u64) -> Result<ExecResult, String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }
    no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Nie udało się uruchomić „{program}”: {e}"))?;
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let t_out = std::thread::spawn(move || { let mut b = Vec::new(); let _ = out.read_to_end(&mut b); b });
    let t_err = std::thread::spawn(move || { let mut b = Vec::new(); let _ = err.read_to_end(&mut b); b });
    let start = Instant::now();
    let code = loop {
        if let Some(st) = child.try_wait().map_err(|e| e.to_string())? {
            break st.code().unwrap_or(-1);
        }
        if start.elapsed() > Duration::from_millis(timeout_ms) {
            let _ = child.kill();
            return Err(format!("Przekroczono limit czasu ({} s)", timeout_ms / 1000));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    Ok(ExecResult { code, stdout: decode(&t_out.join().unwrap_or_default()), stderr: decode(&t_err.join().unwrap_or_default()) })
}

/// Uruchamia program z argumentami (pluginy z uprawnieniem shell:exec).
#[tauri::command]
pub async fn sys_exec(cmd: String, args: Vec<String>, cwd: Option<String>, timeout_ms: Option<u64>) -> Result<ExecResult, String> {
    tauri::async_runtime::spawn_blocking(move || exec_blocking(&cmd, &args, cwd.as_deref(), timeout_ms.unwrap_or(60_000)))
        .await
        .map_err(|e| e.to_string())?
}

/// Uruchamia skrypt w wybranej powłoce (node „Uruchom komendę” w workflow).
#[tauri::command]
pub async fn sys_run_script(shell: String, script: String, cwd: Option<String>, timeout_ms: Option<u64>) -> Result<ExecResult, String> {
    let (program, args): (String, Vec<String>) = match shell.as_str() {
        "cmd" => ("cmd.exe".into(), vec!["/C".into(), script]),
        "powershell" => ("powershell.exe".into(), vec!["-NoProfile".into(), "-Command".into(), script]),
        s if s.starts_with("wsl") => {
            let distro = s.strip_prefix("wsl:").unwrap_or("");
            let mut a = vec![];
            if !distro.is_empty() { a.push("-d".into()); a.push(distro.to_string()); }
            a.extend(["-e".into(), "bash".into(), "-lc".into(), script]);
            ("wsl.exe".into(), a)
        }
        _ => ("pwsh.exe".into(), vec!["-NoProfile".into(), "-Command".into(), script]),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let r = exec_blocking(&program, &args, cwd.as_deref(), timeout_ms.unwrap_or(300_000));
        // pwsh może nie być zainstalowany; wtedy Windows PowerShell.
        match r {
            Err(e) if program == "pwsh.exe" && e.contains("uruchomić") => {
                let mut a = args.clone();
                a.insert(0, "-NoProfile".into());
                a.dedup();
                exec_blocking("powershell.exe", &a, cwd.as_deref(), timeout_ms.unwrap_or(300_000))
            }
            other => other,
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct ShellInfo {
    id: String,
    name: String,
    kind: String,
}

/// Wykrywa dostępne powłoki: PowerShell 7, Windows PowerShell, CMD, dystrybucje WSL, Git Bash.
#[tauri::command]
pub async fn sys_shells() -> Vec<ShellInfo> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut out = Vec::new();
        let has = |exe: &str| exec_blocking("where.exe", &[exe.to_string()], None, 5000).map(|r| r.code == 0).unwrap_or(false);
        if cfg!(windows) {
            if has("pwsh.exe") {
                out.push(ShellInfo { id: "pwsh".into(), name: "PowerShell 7".into(), kind: "ps".into() });
            }
            out.push(ShellInfo { id: "powershell".into(), name: "Windows PowerShell".into(), kind: "ps5".into() });
            out.push(ShellInfo { id: "cmd".into(), name: "Wiersz poleceń".into(), kind: "cmd".into() });
            if let Ok(r) = exec_blocking("wsl.exe", &["-l".into(), "-q".into()], None, 8000) {
                if r.code == 0 {
                    for line in r.stdout.lines().map(|l| l.trim().trim_matches('\0')).filter(|l| !l.is_empty()) {
                        // Wewnętrzne dystrybucje Docker/Rancher Desktop nie służą do pracy w terminalu.
                        if line.starts_with("docker-desktop") || line.starts_with("rancher-desktop") { continue; }
                        out.push(ShellInfo { id: format!("wsl:{line}"), name: format!("WSL · {line}"), kind: "wsl".into() });
                    }
                }
            }
            if std::path::Path::new(r"C:\Program Files\Git\bin\bash.exe").exists() {
                out.push(ShellInfo { id: "gitbash".into(), name: "Git Bash".into(), kind: "bash".into() });
            }
        } else {
            let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
            out.push(ShellInfo { id: sh.clone(), name: sh, kind: "bash".into() });
        }
        out
    })
    .await
    .unwrap_or_default()
}

/// Pliki użytkownika dla nodów workflow „Czytaj / Zapisz / Lista plików”. Workflow uruchamia użytkownik,
/// więc ma te same prawa co on; pluginy nie mają dostępu do tych komend.
#[tauri::command]
pub fn fs_read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
pub fn fs_write_text(path: String, data: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, data).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
pub fn fs_list(dir: String) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| format!("{dir}: {e}"))?
        .flatten()
        .map(|e| e.path().to_string_lossy().into_owned())
        .collect();
    out.sort();
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry { name: String, path: String, is_dir: bool, size: u64, modified: u64 }

/// Lokalny katalog dla panelu SFTP: foldery najpierw, potem pliki.
#[tauri::command]
pub fn fs_list_detail(dir: String) -> Result<(String, Vec<LocalEntry>), String> {
    let base = if dir.is_empty() {
        std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_else(|_| ".".into())
    } else { dir };
    let canon = std::fs::canonicalize(&base).map_err(|e| format!("{base}: {e}"))?;
    let shown = canon.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    let mut out: Vec<LocalEntry> = std::fs::read_dir(&canon)
        .map_err(|e| format!("{shown}: {e}"))?
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            let modified = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            let path = e.path().to_string_lossy().trim_start_matches(r"\\?\").to_string();
            Some(LocalEntry { name: e.file_name().to_string_lossy().into_owned(), path, is_dir: m.is_dir(), size: m.len(), modified })
        })
        .collect();
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok((shown, out))
}

#[derive(Serialize)]
pub struct HttpResult {
    status: u16,
    body: String,
}

/// Zapytanie HTTP z rdzenia (bez ograniczeń CORS webview): workflow, import motywu tweakcn, pluginy z net:*.
#[tauri::command]
pub async fn http_request(method: String, url: String, headers: Option<HashMap<String, String>>, body: Option<String>) -> Result<HttpResult, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Obsługiwane są tylko adresy http(s)".into());
    }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(60)).build().map_err(|e| e.to_string())?;
    let m = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client.request(m, &url).header("user-agent", "TerminalX");
    for (k, v) in headers.unwrap_or_default() {
        req = req.header(k, v);
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    let res = req.send().await.map_err(|e| format!("Błąd połączenia: {e}"))?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(HttpResult { status, body })
}

#[cfg(test)]
mod tests {
    use super::decode;

    #[test]
    fn dekoduje_utf16_z_wsl() {
        let utf16: Vec<u8> = "Ubuntu\r\n".encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
        assert_eq!(decode(&utf16), "Ubuntu\r\n");
        assert_eq!(decode("zażółć".as_bytes()), "zażółć");
    }
}
