//! Sesje terminala na ConPTY (Windows) / openpty (Unix) przez portable-pty.
//! Wyjście idzie do frontendu jako surowe bajty (xterm sam składa znaki wielobajtowe).
//! Jeden wątek „wysyłacz” zbiera wyjście wszystkich sesji w paczki, więc zalew danych to kilka
//! dużych wiadomości zamiast tysięcy małych. Kontrola przepływu: frontend potwierdza (`pty_ack`)
//! przetworzone bajty; gdy zaległość przekroczy HIGH, czytanie staje, a program w powłoce czeka
//! na zapis jak w zwykłym terminalu. Pamięć nie rośnie nawet przy zawieszonym interfejsie.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

/// Zaległość (wysłane, a niepotwierdzone bajty), po której czytanie z PTY czeka.
const HIGH: usize = 2 * 1024 * 1024;
/// Największa paczka w jednej wiadomości.
const MAX_CHUNK: usize = 512 * 1024;

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
    out: Arc<Output>,
    command: String,
    started: u64,
}

#[derive(Default)]
struct OutState {
    buf: Vec<u8>,
    unacked: usize,
    eof: bool,
    closed: bool,
}

struct Output {
    id: u32,
    state: Mutex<OutState>,
    /// Budzi czytający wątek po potwierdzeniu albo zamknięciu.
    acked: Condvar,
    channel: Channel<InvokeResponseBody>,
}

#[derive(Default)]
pub struct Ptys {
    next: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
    dirty: Mutex<Vec<Arc<Output>>>,
    wake: Condvar,
    flusher: OnceLock<()>,
}

/// Zdarzenia sesji SSH (ssh.rs); terminal lokalny wysyła dane jako bajty, a koniec jako `Exit`.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PtyEvent {
    Data { data: String },
    Exit { code: Option<u32> },
}

impl Ptys {
    fn mark(&self, out: &Arc<Output>) {
        self.dirty.lock().unwrap().push(out.clone());
        self.wake.notify_one();
    }

    /// Wątek wysyłający: czeka na dane, chwilę zbiera kolejne (paczka zamiast okruchów) i wysyła.
    fn flush_loop(self: Arc<Self>) {
        loop {
            {
                let mut d = self.dirty.lock().unwrap();
                while d.is_empty() {
                    d = self.wake.wait(d).unwrap();
                }
            }
            std::thread::sleep(Duration::from_millis(4));
            let list = std::mem::take(&mut *self.dirty.lock().unwrap());
            let mut seen: Vec<u32> = Vec::with_capacity(list.len());
            for out in list {
                if seen.contains(&out.id) {
                    continue;
                }
                seen.push(out.id);
                self.drain(&out);
            }
        }
    }

    fn drain(&self, out: &Output) {
        loop {
            let (data, eof, more) = {
                let mut st = out.state.lock().unwrap();
                let n = st.buf.len().min(MAX_CHUNK);
                let data: Vec<u8> = st.buf.drain(..n).collect();
                st.unacked += data.len();
                (data, st.eof && st.buf.is_empty(), !st.buf.is_empty())
            };
            if !data.is_empty() && out.channel.send(InvokeResponseBody::Raw(data)).is_err() {
                out.state.lock().unwrap().closed = true;
                out.acked.notify_all();
                return;
            }
            if eof {
                let code = self
                    .sessions
                    .lock()
                    .unwrap()
                    .get_mut(&out.id)
                    .and_then(|s| s.child.try_wait().ok().flatten())
                    .map(|st| st.exit_code());
                let ev = serde_json::to_string(&PtyEvent::Exit { code }).unwrap_or_default();
                let _ = out.channel.send(InvokeResponseBody::Json(ev));
                return;
            }
            if !more {
                return;
            }
        }
    }
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
    cmd.env("TERM_PROGRAM", "Hermitty");
    cmd
}

#[tauri::command(async)]
pub fn pty_spawn(
    state: State<'_, Arc<Ptys>>,
    shell: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<InvokeResponseBody>,
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
    let out = Arc::new(Output { id, state: Mutex::new(OutState::default()), acked: Condvar::new(), channel: on_event });

    let ptys = state.inner().clone();
    ptys.flusher.get_or_init(|| {
        let p = ptys.clone();
        std::thread::spawn(move || p.flush_loop());
    });
    state.sessions.lock().unwrap().insert(
        id,
        Session { master: pair.master, writer: Arc::new(Mutex::new(writer)), child, out: out.clone(), command: shell.clone(), started: now_ms() },
    );

    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let mut st = out.state.lock().unwrap();
            if st.closed {
                return;
            }
            let was_empty = st.buf.is_empty();
            st.buf.extend_from_slice(&buf[..n]);
            if was_empty {
                ptys.mark(&out);
            }
            // Kontrola przepływu: interfejs nie nadąża (albo stoi), więc na razie nie czytamy.
            while st.unacked + st.buf.len() > HIGH && !st.closed {
                st = out.acked.wait(st).unwrap();
            }
        }
        out.state.lock().unwrap().eof = true;
        ptys.mark(&out);
    });

    Ok(id)
}

/// Frontend przetworzył `bytes` bajtów wyjścia.
#[tauri::command(async)]
pub fn pty_ack(state: State<'_, Arc<Ptys>>, id: u32, bytes: usize) {
    let out = state.sessions.lock().unwrap().get(&id).map(|s| s.out.clone());
    if let Some(out) = out {
        let mut st = out.state.lock().unwrap();
        st.unacked = st.unacked.saturating_sub(bytes);
        out.acked.notify_all();
    }
}

/// Zapis w osobnym wątku i poza wspólną blokadą: duże wklejenie do programu, który nie czyta
/// wejścia, czeka samo, a nie zatrzymuje głównego wątku ani innych terminali.
#[tauri::command]
pub async fn pty_write(state: State<'_, Arc<Ptys>>, id: u32, data: String) -> Result<(), String> {
    let writer = state.sessions.lock().unwrap().get(&id).map(|s| s.writer.clone()).ok_or("Sesja nie istnieje")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut w = writer.lock().unwrap();
        w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
pub fn pty_resize(state: State<'_, Arc<Ptys>>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map = state.sessions.lock().unwrap();
    let s = map.get(&id).ok_or("Sesja nie istnieje")?;
    s.master
        .resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

fn close(mut s: Session) {
    s.out.state.lock().unwrap().closed = true;
    s.out.acked.notify_all();
    let _ = s.child.kill();
}

#[tauri::command(async)]
pub fn pty_kill(state: State<'_, Arc<Ptys>>, id: u32) -> Result<(), String> {
    let s = state.sessions.lock().unwrap().remove(&id);
    if let Some(s) = s {
        close(s);
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

#[tauri::command(async)]
pub fn pty_info(state: State<'_, Arc<Ptys>>, sys: State<'_, crate::sys::SysState>, id: u32) -> Result<PtyInfo, String> {
    let (pid, shell, started) = {
        let map = state.sessions.lock().unwrap();
        let s = map.get(&id).ok_or("Sesja nie istnieje")?;
        (s.child.process_id(), s.command.clone(), s.started)
    };
    let children = pid.map(|p| sys.children_of(p)).unwrap_or_default();
    Ok(PtyInfo { pid, shell, started, children })
}

/// Start (albo przeładowanie) interfejsu: sesje z poprzedniej strony nie mają już odbiorcy.
#[tauri::command(async)]
pub fn pty_reset(state: State<'_, Arc<Ptys>>) {
    kill_all(&state);
}

pub fn kill_all(state: &Ptys) {
    let all: Vec<Session> = state.sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
    all.into_iter().for_each(close);
}
