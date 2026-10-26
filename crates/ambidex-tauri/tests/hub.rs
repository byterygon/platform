//! Hub tests with the real engine and an in-process frame sink (no Tauri runtime).

mod common;

use std::io;
use std::sync::Arc;
use std::time::Duration;

use ambidex::frame::{Frame, Kind};
use ambidex_tauri::{FrameSink, Hub, HubConfig, IpcError};
use common::{Frames, WhoAmI, call, hello, identity, payload, server_config};
use tokio::sync::mpsc;

/// Forwards server chunks to the test; the receiver sees `None` once the transport dropped it.
struct TestSink(mpsc::UnboundedSender<Vec<u8>>);

impl FrameSink for TestSink {
    fn send(&self, bytes: Vec<u8>) -> io::Result<()> {
        self.0
            .send(bytes)
            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))
    }
}

struct Peer {
    id: String,
    chunks: mpsc::UnboundedReceiver<Vec<u8>>,
    frames: Frames,
}

impl Peer {
    async fn next(&mut self) -> Frame {
        loop {
            let chunk = tokio::time::timeout(Duration::from_secs(5), self.chunks.recv())
                .await
                .expect("timed out waiting for a server frame")
                .expect("transport closed");
            if let Some(frame) = self.frames.push(&chunk).into_iter().next() {
                return frame;
            }
        }
    }

    /// Waits until the transport dropped the sink.
    async fn closed(&mut self) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.chunks.recv().await.is_some() {}
        })
        .await
        .expect("transport still open");
    }
}

fn hub(config: HubConfig) -> Arc<Hub> {
    Arc::new(Hub::new(config, identity(), server_config(), WhoAmI))
}

fn two_webviews() -> HubConfig {
    HubConfig {
        allowed_webviews: vec!["main".into(), "second".into()],
        ..HubConfig::default()
    }
}

fn connect(hub: &Arc<Hub>, label: &str) -> Result<Peer, IpcError> {
    let (tx, chunks) = mpsc::unbounded_channel();
    let id = hub.connect(label, label, Box::new(TestSink(tx)))?;
    Ok(Peer {
        id,
        chunks,
        frames: Frames::new(),
    })
}

async fn handshake(hub: &Hub, label: &str, peer: &mut Peer) -> serde_json::Value {
    hub.send(label, &peer.id, hello()).await.unwrap();
    let ack = peer.next().await;
    assert_eq!(ack.kind, Kind::HelloAck);
    payload(&ack)
}

#[tokio::test]
async fn session_is_the_local_human_bound_to_the_webview() {
    let hub = hub(HubConfig::default());
    let mut peer = connect(&hub, "main").unwrap();
    let ack = handshake(&hub, "main", &mut peer).await;

    let session = hub.session("main").expect("session created on connect");
    assert_eq!(session.webview_label, "main");
    assert_eq!(ack["session"], session.id.as_str());

    // Hello.auth claimed root/admin; the call still runs as the local user with app-chosen roles.
    hub.send("main", &peer.id, call(1, "whoami")).await.unwrap();
    let result = peer.next().await;
    assert_eq!((result.kind, result.call_id), (Kind::Result, 1));
    let who = payload(&result);
    assert_eq!(who["principal"], "human:local:alice");
    assert_eq!(who["session"], session.id.as_str());
    assert_eq!(who["principal_session"], session.id.as_str());
    assert_eq!(who["roles"], serde_json::json!(["owner"]));
}

#[tokio::test]
async fn chunks_need_not_align_with_frames() {
    let hub = hub(HubConfig::default());
    let mut peer = connect(&hub, "main").unwrap();
    let mut bytes = hello();
    bytes.extend(call(7, "whoami"));
    for chunk in bytes.chunks(5) {
        hub.send("main", &peer.id, chunk.to_vec()).await.unwrap();
    }
    assert_eq!(peer.next().await.kind, Kind::HelloAck);
    let result = peer.next().await;
    assert_eq!((result.kind, result.call_id), (Kind::Result, 7));
}

#[tokio::test]
async fn connections_of_one_webview_share_its_session() {
    let hub = hub(two_webviews());
    let mut a = connect(&hub, "main").unwrap();
    let mut b = connect(&hub, "main").unwrap();
    let mut c = connect(&hub, "second").unwrap();
    assert_ne!(a.id, b.id);
    let ack_a = handshake(&hub, "main", &mut a).await;
    let ack_b = handshake(&hub, "main", &mut b).await;
    let ack_c = handshake(&hub, "second", &mut c).await;
    assert_eq!(ack_a["session"], ack_b["session"]);
    assert_ne!(ack_a["session"], ack_c["session"]);
}

#[tokio::test]
async fn webviews_outside_the_allowlist_cannot_connect() {
    let hub = hub(HubConfig::default());
    assert_eq!(
        connect(&hub, "settings").err(),
        Some(IpcError::WebviewNotAllowed)
    );
    assert!(hub.session("settings").is_none());
}

#[tokio::test]
async fn a_webview_cannot_use_another_webviews_connection() {
    let hub = hub(two_webviews());
    let mut owner = connect(&hub, "main").unwrap();
    let _other = connect(&hub, "second").unwrap();

    assert_eq!(
        hub.send("second", &owner.id, hello()).await,
        Err(IpcError::UnknownConnection)
    );
    assert_eq!(
        hub.close("second", &owner.id),
        Err(IpcError::UnknownConnection)
    );
    // The owner's connection is untouched.
    handshake(&hub, "main", &mut owner).await;
    assert_eq!(
        hub.send("main", "0000000000000000", hello()).await,
        Err(IpcError::UnknownConnection)
    );
}

#[tokio::test]
async fn connections_per_webview_are_capped() {
    let hub = hub(HubConfig {
        max_connections_per_webview: 2,
        ..HubConfig::default()
    });
    let first = connect(&hub, "main").unwrap();
    let _second = connect(&hub, "main").unwrap();
    assert_eq!(
        connect(&hub, "main").err(),
        Some(IpcError::TooManyConnections)
    );
    hub.close("main", &first.id).unwrap();
    connect(&hub, "main").unwrap();
}

#[tokio::test]
async fn close_ends_the_connection() {
    let hub = hub(HubConfig::default());
    let mut peer = connect(&hub, "main").unwrap();
    handshake(&hub, "main", &mut peer).await;
    hub.close("main", &peer.id).unwrap();
    peer.closed().await;
    assert_eq!(
        hub.send("main", &peer.id, call(1, "whoami")).await,
        Err(IpcError::UnknownConnection)
    );
    assert_eq!(hub.connection_count("main"), 0);
}

#[tokio::test]
async fn page_load_ends_the_session_and_its_connections() {
    let hub = hub(HubConfig::default());
    let mut peer = connect(&hub, "main").unwrap();
    let old = handshake(&hub, "main", &mut peer).await;

    hub.end_webview("main");
    peer.closed().await;
    assert!(hub.session("main").is_none());

    let mut fresh = connect(&hub, "main").unwrap();
    let new = handshake(&hub, "main", &mut fresh).await;
    assert_ne!(old["session"], new["session"]);
}

#[tokio::test]
async fn window_destroyed_ends_its_webviews() {
    let hub = hub(two_webviews());
    let mut main = connect(&hub, "main").unwrap();
    let second = connect(&hub, "second").unwrap();
    hub.end_window("second");
    assert!(hub.session("second").is_none());
    assert_eq!(
        hub.send("second", &second.id, hello()).await,
        Err(IpcError::UnknownConnection)
    );
    handshake(&hub, "main", &mut main).await;
}

#[tokio::test]
async fn engine_close_forgets_the_connection() {
    let hub = hub(HubConfig::default());
    let mut peer = connect(&hub, "main").unwrap();
    // A non-Hello first frame is refused by the engine, which then closes.
    hub.send("main", &peer.id, call(1, "whoami")).await.unwrap();
    let refused = peer.next().await;
    assert_eq!(refused.kind, Kind::Error);
    peer.closed().await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while hub.connection_count("main") > 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("connection not forgotten");
}
