//! Sesje terminala na ConPTY (Windows) / openpty (Unix) przez portable-pty.
//! Wyjście idzie do frontendu kanałem Tauri jako tekst UTF-8; niepełne sekwencje bajtów
//! z końca paczki czekają na następną, żeby nie rozbijać znaków wielobajtowych.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::State;

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    command: String,
    started: u64,
}

#[derive(Default)]
pub struct Ptys {
    next: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PtyEvent {
    Data { data: String },
    Exit { code: Option<u32> },
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Integracja z powłoką: przy każdym prompcie powłoka zgłasza bieżący katalog sekwencją OSC
/// (PowerShell: OSC 7 z zakodowaną ścieżką; cmd i Git Bash: OSC 9;9; WSL: OSC 7 z hostem
/// wsl.localhost). Prompt użytkownika (profil, oh-my-posh) zostaje bez zmian.
const PS_CWD: &str = r#"$global:__txPrompt = $function:prompt
function global:prompt {
  $l = $executionContext.SessionState.Path.CurrentLocation
  if ($l.Provider.Name -eq 'FileSystem') {
    $u = ($l.ProviderPath -split '\\' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
    [Console]::Write("$([char]27)]7;file:///$u$([char]7)")
  }
  & $global:__txPrompt
}"#;
const BASH_WIN_CWD: &str = r#"printf '\033]9;9;%s\007' "$(cygpath -w "$PWD")""#;
const WSL_CWD: &str = r#"printf '\033]7;file://wsl.localhost/%s%s\007' "$WSL_DISTRO_NAME" "$PWD""#;

/// -EncodedCommand to Base64 z UTF-16LE: skrypt przechodzi bez kłopotów z cudzysłowami.
fn encode_ps(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Zamienia identyfikator powłoki z UI na komendę.
fn build_command(shell: &str, cwd: Option<&str>) -> CommandBuilder {
    let mut cmd = if let Some(distro) = shell.strip_prefix("wsl:") {
        let mut c = CommandBuilder::new("wsl.exe");
        if !distro.is_empty() {
            c.args(["-d", distro]);
        }
        // Ścieżka Windows nie ma sensu w WSL: startujemy w zapamiętanym katalogu Linuksa albo w domowym.
        c.args(["--cd", cwd.filter(|d| d.starts_with('/')).unwrap_or("~")]);
        c.env("PROMPT_COMMAND", WSL_CWD);
        let wslenv = std::env::var("WSLENV").unwrap_or_default();
        c.env("WSLENV", if wslenv.is_empty() { "PROMPT_COMMAND/u".to_string() } else { format!("{wslenv}:PROMPT_COMMAND/u") });
        c
    } else {
        match shell {
            "pwsh" | "powershell" => {
                let mut c = CommandBuilder::new(if shell == "pwsh" { "pwsh.exe" } else { "powershell.exe" });
                c.args(["-NoLogo", "-NoExit", "-EncodedCommand", &encode_ps(PS_CWD)]);
                c
            }
            "cmd" => {
                let mut c = CommandBuilder::new("cmd.exe");
                let base = std::env::var("PROMPT").unwrap_or_else(|_| "$P$G".into());
                c.env("PROMPT", format!("$E]9;9;$P$E\\{base}"));
                c
            }
            "gitbash" => {
                let mut c = CommandBuilder::new(r"C:\Program Files\Git\bin\bash.exe");
                c.args(["--login", "-i"]);
                c.env("PROMPT_COMMAND", BASH_WIN_CWD);
                c
            }
            other => CommandBuilder::new(other),
        }
    };
    if !shell.starts_with("wsl:") {
        if let Some(dir) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
            cmd.cwd(dir);
        } else if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            cmd.cwd(home);
        }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "TerminalX");
    cmd
}

#[tauri::command]
pub fn pty_spawn(
    state: State<'_, Arc<Ptys>>,
    shell: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Nie udało się otworzyć PTY: {e}"))?;
    let child = pair
        .slave
        .spawn_command(build_command(&shell, cwd.as_deref()))
        .map_err(|e| format!("Nie udało się uruchomić „{shell}”: {e}"))?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;

    state.sessions.lock().unwrap().insert(
        id,
        Session { master: pair.master, writer, child, command: shell.clone(), started: now_ms() },
    );

    let ptys = state.inner().clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    let valid = match std::str::from_utf8(&carry) {
                        Ok(_) => carry.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(), // niepełny znak na końcu
                        Err(_) => carry.len(),                                  // śmieci: zamień na U+FFFD
                    };
                    if valid == 0 {
                        continue;
                    }
                    let text = String::from_utf8_lossy(&carry[..valid]).into_owned();
                    carry.drain(..valid);
                    if on_event.send(PtyEvent::Data { data: text }).is_err() {
                        break;
                    }
                }
            }
        }
        let code = ptys
            .sessions
            .lock()
            .unwrap()
            .get_mut(&id)
            .and_then(|s| s.child.try_wait().ok().flatten())
            .map(|st| st.exit_code());
        let _ = on_event.send(PtyEvent::Exit { code });
    });

    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<'_, Arc<Ptys>>, id: u32, data: String) -> Result<(), String> {
    let mut map = state.sessions.lock().unwrap();
    let s = map.get_mut(&id).ok_or("Sesja nie istnieje")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, Arc<Ptys>>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map = state.sessions.lock().unwrap();
    let s = map.get(&id).ok_or("Sesja nie istnieje")?;
    s.master
        .resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, Arc<Ptys>>, id: u32) -> Result<(), String> {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    pid: Option<u32>,
    shell: String,
    started: u64,
    /// Procesy potomne powłoki (np. `node` dla `npm run dev`). Pusta lista = powłoka bezczynna.
    children: Vec<String>,
}

#[tauri::command]
pub fn pty_info(state: State<'_, Arc<Ptys>>, sys: State<'_, crate::sys::SysState>, id: u32) -> Result<PtyInfo, String> {
    let (pid, shell, started) = {
        let map = state.sessions.lock().unwrap();
        let s = map.get(&id).ok_or("Sesja nie istnieje")?;
        (s.child.process_id(), s.command.clone(), s.started)
    };
    let children = pid.map(|p| sys.children_of(p)).unwrap_or_default();
    Ok(PtyInfo { pid, shell, started, children })
}

pub fn kill_all(state: &Ptys) {
    for (_, mut s) in state.sessions.lock().unwrap().drain() {
        let _ = s.child.kill();
    }
}
