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

/// Zamienia identyfikator powłoki z UI na komendę.
fn build_command(shell: &str, cwd: Option<&str>) -> CommandBuilder {
    let mut cmd = if let Some(distro) = shell.strip_prefix("wsl:") {
        let mut c = CommandBuilder::new("wsl.exe");
        if !distro.is_empty() {
            c.args(["-d", distro]);
        }
        // Katalog Windows nie ma sensu w WSL; startujemy w katalogu domowym dystrybucji.
        c.args(["--cd", "~"]);
        c
    } else {
        match shell {
            "pwsh" => {
                let mut c = CommandBuilder::new("pwsh.exe");
                c.arg("-NoLogo");
                c
            }
            "powershell" => {
                let mut c = CommandBuilder::new("powershell.exe");
                c.arg("-NoLogo");
                c
            }
            "cmd" => CommandBuilder::new("cmd.exe"),
            "gitbash" => {
                let mut c = CommandBuilder::new(r"C:\Program Files\Git\bin\bash.exe");
                c.args(["--login", "-i"]);
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
