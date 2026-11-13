//! The benchmark server: `bench.rows` over the real WebSocket transport (axum, rustls) on an
//! ephemeral loopback port, backed by the native PostgreSQL driver.
//!
//! ```text
//! cargo run --release -p ambidex-bench --bin bench-server -- [--rows N] [--pg-port P ...]
//! ```
//!
//! Options:
//!
//! - `--rows N`: rows in the benchmark table (default 1000000).
//! - `--pg-port P [--pg-user U] [--pg-database D]`: use the PostgreSQL server already running on
//!   127.0.0.1:P (password in `BENCH_PG_PASSWORD`) instead of starting a throwaway cluster.
//! - `--frame-bytes N`, `--initial-credits N`, `--max-credits N`: engine limits (spec §6).
//!
//! Protocol on stdio, one JSON object per line, like `conformance-server`:
//!
//! - On start, after the table exists, stdout gets `{"url", "origin", "ca_pem", "cookie_name",
//!   "schema_hash", "rows", "load_ms", "frame_bytes", "initial_credits", "max_credits"}`.
//! - stdin `session` -> `{"cookie", "csrf"}`: a fresh placeholder web session.
//! - stdin end of file stops the server and the cluster it started.

use std::io::{BufRead, Write};
use std::sync::Arc;

use ambidex_axum::{
    DEFAULT_SESSION_COOKIE, PlaceholderSessions, RPC_WS_PATH, WsConfig, WsTransport,
    tls_server_config,
};
use ambidex_bench::pg::{Cluster, Db, Server};
use ambidex_bench::{router, server_config};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use security_types::{Principal, PrincipalKind, SessionId, TenantId};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::mpsc;

struct Args {
    rows: u64,
    server: Server,
    frame_bytes: Option<u32>,
    initial_credits: Option<u32>,
    max_credits: Option<u32>,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        rows: 1_000_000,
        server: Server::Managed,
        frame_bytes: None,
        initial_credits: None,
        max_credits: None,
    };
    let (mut port, mut user, mut database) = (None, "postgres".to_owned(), "postgres".to_owned());
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = |name: &str| it.next().ok_or(format!("{name} needs a value"));
        let number = |v: String, name: &str| {
            v.parse::<u64>()
                .map_err(|_| format!("{name}: not a number"))
        };
        match flag.as_str() {
            "--rows" => args.rows = number(value("--rows")?, "--rows")?,
            "--pg-port" => port = Some(number(value("--pg-port")?, "--pg-port")?),
            "--pg-user" => user = value("--pg-user")?,
            "--pg-database" => database = value("--pg-database")?,
            "--frame-bytes" => args.frame_bytes = Some(number(value(&flag)?, &flag)? as u32),
            "--initial-credits" => {
                args.initial_credits = Some(number(value(&flag)?, &flag)? as u32)
            }
            "--max-credits" => args.max_credits = Some(number(value(&flag)?, &flag)? as u32),
            other => return Err(format!("unknown option {other}")),
        }
    }
    if args.rows == 0 {
        return Err("--rows must be at least 1".into());
    }
    if let Some(port) = port {
        args.server = Server::External {
            port: u16::try_from(port).map_err(|_| "--pg-port: out of range".to_owned())?,
            user,
            database,
            password: std::env::var("BENCH_PG_PASSWORD").ok(),
        };
    }
    Ok(args)
}

#[tokio::main]
async fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(e) => {
            eprintln!("bench-server: {e}");
            std::process::exit(2);
        }
    };
    // The cluster is dropped (and its files deleted) before the process exits.
    if let Err(e) = run(args).await {
        eprintln!("bench-server: {e}");
        std::process::exit(1);
    }
}

async fn run(args: Args) -> Result<(), String> {
    let cluster = Cluster::start(args.server.clone()).await?;
    let db = Arc::new(Db::new(&cluster).await?);
    eprintln!(
        "bench-server: generating {} rows in PostgreSQL (port {})",
        args.rows,
        cluster.port()
    );
    let load = db.load(args.rows).await?;

    let mut config = server_config();
    if let Some(n) = args.frame_bytes {
        config.max_frame_bytes = n;
    }
    if let Some(n) = args.initial_credits {
        config.stream_initial_credits = n;
    }
    if let Some(n) = args.max_credits {
        config.stream_max_credits = n;
    }

    let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).expect("certificate");
    let cert_der = CertificateDer::from(cert.cert.der().to_vec());
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()));
    let tls = tls_server_config(vec![cert_der], key).expect("TLS config");

    // Loopback only, ephemeral port.
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("local addr").port();
    let host = format!("localhost:{port}");
    let origin = format!("https://{host}");

    let sessions = Arc::new(PlaceholderSessions::new());
    let info = json!({
        "url": format!("wss://{host}{RPC_WS_PATH}"),
        "origin": origin,
        "ca_pem": cert.cert.pem(),
        "cookie_name": DEFAULT_SESSION_COOKIE,
        "schema_hash": ambidex_bench::schema_hash(),
        "rows": args.rows,
        "load_ms": load.as_millis() as u64,
        "frame_bytes": config.max_frame_bytes,
        "initial_credits": config.stream_initial_credits,
        "max_credits": config.stream_max_credits,
    });
    let transport = WsTransport::new(
        WsConfig::new([host.clone()], origin),
        config,
        Arc::clone(&sessions),
        router(Some(db)),
    )
    .expect("valid WsConfig");
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        transport
            .serve(listener, tls, axum::Router::new(), async {
                let _ = stop_rx.await;
            })
            .await
    });
    print_line(&info);

    // Blocking stdin on its own thread; commands are handled on the runtime.
    let (lines_tx, mut lines) = mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if lines_tx.send(line).is_err() {
                break;
            }
        }
    });
    while let Some(line) = lines.recv().await {
        match line.trim() {
            "session" => {
                let issued = sessions.issue(principal()).expect("OS randomness");
                print_line(&json!({ "cookie": issued.cookie, "csrf": issued.csrf_token }));
            }
            other => print_line(&json!({ "error": format!("unknown command {other:?}") })),
        }
    }

    let _ = stop_tx.send(());
    let _ = server.await;
    cluster.stop().await;
    Ok(())
}

fn print_line(value: &serde_json::Value) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{value}").expect("stdout");
    out.flush().expect("stdout");
}

fn principal() -> Principal {
    Principal {
        kind: PrincipalKind::Human,
        id: "human:bench:runner".into(),
        tenant: TenantId::new("t-1"),
        on_behalf_of: None,
        roles: vec![],
        session: SessionId::new("overwritten by issue"),
    }
}
