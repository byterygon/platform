//! The fixture API over the real WebSocket transport, for the TypeScript client's integration
//! tests (Ambidex spec §12, TSK-8).
//!
//! ```text
//! cargo run -p ambidex-conformance --no-default-features --features ws --bin conformance-server
//! ```
//!
//! Serves the same router, engine configuration and transport as the `ws` harness: axum over
//! rustls on an ephemeral loopback port with a certificate generated in memory, Host, Origin and
//! session-cookie checks on. The allowed host is `localhost:<port>` and the origin
//! `https://localhost:<port>`, so a client can connect without overriding `Host`.
//!
//! Protocol on stdio, one JSON object per line:
//!
//! - On start, stdout gets `{"url", "origin", "ca_pem", "cookie_name", "schema_hash"}`.
//! - stdin `session` → `{"cookie", "csrf"}`: a fresh placeholder web session.
//! - stdin `events` → `{"events": ["Started:wait", "Cancelled:wait", ...]}`: what the fixture
//!   handlers did since the last `events`.
//! - stdin end of file stops the server.

use std::io::{BufRead, Write};
use std::sync::Arc;

use ambidex_axum::{
    DEFAULT_SESSION_COOKIE, PlaceholderSessions, RPC_WS_PATH, WsConfig, WsTransport,
    tls_server_config,
};
use ambidex_conformance::fixture::{Event, Fixture, SCHEMA_HASH, server_config};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use security_types::{Principal, PrincipalKind, SessionId, TenantId};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::mpsc;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).expect("certificate");
    let cert_der = CertificateDer::from(cert.cert.der().to_vec());
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()));
    let tls = tls_server_config(vec![cert_der], key).expect("TLS config");

    // Loopback only, ephemeral port.
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("local addr").port();
    let host = format!("localhost:{port}");
    let origin = format!("https://{host}");

    let fixture = Fixture::new();
    let sessions = Arc::new(PlaceholderSessions::new());
    let transport = WsTransport::new(
        WsConfig::new([host.clone()], origin.clone()),
        server_config(),
        Arc::clone(&sessions),
        fixture.router(),
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

    print_line(&json!({
        "url": format!("wss://{host}{RPC_WS_PATH}"),
        "origin": origin,
        "ca_pem": cert.cert.pem(),
        "cookie_name": DEFAULT_SESSION_COOKIE,
        "schema_hash": SCHEMA_HASH.as_str(),
    }));

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
            "events" => {
                let events: Vec<String> = fixture
                    .probe
                    .pending()
                    .await
                    .into_iter()
                    .map(|event| match event {
                        Event::Started(name) => format!("Started:{name}"),
                        Event::Cancelled(name) => format!("Cancelled:{name}"),
                        Event::Dropped(name) => format!("Dropped:{name}"),
                    })
                    .collect();
                print_line(&json!({ "events": events }));
            }
            other => print_line(&json!({ "error": format!("unknown command {other:?}") })),
        }
    }

    let _ = stop_tx.send(());
    server
        .await
        .expect("server task")
        .expect("server stops cleanly");
}

fn print_line(value: &serde_json::Value) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{value}").expect("stdout");
    out.flush().expect("stdout");
}

fn principal() -> Principal {
    Principal {
        kind: PrincipalKind::Human,
        id: "human:placeholder:alice".into(),
        tenant: TenantId::new("t-1"),
        on_behalf_of: None,
        roles: vec![],
        session: SessionId::new("overwritten by issue"),
    }
}
