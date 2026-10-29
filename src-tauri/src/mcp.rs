//! Klient MCP (Model Context Protocol) dla agentów: serwery lokalne (stdio) i zdalne (Streamable HTTP).
//! Serwer startuje przy pierwszym użyciu i działa do zamknięcia aplikacji albo zmiany konfiguracji.
//! Sekret serwera (token) leży w Menedżerze poświadczeń; frontend podaje tylko jego identyfikator.

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as SyncMutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

const PROTOCOL: &str = "2025-06-18";

#[derive(Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpCfg {
    kind: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    key_ref: Option<String>,
    #[serde(default)]
    secret_env: Option<String>,
}

type Pending = Arc<SyncMutex<HashMap<u64, oneshot::Sender<Value>>>>;

enum Conn {
    Stdio { stdin: Arc<Mutex<ChildStdin>>, pending: Pending, child: SyncMutex<Option<Child>>, stderr: Arc<SyncMutex<String>>, alive: Arc<AtomicBool> },
    Http { client: reqwest::Client, url: String, headers: Vec<(String, String)>, session: SyncMutex<Option<String>> },
}

struct Server {
    cfg: McpCfg,
    conn: Conn,
    next: AtomicU64,
    tools: Vec<Value>,
}

type Slot = Arc<Mutex<Option<Arc<Server>>>>;

#[derive(Default)]
pub struct McpState {
    slots: SyncMutex<HashMap<String, Slot>>,
}

fn secret(key_ref: &Option<String>) -> Option<String> {
    let r = key_ref.as_deref().filter(|r| r.starts_with("mcp:"))?;
    crate::ai::secret(r)
}

fn kill_tree(child: &mut Child) {
    // npx/uvx uruchamiają kolejne procesy; zabijamy całe drzewo, żeby nic nie zostało w tle.
    #[cfg(windows)]
    {
        if let Some(pid) = child.id() {
            use std::os::windows::process::CommandExt;
            let mut cmd = std::process::Command::new("taskkill");
            cmd.args(["/PID", &pid.to_string(), "/T", "/F"]).creation_flags(0x0800_0000);
            let _ = cmd.status();
        }
    }
    let _ = child.start_kill();
}

impl Server {
    fn stop(&self) {
        if let Conn::Stdio { child, .. } = &self.conn {
            if let Some(mut c) = child.lock().unwrap().take() {
                kill_tree(&mut c);
            }
        }
    }

    fn alive(&self) -> bool {
        match &self.conn {
            Conn::Stdio { alive, .. } => alive.load(Ordering::Relaxed),
            Conn::Http { .. } => true,
        }
    }

    async fn notify(&self, method: &str) -> Result<(), String> {
        let msg = json!({ "jsonrpc": "2.0", "method": method });
        match &self.conn {
            Conn::Stdio { stdin, .. } => write_line(stdin, &msg).await,
            Conn::Http { .. } => self.http(&msg, None).await.map(|_| ()),
        }
    }

    async fn request(&self, method: &str, params: Value, secs: u64) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let resp = match &self.conn {
            Conn::Stdio { stdin, pending, stderr, .. } => {
                let (tx, rx) = oneshot::channel();
                pending.lock().unwrap().insert(id, tx);
                write_line(stdin, &msg).await?;
                match tokio::time::timeout(Duration::from_secs(secs), rx).await {
                    Err(_) => {
                        pending.lock().unwrap().remove(&id);
                        return Err(format!("Serwer MCP nie odpowiedział w {secs} s ({method})."));
                    }
                    Ok(Err(_)) => return Err(format!("Serwer MCP zakończył pracę.{}", tail(&stderr.lock().unwrap()))),
                    Ok(Ok(v)) => v,
                }
            }
            Conn::Http { .. } => tokio::time::timeout(Duration::from_secs(secs), self.http(&msg, Some(id)))
                .await
                .map_err(|_| format!("Serwer MCP nie odpowiedział w {secs} s ({method})."))??
                .ok_or("Serwer MCP nie zwrócił odpowiedzi")?,
        };
        if let Some(e) = resp.get("error") {
            return Err(format!("MCP: {}", e.get("message").and_then(Value::as_str).unwrap_or(&e.to_string())));
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    /// Streamable HTTP: POST z JSON-RPC, odpowiedź jako JSON albo strumień SSE.
    async fn http(&self, msg: &Value, id: Option<u64>) -> Result<Option<Value>, String> {
        let Conn::Http { client, url, headers, session } = &self.conn else { return Err("zły transport".into()) };
        let mut req = client.post(url).header("content-type", "application/json").header("accept", "application/json, text/event-stream").header("mcp-protocol-version", PROTOCOL);
        for (k, v) in headers {
            req = req.header(k.as_str(), v.as_str());
        }
        if let Some(s) = session.lock().unwrap().clone() {
            req = req.header("mcp-session-id", s);
        }
        let mut resp = req.json(msg).send().await.map_err(|e| format!("Nie mogę połączyć się z serwerem MCP: {e}"))?;
        if let Some(s) = resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            *session.lock().unwrap() = Some(s.to_string());
        }
        let status = resp.status();
        if !status.is_success() {
            let t = resp.text().await.unwrap_or_default();
            let hint = if status.as_u16() == 401 || status.as_u16() == 403 { " Sprawdź token serwera." } else { "" };
            return Err(format!("Serwer MCP: HTTP {}{hint} {}", status.as_u16(), t.chars().take(300).collect::<String>()));
        }
        let Some(id) = id else { return Ok(None) };
        let sse = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|c| c.starts_with("text/event-stream"));
        if !sse {
            return resp.json::<Value>().await.map(Some).map_err(|e| format!("Serwer MCP: niepoprawna odpowiedź ({e})"));
        }
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
            buf.extend(chunk.iter().filter(|b| **b != b'\r'));
            while let Some(end) = buf.windows(2).position(|w| w == b"\n\n") {
                let event: Vec<u8> = buf.drain(..end + 2).collect();
                if let Some(v) = sse_json(&String::from_utf8_lossy(&event)) {
                    if v.get("id").and_then(Value::as_u64) == Some(id) && (v.get("result").is_some() || v.get("error").is_some()) {
                        return Ok(Some(v));
                    }
                }
            }
        }
        Err("Serwer MCP zamknął strumień bez odpowiedzi".into())
    }
}

/// Dane zdarzenia SSE (linie `data:` złączone) jako JSON.
fn sse_json(event: &str) -> Option<Value> {
    let data: Vec<&str> = event.lines().filter_map(|l| l.strip_prefix("data:")).map(|l| l.strip_prefix(' ').unwrap_or(l)).collect();
    if data.is_empty() {
        return None;
    }
    serde_json::from_str(&data.join("\n")).ok()
}

fn tail(s: &str) -> String {
    let t = s.trim();
    if t.is_empty() {
        return String::new();
    }
    let c: Vec<char> = t.chars().collect();
    format!(" Ostatnie komunikaty: {}", c[c.len().saturating_sub(600)..].iter().collect::<String>())
}

async fn write_line(stdin: &Mutex<ChildStdin>, msg: &Value) -> Result<(), String> {
    let mut line = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
    line.push(b'\n');
    let mut w = stdin.lock().await;
    w.write_all(&line).await.map_err(|_| "Serwer MCP nie przyjmuje danych (zakończył pracę?)".to_string())?;
    w.flush().await.map_err(|e| e.to_string())
}

fn spawn_stdio(cfg: &McpCfg) -> Result<Conn, String> {
    if cfg.command.trim().is_empty() {
        return Err("Podaj komendę serwera MCP, np. npx".into());
    }
    // Na Windows `npx`, `uvx` itp. to skrypty .cmd: uruchamiamy przez cmd, chyba że to wprost plik .exe.
    let mut cmd = if cfg!(windows) && !cfg.command.to_lowercase().ends_with(".exe") {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&cfg.command);
        c
    } else {
        Command::new(&cfg.command)
    };
    cmd.args(&cfg.args).envs(&cfg.env).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    if let Some(s) = secret(&cfg.key_ref) {
        cmd.env(cfg.secret_env.as_deref().filter(|e| !e.trim().is_empty()).unwrap_or("API_KEY").trim(), s);
    }
    if let Some(d) = cfg.cwd.as_deref().filter(|d| !d.trim().is_empty()) {
        cmd.current_dir(d);
    }
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("Nie mogę uruchomić „{}”: {e}", cfg.command))?;
    let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or("brak stdin")?));
    let stdout = child.stdout.take().ok_or("brak stdout")?;
    let mut err = child.stderr.take().ok_or("brak stderr")?;
    let pending: Pending = Arc::default();
    let stderr = Arc::new(SyncMutex::new(String::new()));
    let alive = Arc::new(AtomicBool::new(true));

    let log = stderr.clone();
    tokio::spawn(async move {
        let mut b = [0u8; 2048];
        while let Ok(n) = err.read(&mut b).await {
            if n == 0 {
                break;
            }
            let mut l = log.lock().unwrap();
            l.push_str(&String::from_utf8_lossy(&b[..n]));
            if l.len() > 4000 {
                let cut = l.len() - 2000;
                let cut = (cut..l.len()).find(|i| l.is_char_boundary(*i)).unwrap_or(l.len());
                l.drain(..cut);
            }
        }
    });

    let (p, w, a) = (pending.clone(), stdin.clone(), alive.clone());
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
            let id = v.get("id").cloned();
            if v.get("method").is_some() {
                // Zapytanie serwera do klienta: ping obsługujemy, reszty (sampling, roots) nie udostępniamy.
                if let Some(id) = id {
                    let r = if v["method"] == "ping" { json!({ "jsonrpc": "2.0", "id": id, "result": {} }) } else { json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Nieobsługiwane przez TerminalX" } }) };
                    let _ = write_line(&w, &r).await;
                }
            } else if let Some(n) = id.and_then(|i| i.as_u64()) {
                if let Some(tx) = p.lock().unwrap().remove(&n) {
                    let _ = tx.send(v);
                }
            }
        }
        a.store(false, Ordering::Relaxed);
        p.lock().unwrap().clear();
    });

    Ok(Conn::Stdio { stdin, pending, child: SyncMutex::new(Some(child)), stderr, alive })
}

async fn connect(cfg: &McpCfg) -> Result<Server, String> {
    let conn = match cfg.kind.as_str() {
        "stdio" => spawn_stdio(cfg)?,
        "http" => {
            if !cfg.url.starts_with("http://") && !cfg.url.starts_with("https://") {
                return Err("Adres serwera MCP musi zaczynać się od http:// albo https://".into());
            }
            let mut headers: Vec<(String, String)> = cfg.headers.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            if let Some(s) = secret(&cfg.key_ref) {
                if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("authorization")) {
                    headers.push(("authorization".into(), format!("Bearer {s}")));
                }
            }
            let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
            Conn::Http { client, url: cfg.url.clone(), headers, session: SyncMutex::new(None) }
        }
        k => return Err(format!("Nieznany rodzaj serwera MCP: {k}")),
    };
    let mut s = Server { cfg: cfg.clone(), conn, next: AtomicU64::new(1), tools: vec![] };
    let init = async {
        // Pierwsze `npx -y …` pobiera pakiet, więc na start dajemy więcej czasu.
        s.request("initialize", json!({ "protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": { "name": "Hermitty", "version": env!("CARGO_PKG_VERSION") } }), 120).await?;
        s.notify("notifications/initialized").await?;
        let mut cursor: Option<String> = None;
        for _ in 0..20 {
            let r = s.request("tools/list", cursor.as_ref().map(|c| json!({ "cursor": c })).unwrap_or(json!({})), 30).await?;
            if let Some(t) = r.get("tools").and_then(Value::as_array) {
                s.tools.extend(t.iter().cloned());
            }
            cursor = r.get("nextCursor").and_then(Value::as_str).map(String::from);
            if cursor.is_none() {
                break;
            }
        }
        Ok::<(), String>(())
    }
    .await;
    if let Err(e) = init {
        s.stop();
        return Err(e);
    }
    Ok(s)
}

async fn ensure(state: &McpState, id: &str, cfg: &McpCfg) -> Result<Arc<Server>, String> {
    let slot = state.slots.lock().unwrap().entry(id.to_string()).or_default().clone();
    let mut g = slot.lock().await;
    if let Some(s) = g.as_ref() {
        if s.cfg == *cfg && s.alive() {
            return Ok(s.clone());
        }
        s.stop();
        *g = None;
    }
    let s = Arc::new(connect(cfg).await?);
    *g = Some(s.clone());
    Ok(s)
}

/// Łączy się z serwerem (albo używa działającego połączenia) i zwraca jego narzędzia.
#[tauri::command]
pub async fn mcp_connect(state: tauri::State<'_, McpState>, id: String, cfg: McpCfg) -> Result<Vec<Value>, String> {
    Ok(ensure(&state, &id, &cfg).await?.tools.clone())
}

/// Wywołuje narzędzie serwera; wynik to obiekt MCP `{ content: [...], isError }`.
#[tauri::command]
pub async fn mcp_call(state: tauri::State<'_, McpState>, id: String, cfg: McpCfg, name: String, args: Value) -> Result<Value, String> {
    let s = ensure(&state, &id, &cfg).await?;
    s.request("tools/call", json!({ "name": name, "arguments": if args.is_object() { args } else { json!({}) } }), 600).await
}

#[tauri::command]
pub async fn mcp_disconnect(state: tauri::State<'_, McpState>, id: String) -> Result<(), String> {
    let slot = state.slots.lock().unwrap().remove(&id);
    if let Some(slot) = slot {
        if let Some(s) = slot.lock().await.take() {
            s.stop();
        }
    }
    Ok(())
}

pub fn stop_all(state: &McpState) {
    for slot in state.slots.lock().unwrap().drain().map(|(_, s)| s) {
        if let Ok(mut g) = slot.try_lock() {
            if let Some(s) = g.take() {
                s.stop();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::sse_json;

    #[test]
    fn sse_event() {
        let v = sse_json("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":3,\ndata: \"result\":{}}\n").unwrap();
        assert_eq!(v["id"], 3);
        assert!(sse_json(": ping\n").is_none());
    }
}
