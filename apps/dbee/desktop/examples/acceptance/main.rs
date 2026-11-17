//! The desktop acceptance driver (TSK-61, DBee spec §1 performance budget and §14): the real
//! desktop app — the same [`Desktop`] core, Ambidex plugin, capability, CSP and bundled UI as
//! `dbee-desktop` — with the TSK-39 bench hook and `driver.js` installed as an initialization
//! script on the `main` window. It is an example, never shipped. Everything it does in the page
//! goes through the UI (tree chevrons, the toolbar's Run and Cancel, the grid's scroller); the
//! connection itself is created beforehand through the core's own `connections.prepare` and
//! `connections.create`, as the approval dialog does.
//!
//! ```sh
//! # a workspace with one approved plaintext connection to a server holding bench_rows and the
//! # schema `wide` (apps/dbee/acceptance), and one query tab with `select * from bench_rows`
//! cargo run --release -p dbee-desktop --example acceptance -- prepare --workspace W --port 55432
//! # measure: time to a usable window, schema tree, idle RAM, time to first rows, scrolling
//! # while 1M x 10 rows stream, the end of the stream, cancel to the driver-side cancel
//! cargo run --release -p dbee-desktop --example acceptance -- perf --workspace W [--seconds 3] [--out report.json]
//! ```
//!
//! `apps/dbee/acceptance/acceptance.sh perf` runs both, plus the real binary's cold start.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dbee_desktop::{Desktop, MAIN_WINDOW, local_identity};
use security_types::{Principal, PrincipalKind, SessionId};
use serde_json::{Value, json};
use tauri::{RunEvent, WebviewWindow, WebviewWindowBuilder};

const DRIVER_JS: &str = include_str!("driver.js");
const CONNECTION: &str = "Bench (plaintext)";
const TAB_SQL: &str = "select * from bench_rows";
/// A second tab for the cancel measurement: 10M rows, long enough to cancel mid-stream.
const CANCEL_SQL: &str = "select * from bench_rows cross join generate_series(1, 10) as copy";

struct Args {
    command: String,
    workspace: PathBuf,
    port: u16,
    seconds: f64,
    out: Option<PathBuf>,
    /// `steps`: a JSON array of `[name, args]` pairs run in order instead of the perf scenario.
    steps: Option<String>,
}

fn args() -> Result<Args, String> {
    let mut it = std::env::args().skip(1);
    let command = it
        .next()
        .ok_or("usage: acceptance prepare|perf --workspace DIR ...")?;
    let mut workspace = None;
    let mut port = 55432;
    let mut seconds = 3.0;
    let mut out = None;
    let mut steps = None;
    while let Some(flag) = it.next() {
        let mut value = || it.next().ok_or(format!("{flag} needs a value"));
        match flag.as_str() {
            "--workspace" => workspace = Some(PathBuf::from(value()?)),
            "--port" => port = value()?.parse().map_err(|e| format!("--port: {e}"))?,
            "--seconds" => seconds = value()?.parse().map_err(|e| format!("--seconds: {e}"))?,
            "--out" => out = Some(PathBuf::from(value()?)),
            "--steps" => steps = Some(value()?),
            other => return Err(format!("unknown flag {other}")),
        }
    }
    Ok(Args {
        command,
        workspace: workspace.ok_or("--workspace is required")?,
        port,
        seconds,
        out,
        steps,
    })
}

fn main() -> ExitCode {
    let started = Instant::now();
    let args = match args() {
        Ok(args) => args,
        Err(e) => {
            eprintln!("acceptance: {e}");
            return ExitCode::from(2);
        }
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    tauri::async_runtime::set(runtime.handle().clone());
    match args.command.as_str() {
        "prepare" => match runtime.block_on(prepare(&args)) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("acceptance prepare: {e}");
                ExitCode::FAILURE
            }
        },
        "perf" | "steps" => perf(args, started, &runtime),
        other => {
            eprintln!("acceptance: unknown command {other}");
            ExitCode::from(2)
        }
    }
}

/// The local human as the desktop session would carry it.
fn principal() -> Principal {
    let identity = local_identity().expect("OS user");
    Principal {
        kind: PrincipalKind::Human,
        id: identity.principal_id(),
        tenant: security_types::TenantId::new(dbee_core::authz::LOCAL_TENANT),
        on_behalf_of: None,
        roles: vec![],
        session: SessionId::new("acceptance-prepare"),
    }
}

async fn call(desktop: &Desktop, procedure: &str, input: Value) -> Result<Value, String> {
    let session = Arc::new(ambidex::Session {
        id: "acceptance-prepare".into(),
        principal: principal(),
    });
    desktop
        .core()
        .router()
        .call(session, ambidex::Call::new(procedure, input))
        .await
        .map_err(|e| format!("{procedure}: {e:?}"))
}

async fn prepare(args: &Args) -> Result<(), String> {
    std::fs::create_dir_all(&args.workspace).map_err(|e| e.to_string())?;
    let identity = local_identity().map_err(|e| e.to_string())?;
    let desktop = Desktop::start(args.workspace.clone(), identity, Instant::now(), |_| {})
        .await
        .map_err(|e| e.to_string())?;
    let draft = json!({
        "name": CONNECTION,
        "host": "127.0.0.1",
        "port": args.port,
        "database": "postgres",
        "user": "postgres",
        "tls": { "kind": "plaintext" },
        "hasSecret": false,
    });
    let preview = call(&desktop, "connections.prepare", draft.clone()).await?;
    let created = call(
        &desktop,
        "connections.create",
        json!({ "draft": draft, "previewDigest": preview["previewDigest"] }),
    )
    .await?;
    let workspace = call(&desktop, "app.getWorkspace", json!({})).await?;
    call(
        &desktop,
        "app.setWorkspace",
        json!({
            "tabs": {
                "version": 1,
                "tabs": [
                    { "id": "bench", "connectionId": created["id"], "sql": TAB_SQL, "maxRows": null },
                    { "id": "cancel", "connectionId": created["id"], "sql": CANCEL_SQL, "maxRows": null },
                ],
                "activeTab": "bench",
            },
            "baseRevision": workspace["revision"],
        }),
    )
    .await?;
    println!(
        "{}",
        json!({ "workspace": args.workspace, "connection": created["id"], "preview": preview })
    );
    Ok(())
}

/// Process ids whose resident set counts as the app: this process, its descendants (WebKitGTK's
/// web and network processes on Linux) and, on macOS, the WebKit XPC services started after
/// `before` (WKWebView's processes are children of launchd, not of the app).
fn app_pids(before: &BTreeSet<u32>) -> Vec<(u32, String, u64)> {
    let out = Command::new("ps")
        .args(["-axo", "pid=,ppid=,rss=,comm="])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let rows: Vec<(u32, u32, u64, String)> = out
        .lines()
        .filter_map(|l| {
            let mut f = l.split_whitespace();
            Some((
                f.next()?.parse().ok()?,
                f.next()?.parse().ok()?,
                f.next()?.parse().ok()?,
                f.collect::<Vec<_>>().join(" "),
            ))
        })
        .collect();
    let mut ours: BTreeSet<u32> = BTreeSet::from([std::process::id()]);
    loop {
        let more: Vec<u32> = rows
            .iter()
            .filter(|r| ours.contains(&r.1) && !ours.contains(&r.0))
            .map(|r| r.0)
            .collect();
        if more.is_empty() {
            break;
        }
        ours.extend(more);
    }
    if cfg!(target_os = "macos") {
        ours.extend(
            rows.iter()
                .filter(|r| r.3.contains("com.apple.WebKit") && !before.contains(&r.0))
                .map(|r| r.0),
        );
    }
    rows.into_iter()
        .filter(|r| ours.contains(&r.0))
        .map(|r| (r.0, r.3, r.2))
        .collect()
}

fn webkit_pids() -> BTreeSet<u32> {
    app_pids(&BTreeSet::new())
        .into_iter()
        .map(|p| p.0)
        .chain(
            Command::new("ps")
                .args(["-axo", "pid=,comm="])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                .unwrap_or_default()
                .lines()
                .filter(|l| l.contains("com.apple.WebKit"))
                .filter_map(|l| l.split_whitespace().next()?.parse().ok()),
        )
        .collect()
}

/// macOS: the process's physical footprint in KiB (what Activity Monitor shows as Memory), from
/// `footprint -p`; RSS there also counts the shared system frameworks every process maps.
fn footprint_kib(pid: u32) -> Option<f64> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = Command::new("footprint")
        .args(["-p", &pid.to_string()])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let rest = text.split("Footprint: ").nth(1)?;
    let mut it = rest.split_whitespace();
    let n: f64 = it.next()?.parse().ok()?;
    let unit = it.next()?;
    Some(match unit {
        "B" => n / 1024.0,
        "KB" => n,
        "MB" => n * 1024.0,
        "GB" => n * 1024.0 * 1024.0,
        _ => return None,
    })
}

fn memory(before: &BTreeSet<u32>) -> Value {
    let pids: Vec<_> = app_pids(before)
        .into_iter()
        .filter(|p| !["ps", "footprint"].iter().any(|t| p.1.ends_with(t)))
        .collect();
    let total_kib: u64 = pids.iter().map(|p| p.2).sum();
    let footprints: Vec<Option<f64>> = pids.iter().map(|p| footprint_kib(p.0)).collect();
    let footprint_total = footprints
        .iter()
        .copied()
        .sum::<Option<f64>>()
        .map(|kib| kib / 1024.0);
    json!({
        "totalMiB": total_kib as f64 / 1024.0,
        "footprintMiB": footprint_total,
        "method": "sum of ps rss over the app's processes; on macOS also the sum of footprint -p (physical footprint)",
        "processes": pids.iter().zip(&footprints).map(|((pid, name, rss), fp)| json!({
            "pid": pid,
            "name": Path::new(name).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| name.clone()),
            "rssMiB": *rss as f64 / 1024.0,
            "footprintMiB": fp.map(|k| k / 1024.0),
        })).collect::<Vec<_>>(),
    })
}

/// Evaluates `js` in the window and returns its value as a string (wry hands it over as JSON).
async fn eval(window: &WebviewWindow, js: String) -> Result<String, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Mutex::new(Some(tx));
    window
        .eval_with_callback(js, move |value| {
            if let Some(tx) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = tx.send(value);
            }
        })
        .map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(30), rx)
        .await
        .map_err(|_| "eval timed out".to_owned())?
        .map_err(|_| "eval dropped".to_owned())
}

/// A JSON value the page returned through `JSON.stringify`, possibly quoted once more by wry.
fn decode(raw: &str) -> Value {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::String(inner)) => serde_json::from_str(&inner).unwrap_or(Value::String(inner)),
        Ok(v) => v,
        Err(_) => Value::String(raw.to_owned()),
    }
}

/// Starts a step of driver.js and waits for its result.
async fn step(
    window: &WebviewWindow,
    name: &str,
    args: Value,
    limit: Duration,
) -> Result<Value, String> {
    let deadline = Instant::now() + limit;
    // The init script is installed before the page's own scripts; wait until it is there.
    loop {
        // Before the first page load an evaluation may be dropped unanswered; try again.
        let ready = eval(
            window,
            "typeof window.__acc === 'object' ? 'yes' : 'no'".into(),
        )
        .await;
        if ready.is_ok_and(|r| r.contains("yes")) {
            break;
        }
        if Instant::now() > deadline {
            return Err("driver.js is not installed".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    eval(
        window,
        format!("window.__acc.start({}, {args})", Value::from(name)),
    )
    .await?;
    loop {
        let raw = eval(window, format!("window.__acc.poll({})", Value::from(name))).await?;
        let v = decode(&raw);
        if let Some(ok) = v.get("ok") {
            return Ok(ok.clone());
        }
        if let Some(err) = v.get("error") {
            return Err(format!("{name}: {}", err.as_str().unwrap_or_default()));
        }
        if Instant::now() > deadline {
            return Err(format!("{name}: no result within {limit:?}"));
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// The audit entries of the cancel connection opened at or after `since_unix_ms`.
fn cancel_entries(workspace: &Path, since_unix_ms: u64) -> Vec<u64> {
    dbee_core::audit::read_records(&workspace.join("audit/log.jsonl"))
        .unwrap_or_default()
        .into_iter()
        .filter(|r| r.entry.action.name == "plugin-host.broker.open-cancel")
        .map(|r| r.entry.timestamp_unix_ms)
        .filter(|t| *t >= since_unix_ms.saturating_sub(1))
        .collect()
}

async fn scenario(
    window: WebviewWindow,
    workspace: PathBuf,
    seconds: f64,
    started: Instant,
    before: BTreeSet<u32>,
) -> Result<Value, String> {
    let minute = Duration::from_secs(60);
    let usable = step(
        &window,
        "usable",
        json!({ "connection": CONNECTION }),
        minute,
    )
    .await?;
    let usable_ms = started.elapsed().as_millis();
    let tree = step(
        &window,
        "tree",
        json!({ "connection": CONNECTION, "schema": "wide", "firstTable": "table_00001" }),
        minute,
    )
    .await?;
    let _ = step(&window, "idle", json!({ "ms": 5000 }), minute).await?;
    let idle = memory(&before);
    let run = step(
        &window,
        "run",
        json!({ "seconds": seconds }),
        Duration::from_secs(900),
    )
    .await?;
    let loaded = memory(&before);
    let cancel = step(
        &window,
        "cancel",
        json!({ "afterRows": 20000, "tab": "select * from bench_rows cross" }),
        Duration::from_secs(120),
    )
    .await?;
    let clicked = cancel["clickedAtUnixMs"].as_u64().unwrap_or(0);
    let entries = cancel_entries(&workspace, clicked);
    let cancel_issued_ms = entries.first().map(|t| t.saturating_sub(clicked));
    let verified = dbee_core::audit::verify(&workspace.join("audit/log.jsonl"))
        .map(
            |r| json!({ "verified": true, "records": r.records, "unfinished": r.unfinished.len() }),
        )
        .unwrap_or_else(|e| json!({ "verified": false, "error": format!("{e:?}") }));
    Ok(json!({
        "platform": { "os": std::env::consts::OS, "arch": std::env::consts::ARCH, "userAgent": usable["userAgent"], "devicePixelRatio": usable["devicePixelRatio"] },
        "usableWindowMs": usable_ms,
        "tree": tree,
        "idleMemory": idle,
        "run": run,
        "memoryAfter1M": loaded,
        "cancel": {
            "page": cancel,
            "cancelConnectionAuditMs": cancel_issued_ms,
            "note": "click (Date.now) to the audit entry plugin-host.broker.open-cancel (the driver's cancel request through the broker), both wall clock on this machine",
        },
        "auditChain": verified,
    }))
}

/// Runs `[[name, args], ...]` in order; stops at the first failing step.
async fn run_steps(window: WebviewWindow, list: &str) -> Result<Value, String> {
    let list: Vec<(String, Value)> =
        serde_json::from_str(list).map_err(|e| format!("--steps: {e}"))?;
    let mut done = Vec::new();
    for (name, args) in list {
        match step(&window, &name, args, Duration::from_secs(300)).await {
            Ok(v) => done.push(json!({ "step": name, "ok": v })),
            Err(e) => {
                done.push(json!({ "step": name, "error": e }));
                break;
            }
        }
    }
    Ok(json!({ "steps": done }))
}

fn perf(args: Args, started: Instant, runtime: &tokio::runtime::Runtime) -> ExitCode {
    let identity = local_identity().expect("OS user");
    let desktop = match runtime.block_on(Desktop::start(
        args.workspace.clone(),
        identity,
        started,
        |_| {},
    )) {
        Ok(desktop) => desktop,
        Err(e) => {
            eprintln!("acceptance perf: {e}");
            return ExitCode::FAILURE;
        }
    };
    let core_ready_ms = started.elapsed().as_millis();
    let mut context = tauri::generate_context!();
    // The main window is created below, from the same configuration, with the driver installed.
    let windows = std::mem::take(&mut context.config_mut().app.windows);
    let app = match desktop.configure(tauri::Builder::default()).build(context) {
        Ok(app) => app,
        Err(e) => {
            eprintln!("acceptance perf: {e}");
            return ExitCode::FAILURE;
        }
    };
    let workspace = args.workspace.clone();
    let out = args.out.clone();
    let seconds = args.seconds;
    let custom = args.steps.clone();
    let code = app.run_return(move |handle, event| {
        if let RunEvent::Ready = event {
            let Some(config) = windows.iter().find(|w| w.label == MAIN_WINDOW) else {
                eprintln!("acceptance perf: no main window in tauri.conf.json");
                handle.exit(1);
                return;
            };
            let before = webkit_pids();
            let window = match WebviewWindowBuilder::from_config(handle, config)
                .and_then(|b| b.initialization_script(DRIVER_JS).build())
            {
                Ok(window) => window,
                Err(e) => {
                    eprintln!("acceptance perf: cannot open the window: {e}");
                    handle.exit(1);
                    return;
                }
            };
            let window_ms = started.elapsed().as_millis();
            let handle = handle.clone();
            let workspace = workspace.clone();
            let out = out.clone();
            let custom = custom.clone();
            tauri::async_runtime::spawn(async move {
                let result = match custom {
                    Some(list) => run_steps(window, &list).await,
                    None => scenario(window, workspace, seconds, started, before).await,
                };
                let (report, code) = match result {
                    Ok(mut report) => {
                        report["coreReadyMs"] = json!(core_ready_ms);
                        report["windowCreatedMs"] = json!(window_ms);
                        (report, 0)
                    }
                    Err(e) => (json!({ "error": e }), 1),
                };
                let text = serde_json::to_string_pretty(&report).unwrap_or_default();
                println!("{text}");
                if let Some(path) = out {
                    let _ = std::fs::write(path, &text);
                }
                handle.exit(code);
            });
        }
    });
    if code == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
