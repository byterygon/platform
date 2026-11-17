//! The DBee core through its router (DBee spec §4, §5, §14 "TSK-38, app skeleton").
//!
//! A fake driver stands in for PostgreSQL (`tests/postgres.rs` runs the real one); the
//! workspace, keychain stand-in, audit log, grant store and broker are the real ones.

mod support;

use std::sync::atomic::Ordering;
use std::time::Duration;

use ambidex::Code;
use dbee_core::audit::UnavailableAuditSink;
use dbee_core::secrets::SecretStore;
use dbee_core::{AuditConfig, SecretStoreConfig};
use security_types::{Outcome, PrincipalKind, Risk};
use serde_json::json;
use std::sync::Arc;
use support::{ManualClock, Options, PASSWORD, TESTER, TestCore, draft, kind, tester};

#[tokio::test]
async fn prepare_shows_exactly_what_the_grant_will_hold() {
    let t = TestCore::start().await;
    let preview = t.ok("connections.prepare", draft("Local")).await;
    assert_eq!(preview["driver"]["id"], "com.byterygon.dbee.postgres");
    assert_eq!(preview["driver"]["firstParty"], true);
    assert!(
        preview["driver"]["digest"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert_eq!(preview["template"], "db-transport");
    assert_eq!(preview["host"], "localhost");
    assert_eq!(preview["port"], 5432);
    assert_eq!(preview["resolvedAddresses"], json!(["127.0.0.1"]));
    assert_eq!(
        preview["proposedAddresses"],
        json!(["127.0.0.1/32", "::1/128"])
    );
    assert_eq!(preview["tls"]["kind"], "plaintext");
    assert_eq!(preview["allowCancelConnection"], true);
    assert_eq!(preview["expiresAt"], json!(null));
    assert_eq!(preview["secretBinding"], true);
    assert_eq!(preview["approver"], TESTER);
    assert!(
        preview["previewDigest"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );

    // A remote host proposes its resolved addresses; the user may widen them.
    let mut remote = draft("Remote");
    remote["host"] = json!("db.example");
    remote["tls"] = json!({ "kind": "pinned-cert", "fingerprint": "ab".repeat(32) });
    let preview = t.ok("connections.prepare", remote.clone()).await;
    assert_eq!(preview["resolvedAddresses"], json!(["10.1.2.3"]));
    assert_eq!(preview["proposedAddresses"], json!(["10.1.2.3/32"]));
    assert_eq!(preview["tls"]["serverName"], "db.example");
    assert_eq!(
        preview["tls"]["pinned"],
        json!([format!("sha256:{}", "ab".repeat(32))])
    );
    remote["allowedAddresses"] = json!(["10.1.0.0/16"]);
    let preview = t.ok("connections.prepare", remote.clone()).await;
    assert_eq!(preview["proposedAddresses"], json!(["10.1.0.0/16"]));
    remote["allowedAddresses"] = json!(["192.168.0.0/16"]);
    let err = t.err("connections.prepare", remote).await;
    assert_eq!(
        (err.code, kind(&err).as_str()),
        (Code::InvalidArgument, "InvalidTarget")
    );
    assert_eq!(err.details.as_ref().unwrap()["field"], "allowedAddresses");

    let mut unknown = draft("Unknown");
    unknown["host"] = json!("nowhere.example");
    let err = t.err("connections.prepare", unknown).await;
    assert_eq!(kind(&err), "ResolveFailed");
    let mut bad = draft("Bad");
    bad["port"] = json!(0);
    let err = t.err("connections.prepare", bad).await;
    assert_eq!(err.details.as_ref().unwrap()["field"], "port");
}

#[tokio::test]
async fn create_approves_the_grant_stores_the_record_and_audits_with_parent_ids() {
    let t = TestCore::start().await;
    let summary = t.approve("Local").await;
    assert_eq!(summary["name"], "Local");
    assert_eq!(summary["tls"], "plaintext");
    assert_eq!(summary["hasSecret"], true);
    assert_eq!(summary["status"], "disconnected");
    assert_eq!(summary["grant"]["state"], "active");
    let id = summary["id"].as_str().unwrap().to_owned();

    let list = t.ok("connections.list", json!({})).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], id);

    // The password is in the keychain stand-in and nowhere else.
    assert_eq!(t.keychain.len(), 1);
    assert!(t.keychain.contains_value(PASSWORD));
    let text = t.workspace_text();
    assert!(
        !text.contains(PASSWORD),
        "the password leaked into the workspace"
    );
    assert!(
        text.contains("\"secretRef\""),
        "the record keeps only the reference"
    );
    let outputs = format!("{summary}{list}");
    assert!(!outputs.contains(PASSWORD));
    let connections = std::fs::read_to_string(t.workspace_dir().join("connections.json")).unwrap();
    assert!(!connections.contains("password"));

    // Audit: admission and completion of the call, and the grant entry nested under it.
    let records = t.audit_records();
    let entries: Vec<_> = records.iter().map(|r| &r.entry).collect();
    let create_started = entries
        .iter()
        .find(|e| e.action.name == "connections.create" && e.outcome == Outcome::Started)
        .expect("admission entry of connections.create");
    let create_done = entries
        .iter()
        .find(|e| e.action.name == "connections.create" && e.is_completion())
        .expect("completion entry of connections.create");
    assert_eq!(create_done.outcome, Outcome::Success);
    assert_eq!(create_done.correlation_id, create_started.correlation_id);
    let grant = entries
        .iter()
        .find(|e| e.action.name == "plugin-host.grants.create")
        .expect("grant entry");
    assert_eq!(grant.outcome, Outcome::Success);
    assert_eq!(
        grant.parent_correlation_id.as_deref(),
        Some(create_started.correlation_id.as_str())
    );
    assert_ne!(grant.correlation_id, create_started.correlation_id);
    let audit_text = std::fs::read_to_string(t.audit_path()).unwrap();
    assert!(!audit_text.contains(PASSWORD));
    assert!(
        !audit_text.contains("secretRef"),
        "the reference is not in the audit log"
    );
}

#[tokio::test]
async fn an_on_behalf_of_chain_cannot_approve() {
    let t = TestCore::start().await;
    let mut acting = tester();
    acting.id = "human:local:helper".into();
    acting.on_behalf_of = Some(Box::new(tester()));
    let draft = draft("Local");
    let preview = t
        .call_as(&acting, "connections.prepare", draft.clone())
        .await
        .unwrap();
    let err = t
        .call_as(
            &acting,
            "connections.create",
            json!({
                "draft": draft,
                "previewDigest": preview["previewDigest"],
                "secret": { "password": PASSWORD },
            }),
        )
        .await
        .unwrap_err();
    assert_eq!(
        (err.code, kind(&err).as_str()),
        (Code::PermissionDenied, "GrantRefused")
    );
    assert!(
        t.ok("connections.list", json!({}))
            .await
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        t.keychain.is_empty(),
        "no secret is stored for a refused grant"
    );

    // An agent anywhere in the chain is denied by the Authorizer before any handler runs.
    let mut agent = tester();
    agent.kind = PrincipalKind::Agent;
    agent.id = "agent:token:a".into();
    agent.on_behalf_of = Some(Box::new(tester()));
    let err = t
        .call_as(&agent, "connections.list", json!({}))
        .await
        .unwrap_err();
    // Hidden procedures do not exist for agents; exposed ones are denied.
    assert_eq!(err.code, Code::PermissionDenied);
    let err = t
        .call_as(&agent, "connections.prepare", json!({}))
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::NotFound);
}

#[tokio::test]
async fn a_changed_draft_or_address_makes_the_preview_stale() {
    let t = TestCore::start().await;
    let mut draft = draft("Local");
    let preview = t.ok("connections.prepare", draft.clone()).await;
    draft["port"] = json!(5433);
    let err = t
        .err(
            "connections.create",
            json!({ "draft": draft, "previewDigest": preview["previewDigest"], "secret": { "password": PASSWORD } }),
        )
        .await;
    assert_eq!(
        (err.code, kind(&err).as_str()),
        (Code::FailedPrecondition, "PreviewStale")
    );

    // The host resolving elsewhere between prepare and create is stale too.
    let mut remote = support::draft("Remote");
    remote["host"] = json!("db.example");
    let preview = t.ok("connections.prepare", remote.clone()).await;
    t.resolver.set("db.example", &["10.9.9.9"]);
    let err = t
        .err(
            "connections.create",
            json!({ "draft": remote, "previewDigest": preview["previewDigest"], "secret": { "password": PASSWORD } }),
        )
        .await;
    assert_eq!(kind(&err), "PreviewStale");
    assert!(t.keychain.is_empty());
    assert!(
        t.ok("connections.list", json!({}))
            .await
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn an_unavailable_audit_log_blocks_create_and_creates_nothing() {
    let t = TestCore::with(Options {
        audit: Some(AuditConfig::Sink(Arc::new(UnavailableAuditSink(
            "disk full".into(),
        )))),
        ..Options::default()
    })
    .await;
    // Human Reads still run (default AuditPolicy); Writes do not.
    assert!(
        t.ok("connections.list", json!({}))
            .await
            .as_array()
            .unwrap()
            .is_empty()
    );
    let err = t.err("connections.prepare", draft("Local")).await;
    assert_eq!(err.code, Code::Unavailable);
    assert!(err.retryable);
    let err = t
        .err(
            "connections.create",
            json!({ "draft": draft("Local"), "previewDigest": "sha256:0", "secret": { "password": PASSWORD } }),
        )
        .await;
    assert_eq!(err.code, Code::Unavailable);
    assert!(
        t.ok("connections.list", json!({}))
            .await
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(t.keychain.is_empty());
    assert!(!t.workspace_dir().join("connections.json").exists());
}

#[tokio::test]
async fn a_grant_store_that_cannot_record_rolls_the_secret_back() {
    // The router records the call, then the grant store's own entry fails: the password put in
    // the keychain first is removed again and nothing is created.
    struct FlakySink(Arc<security_types::MemoryAuditLog>);
    impl security_types::AuditSink for FlakySink {
        fn append(
            &self,
            entry: security_types::AuditEntry,
        ) -> security_types::BoxFuture<'_, Result<(), security_types::AuditError>> {
            if entry.action.name.starts_with("plugin-host.") {
                return Box::pin(std::future::ready(Err(security_types::AuditError(
                    "grant log full".into(),
                ))));
            }
            self.0.append(entry)
        }
    }
    let log = Arc::new(security_types::MemoryAuditLog::new());
    let t = TestCore::with(Options {
        audit: Some(AuditConfig::Sink(Arc::new(FlakySink(log)))),
        ..Options::default()
    })
    .await;
    let draft = draft("Local");
    let preview = t.ok("connections.prepare", draft.clone()).await;
    let err = t
        .err(
            "connections.create",
            json!({ "draft": draft, "previewDigest": preview["previewDigest"], "secret": { "password": PASSWORD } }),
        )
        .await;
    assert_eq!(err.code, Code::Unavailable);
    assert!(t.keychain.is_empty());
    assert!(
        t.ok("connections.list", json!({}))
            .await
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn sessions_need_an_approved_connection_and_end_with_it() {
    let t = TestCore::start().await;
    let err = t
        .err(
            "sessions.open",
            json!({ "connectionId": "conn-missing", "purpose": "editor" }),
        )
        .await;
    assert_eq!(err.code, Code::NotFound);

    let id = t.approve("Local").await["id"].as_str().unwrap().to_owned();
    let opened = t
        .ok(
            "sessions.open",
            json!({ "connectionId": id, "purpose": "editor" }),
        )
        .await;
    assert_eq!(opened["serverVersion"], "16.1 (fake)");
    let session_id = opened["sessionId"].as_str().unwrap().to_owned();
    assert_eq!(t.probe.connects.load(Ordering::SeqCst), 1);
    let list = t.ok("connections.list", json!({})).await;
    assert_eq!(list[0]["status"], "connected");

    // The browser session is one per connection.
    let a = t
        .ok(
            "sessions.open",
            json!({ "connectionId": id, "purpose": "browser" }),
        )
        .await;
    let b = t
        .ok(
            "sessions.open",
            json!({ "connectionId": id, "purpose": "browser" }),
        )
        .await;
    assert_eq!(a["sessionId"], b["sessionId"]);
    assert_eq!(t.probe.connects.load(Ordering::SeqCst), 2);
    let schemas = t.ok("schema.schemas", json!({ "connectionId": id })).await;
    assert_eq!(schemas, json!(["public", "sales"]));
    let tables = t
        .ok(
            "schema.tables",
            json!({ "connectionId": id, "schema": "sales" }),
        )
        .await;
    assert_eq!(tables[0]["kind"], "table");
    let columns = t
        .ok(
            "schema.columns",
            json!({ "connectionId": id, "table": "items" }),
        )
        .await;
    assert_eq!(columns[0]["typeName"], "int8");

    // Another principal cannot use the session.
    let mut other = tester();
    other.id = "human:local:other".into();
    let err = t
        .call_as(&other, "sessions.close", json!({ "sessionId": session_id }))
        .await
        .unwrap();
    assert_eq!(err, json!({}), "close is idempotent and silent");
    assert!(
        t.core
            .state()
            .manager
            .session(&session_id, &tester())
            .is_some()
    );

    // Delete revokes the grant, closes the sessions and removes the keychain entry.
    let mut events = t.core.state().manager.subscribe();
    t.ok("connections.delete", json!({ "id": id })).await;
    assert!(
        t.ok("connections.list", json!({}))
            .await
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(t.keychain.is_empty());
    assert!(
        t.core
            .state()
            .manager
            .session(&session_id, &tester())
            .is_none()
    );
    let err = t
        .err(
            "sessions.open",
            json!({ "connectionId": id, "purpose": "editor" }),
        )
        .await;
    assert_eq!(err.code, Code::NotFound);
    let mut saw_ended = false;
    while let Ok(event) = events.try_recv() {
        let event = serde_json::to_value(event).unwrap();
        if event["kind"] == "SessionEnded" {
            saw_ended = true;
        }
    }
    assert!(saw_ended, "the ended session was announced");
    let revoked = t
        .audit_records()
        .iter()
        .any(|r| r.entry.action.name == "plugin-host.grants.revoke");
    assert!(revoked);
}

#[tokio::test]
async fn restart_rebuilds_the_grants_from_the_workspace() {
    let first = TestCore::start().await;
    let id = first.approve("Local").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let TestCore {
        core,
        dir,
        keychain,
        ..
    } = first;
    drop(core);

    let again = TestCore::with(Options {
        secret_store: Some(SecretStoreConfig::Store(keychain as Arc<dyn SecretStore>)),
        dir: Some(dir),
        ..Options::default()
    })
    .await;
    let list = again.ok("connections.list", json!({})).await;
    assert_eq!(list[0]["id"], id);
    assert_eq!(list[0]["hasSecret"], true);
    assert_eq!(list[0]["grant"]["state"], "active");
    again
        .ok(
            "sessions.open",
            json!({ "connectionId": id, "purpose": "editor" }),
        )
        .await;
    let restore = again
        .audit_records()
        .into_iter()
        .rfind(|r| r.entry.action.name == "plugin-host.grants.create")
        .expect("the restore writes a grant entry");
    assert_eq!(
        restore.entry.detail.as_ref().and_then(|d| d.get("origin")),
        Some("workspace_restore")
    );
    assert_eq!(restore.entry.parent_correlation_id, None);
}

#[tokio::test]
async fn update_covers_display_fields_only_and_set_secret_is_write_only() {
    let t = TestCore::start().await;
    let id = t.approve("Local").await["id"].as_str().unwrap().to_owned();
    let updated = t
        .ok(
            "connections.update",
            json!({ "id": id, "name": "Renamed", "colour": "amber" }),
        )
        .await;
    assert_eq!(updated["name"], "Renamed");
    assert_eq!(updated["colour"], "amber");
    let err = t
        .err(
            "connections.update",
            json!({ "id": id, "host": "elsewhere" }),
        )
        .await;
    assert_eq!(err.code, Code::InvalidArgument);
    let err = t
        .err("connections.update", json!({ "id": "nope", "name": "x" }))
        .await;
    assert_eq!(err.code, Code::NotFound);

    let out = t
        .ok(
            "connections.setSecret",
            json!({ "id": id, "password": "second-7c1d" }),
        )
        .await;
    assert_eq!(out["hasSecret"], true);
    assert!(t.keychain.contains_value("second-7c1d"));
    assert!(!t.keychain.contains_value(PASSWORD));
    let out = t
        .ok(
            "connections.setSecret",
            json!({ "id": id, "password": null }),
        )
        .await;
    assert_eq!(out["hasSecret"], false);
    assert!(t.keychain.is_empty());
    assert!(!t.workspace_text().contains("second-7c1d"));
}

#[tokio::test]
async fn without_a_keychain_nothing_is_persisted_and_the_password_is_per_session() {
    let t = TestCore::with(Options {
        secret_store: Some(SecretStoreConfig::SessionOnly("no secret service".into())),
        ..Options::default()
    })
    .await;
    let info = t.ok("app.info", json!({})).await;
    assert_eq!(info["secretStore"], "session-only");
    assert_eq!(info["secretStoreNote"], "no secret service");
    assert_eq!(info["mode"], "standalone");
    assert_eq!(info["drivers"][0]["firstParty"], true);

    let mut draft = draft("Local");
    let preview = t.ok("connections.prepare", draft.clone()).await;
    let err = t
        .err(
            "connections.create",
            json!({ "draft": draft, "previewDigest": preview["previewDigest"], "secret": { "password": PASSWORD } }),
        )
        .await;
    assert_eq!(kind(&err), "SecretStoreUnavailable");

    // Continue without saving the password: a new preview without a binding.
    draft["hasSecret"] = json!(false);
    let preview = t.ok("connections.prepare", draft.clone()).await;
    assert_eq!(preview["secretBinding"], false);
    let summary = t
        .ok(
            "connections.create",
            json!({ "draft": draft, "previewDigest": preview["previewDigest"] }),
        )
        .await;
    assert_eq!(summary["hasSecret"], false);
    let id = summary["id"].as_str().unwrap().to_owned();
    let out = t
        .ok(
            "connections.setSecret",
            json!({ "id": id, "password": PASSWORD }),
        )
        .await;
    assert_eq!(out["hasSecret"], true);
    assert!(!t.workspace_text().contains(PASSWORD));
    assert!(!t.workspace_text().contains("secretRef"));
    t.ok(
        "sessions.open",
        json!({ "connectionId": id, "purpose": "editor" }),
    )
    .await;
}

#[tokio::test]
async fn classify_is_the_servers_classifier() {
    let t = TestCore::start().await;
    let c = t
        .ok("query.classify", json!({ "sql": "select 1; drop table t" }))
        .await;
    assert_eq!(
        c,
        json!({ "risk": "Destructive", "statements": 2, "kind": "SELECT" })
    );
    let c = t
        .ok("query.classify", json!({ "sql": "select 'unterminated" }))
        .await;
    assert_eq!(c["risk"], "Write");
    assert_eq!(c["kind"], "unparseable");
}

#[tokio::test]
async fn execute_streams_arrow_chunks_and_reauthorizes_with_the_connection_target() {
    let t = TestCore::start().await;
    let id = t.approve("Local").await["id"].as_str().unwrap().to_owned();
    let session = t
        .ok(
            "sessions.open",
            json!({ "connectionId": id, "purpose": "editor" }),
        )
        .await["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut client = t.connect().await;
    client
        .call(
            1,
            "query.execute",
            json!({ "sessionId": session, "sql": "select * from items" }),
        )
        .await;
    let mut chunks = Vec::new();
    for _ in 0..3 {
        chunks.push(client.expect_chunk(1).await);
    }
    assert_eq!(
        chunks,
        support::ipc_chunks(&[(1, Some("a,b")), (2, None), (3, Some(""))])
    );
    let summary = client.expect_stream_end(1).await;
    assert_eq!(summary["rowsReturned"], 3);
    assert_eq!(summary["statementKind"], "SELECT");
    assert_eq!(summary["risk"], "Read");

    // A destructive statement is re-authorized at its escalated risk against the connection.
    client
        .call(
            2,
            "query.execute",
            json!({ "sessionId": session, "sql": "drop table items" }),
        )
        .await;
    for _ in 0..3 {
        client.expect_chunk(2).await;
    }
    let summary = client.expect_stream_end(2).await;
    assert_eq!(summary["risk"], "Destructive");
    let recheck = t
        .audit_records()
        .into_iter()
        .map(|r| r.entry)
        .find(|e| {
            e.action.name == "query.execute" && e.risk == Risk::Destructive && e.target.is_some()
        })
        .expect("escalated re-check entry");
    assert_eq!(recheck.target.unwrap().id, id);
    assert_eq!(recheck.outcome, Outcome::Started);

    // Errors are typed; a syntax error carries its position.
    client
        .call(
            3,
            "query.execute",
            json!({ "sessionId": session, "sql": "select syntax error" }),
        )
        .await;
    let err = client.expect_code(3, Code::InvalidArgument).await;
    assert_eq!(kind(&err), "Syntax");
    assert_eq!(err.details.as_ref().unwrap()["position"], 8);
    assert_eq!(err.details.as_ref().unwrap()["sqlstate"], "42601");
    assert!(!err.correlation_id.is_empty());

    // An unknown session is NotFound before anything runs.
    client
        .call(
            4,
            "query.execute",
            json!({ "sessionId": "sess-x", "sql": "select 1" }),
        )
        .await;
    client.expect_code(4, Code::NotFound).await;

    // SQL text never reaches the audit log.
    let audit = std::fs::read_to_string(t.audit_path()).unwrap();
    assert!(!audit.contains("from items"));
    assert!(!audit.contains("drop table"));
}

#[tokio::test]
async fn cancel_reaches_the_drivers_result_stream() {
    let t = TestCore::start().await;
    let id = t.approve("Local").await["id"].as_str().unwrap().to_owned();
    let session = t
        .ok(
            "sessions.open",
            json!({ "connectionId": id, "purpose": "editor" }),
        )
        .await["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut client = t.connect().await;
    client
        .call(
            1,
            "query.execute",
            json!({ "sessionId": session, "sql": "select pg_sleep(60)" }),
        )
        .await;
    // The schema chunk shows the statement is running.
    client.expect_chunk(1).await;
    assert_eq!(t.probe.cancels.load(Ordering::SeqCst), 0);
    let started = std::time::Instant::now();
    client.cancel(1).await;
    client.expect_code(1, Code::Cancelled).await;
    let deadline = started + Duration::from_secs(5);
    while t.probe.cancels.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(
        t.probe.cancels.load(Ordering::SeqCst),
        1,
        "ResultStream::cancel was called"
    );
    // The completion entry is written after the Cancelled reply reaches the client, so wait for
    // it (bounded) instead of reading the audit log once.
    let audit_deadline = std::time::Instant::now() + Duration::from_secs(5);
    let completion = loop {
        let found = t
            .audit_records()
            .into_iter()
            .map(|r| r.entry)
            .find(|e| e.action.name == "query.execute" && e.is_completion());
        match found {
            Some(entry) => break entry,
            None if std::time::Instant::now() < audit_deadline => {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            None => panic!("completion of the cancelled call"),
        }
    };
    assert_eq!(
        completion.delivery,
        Some(security_types::Delivery::Cancelled)
    );
}

#[tokio::test]
async fn export_streams_the_encoded_result_to_the_client() {
    let t = TestCore::start().await;
    let id = t.approve("Local").await["id"].as_str().unwrap().to_owned();
    let session = t
        .ok(
            "sessions.open",
            json!({ "connectionId": id, "purpose": "editor" }),
        )
        .await["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut client = t.connect().await;
    client
        .call(
            1,
            "export.run",
            json!({
                "sessionId": session,
                "sql": "select * from items",
                "format": "csv",
                "options": { "nullText": "NULL" },
                "destination": { "kind": "client" },
            }),
        )
        .await;
    let chunk = client.expect_chunk(1).await;
    let summary = client.expect_stream_end(1).await;
    let text = String::from_utf8(chunk).unwrap();
    assert_eq!(text, "id,name\n1,\"a,b\"\n2,NULL\n3,\n");
    assert_eq!(summary["rows"], 3);
    assert_eq!(summary["bytes"], text.len());
    assert_eq!(summary["path"], json!(null));

    // JSON Lines, and the file destination needs a handle from files.chooseSavePath, which this
    // shell does not have.
    client
        .call(
            2,
            "export.run",
            json!({
                "sessionId": session,
                "sql": "select * from items",
                "format": "jsonl",
                "destination": { "kind": "file", "handle": "nope" },
            }),
        )
        .await;
    client.expect_code(2, Code::InvalidArgument).await;
    let err = t
        .err(
            "files.chooseSavePath",
            json!({ "suggestedName": "items.csv" }),
        )
        .await;
    assert_eq!(err.code, Code::Unimplemented);
}

#[tokio::test]
async fn a_grant_that_expires_is_announced_and_ends_its_sessions() {
    let t = TestCore::start().await;
    let mut events = t.core.state().manager.subscribe();
    let mut draft = draft("Short");
    let expires_at = security_types::unix_now_ms() + 1200;
    draft["expiresAt"] = json!(expires_at);
    let preview = t.ok("connections.prepare", draft.clone()).await;
    assert_eq!(preview["expiresAt"], expires_at);
    let summary = t
        .ok(
            "connections.create",
            json!({ "draft": draft, "previewDigest": preview["previewDigest"], "secret": { "password": PASSWORD } }),
        )
        .await;
    let id = summary["id"].as_str().unwrap().to_owned();
    assert_eq!(summary["grant"]["expiresAt"], expires_at);
    let session = t
        .ok(
            "sessions.open",
            json!({ "connectionId": id, "purpose": "editor" }),
        )
        .await["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();

    let mut seen = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while seen.len() < 2 {
        let event = tokio::time::timeout_at(deadline, events.recv())
            .await
            .expect("expiry events arrive")
            .unwrap();
        let event = serde_json::to_value(event).unwrap();
        if matches!(
            event["kind"].as_str(),
            Some("GrantExpiring" | "GrantExpired")
        ) {
            seen.push(event);
        }
    }
    assert_eq!(seen[0]["kind"], "GrantExpiring");
    assert_eq!(seen[0]["expiresAt"], expires_at);
    assert_eq!(seen[1]["kind"], "GrantExpired");
    assert!(
        t.core
            .state()
            .manager
            .session(&session, &tester())
            .is_none()
    );
    let list = t.ok("connections.list", json!({})).await;
    assert_eq!(list[0]["status"], "expired");
    assert_eq!(list[0]["grant"]["state"], "expired");
    let err = t
        .err(
            "sessions.open",
            json!({ "connectionId": id, "purpose": "editor" }),
        )
        .await;
    assert_eq!(
        (err.code, kind(&err).as_str()),
        (Code::PermissionDenied, "PermissionDenied")
    );
    assert_eq!(err.details.as_ref().unwrap()["reason"]["kind"], "Expired");
}

/// Reads the next expiry event of `events`, with a real-time bound only as a hang guard.
async fn next_expiry_event(
    events: &mut tokio::sync::broadcast::Receiver<dbee_core::types::AppEvent>,
) -> serde_json::Value {
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("an expiry event arrives")
            .unwrap();
        let event = serde_json::to_value(event).unwrap();
        if matches!(
            event["kind"].as_str(),
            Some("GrantExpiring" | "GrantExpired")
        ) {
            return event;
        }
    }
}

async fn approve_with_expiry(t: &TestCore, expires_at: u64) -> String {
    let mut draft = draft("Short");
    draft["expiresAt"] = json!(expires_at);
    let preview = t.ok("connections.prepare", draft.clone()).await;
    let summary = t
        .ok(
            "connections.create",
            json!({ "draft": draft, "previewDigest": preview["previewDigest"], "secret": { "password": PASSWORD } }),
        )
        .await;
    summary["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn expiry_events_follow_the_clock_in_order_and_on_time() {
    let start = security_types::unix_now_ms();
    let clock = ManualClock::at(start);
    let t = TestCore::with(Options {
        clock: Some(clock.clone()),
        ..Options::default()
    })
    .await;
    let mut events = t.core.state().manager.subscribe();
    let expires_at = start + 60 * 60 * 1000;
    let id = approve_with_expiry(&t, expires_at).await;
    let session = t
        .ok(
            "sessions.open",
            json!({ "connectionId": id, "purpose": "editor" }),
        )
        .await["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();

    // Just before the warning time: nothing yet.
    let warn_at = expires_at - 15 * 60 * 1000;
    clock.advance(warn_at - 1 - start);
    tokio::task::yield_now().await;
    assert!(events.try_recv().map_or(true, |e| !matches!(
        serde_json::to_value(e).unwrap()["kind"].as_str(),
        Some("GrantExpiring")
    )));

    clock.advance(1);
    let warning = next_expiry_event(&mut events).await;
    assert_eq!(warning["kind"], "GrantExpiring");
    assert_eq!(warning["expiresAt"], expires_at);
    assert!(
        t.core
            .state()
            .manager
            .session(&session, &tester())
            .is_some()
    );

    clock.advance(expires_at - warn_at - 1);
    tokio::task::yield_now().await;
    assert!(
        t.core
            .state()
            .manager
            .session(&session, &tester())
            .is_some()
    );

    clock.advance(1);
    let expired = next_expiry_event(&mut events).await;
    assert_eq!(expired["kind"], "GrantExpired");
    assert_eq!(expired["expiredAt"], expires_at);
    assert!(
        t.core
            .state()
            .manager
            .session(&session, &tester())
            .is_none()
    );
}

#[tokio::test]
async fn a_clock_that_jumps_past_both_times_announces_both_at_once() {
    // A machine waking from sleep: the wall clock is already past the warning and the expiry.
    let start = security_types::unix_now_ms();
    let clock = ManualClock::at(start);
    let t = TestCore::with(Options {
        clock: Some(clock.clone()),
        ..Options::default()
    })
    .await;
    let mut events = t.core.state().manager.subscribe();
    let expires_at = start + 60 * 60 * 1000;
    let id = approve_with_expiry(&t, expires_at).await;
    let session = t
        .ok(
            "sessions.open",
            json!({ "connectionId": id, "purpose": "editor" }),
        )
        .await["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();

    clock.advance(3 * 60 * 60 * 1000);
    assert_eq!(
        next_expiry_event(&mut events).await["kind"],
        "GrantExpiring"
    );
    assert_eq!(next_expiry_event(&mut events).await["kind"], "GrantExpired");
    assert!(
        t.core
            .state()
            .manager
            .session(&session, &tester())
            .is_none()
    );
    let list = t.ok("connections.list", json!({})).await;
    assert_eq!(list[0]["status"], "expired");
}

#[tokio::test]
async fn app_events_subscription_carries_status_changes() {
    let t = TestCore::start().await;
    let mut client = t.connect().await;
    client.subscribe(1, "app.events", json!({})).await;
    let id = t.approve("Local").await["id"].as_str().unwrap().to_owned();
    let event = client.expect_event(1).await;
    assert_eq!(
        event,
        json!({ "kind": "ConnectionStatus", "connectionId": id, "status": "disconnected" })
    );
    t.ok(
        "sessions.open",
        json!({ "connectionId": id, "purpose": "editor" }),
    )
    .await;
    let event = client.expect_event(1).await;
    assert_eq!(event["status"], "connecting");
    let event = client.expect_event(1).await;
    assert_eq!(event["status"], "connected");
    client.unsubscribe(1).await;
}

// ---------------------------------------------------------------------------------------------
// Workspace documents (app.getWorkspace / app.setWorkspace, spec §5 and Open question 11)
// ---------------------------------------------------------------------------------------------

/// SQL text a tab holds; it must reach tabs.json and nothing else (spec §4: no SQL in the audit).
const TAB_SQL: &str = "select 'tab-text-6c1e' from accounts";

#[tokio::test]
async fn tabs_and_settings_survive_a_restart_and_a_stale_revision_conflicts() {
    let first = TestCore::start().await;
    let empty = first.ok("app.getWorkspace", json!({})).await;
    assert_eq!(empty["settings"], json!(null));
    assert_eq!(empty["tabs"], json!(null));
    let base = empty["revision"].as_str().unwrap().to_owned();

    let settings = json!({ "version": 1, "settings": { "density": "comfortable" } });
    let tabs = json!({ "version": 1, "tabs": [{ "id": "t1", "sql": TAB_SQL }], "activeTab": "t1" });
    let written = first
        .ok(
            "app.setWorkspace",
            json!({ "settings": settings, "tabs": tabs, "baseRevision": base }),
        )
        .await;
    let revision = written["revision"].as_str().unwrap().to_owned();
    assert_ne!(revision, base);

    // A second window still holding the first revision writes nothing.
    let err = first
        .err(
            "app.setWorkspace",
            json!({ "tabs": { "version": 1, "tabs": [] }, "baseRevision": base }),
        )
        .await;
    assert_eq!(
        (err.code, kind(&err).as_str()),
        (Code::FailedPrecondition, "Conflict")
    );
    assert_eq!(err.details.as_ref().unwrap()["revision"], revision);

    // Only the document given changes; the other keeps its value.
    let only_settings = json!({ "version": 1, "settings": { "density": "compact" } });
    let revision = first
        .ok(
            "app.setWorkspace",
            json!({ "settings": only_settings, "baseRevision": revision }),
        )
        .await["revision"]
        .as_str()
        .unwrap()
        .to_owned();
    let read = first.ok("app.getWorkspace", json!({})).await;
    assert_eq!(read["settings"], only_settings);
    assert_eq!(read["tabs"], tabs);
    assert_eq!(read["revision"], revision);

    // The files are the documents, and the tab text is in tabs.json only.
    let on_disk: serde_json::Value =
        serde_json::from_slice(&std::fs::read(first.workspace_dir().join("tabs.json")).unwrap())
            .unwrap();
    assert_eq!(on_disk, tabs);
    let audit_text = std::fs::read_to_string(first.audit_path()).unwrap();
    assert!(
        !audit_text.contains("tab-text-6c1e"),
        "tab SQL leaked into the audit log"
    );
    let entries: Vec<_> = first
        .audit_records()
        .into_iter()
        .map(|r| r.entry)
        .filter(|e| e.action.name == "app.setWorkspace")
        .collect();
    // Admission and completion of three calls, at Write risk with the workspace permission.
    assert_eq!(entries.len(), 6);
    assert!(entries.iter().all(|e| e.risk == Risk::Write));
    assert!(
        entries
            .iter()
            .all(|e| e.action.perm.as_str() == "workspace.write")
    );
    assert_eq!(
        entries
            .iter()
            .filter(|e| e.outcome == Outcome::Success)
            .count(),
        2
    );

    // Restart on the same workspace: the documents are back under a new revision.
    let TestCore {
        core,
        dir,
        keychain,
        ..
    } = first;
    drop(core);
    let again = TestCore::with(Options {
        secret_store: Some(SecretStoreConfig::Store(keychain as Arc<dyn SecretStore>)),
        dir: Some(dir),
        ..Options::default()
    })
    .await;
    let restored = again.ok("app.getWorkspace", json!({})).await;
    assert_eq!(restored["settings"], only_settings);
    assert_eq!(restored["tabs"], tabs);
    assert_ne!(restored["revision"], json!(revision));
    let err = again
        .err(
            "app.setWorkspace",
            json!({ "tabs": tabs, "baseRevision": revision }),
        )
        .await;
    assert_eq!(kind(&err), "Conflict");
}

#[tokio::test]
async fn set_workspace_takes_objects_within_the_cap_only() {
    let t = TestCore::start().await;
    let base = t.ok("app.getWorkspace", json!({})).await["revision"].clone();
    let err = t
        .err(
            "app.setWorkspace",
            json!({ "tabs": [TAB_SQL], "baseRevision": base }),
        )
        .await;
    assert_eq!(
        (err.code, kind(&err).as_str()),
        (Code::InvalidArgument, "InvalidDocument")
    );
    assert_eq!(err.details.as_ref().unwrap()["document"], "tabs");
    assert!(!err.message.contains("tab-text-6c1e"));

    let big = "x".repeat(dbee_core::types::MAX_WORKSPACE_DOCUMENT_BYTES);
    let err = t
        .err(
            "app.setWorkspace",
            json!({ "settings": { "v": big }, "baseRevision": base }),
        )
        .await;
    assert_eq!(kind(&err), "InvalidDocument");
    assert_eq!(err.details.as_ref().unwrap()["document"], "settings");

    // A write the disk refuses reports the file, not the directory, and changes nothing.
    std::fs::create_dir(t.workspace_dir().join("tabs.json")).unwrap();
    let err = t
        .err(
            "app.setWorkspace",
            json!({ "tabs": { "v": 1 }, "baseRevision": base }),
        )
        .await;
    assert_eq!(
        (err.code, kind(&err).as_str()),
        (Code::FailedPrecondition, "WriteFailed")
    );
    let message = err.details.as_ref().unwrap()["message"].as_str().unwrap();
    assert!(
        message.starts_with("could not write tabs.json"),
        "{message}"
    );
    assert!(!message.contains(&*t.workspace_dir().to_string_lossy()));
    let read = t.ok("app.getWorkspace", json!({})).await;
    assert_eq!((&read["tabs"], &read["revision"]), (&json!(null), &base));
}

#[tokio::test]
async fn workspace_documents_follow_the_audit_policy_and_hide_from_agents() {
    // Without an audit log the read runs (human Reads run and report); the write does not.
    let t = TestCore::with(Options {
        audit: Some(AuditConfig::Sink(Arc::new(UnavailableAuditSink(
            "disk full".into(),
        )))),
        ..Options::default()
    })
    .await;
    let base = t.ok("app.getWorkspace", json!({})).await["revision"].clone();
    let err = t
        .err(
            "app.setWorkspace",
            json!({ "tabs": { "version": 1 }, "baseRevision": base }),
        )
        .await;
    assert_eq!(err.code, Code::Unavailable);
    assert!(!t.workspace_dir().join("tabs.json").exists());
    assert_eq!(t.ok("app.getWorkspace", json!({})).await["revision"], base);

    // Both are Hidden: an agent's chain does not find them.
    let t = TestCore::start().await;
    let mut agent = tester();
    agent.kind = PrincipalKind::Agent;
    agent.id = "agent:token:a".into();
    agent.on_behalf_of = Some(Box::new(tester()));
    for (procedure, input) in [
        ("app.getWorkspace", json!({})),
        (
            "app.setWorkspace",
            json!({ "tabs": {}, "baseRevision": "x" }),
        ),
    ] {
        let err = t.call_as(&agent, procedure, input).await.unwrap_err();
        assert_eq!(err.code, Code::NotFound, "{procedure}");
    }
    assert!(!t.workspace_dir().join("tabs.json").exists());
}
