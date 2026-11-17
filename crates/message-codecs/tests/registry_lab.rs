//! Against the lab's Confluent Schema Registry (Mightyconsole spec §14; TSK-80 acceptance
//! "wire-format"): Avro, Protobuf with an import through a reference, and JSON Schema with a
//! `$ref` through a reference, encoded in the wire format and read back identical; the three
//! naming strategies; compatibility checks, levels and the mode.
//!
//! Needs `MESSAGE_CODECS_REGISTRY_URL` (the lab's is `http://127.0.0.1:8081`); skipped without
//! it unless `BYTERYGON_REQUIRE_LAB=1`, as CI's Mightyconsole lab job sets. Every run uses its
//! own subject prefix, so runs do not see each other's subjects.

use std::time::{SystemTime, UNIX_EPOCH};

use message_codecs::registry::SchemaReference;
use message_codecs::types::*;
use message_codecs::{Codecs, CodecsConfig, CompiledSchema, RegistryClient, RegistryConfig};

const ORDER_PROTO: &str = include_str!("fixtures/order.proto");
const MONEY_PROTO: &str = include_str!("fixtures/money.proto");
const ORDER_V1: &str = include_str!("fixtures/order-v1.avsc");
const ORDER_V2: &str = include_str!("fixtures/order-v2.avsc");

fn registry_url() -> Option<String> {
    match std::env::var("MESSAGE_CODECS_REGISTRY_URL") {
        Ok(u) if !u.is_empty() => Some(u),
        _ => {
            assert!(
                std::env::var("BYTERYGON_REQUIRE_LAB").as_deref() != Ok("1"),
                "BYTERYGON_REQUIRE_LAB=1 but MESSAGE_CODECS_REGISTRY_URL is not set"
            );
            eprintln!(
                "skipped: MESSAGE_CODECS_REGISTRY_URL is not set (start the lab's kafka profile)"
            );
            None
        }
    }
}

fn prefix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("tsk80x{nanos}")
}

fn payload(codec: CodecId, text: &str, schema: Option<SchemaRef>) -> ComposePayload {
    ComposePayload {
        codec,
        text: text.into(),
        schema,
        message_type: None,
        wire_format: None,
    }
}

#[tokio::test]
async fn lab_registry() {
    let Some(url) = registry_url() else { return };
    let p = prefix();
    let registry = RegistryClient::new(&RegistryConfig::new(url)).unwrap();
    assert_eq!(registry.mode().await.unwrap(), "READWRITE");

    // --- Avro: two versions under BACKWARD, compatibility checked first.
    let avro_subject = format!("{p}-orders-avro-value");
    let v1 = registry
        .register(&avro_subject, SchemaType::Avro, ORDER_V1, &[])
        .await
        .unwrap();
    registry
        .set_compatibility_level(Some(&avro_subject), "BACKWARD")
        .await
        .unwrap();
    assert_eq!(
        registry
            .compatibility_level(Some(&avro_subject))
            .await
            .unwrap()
            .as_deref(),
        Some("BACKWARD")
    );
    let latest = SchemaVersion::Latest(Latest::Latest);
    let ok = registry
        .check_compatibility(&avro_subject, latest, SchemaType::Avro, ORDER_V2, &[])
        .await
        .unwrap();
    assert!(ok.is_compatible, "{:?}", ok.messages);
    let breaking = ORDER_V1.replace(
        r#""name": "customer", "type": "string""#,
        r#""name": "customer", "type": "int""#,
    );
    assert_ne!(
        breaking, ORDER_V1,
        "the fixture changed; update the replacement"
    );
    let bad = registry
        .check_compatibility(&avro_subject, latest, SchemaType::Avro, &breaking, &[])
        .await
        .unwrap();
    assert!(!bad.is_compatible);
    assert!(!bad.messages.is_empty(), "verbose messages explain why");
    let v2 = registry
        .register(&avro_subject, SchemaType::Avro, ORDER_V2, &[])
        .await
        .unwrap();
    assert_ne!(v1, v2);
    assert_eq!(registry.versions(&avro_subject).await.unwrap(), vec![1, 2]);
    assert!(
        registry
            .id_versions(v2)
            .await
            .unwrap()
            .iter()
            .any(|r| r.subject == avro_subject && r.version == 2)
    );
    let e = registry
        .register(&avro_subject, SchemaType::Avro, &breaking, &[])
        .await
        .unwrap_err();
    assert_eq!(e.kind, message_codecs::ErrorKind::Conflict, "{e}");

    // --- Protobuf with an import through a reference.
    let money_subject = format!("{p}-lab/common/money.proto");
    registry
        .register(&money_subject, SchemaType::Protobuf, MONEY_PROTO, &[])
        .await
        .unwrap();
    let refs = [SchemaReference {
        name: "lab/common/money.proto".into(),
        subject: money_subject.clone(),
        version: 1,
    }];
    let proto_id = registry
        .register(
            &format!("{p}-orders-proto-value"),
            SchemaType::Protobuf,
            ORDER_PROTO,
            &refs,
        )
        .await
        .unwrap();

    // --- JSON Schema with a $ref through a reference.
    let customer_subject = format!("{p}-customer.json");
    registry
        .register(
            &customer_subject,
            SchemaType::Jsonschema,
            r#"{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}"#,
            &[],
        )
        .await
        .unwrap();
    let json_refs = [SchemaReference {
        name: "customer.json".into(),
        subject: customer_subject,
        version: 1,
    }];
    let json_id = registry
        .register(
            &format!("{p}-events-value"),
            SchemaType::Jsonschema,
            r#"{"title":"lab.Event","type":"object","properties":{"customer":{"$ref":"customer.json"}},"required":["customer"]}"#,
            &json_refs,
        )
        .await
        .unwrap();

    // --- Encode in the wire format (TopicNameStrategy picks the subject), read back identical.
    let codecs = Codecs::new(CodecsConfig {
        registry: Some(registry.clone()),
        ..CodecsConfig::default()
    });
    let topic = |t: &str| Target::Topic {
        name: format!("{p}-{t}"),
    };
    let cases = [
        (
            "orders-avro",
            CodecId::Avro,
            r#"{"id":"o-1","customer":"c-1","amount":"19.90","placedAt":"2026-11-17T10:00:00.250Z","note":"gift","channel":"WEB"}"#,
            v2,
        ),
        (
            "orders-proto",
            CodecId::Protobuf,
            r#"{"id":"o-2","customer":"c-2","total":{"currency":"EUR","units":"9007199254740993","nanos":10},"items":["x","y"],"status":"SHIPPED"}"#,
            proto_id,
        ),
        (
            "events",
            CodecId::Jsonschema,
            r#"{"customer":{"name":"An"}}"#,
            json_id,
        ),
    ];
    for (t, codec, text, id) in cases {
        let enc = codecs
            .encode(Some(&topic(t)), Part::Value, &payload(codec, text, None))
            .await
            .unwrap();
        assert_eq!(enc.schema_id, Some(id), "{t}");
        assert_eq!(
            message_codecs::wire::split(&enc.bytes).unwrap().0.schema_id,
            id
        );
        // A fresh client, so the schema comes from the registry, not the encoder's cache.
        let reader = Codecs::new(CodecsConfig {
            registry: Some(RegistryClient::new(&RegistryConfig::new(registry.url())).unwrap()),
            ..CodecsConfig::default()
        });
        let d = reader
            .decode(
                &enc.bytes,
                Some(&topic(t)),
                Part::Value,
                &CodecChoice::auto(),
            )
            .await;
        assert_eq!(
            (d.codec, d.text.as_deref(), d.error.as_deref()),
            (codec, Some(text), None),
            "{t}"
        );
        assert_eq!(d.schema_ref, Some(format!("registry:{id}")));
    }
    // A JSON Schema violation through the reference is listed, not fatal.
    let enc = codecs
        .encode(
            Some(&topic("events")),
            Part::Value,
            &payload(CodecId::Json, r#"{"customer":{}}"#, None),
        )
        .await
        .unwrap();
    let wired = message_codecs::wire::write(json_id, None, &enc.bytes);
    let d = codecs
        .decode(&wired, None, Part::Value, &CodecChoice::auto())
        .await;
    assert!(
        d.error.as_deref().is_some_and(|e| e.contains("/customer")),
        "{:?}",
        d.error
    );

    // --- The three naming strategies give the subjects the registry holds.
    let compiled = registry.schema_by_id(v2).await.unwrap().compiled.clone();
    let record = compiled.record_name(None).unwrap();
    assert_eq!(record, "lab.orders.Order");
    // Record names are global, so the record strategy registers a record of this run's own.
    let own = ORDER_V2.replace(
        r#""namespace": "lab.orders""#,
        &format!(r#""namespace": "{p}.orders""#),
    );
    let own_record = match message_codecs::schema::compile_local(&LocalSchema {
        id: "own".into(),
        name: "own".into(),
        schema_type: SchemaType::Avro,
        files: LocalSchemaFiles::Files(vec![SchemaFile {
            path: "o.avsc".into(),
            text: own.clone(),
        }]),
        message_types: None,
    })
    .unwrap()
    {
        CompiledSchema::Avro(s) => s.record_name().unwrap(),
        _ => unreachable!(),
    };
    let naming = NamingConfig {
        default: NamingStrategy::TopicNameStrategy,
        topics: vec![
            TopicNaming {
                topic: format!("{p}-events-rn"),
                strategy: NamingStrategy::RecordNameStrategy,
            },
            TopicNaming {
                topic: format!("{p}-audit"),
                strategy: NamingStrategy::TopicRecordNameStrategy,
            },
        ],
    };
    let subjects = [
        (format!("{p}-plain"), None, format!("{p}-plain-value")),
        (
            format!("{p}-events-rn"),
            Some(own_record.as_str()),
            own_record.clone(),
        ),
        (
            format!("{p}-audit"),
            Some(record.as_str()),
            format!("{p}-audit-lab.orders.Order"),
        ),
    ];
    let schema_for = |s: &str| {
        if s == own_record {
            own.clone()
        } else {
            ORDER_V2.to_owned()
        }
    };
    let topics: Vec<String> = subjects.iter().map(|(t, _, _)| t.clone()).collect();
    for (t, record_name, want) in &subjects {
        let subject = naming.subject(t, Part::Value, *record_name).unwrap();
        assert_eq!(&subject, want);
        let id = registry
            .register(&subject, SchemaType::Avro, &schema_for(&subject), &[])
            .await
            .unwrap();
        // Encode by subject, decode by id: the subject the strategy named is the one in use.
        let schema = SchemaRef::Registry(RegistryRef::Subject {
            subject: subject.clone(),
            version: latest,
        });
        let text = r#"{"id":"n","customer":"c","amount":"1.00","placedAt":0}"#;
        let enc = codecs
            .encode(
                Some(&Target::Topic { name: t.clone() }),
                Part::Value,
                &payload(CodecId::Avro, text, Some(schema)),
            )
            .await
            .unwrap();
        assert_eq!(enc.schema_id, Some(id));
        assert_eq!(
            naming
                .topics_for_subject(&subject, &topics)
                .first()
                .map(|(t, _)| t),
            Some(t),
            "{subject}"
        );
    }
    assert!(registry.subjects().await.unwrap().contains(&own_record));
}
