//! Zużycie planów subskrypcji (Claude, Codex, Gemini CLI, Cursor, z.ai, OpenCode Go) dla pluginu Quota.
//! Korzystamy z logowania, które użytkownik ma już w danym narzędziu: rdzeń czyta jego token z dysku,
//! pyta usługę o limity i oddaje tylko procenty i czasy resetu. Tokenów nie zapisujemy, nie odświeżamy
//! (poza Gemini, gdzie odświeżenie nie unieważnia logowania CLI) i nie wysyłamy do interfejsu.
//! Endpointy są nieoficjalne (te same, z których korzystają same narzędzia), więc każda usługa może
//! w każdej chwili zwrócić błąd; wtedy Quota pokazuje powód zamiast liczb.

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    label: String,
    used_percent: f64,
    /// Znacznik czasu resetu w ms (0: nieznany).
    resets_at: i64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanUsage {
    plan: String,
    windows: Vec<Window>,
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn read_json(path: &PathBuf, missing: &str) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|_| missing.to_string())?;
    serde_json::from_str(&text).map_err(|_| format!("Nie da się odczytać pliku logowania ({}).", path.display()))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())
}

/// Odpowiedź jako JSON; przy błędzie HTTP czytelny komunikat (bez nagłówków i tokenów).
async fn send(req: reqwest::RequestBuilder, what: &str) -> Result<Value, String> {
    let res = req.send().await.map_err(|e| format!("{what}: brak połączenia ({})", e.without_url()))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    match status.as_u16() {
        200..=299 => serde_json::from_str(&text).map_err(|_| format!("{what}: nieoczekiwana odpowiedź")),
        401 | 403 => Err(format!("{what}: logowanie wygasło albo nie ma dostępu do limitów ({})", status.as_u16())),
        429 => Err(format!("{what}: za dużo zapytań, spróbuję później")),
        s => Err(format!("{what}: błąd {s}")),
    }
}

fn iso_ms(v: &Value) -> i64 {
    v.as_str()
        .and_then(|s| chrono_like_parse(s))
        .or_else(|| v.as_i64().map(|n| if n < 10_000_000_000 { n * 1000 } else { n }))
        .unwrap_or(0)
}

/// ISO 8601 (np. 2026-10-30T14:00:00.123+00:00 albo …Z) → ms, bez dodatkowych zależności.
fn chrono_like_parse(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[10] != b'T' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let mut rest = &s[19..];
    let mut ms = 0;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: String = frac.chars().take_while(|c| c.is_ascii_digit()).collect();
        ms = format!("{:0<3}", &digits[..digits.len().min(3)]).parse().unwrap_or(0);
        rest = &frac[digits.len()..];
    }
    let off = match rest {
        "" | "Z" | "z" => 0,
        o if o.len() >= 6 => {
            let sign = if o.starts_with('-') { -1 } else { 1 };
            sign * (o[1..3].parse::<i64>().ok()? * 60 + o[4..6].parse::<i64>().ok()?)
        }
        _ => return None,
    };
    // Dni od 1970-01-01 (algorytm „days from civil”).
    let (yy, mm) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * mm + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400 + h * 3600 + mi * 60 + se) - off * 60) * 1000 + ms)
}

fn window_label(secs: i64) -> String {
    match secs {
        0 => String::new(),
        s if s % 604800 == 0 => if s == 604800 { "tydz.".into() } else { format!("{} tyg.", s / 604800) },
        s if s >= 2_419_200 => "mies.".into(),
        s if s % 86400 == 0 => format!("{} d", s / 86400),
        s => format!("{} h", (s as f64 / 3600.0).round() as i64),
    }
}

fn pct(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

/// Dodatkowe konto bez logowania (folder konta jeszcze pusty).
const NOT_LOGGED: &str = "To konto nie jest jeszcze zalogowane. Kliknij „Zaloguj w zakładce terminala”.";

/* ---------- Claude (Pro / Max, logowanie Claude Code) ---------- */

async fn claude(account: Option<PathBuf>) -> Result<PlanUsage, String> {
    let missing = if account.is_some() { NOT_LOGGED } else { "Brak logowania Claude Code (zaloguj się w Claude Code)." };
    let dir = account.or_else(|| std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from)).unwrap_or_else(|| home().join(".claude"));
    let creds = read_json(&dir.join(".credentials.json"), missing)?;
    let o = creds.get("claudeAiOauth").ok_or("Claude Code nie jest zalogowany kontem Claude (Pro/Max).")?;
    let token = o.get("accessToken").and_then(Value::as_str).filter(|t| !t.is_empty()).ok_or("Brak tokenu Claude Code.")?;
    if o.get("expiresAt").and_then(Value::as_f64).is_some_and(|e| (e as i64) < now_ms()) {
        return Err("Logowanie Claude Code wygasło. Uruchom Claude Code, żeby je odświeżyć.".into());
    }
    let req = client()?
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("accept", "application/json")
        .header("user-agent", "claude-cli/2.1.0 (external, cli)");
    let r = send(req, "Claude").await?;
    let out = parse_claude(&r, o.get("subscriptionType").and_then(Value::as_str).unwrap_or(""));
    if out.windows.is_empty() {
        return Err("Claude: konto nie zwróciło limitów planu.".into());
    }
    Ok(out)
}

fn parse_claude(r: &Value, plan: &str) -> PlanUsage {
    let mut out = PlanUsage { plan: plan.into(), windows: vec![] };
    for (key, label) in [("five_hour", "5 h"), ("seven_day", "tydz."), ("seven_day_opus", "Opus tydz."), ("seven_day_sonnet", "Sonnet tydz.")] {
        if let Some(w) = r.get(key).filter(|w| w.is_object()) {
            if let Some(u) = w.get("utilization").and_then(pct) {
                out.windows.push(Window { label: label.into(), used_percent: u, resets_at: w.get("resets_at").map(iso_ms).unwrap_or(0) });
            }
        }
    }
    out
}

/* ---------- Codex (ChatGPT Plus / Pro, logowanie Codex CLI) ---------- */

async fn codex(account: Option<PathBuf>) -> Result<PlanUsage, String> {
    let missing = if account.is_some() { NOT_LOGGED } else { "Brak logowania Codex CLI (codex login)." };
    let dir = account.or_else(|| std::env::var_os("CODEX_HOME").map(PathBuf::from)).unwrap_or_else(|| home().join(".codex"));
    let auth = read_json(&dir.join("auth.json"), missing)?;
    let t = auth.get("tokens").ok_or("Codex CLI jest zalogowany kluczem API, nie kontem ChatGPT: plan nie ma limitów do pokazania.")?;
    let token = t.get("access_token").or_else(|| t.get("accessToken")).and_then(Value::as_str).ok_or("Brak tokenu Codex CLI.")?;
    let mut req = client()?
        .get("https://chatgpt.com/backend-api/wham/usage")
        .bearer_auth(token)
        .header("accept", "application/json")
        .header("user-agent", "Hermitty");
    if let Some(acc) = t.get("account_id").or_else(|| t.get("accountId")).and_then(Value::as_str).filter(|a| !a.is_empty()) {
        req = req.header("ChatGPT-Account-Id", acc);
    }
    let r = send(req, "Codex").await?;
    let out = parse_codex(&r);
    if out.windows.is_empty() {
        return Err("Codex: plan bez limitów do pokazania.".into());
    }
    Ok(out)
}

fn parse_codex(r: &Value) -> PlanUsage {
    let mut out = PlanUsage { plan: r.get("plan_type").and_then(Value::as_str).unwrap_or("").into(), windows: vec![] };
    if let Some(rl) = r.get("rate_limit") {
        for (key, fallback) in [("primary_window", "5 h"), ("secondary_window", "tydz.")] {
            let Some(w) = rl.get(key).filter(|w| w.is_object()) else { continue };
            let Some(u) = w.get("used_percent").and_then(pct) else { continue };
            let label = window_label(w.get("limit_window_seconds").and_then(Value::as_i64).unwrap_or(0));
            out.windows.push(Window {
                label: if label.is_empty() { fallback.into() } else { label },
                used_percent: u,
                resets_at: w.get("reset_at").map(iso_ms).unwrap_or(0),
            });
        }
    }
    out
}

/* ---------- Gemini CLI (logowanie kontem Google) ---------- */

/// Identyfikator klienta OAuth Gemini CLI z jego instalacji (potrzebny tylko do odświeżenia tokenu).
fn gemini_client() -> Option<(String, String)> {
    let mut roots = vec![];
    if let Some(a) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(a).join("npm").join("node_modules"));
    }
    roots.push(PathBuf::from("/usr/local/lib/node_modules"));
    roots.push(PathBuf::from("/opt/homebrew/lib/node_modules"));
    roots.push(home().join(".npm-global").join("lib").join("node_modules"));
    let rels = [
        "@google/gemini-cli/node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js",
        "@google/gemini-cli-core/dist/src/code_assist/oauth2.js",
    ];
    let grab = |text: &str, name: &str| -> Option<String> {
        let i = text.find(name)? + name.len();
        let rest = &text[i..];
        let q = rest.find(['\'', '"'])?;
        let end = rest[q + 1..].find(['\'', '"'])?;
        Some(rest[q + 1..q + 1 + end].to_string())
    };
    for r in &roots {
        for rel in rels {
            if let Ok(text) = std::fs::read_to_string(r.join(rel)) {
                if let (Some(id), Some(secret)) = (grab(&text, "OAUTH_CLIENT_ID"), grab(&text, "OAUTH_CLIENT_SECRET")) {
                    return Some((id, secret));
                }
            }
        }
    }
    None
}

async fn gemini() -> Result<PlanUsage, String> {
    let creds = read_json(&home().join(".gemini").join("oauth_creds.json"), "Brak logowania Gemini CLI (zaloguj się kontem Google w Gemini CLI).")?;
    let mut token = creds.get("access_token").and_then(Value::as_str).unwrap_or("").to_string();
    let expired = creds.get("expiry_date").and_then(Value::as_f64).is_some_and(|e| (e as i64) < now_ms() + 60_000);
    let http = client()?;
    if token.is_empty() || expired {
        // Odświeżenie Google nie unieważnia tokenu CLI; nowego tokenu nie zapisujemy na dysk.
        let refresh = creds.get("refresh_token").and_then(Value::as_str).ok_or("Logowanie Gemini CLI wygasło. Uruchom Gemini CLI.")?;
        let (id, secret) = gemini_client().ok_or("Logowanie Gemini CLI wygasło, a nie znalazłem instalacji Gemini CLI do jego odświeżenia. Uruchom Gemini CLI.")?;
        let r = send(http.post("https://oauth2.googleapis.com/token").form(&[("client_id", id.as_str()), ("client_secret", secret.as_str()), ("refresh_token", refresh), ("grant_type", "refresh_token")]), "Gemini").await?;
        token = r.get("access_token").and_then(Value::as_str).ok_or("Gemini: nie udało się odświeżyć logowania.")?.to_string();
    }
    let base = "https://cloudcode-pa.googleapis.com/v1internal";
    let load = send(http.post(format!("{base}:loadCodeAssist")).bearer_auth(&token).json(&serde_json::json!({ "metadata": { "ideType": "GEMINI_CLI", "pluginType": "GEMINI" } })), "Gemini").await?;
    let project = load.get("cloudaicompanionProject").and_then(|p| p.as_str().map(String::from).or_else(|| p.get("id").and_then(Value::as_str).map(String::from)));
    let tier = load.pointer("/paidTier/name").or_else(|| load.pointer("/currentTier/name")).and_then(Value::as_str).unwrap_or("").to_string();
    let body = match &project { Some(p) => serde_json::json!({ "project": p }), None => serde_json::json!({}) };
    let q = send(http.post(format!("{base}:retrieveUserQuota")).bearer_auth(&token).json(&body), "Gemini").await?;
    // Na model najniższy pozostały ułamek; pokazujemy Pro i Flash, a gdy ich nie ma, wszystkie modele.
    let mut per: std::collections::BTreeMap<String, (f64, i64)> = Default::default();
    for b in q.get("buckets").and_then(Value::as_array).into_iter().flatten() {
        let (Some(model), Some(frac)) = (b.get("modelId").and_then(Value::as_str), b.get("remainingFraction").and_then(pct)) else { continue };
        let e = per.entry(model.to_string()).or_insert((frac, 0));
        if frac <= e.0 {
            *e = (frac, b.get("resetTime").map(iso_ms).unwrap_or(0));
        }
    }
    let pick = |needle: &str| per.iter().filter(|(m, _)| m.contains(needle)).min_by(|a, b| a.1 .0.total_cmp(&b.1 .0)).map(|(_, v)| *v);
    let mut out = PlanUsage { plan: tier, windows: vec![] };
    for (needle, label) in [("pro", "Pro"), ("flash", "Flash")] {
        if let Some((frac, reset)) = pick(needle) {
            out.windows.push(Window { label: label.into(), used_percent: (1.0 - frac) * 100.0, resets_at: reset });
        }
    }
    if out.windows.is_empty() {
        out.windows = per.into_iter().map(|(m, (frac, reset))| Window { label: m, used_percent: (1.0 - frac) * 100.0, resets_at: reset }).collect();
    }
    if out.windows.is_empty() {
        return Err("Gemini: konto nie zwróciło limitów.".into());
    }
    Ok(out)
}

/* ---------- Cursor (logowanie aplikacji Cursor) ---------- */

fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Token z bazy ustawień Cursor (SQLite, klucz cursorAuth/accessToken). Zamiast całego silnika SQLite
/// szukamy wartości tuż za kluczem; z kilku kopii (WAL, stare strony) wygrywa token z najdalszym `exp`.
fn cursor_token() -> Result<String, String> {
    let dir = if cfg!(target_os = "macos") {
        home().join("Library/Application Support/Cursor/User/globalStorage")
    } else if cfg!(windows) {
        PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("Cursor").join("User").join("globalStorage")
    } else {
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".config")).join("Cursor/User/globalStorage")
    };
    let key = b"cursorAuth/accessToken";
    let mut best: Option<(i64, String)> = None;
    for name in ["state.vscdb", "state.vscdb-wal"] {
        let Ok(data) = std::fs::read(dir.join(name)) else { continue };
        let mut i = 0;
        while let Some(pos) = data[i..].windows(key.len()).position(|w| w == key) {
            let start = i + pos + key.len();
            let tok: String = data[start..].iter().take(4096).take_while(|c| c.is_ascii_alphanumeric() || matches!(**c, b'-' | b'_' | b'.')).map(|&c| c as char).collect();
            if tok.starts_with("eyJ") && tok.matches('.').count() == 2 {
                if let Some(exp) = jwt_claims(&tok).and_then(|c| c.get("exp").and_then(Value::as_i64)) {
                    if best.as_ref().is_none_or(|(e, _)| exp > *e) {
                        best = Some((exp, tok));
                    }
                }
            }
            i = start;
        }
    }
    let (exp, tok) = best.ok_or("Brak logowania Cursor (zaloguj się w aplikacji Cursor).")?;
    if exp * 1000 < now_ms() + 60_000 {
        return Err("Logowanie Cursor wygasło. Otwórz Cursor, żeby je odświeżyć.".into());
    }
    Ok(tok)
}

async fn cursor() -> Result<PlanUsage, String> {
    let token = cursor_token()?;
    let sub = jwt_claims(&token).and_then(|c| c.get("sub").and_then(Value::as_str).map(String::from)).unwrap_or_default();
    let user = sub.rsplit('|').next().unwrap_or("").to_string();
    if user.is_empty() || !user.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        return Err("Cursor: nieznany format logowania.".into());
    }
    let req = client()?
        .get("https://cursor.com/api/usage-summary")
        .header("accept", "application/json")
        .header("cookie", format!("WorkosCursorSessionToken={user}%3A%3A{token}"));
    let r = send(req, "Cursor").await?;
    let out = parse_cursor(&r);
    if out.windows.is_empty() {
        return Err("Cursor: plan nie zwrócił limitów.".into());
    }
    Ok(out)
}

fn parse_cursor(r: &Value) -> PlanUsage {
    let reset = r.get("billingCycleEnd").map(iso_ms).unwrap_or(0);
    let mut out = PlanUsage { plan: r.get("membershipType").and_then(Value::as_str).unwrap_or("").into(), windows: vec![] };
    let plan = r.pointer("/individualUsage/plan");
    if let Some(p) = plan {
        for (key, label) in [("totalPercentUsed", "plan"), ("autoPercentUsed", "Auto"), ("apiPercentUsed", "API")] {
            if let Some(u) = p.get(key).and_then(pct) {
                out.windows.push(Window { label: label.into(), used_percent: u, resets_at: reset });
            }
        }
        if out.windows.is_empty() {
            if let (Some(used), Some(limit)) = (p.get("used").and_then(Value::as_f64), p.get("limit").and_then(Value::as_f64).filter(|l| *l > 0.0)) {
                out.windows.push(Window { label: "plan".into(), used_percent: used / limit * 100.0, resets_at: reset });
            }
        }
    }
    if r.get("isUnlimited").and_then(Value::as_bool) == Some(true) && out.windows.is_empty() {
        out.windows.push(Window { label: "bez limitu".into(), used_percent: 0.0, resets_at: reset });
    }
    out
}

/* ---------- z.ai / BigModel (GLM Coding Plan, klucz API z Providerów) ---------- */

async fn zai(key_ref: &str, base_url: &str) -> Result<PlanUsage, String> {
    let key = crate::ai::secret(key_ref).ok_or_else(|| "z.ai: dodaj klucz API providera z.ai w Ustawienia → Konta i providerzy.".to_string())?;
    let host = if base_url.contains("bigmodel.cn") { "https://open.bigmodel.cn" } else { "https://api.z.ai" };
    let url = format!("{host}/api/monitor/usage/quota/limit");
    let http = client()?;
    // Narzędzia używają raz samego klucza, raz z „Bearer”; próbujemy obu.
    let r = match send(http.get(&url).header("authorization", &key).header("accept", "application/json"), "z.ai").await {
        Ok(r) => r,
        Err(_) => send(http.get(&url).bearer_auth(&key).header("accept", "application/json"), "z.ai").await?,
    };
    let out = parse_zai(&r);
    if out.windows.is_empty() {
        return Err("z.ai: konto nie ma planu z limitami (GLM Coding Plan).".into());
    }
    Ok(out)
}

fn parse_zai(r: &Value) -> PlanUsage {
    let d = r.get("data").unwrap_or(r);
    let plan = ["planName", "plan", "plan_type", "packageName", "level"].iter().find_map(|k| d.get(*k).and_then(Value::as_str)).unwrap_or("").to_string();
    let mut out = PlanUsage { plan, windows: vec![] };
    for l in d.get("limits").and_then(Value::as_array).into_iter().flatten() {
        let kind = l.get("type").and_then(Value::as_str).unwrap_or("");
        let used = match (l.get("usage").and_then(Value::as_f64).filter(|u| *u > 0.0), l.get("currentValue").and_then(Value::as_f64)) {
            (Some(total), Some(cur)) => Some(cur / total * 100.0),
            _ => l.get("percentage").and_then(pct),
        };
        let Some(used) = used else { continue };
        let label = match kind { "TOKENS_LIMIT" | "CREDIT_LIMIT" => "5 h", "TIME_LIMIT" => "MCP mies.", other => other };
        out.windows.push(Window { label: label.into(), used_percent: used.clamp(0.0, 100.0), resets_at: l.get("nextResetTime").map(iso_ms).unwrap_or(0) });
    }
    out
}

/* ---------- OpenCode Go (klucz z logowania OpenCode) ---------- */

async fn opencode() -> Result<PlanUsage, String> {
    let data = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".local").join("share"));
    let auth = read_json(&data.join("opencode").join("auth.json"), "Brak logowania OpenCode (opencode auth login → OpenCode).")?;
    let key = std::env::var("OPENCODE_API_KEY").ok().or_else(|| {
        ["opencode", "opencode-go"].iter().find_map(|k| auth.get(*k).and_then(|v| v.get("key")).and_then(Value::as_str).map(String::from))
    }).ok_or("OpenCode: brak klucza OpenCode Zen/Go w logowaniu OpenCode.")?;
    let r = send(client()?.get("https://opencode.ai/zen/go/v1/usage").bearer_auth(&key).header("accept", "application/json"), "OpenCode").await?;
    let u = r.get("usage").unwrap_or(&r);
    let mut out = PlanUsage { plan: "Go".into(), windows: vec![] };
    for (key, label) in [("rolling", "5 h"), ("weekly", "tydz."), ("monthly", "mies.")] {
        if let Some(p) = u.get(key).and_then(|w| w.get("percent")).and_then(pct) {
            let reset = u.get(key).and_then(|w| w.get("resetInSec")).and_then(Value::as_i64).map(|s| now_ms() + s * 1000).unwrap_or(0);
            out.windows.push(Window { label: label.into(), used_percent: p, resets_at: reset });
        }
    }
    if out.windows.is_empty() {
        return Err("OpenCode: brak subskrypcji Go z limitami.".into());
    }
    Ok(out)
}

/// Zużycie planu usługi. `key_ref`/`url` tylko dla z.ai (klucz providera z Ustawień),
/// `account` dla dodatkowego konta Claude Code albo Codex (jego folder logowania w danych aplikacji).
#[tauri::command]
pub async fn plan_usage(app: tauri::AppHandle, service: String, key_ref: Option<String>, url: Option<String>, account: Option<String>) -> Result<PlanUsage, String> {
    let dir = account.filter(|a| !a.is_empty()).map(|a| crate::store::account_dir(&app, &a)).transpose()?;
    match service.as_str() {
        "claude" => claude(dir).await,
        "codex" => codex(dir).await,
        "gemini" => gemini().await,
        "cursor" => cursor().await,
        "zai" => zai(key_ref.as_deref().filter(|k| !k.is_empty()).ok_or("z.ai: dodaj providera z.ai z kluczem API w Ustawienia → Konta i providerzy.")?, url.as_deref().unwrap_or("")).await,
        "opencode" => opencode().await,
        _ => Err("Nieznana usługa".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_and_epoch() {
        assert_eq!(chrono_like_parse("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(chrono_like_parse("2026-10-30T12:00:00.5+02:00"), Some(1_793_354_400_500));
        assert_eq!(iso_ms(&serde_json::json!(1_793_354_400)), 1_793_354_400_000);
        assert_eq!(iso_ms(&serde_json::json!(1_793_354_400_000i64)), 1_793_354_400_000);
        assert_eq!(window_label(18000), "5 h");
        assert_eq!(window_label(604800), "tydz.");
        assert_eq!(window_label(2_592_000), "mies.");
    }

    #[test]
    fn claude_usage() {
        let r = serde_json::json!({ "five_hour": { "utilization": 34.0, "resets_at": "2026-10-30T12:18:00Z" }, "seven_day": { "utilization": 36.5, "resets_at": "2026-11-03T01:00:00+00:00" }, "seven_day_opus": null });
        let u = parse_claude(&r, "max");
        assert_eq!(u.windows.len(), 2);
        assert_eq!((u.windows[0].label.as_str(), u.windows[0].used_percent), ("5 h", 34.0));
        assert_eq!(u.windows[1].resets_at, chrono_like_parse("2026-11-03T01:00:00Z").unwrap());
    }

    #[test]
    fn codex_usage() {
        let r = serde_json::json!({ "plan_type": "plus", "rate_limit": { "primary_window": { "used_percent": 6, "limit_window_seconds": 18000, "reset_at": 1_793_354_400 }, "secondary_window": { "used_percent": 12.5, "limit_window_seconds": 604800, "reset_at": 1_793_800_000 } } });
        let u = parse_codex(&r);
        assert_eq!(u.plan, "plus");
        assert_eq!(u.windows.iter().map(|w| w.label.as_str()).collect::<Vec<_>>(), ["5 h", "tydz."]);
        assert_eq!(u.windows[0].resets_at, 1_793_354_400_000);
    }

    #[test]
    fn cursor_usage() {
        let r = serde_json::json!({ "membershipType": "pro", "billingCycleEnd": "2026-11-15T00:00:00.000Z", "individualUsage": { "plan": { "used": 330, "limit": 1000, "totalPercentUsed": 33.0, "autoPercentUsed": 20.0, "apiPercentUsed": 100.0 } } });
        let u = parse_cursor(&r);
        assert_eq!(u.windows.len(), 3);
        assert_eq!(u.windows[2].used_percent, 100.0);
        let legacy = parse_cursor(&serde_json::json!({ "individualUsage": { "plan": { "used": 50, "limit": 200 } } }));
        assert_eq!(legacy.windows[0].used_percent, 25.0);
    }

    #[test]
    fn zai_usage() {
        let r = serde_json::json!({ "code": 200, "data": { "planName": "GLM Coding Pro", "limits": [
            { "type": "TOKENS_LIMIT", "unit": 3, "number": 5, "usage": 800000000, "currentValue": 120000000, "remaining": 680000000, "percentage": 15, "nextResetTime": 1_793_354_400_000i64 },
            { "type": "TIME_LIMIT", "percentage": 4, "nextResetTime": null } ] } });
        let u = parse_zai(&r);
        assert_eq!(u.plan, "GLM Coding Pro");
        assert_eq!((u.windows[0].label.as_str(), u.windows[0].used_percent, u.windows[0].resets_at), ("5 h", 15.0, 1_793_354_400_000));
        assert_eq!((u.windows[1].label.as_str(), u.windows[1].used_percent, u.windows[1].resets_at), ("MCP mies.", 4.0, 0));
    }

    #[test]
    fn jwt_payload() {
        // {"sub":"auth0|user_01ABC","exp":4102444800}
        let t = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdXRoMHx1c2VyXzAxQUJDIiwiZXhwIjo0MTAyNDQ0ODAwfQ.sig";
        let c = jwt_claims(t).unwrap();
        assert_eq!(c["sub"], "auth0|user_01ABC");
        assert_eq!(c["exp"], 4102444800i64);
    }
}
