//! Read-only integration with the unchanged production engine and frame parser.
use ambidex::engine::BoxFuture;
use ambidex::frame::{Frame, FrameDecoder, Kind};
use ambidex::security_types::{
    Authorizer, AuthzRequest, Decision, Principal, PrincipalKind, SessionId, TenantId,
};
use ambidex::transport::{TransportRx, TransportTx, memory};
use ambidex::{Authenticate, Code, Hello, Router, Server, ServerConfig, Session};
use serde_json::json;
struct Auth;
impl Authenticate for Auth {
    fn authenticate<'a>(&'a self, _: &'a Hello) -> BoxFuture<'a, Option<Session>> {
        Box::pin(async {
            Some(Session {
                id: "legacy-session".into(),
                principal: Principal {
                    kind: PrincipalKind::Human,
                    id: "human:alice".into(),
                    tenant: TenantId::new("test"),
                    on_behalf_of: None,
                    roles: vec![],
                    session: SessionId::new("legacy-session"),
                },
            })
        })
    }
}
struct Deny;
impl Authorizer for Deny {
    async fn check(&self, _: &AuthzRequest<'_>) -> Decision {
        Decision::Deny {
            reason: ambidex::security_types::Reason::Policy {
                message: "deny".into(),
            },
        }
    }
}
#[tokio::test]
async fn unchanged_engine_ignores_capability_extension() {
    let server = Server::new(
        ServerConfig::new("spike", "hash-v1", "test"),
        Auth,
        Router::new(Deny),
    );
    let ((sr, st), (mut cr, mut ct)) = memory(16);
    let connection = server.serve(sr, st);
    let hello = json!({"protocol":1,"api":"spike","schema_hash":"hash-v1","client_version":"spike","capabilities":{"version":1,"controlCodecs":["json-lossless-v2","cbor-v1"]}});
    let frame = Frame::new(Kind::Hello, 0, serde_json::to_vec(&hello).unwrap());
    ct.send(frame.encode(1048576).unwrap()).await.unwrap();
    let bytes = tokio::time::timeout(std::time::Duration::from_secs(2), cr.recv())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let mut decoder = FrameDecoder::new(1048576);
    decoder.push(&bytes);
    let ack = decoder.next_frame().unwrap().unwrap();
    assert_eq!((ack.kind, ack.call_id), (Kind::HelloAck, 0));
    let payload: serde_json::Value = serde_json::from_slice(&ack.payload).unwrap();
    assert!(payload.get("capabilities").is_none());
    connection.goaway(Code::Unavailable, "done").await;
    connection.closed().await;
}
#[test]
fn unchanged_ack_and_control_frames_stay_json() {
    let ack = json!({"session":"s","server_version":"v","limits":{"max_frame_bytes":1048576,"max_concurrent_calls":4},"capabilities":{"version":1,"codec":"cbor-v1"}});
    let _: ambidex::HelloAck = serde_json::from_value(ack).unwrap();
    for kind in [Kind::Error, Kind::Goaway] {
        let frame = Frame::new(
            kind,
            0,
            serde_json::to_vec(&json!({"code":"VersionMismatch","message":"unsupported codec"}))
                .unwrap(),
        );
        let bytes = frame.encode(1048576).unwrap();
        let mut d = FrameDecoder::new(1048576);
        d.push(&bytes);
        let decoded = d.next_frame().unwrap().unwrap();
        assert_eq!(decoded.call_id, 0);
        assert!(serde_json::from_slice::<serde_json::Value>(&decoded.payload).is_ok());
    }
}
