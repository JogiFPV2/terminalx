// Zainstalowane narzędzia AI w wierszu poleceń (Claude Code, Codex, Gemini CLI, Amp, OpenCode, Cursor…)
// jako providerzy czatu. Każde pytanie to jedno uruchomienie narzędzia w trybie bez okna: prompt idzie na stdin,
// odpowiedź wraca ze stdout. Logowanie robi samo narzędzie w zakładce terminala; aplikacja nie czyta jego plików
// logowania, a stan konta zna tylko z komendy statusu narzędzia.
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, State};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex};

#[derive(Clone, Copy, PartialEq)]
enum Out {
    /// Tekst ze stdout.
    Text,
    /// JSON ze stdout, odpowiedź pod wskazaną ścieżką.
    Json(&'static str),
    /// Ostatnia wiadomość zapisana przez narzędzie do pliku (`codex exec -o`).
    LastFile,
}

struct Spec {
    id: &'static str,
    name: &'static str,
    bins: &'static [&'static str],
    /// Stałe argumenty trybu bez okna (prompt zawsze na stdin).
    args: &'static [&'static str],
    model_flag: Option<&'static str>,
    /// Flaga zastępująca prompt systemowy narzędzia; bez niej prompt systemowy idzie na początek wiadomości.
    system_flag: Option<&'static str>,
    out: Out,
    /// Komenda logowania wpisywana w zakładce terminala.
    login: &'static str,
    status: Option<&'static [&'static str]>,
    install: &'static str,
    models: &'static [&'static str],
    list_models: Option<&'static [&'static str]>,
    /// Zmienna z folderem logowania dodatkowego konta (Konta subskrypcji).
    account_env: Option<&'static str>,
    /// false: narzędzie nie ma trybu bez okna (np. edytor), pokazujemy je tylko jako zainstalowane.
    headless: bool,
    note: &'static str,
}

const SPECS: &[Spec] = &[
    Spec {
        id: "claude", name: "Claude Code", bins: &["claude"],
        args: &["-p", "--output-format", "json", "--no-session-persistence", "--tools", ""],
        model_flag: Some("--model"), system_flag: Some("--system-prompt"), out: Out::Json("/result"),
        login: "claude auth login", status: Some(&["auth", "status"]), install: "npm i -g @anthropic-ai/claude-code",
        models: &["sonnet", "opus", "haiku"], list_models: None, account_env: Some("CLAUDE_CONFIG_DIR"), headless: true,
        note: "Plan Claude Pro/Max albo klucz API z logowania Claude Code.",
    },
    Spec {
        id: "codex", name: "Codex", bins: &["codex"],
        args: &["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never"],
        model_flag: Some("-m"), system_flag: None, out: Out::LastFile,
        login: "codex login", status: Some(&["login", "status"]), install: "npm i -g @openai/codex",
        models: &[], list_models: None, account_env: Some("CODEX_HOME"), headless: true,
        note: "Plan ChatGPT albo klucz OpenAI z logowania Codex.",
    },
    Spec {
        id: "gemini", name: "Gemini CLI", bins: &["gemini"],
        args: &["--output-format", "json"], model_flag: Some("-m"), system_flag: None, out: Out::Json("/response"),
        login: "gemini", status: None, install: "npm i -g @google/gemini-cli",
        models: &["gemini-2.5-pro", "gemini-2.5-flash"], list_models: None, account_env: None, headless: true,
        note: "Konto Google: przy pierwszym uruchomieniu wybierz „Login with Google”.",
    },
    Spec {
        id: "qwen", name: "Qwen Code", bins: &["qwen"],
        args: &[], model_flag: Some("-m"), system_flag: None, out: Out::Text,
        login: "qwen", status: None, install: "npm i -g @qwen-code/qwen-code",
        models: &[], list_models: None, account_env: None, headless: true,
        note: "Konto Qwen OAuth albo klucz zgodny z OpenAI.",
    },
    Spec {
        id: "amp", name: "Amp", bins: &["amp"],
        args: &["-x", "--no-notifications"], model_flag: Some("-m"), system_flag: None, out: Out::Text,
        login: "amp login", status: None, install: "npm i -g @sourcegraph/amp",
        models: &["low", "medium", "high"], list_models: None, account_env: None, headless: true,
        note: "Model wybiera tryb Amp (low, medium, high). Tryb bez okna wymaga kredytów Amp.",
    },
    Spec {
        id: "opencode", name: "OpenCode", bins: &["opencode"],
        args: &["run", "--standalone"], model_flag: Some("-m"), system_flag: None, out: Out::Text,
        login: "opencode auth login", status: None, install: "npm i -g opencode-ai",
        models: &[], list_models: Some(&["models", "--standalone"]), account_env: None, headless: true,
        note: "Modele w formacie provider/model; lista pobiera się z OpenCode.",
    },
    Spec {
        id: "cursor", name: "Cursor Agent", bins: &["cursor-agent", "agent"],
        args: &["-p", "--trust", "--mode", "ask", "--output-format", "json"],
        model_flag: Some("--model"), system_flag: None, out: Out::Json("/result"),
        login: "cursor-agent login", status: Some(&["status"]), install: "irm 'https://cursor.com/install?win32=true' | iex",
        models: &["auto"], list_models: None, account_env: None, headless: true,
        note: "Konto Cursor; na planie darmowym działa model „auto”.",
    },
    Spec {
        id: "droid", name: "Factory Droid", bins: &["droid"],
        args: &["exec"], model_flag: Some("-m"), system_flag: None, out: Out::Text,
        login: "droid", status: None, install: "irm https://app.factory.ai/cli/windows | iex",
        models: &[], list_models: None, account_env: None, headless: true,
        note: "Konto Factory: zaloguj się przy pierwszym uruchomieniu.",
    },
    Spec {
        id: "crush", name: "Crush", bins: &["crush"],
        args: &["run", "-q"], model_flag: None, system_flag: None, out: Out::Text,
        login: "crush", status: None, install: "npm i -g @charmland/crush",
        models: &[], list_models: None, account_env: None, headless: true,
        note: "Provider i model ustawiasz w samym Crush.",
    },
    Spec {
        id: "antigravity", name: "Google Antigravity", bins: &["antigravity"],
        args: &[], model_flag: None, system_flag: None, out: Out::Text,
        login: "antigravity", status: None, install: "antigravity.google",
        models: &[], list_models: None, account_env: None, headless: false,
        note: "To edytor bez trybu wiersza poleceń, więc aplikacja nie może z niego brać modeli. Modele Gemini: Gemini CLI albo klucz Google AI Studio.",
    },
];

fn spec(id: &str) -> Result<&'static Spec, String> {
    SPECS.iter().find(|s| s.id == id).ok_or_else(|| format!("Nieznane narzędzie: {id}"))
}

/* ---------- wyszukiwanie i uruchamianie ---------- */

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_default()
}

/// Foldery z PATH i typowe miejsca instalatorów (aplikacja z menu Start może mieć starszy PATH niż terminal).
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    let h = home();
    for d in [".local/bin", ".amp/bin", ".opencode/bin", ".bun/bin", ".npm-global/bin", ".factory/bin"] {
        dirs.push(h.join(d));
    }
    if let Some(a) = std::env::var_os("APPDATA") { dirs.push(PathBuf::from(a).join("npm")); }
    if let Some(l) = std::env::var_os("LOCALAPPDATA") {
        let l = PathBuf::from(l);
        dirs.push(l.join("cursor-agent"));
        dirs.push(l.join("Programs").join("Antigravity").join("bin"));
    }
    dirs
}

fn find(bins: &[&str]) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat"] } else { &[""] };
    let dirs = search_dirs();
    for b in bins {
        for d in &dirs {
            for e in exts {
                let p = d.join(format!("{b}{e}"));
                if p.is_file() { return Some(p); }
            }
        }
    }
    None
}

/// Program do uruchomienia: plik .exe wprost; skrypt npm (.cmd) rozwijamy do programu, który wywołuje,
/// żeby argumenty nie przechodziły przez cmd.exe. `direct` = argumenty dochodzą bez przeróbek.
fn launcher(path: &Path) -> (Command, bool) {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if ext == "cmd" || ext == "bat" {
        if let Ok(text) = std::fs::read_to_string(path) {
            let dir = path.parent().unwrap_or(Path::new("."));
            // npm: "%dp0%\node_modules\pakiet\bin\narzędzie.exe" albo "%~dp0\node_modules\...\cli.js"
            let re = regex_lite(&text);
            if let Some(rel) = re {
                let target = dir.join(rel.trim_start_matches(['\\', '/']));
                if target.is_file() {
                    let t_ext = target.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                    if t_ext == "exe" { return (Command::new(target), true); }
                    if t_ext == "js" || t_ext == "mjs" || t_ext == "cjs" {
                        let node = dir.join("node.exe");
                        let mut c = Command::new(if node.is_file() { node } else { PathBuf::from("node") });
                        c.arg(target);
                        return (c, true);
                    }
                }
            }
        }
        let mut c = Command::new("cmd");
        c.arg("/C").arg(path);
        return (c, false);
    }
    (Command::new(path), true)
}

/// Ścieżka po `%dp0%` / `%~dp0` w skrypcie npm, do pierwszego cudzysłowu.
fn regex_lite(text: &str) -> Option<String> {
    for marker in ["%dp0%", "%~dp0"] {
        for (i, _) in text.match_indices(marker) {
            let rest = &text[i + marker.len()..];
            let end = rest.find('"').unwrap_or(rest.len());
            let rel = &rest[..end];
            let low = rel.to_lowercase();
            if low.contains("node_modules") && (low.ends_with(".exe") || low.ends_with(".js") || low.ends_with(".mjs") || low.ends_with(".cjs")) {
                return Some(rel.to_string());
            }
        }
    }
    None
}

fn base_command(path: &Path, cwd: &Path) -> (Command, bool) {
    let (mut c, direct) = launcher(path);
    c.current_dir(cwd)
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .env("TERM", "dumb")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    (c, direct)
}

/// Pusty folder roboczy: narzędzia agentowe nie dotykają projektów użytkownika.
fn sandbox(app: &AppHandle) -> Result<PathBuf, String> {
    let d = crate::store::data_dir(app)?.join("cli-sandbox");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\x1b' {
            if it.peek() == Some(&'[') {
                it.next();
                while let Some(&n) = it.peek() { it.next(); if ('@'..='~').contains(&n) { break; } }
            } else if it.peek() == Some(&']') {
                while let Some(n) = it.next() { if n == '\x07' { break; } }
            }
            continue;
        }
        if c != '\r' { out.push(c); }
    }
    out
}

fn tail(s: &str, n: usize) -> String {
    let t = strip_ansi(s);
    let t = t.trim();
    let start = t.char_indices().rev().nth(n).map(|(i, _)| i).unwrap_or(0);
    t[start..].to_string()
}

async fn run_quick(app: &AppHandle, path: &Path, args: &[&str], secs: u64) -> Option<(bool, String)> {
    let (mut c, _) = base_command(path, &sandbox(app).ok()?);
    c.args(args).stdin(Stdio::null());
    let out = tokio::time::timeout(Duration::from_secs(secs), c.output()).await.ok()?.ok()?;
    let text = strip_ansi(&String::from_utf8_lossy(&out.stdout)) + &strip_ansi(&String::from_utf8_lossy(&out.stderr));
    Some((out.status.success(), text))
}

/* ---------- komendy ---------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInfo {
    id: &'static str,
    name: &'static str,
    installed: bool,
    path: String,
    version: String,
    headless: bool,
    login: &'static str,
    install: &'static str,
    models: Vec<&'static str>,
    accounts: bool,
    note: &'static str,
}

/// Lista znanych narzędzi z informacją, które są zainstalowane (wersje sprawdzane równolegle).
#[tauri::command]
pub async fn aicli_detect(app: AppHandle) -> Result<Vec<CliInfo>, String> {
    let mut set = tokio::task::JoinSet::new();
    for (i, s) in SPECS.iter().enumerate() {
        let app = app.clone();
        set.spawn(async move {
            let path = find(s.bins);
            let version = match (&path, s.headless) {
                (Some(p), true) => run_quick(&app, p, &["--version"], 10).await
                    .map(|(_, t)| t.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").split(" (").next().unwrap_or("").chars().take(40).collect())
                    .unwrap_or_default(),
                _ => String::new(),
            };
            (i, CliInfo {
                id: s.id, name: s.name, installed: path.is_some(), path: path.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
                version, headless: s.headless, login: s.login, install: s.install, models: s.models.to_vec(),
                accounts: s.account_env.is_some(), note: s.note,
            })
        });
    }
    let mut out: Vec<(usize, CliInfo)> = Vec::new();
    while let Some(r) = set.join_next().await { if let Ok(x) = r { out.push(x); } }
    out.sort_by_key(|(i, _)| *i);
    Ok(out.into_iter().map(|(_, x)| x).collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus { logged_in: Option<bool>, text: String }

/// Stan logowania z komendy statusu narzędzia (bez czytania jego plików).
#[tauri::command]
pub async fn aicli_status(app: AppHandle, id: String, account: Option<String>) -> Result<CliStatus, String> {
    let s = spec(&id)?;
    let Some(args) = s.status else { return Ok(CliStatus { logged_in: None, text: String::new() }) };
    let path = find(s.bins).ok_or("Narzędzie nie jest zainstalowane")?;
    let (mut c, _) = base_command(&path, &sandbox(&app)?);
    c.args(args).stdin(Stdio::null());
    if let (Some(var), Some(acc)) = (s.account_env, account.as_deref().filter(|a| !a.is_empty())) {
        c.env(var, crate::store::account_dir(&app, acc)?);
    }
    let out = tokio::time::timeout(Duration::from_secs(15), c.output()).await.map_err(|_| "Brak odpowiedzi narzędzia")?.map_err(|e| e.to_string())?;
    let text = strip_ansi(&String::from_utf8_lossy(&out.stdout)) + &strip_ansi(&String::from_utf8_lossy(&out.stderr));
    if let Ok(j) = serde_json::from_str::<Value>(text.trim()) {
        if let Some(b) = j.get("loggedIn").and_then(Value::as_bool) {
            let how = ["subscriptionType", "authMethod"].iter().find_map(|k| j.get(*k).and_then(Value::as_str)).unwrap_or("");
            return Ok(CliStatus { logged_in: Some(b), text: if b { format!("zalogowano{}", if how.is_empty() { String::new() } else { format!(" · {how}") }) } else { "niezalogowano".into() } });
        }
    }
    let low = text.to_lowercase();
    let logged = if low.contains("not logged") || low.contains("not authenticated") || low.contains("niezalog") { Some(false) }
        else if out.status.success() { Some(true) } else { Some(false) };
    // Pierwsza linia bez adresów e-mail: status bywa oglądany przy innych osobach.
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").split_whitespace()
        .map(|w| if w.contains('@') { "•••" } else { w }).collect::<Vec<_>>().join(" ");
    Ok(CliStatus { logged_in: logged, text: line.chars().take(80).collect() })
}

#[tauri::command]
pub async fn aicli_models(app: AppHandle, id: String) -> Result<Vec<String>, String> {
    let s = spec(&id)?;
    let Some(args) = s.list_models else { return Ok(s.models.iter().map(|m| m.to_string()).collect()) };
    let path = find(s.bins).ok_or("Narzędzie nie jest zainstalowane")?;
    let (ok, text) = run_quick(&app, &path, args, 60).await.ok_or("Brak odpowiedzi narzędzia")?;
    if !ok { return Err(tail(&text, 300)); }
    Ok(text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.contains(' ') && l.contains('/')).map(String::from).collect())
}

#[derive(Default)]
pub struct CliState { running: Mutex<HashMap<String, oneshot::Sender<()>>> }

#[derive(Serialize)]
pub struct CliAnswer { text: String, usage: Value }

/// Jedno pytanie do narzędzia. `run_id` pozwala przerwać je przez `aicli_cancel`.
#[tauri::command]
pub async fn aicli_run(
    app: AppHandle,
    state: State<'_, Arc<CliState>>,
    id: String,
    model: Option<String>,
    system: Option<String>,
    prompt: String,
    account: Option<String>,
    run_id: Option<String>,
) -> Result<CliAnswer, String> {
    let s = spec(&id)?;
    if !s.headless { return Err(format!("{}: {}", s.name, s.note)); }
    let path = find(s.bins).ok_or_else(|| format!("{} nie jest zainstalowane. Instalacja: {}", s.name, s.install))?;
    let dir = sandbox(&app)?;
    let (mut c, direct) = base_command(&path, &dir);
    c.args(s.args);
    if let (Some(f), Some(m)) = (s.model_flag, model.as_deref().map(str::trim).filter(|m| !m.is_empty())) { c.arg(f).arg(m); }
    let system = system.filter(|t| !t.trim().is_empty());
    // Prompt systemowy jako argument tylko przy bezpośrednim uruchomieniu (cmd.exe gubi nowe linie).
    let mut input = prompt;
    match (s.system_flag, &system) {
        (Some(f), Some(t)) if direct => { c.arg(f).arg(t); }
        (_, Some(t)) => input = format!("<instrukcje>\n{t}\n</instrukcje>\n\n{input}"),
        _ => {}
    }
    let last_file = (s.out == Out::LastFile).then(|| dir.join(format!("last-{}-{}.txt", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed))));
    if let Some(f) = &last_file { c.arg("--output-last-message").arg(f); }
    if s.id == "codex" { c.arg("-"); }
    if let (Some(var), Some(acc)) = (s.account_env, account.as_deref().filter(|a| !a.is_empty())) {
        c.env(var, crate::store::account_dir(&app, acc)?);
    }

    let mut child = c.spawn().map_err(|e| format!("Nie mogę uruchomić {}: {e}", s.name))?;
    let mut stdin = child.stdin.take().ok_or("brak stdin")?;
    let write = async move {
        let _ = stdin.write_all(input.as_bytes()).await;
        let _ = stdin.shutdown().await;
    };
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    if let Some(r) = &run_id { state.running.lock().await.insert(r.clone(), cancel_tx); }
    let result = tokio::select! {
        (_, out) = async { tokio::join!(write, child.wait_with_output()) } => Some(out),
        _ = cancel_rx => None,
        _ = tokio::time::sleep(Duration::from_secs(900)) => { if let Some(f) = &last_file { let _ = std::fs::remove_file(f); } return Err(format!("{}: brak odpowiedzi przez 15 minut", s.name)); }
    };
    if let Some(r) = &run_id { state.running.lock().await.remove(r); }
    let Some(out) = result else { return Err("Przerwano".into()) };
    let out = out.map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    let file_text = last_file.as_ref().and_then(|f| { let t = std::fs::read_to_string(f).ok(); let _ = std::fs::remove_file(f); t });

    let fail = |msg: String| Err(format!("{}: {}", s.name, if msg.trim().is_empty() { format!("zakończono z kodem {}", out.status.code().unwrap_or(-1)) } else { msg }));
    match s.out {
        Out::Json(ptr) => {
            // Ostatni obiekt JSON w wyjściu (przed nim bywają ostrzeżenia).
            let j = stdout.lines().rev().find_map(|l| serde_json::from_str::<Value>(l.trim()).ok().filter(Value::is_object))
                .or_else(|| serde_json::from_str::<Value>(stdout.trim()).ok());
            let Some(j) = j else { return fail(tail(&(stderr + &stdout), 600)) };
            let text = j.pointer(ptr).and_then(Value::as_str).unwrap_or("").to_string();
            let is_err = j.get("is_error").and_then(Value::as_bool).unwrap_or(false) || j.get("error").is_some_and(|e| !e.is_null());
            if is_err || !out.status.success() {
                let msg = if text.is_empty() { j.pointer("/error/message").or(j.get("error")).map(|e| e.as_str().map(String::from).unwrap_or(e.to_string())).unwrap_or_default() } else { text };
                return fail(if msg.is_empty() { tail(&stderr, 600) } else { msg });
            }
            Ok(CliAnswer { text, usage: j.get("usage").cloned().unwrap_or(Value::Null) })
        }
        Out::LastFile => {
            if !out.status.success() { return fail(tail(&(stderr + &stdout), 600)); }
            Ok(CliAnswer { text: file_text.unwrap_or_else(|| strip_ansi(&stdout)).trim().to_string(), usage: Value::Null })
        }
        Out::Text => {
            if !out.status.success() { return fail(tail(&(stderr + &stdout), 600)); }
            Ok(CliAnswer { text: strip_ansi(&stdout).trim().to_string(), usage: Value::Null })
        }
    }
}

static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[tauri::command]
pub async fn aicli_cancel(state: State<'_, Arc<CliState>>, run_id: String) -> Result<(), String> {
    if let Some(tx) = state.running.lock().await.remove(&run_id) { let _ = tx.send(()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn npm_shim_target() {
        let shim = "@ECHO off\r\nCALL :find_dp0\r\n\"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe\"   %*\r\n";
        assert_eq!(super::regex_lite(shim).as_deref(), Some("\\node_modules\\@opencode\\cli\\bin\\opencode.exe"));
        let js = "\"%_prog%\"  \"%dp0%\\node_modules\\@google\\gemini-cli\\dist\\index.js\" %*";
        assert!(super::regex_lite(js).unwrap().ends_with("index.js"));
        assert!(super::regex_lite("powershell -File \"%SCRIPT_DIR%\\cursor-agent.ps1\" %*").is_none());
    }

    #[test]
    fn ansi_is_removed() {
        assert_eq!(super::strip_ansi("\x1b[91m\x1b[1mError: \x1b[0mzły model\r\n"), "Error: zły model\n");
    }
}
