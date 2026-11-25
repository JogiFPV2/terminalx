//! Test SSH bez telefonu (tylko wersja debug na komputerze): HERMITTY_SSH_SELFTEST=host:port:user:hasło.
//! Loguje się hasłem, potem generuje klucz ed25519, dopisuje go przez tę samą sesję do authorized_keys
//! i loguje się kluczem. Klucz serwera akceptuje automatycznie. Wynik: linie SELFTEST na stdout i kod wyjścia.

use crate::ssh::{self, HostCfg, ShellEvent, SshState};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Listener, Manager};

async fn session(app: &AppHandle, cfg: HostCfg, script: Vec<String>, expect: &str) -> Result<String, String> {
    let st = app.state::<Arc<SshState>>().inner().clone();
    let out = Arc::new(Mutex::new(String::new()));
    let (done_tx, mut done_rx) = tokio::sync::mpsc::unbounded_channel::<Option<String>>();
    let o = out.clone();
    let id = ssh::start_shell(app.clone(), st.clone(), cfg, 100, 30, move |e| {
        match e {
            ShellEvent::Data { data } => o.lock().unwrap().push_str(&data),
            ShellEvent::Exit { error, .. } => { let _ = done_tx.send(error); }
        }
        true
    })
    .await?;
    tokio::time::sleep(Duration::from_secs(3)).await;
    for line in script {
        ssh::send(&st, id, &format!("{line}\n")).await;
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
    ssh::send(&st, id, "exit\n").await;
    let err = tokio::time::timeout(Duration::from_secs(20), done_rx.recv()).await.map_err(|_| "brak końca sesji".to_string())?.flatten();
    let text = out.lock().unwrap().clone();
    if let Some(e) = err { return Err(e); }
    if !text.contains(expect) { return Err(format!("brak „{expect}” w wyjściu:\n{text}")); }
    Ok(text)
}

pub fn run(app: AppHandle, spec: String) {
    let st = app.state::<Arc<SshState>>().inner().clone();
    app.listen("ssh:hostkey", move |ev| {
        let v: serde_json::Value = serde_json::from_str(ev.payload()).unwrap_or_default();
        println!("SELFTEST hostkey {} {}", v["algorithm"], v["fingerprint"]);
        let id = v["reqId"].as_u64().unwrap_or(0) as u32;
        let st = st.clone();
        tauri::async_runtime::spawn(async move { ssh::answer(&st, id, true).await });
    });
    tauri::async_runtime::spawn(async move {
        let p: Vec<&str> = spec.splitn(4, ':').collect();
        let (host, port, user, pass) = (p[0].to_string(), p[1].parse::<u16>().unwrap_or(22), p[2].to_string(), p[3].to_string());
        let res = async {
            crate::secret::write(&app, ssh::secret_name("t1", "pass"), pass).await?;
            let pw = HostCfg { id: "t1".into(), host: host.clone(), port, user: user.clone(), auth: "password".into(), trust_local: false };
            let public = ssh::ssh_keygen(app.clone(), "t2".into(), "selftest".into()).await?;
            println!("SELFTEST pubkey {public}");
            session(&app, pw, vec![
                "echo HERMITTY_$((40+2))".into(),
                format!("mkdir -p ~/.ssh && echo '{public}' > ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"),
            ], "HERMITTY_42").await?;
            println!("SELFTEST password OK");
            let key = HostCfg { id: "t2".into(), host, port, user, auth: "key".into(), trust_local: false };
            session(&app, key.clone(), vec!["echo KEY_$((6*7))".into()], "KEY_42").await?;
            println!("SELFTEST key OK");
            let r = ssh::ssh_exec(app.clone(), key.clone(), "echo EXEC_$((1+1)); echo err >&2; exit 3".into(), Some(10)).await?;
            if r.code != Some(3) || !r.output.contains("EXEC_2") || !r.output.contains("err") { return Err(format!("exec: {:?} {}", r.code, r.output)); }
            println!("SELFTEST exec OK");
            ssh::selftest_sftp(&app, &key).await?;
            println!("SELFTEST sftp OK");
            if !ssh::port_open(port).await || ssh::port_open(1).await { return Err("port_open".into()); }
            println!("SELFTEST port OK");
            if let Ok(url) = std::env::var("HERMITTY_AI_SELFTEST") {
                crate::secret::write(&app, crate::ai::key_name("main"), "sk-selftest".into()).await?;
                let p = |kind: &str| crate::ai::ProviderRef { id: "main".into(), kind: kind.into(), url: url.clone() };
                let a = crate::ai::ai_request(app.clone(), p("anthropic"), "POST".into(), "/v1/messages".into(), Some(serde_json::json!({"x": 1}))).await?;
                let o = crate::ai::ai_request(app.clone(), p("openai"), "POST".into(), "/chat/completions".into(), None).await?;
                if a["x-api-key"] != "sk-selftest" || a["anthropic-version"] != "2023-06-01" || a["body"]["x"] != 1 || o["authorization"] != "Bearer sk-selftest" {
                    return Err(format!("ai: {a} {o}"));
                }
                match crate::ai::ai_request(app.clone(), p("openai"), "GET".into(), "/err".into(), None).await {
                    Err(e) if e.contains("zły klucz") => println!("SELFTEST ai-error OK: {e}"),
                    other => return Err(format!("ai-error: {other:?}")),
                }
                println!("SELFTEST ai OK");
            }
            let bad = HostCfg { id: "nope".into(), host: "127.0.0.1".into(), port, user: "x".into(), auth: "password".into(), trust_local: false };
            match session(&app, bad, vec![], "").await {
                Err(e) => println!("SELFTEST missing-secret OK: {e}"),
                Ok(_) => return Err("sesja bez hasła nie powinna ruszyć".to_string()),
            }
            Ok::<_, String>(())
        }
        .await;
        match res {
            Ok(()) => { println!("SELFTEST PASS"); std::process::exit(0) }
            Err(e) => { println!("SELFTEST FAIL {e}"); std::process::exit(1) }
        }
    });
}
