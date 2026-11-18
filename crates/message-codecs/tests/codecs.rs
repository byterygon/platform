//! The codec registry end to end (Mightyconsole spec §5.2, §5.3; TSK-80 acceptance "codecs",
//! "wire-format" without the lab, "local-schemas"): auto-detect on a fixture set of ambiguous
//! payloads, every codec through [`Codecs`], local schemas and mappings, and the Confluent wire
//! format through a fake registry on loopback.

mod support;

use message_codecs::types::*;
use message_codecs::{
    Codecs, CodecsConfig, RegistryClient, RegistryConfig, codec::detect_plain, wire,
};
use serde_json::json;
use support::FakeRegistry;

const ORDER_PROTO: &str = include_str!("fixtures/order.proto");
const MONEY_PROTO: &str = include_str!("fixtures/money.proto");
const ORDER_V1: &str = include_str!("fixtures/order-v1.avsc");
const ORDER_V2: &str = include_str!("fixtures/order-v2.avsc");

fn proto_files() -> Vec<SchemaFile> {
    vec![
        SchemaFile {
            path: "lab/orders/order.proto".into(),
            text: ORDER_PROTO.into(),
        },
        SchemaFile {
            path: "lab/common/money.proto".into(),
            text: MONEY_PROTO.into(),
        },
    ]
}

fn msgpack(v: &rmpv_like::V) -> Vec<u8> {
    rmpv_like::encode(v)
}

/// Hand-written MessagePack, so the fixtures do not depend on the encoder under test.
mod rmpv_like {
    pub enum V {
        Map1(&'static str, u8),
        Arr(Vec<u8>),
    }
    pub fn encode(v: &V) -> Vec<u8> {
        match v {
            V::Map1(k, n) => {
                let mut out = vec![0x81, 0xa0 | k.len() as u8];
                out.extend_from_slice(k.as_bytes());
                out.push(*n);
                out
            }
            V::Arr(items) => {
                let mut out = vec![0x90 | items.len() as u8];
                out.extend_from_slice(items);
                out
            }
        }
    }
}

#[test]
fn auto_detect_order_on_ambiguous_payloads() {
    use rmpv_like::V;
    let mostly_text: Vec<u8> = [&[0u8, 0, 0, 0, 1][..], &[b'a'; 200]].concat();
    let cases: Vec<(&str, Vec<u8>, CodecId)> = vec![
        ("JSON object", br#"{"id":1}"#.to_vec(), CodecId::Json),
        (
            "JSON array with spaces",
            b"  [1, 2]\n".to_vec(),
            CodecId::Json,
        ),
        ("bare number stays text", b"42".to_vec(), CodecId::Utf8),
        (
            "bare JSON string stays text",
            br#""hi""#.to_vec(),
            CodecId::Utf8,
        ),
        ("broken JSON is text", br#"{"id":"#.to_vec(), CodecId::Utf8),
        (
            "plain text",
            "Xin chào, thế giới".as_bytes().to_vec(),
            CodecId::Utf8,
        ),
        ("empty payload", Vec::new(), CodecId::Utf8),
        (
            "MessagePack map",
            msgpack(&V::Map1("a", 1)),
            CodecId::Msgpack,
        ),
        (
            "MessagePack array",
            msgpack(&V::Arr(vec![1, 2, 3])),
            CodecId::Msgpack,
        ),
        (
            "MessagePack with trailing bytes is binary",
            [msgpack(&V::Arr(vec![1])), vec![0xc1]].concat(),
            CodecId::Hex,
        ),
        (
            "base64 text is never base64",
            b"AAGr/w==".to_vec(),
            CodecId::Utf8,
        ),
        ("binary", vec![0x00, 0xff, 0x10, 0x80], CodecId::Hex),
        (
            "text with many controls is binary",
            b"a\x01\x02b".to_vec(),
            CodecId::Hex,
        ),
        ("invalid UTF-8", vec![b'a', 0xc3, 0x28], CodecId::Hex),
        (
            "wire format without a registry, mostly printable",
            mostly_text,
            CodecId::Utf8,
        ),
        (
            "wire format without a registry, binary",
            wire::write(7, None, &[0x02, 0xff]),
            CodecId::Hex,
        ),
    ];
    for (name, bytes, want) in cases {
        assert_eq!(detect_plain(&bytes), want, "{name}");
    }
}

#[tokio::test]
async fn every_codec_round_trips_through_the_engine() {
    let codecs = Codecs::default();
    let cases = [
        (CodecId::Utf8, "Xin chào"),
        (
            CodecId::Json,
            r#"{"b":1,"a":[1,2,{"big":12345678901234567890}]}"#,
        ),
        (CodecId::Hex, "0001abff"),
        (CodecId::Base64, "AAGr/w=="),
        (
            CodecId::Msgpack,
            r#"{"b":1,"a":"x","bin":{"$binary":"AP8="},"ext":{"$ext":-1,"data":"AQ=="}}"#,
        ),
    ];
    for (codec, text) in cases {
        let payload = ComposePayload {
            codec,
            text: text.into(),
            schema: None,
            message_type: None,
            wire_format: None,
        };
        let enc = codecs.encode(None, Part::Value, &payload).await.unwrap();
        let dec = codecs
            .decode(&enc.bytes, None, Part::Value, &CodecChoice::codec(codec))
            .await;
        assert_eq!(dec.codec, codec);
        assert_eq!(dec.text.as_deref(), Some(text), "{codec}");
        assert!(dec.error.is_none(), "{codec}: {:?}", dec.error);
    }
    // A codec that cannot read the bytes says why and keeps nothing else.
    let d = codecs
        .decode(
            &[0xff],
            None,
            Part::Value,
            &CodecChoice::codec(CodecId::Utf8),
        )
        .await;
    assert_eq!((d.codec, d.text.is_none()), (CodecId::Utf8, true));
    assert!(d.error.unwrap().contains("UTF-8"));
    let d = codecs
        .decode(b"x", None, Part::Value, &CodecChoice::codec(CodecId::Avro))
        .await;
    assert!(d.error.unwrap().contains("needs a schema"));
    // Encoding errors carry the part and the position.
    let e = codecs
        .encode(
            None,
            Part::Key,
            &ComposePayload {
                codec: CodecId::Json,
                text: "{\n\"a\":}".into(),
                schema: None,
                message_type: None,
                wire_format: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(e.field.as_deref(), Some("key"));
    assert_eq!(e.position.map(|p| p.line), Some(2));
}

fn local(id: &str, t: SchemaType, files: Vec<SchemaFile>) -> LocalSchema {
    LocalSchema {
        id: id.into(),
        name: id.into(),
        schema_type: t,
        files: LocalSchemaFiles::Files(files),
        message_types: None,
    }
}

#[tokio::test]
async fn local_schemas_and_mappings() {
    let codecs = Codecs::new(CodecsConfig {
        local_schemas: vec![
            local("proto", SchemaType::Protobuf, proto_files()),
            local("avro", SchemaType::Avro, vec![SchemaFile { path: "order.avsc".into(), text: ORDER_V2.into() }]),
            local(
                "json",
                SchemaType::Jsonschema,
                vec![
                    SchemaFile { path: "cfg.json".into(), text: r#"{"type":"object","properties":{"ttl":{"$ref":"ttl.json"}},"required":["ttl"]}"#.into() },
                    SchemaFile { path: "ttl.json".into(), text: r#"{"type":"integer","minimum":0}"#.into() },
                ],
            ),
            local("broken", SchemaType::Protobuf, vec![SchemaFile { path: "b.proto".into(), text: "syntax = \"proto3\";\nmessage {".into() }]),
        ],
        mappings: vec![
            SchemaMapping {
                id: "m1".into(),
                target: MappingTarget::Subject { pattern: "orders.proto.>".into() },
                part: Part::Value,
                schema_id: "proto".into(),
                message_type: Some("lab.orders.Order".into()),
            },
            SchemaMapping { id: "m2".into(), target: MappingTarget::KvBucket { bucket: "config".into() }, part: Part::Value, schema_id: "json".into(), message_type: None },
            SchemaMapping { id: "m3".into(), target: MappingTarget::Topic { name: "orders-avro".into() }, part: Part::Value, schema_id: "avro".into(), message_type: None },
            SchemaMapping { id: "m4".into(), target: MappingTarget::Topic { name: "bad".into() }, part: Part::Value, schema_id: "broken".into(), message_type: None },
        ],
        ..CodecsConfig::default()
    });
    // The broken schema is reported with its file and line; the others compile.
    assert_eq!(codecs.issues().len(), 1);
    assert_eq!(codecs.issues()[0].schema_id.as_deref(), Some("broken"));
    assert_eq!(codecs.issues()[0].file.as_deref(), Some("b.proto"));
    assert_eq!(codecs.issues()[0].line, Some(2));
    assert_eq!(codecs.local().len(), 3);

    // Protobuf through a subject mapping (encode with the mapping, decode by auto-detect).
    let subject = Target::Subject {
        subject: "orders.proto.eu".into(),
    };
    let text = r#"{"id":"o-1","total":{"currency":"EUR","units":"12"},"status":"SHIPPED"}"#;
    let enc = codecs
        .encode(
            Some(&subject),
            Part::Value,
            &ComposePayload {
                codec: CodecId::Protobuf,
                text: text.into(),
                schema: None,
                message_type: None,
                wire_format: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        enc.schema_ref.as_deref(),
        Some("local:proto#lab.orders.Order")
    );
    let dec = codecs
        .decode(
            &enc.bytes,
            Some(&subject),
            Part::Value,
            &CodecChoice::auto(),
        )
        .await;
    assert_eq!(dec.codec, CodecId::Protobuf);
    assert_eq!(dec.text.as_deref(), Some(text));
    assert_eq!(
        dec.schema_ref.as_deref(),
        Some("local:proto#lab.orders.Order")
    );
    // Another subject falls through to the plain codecs.
    let other = Target::Subject {
        subject: "orders.eu".into(),
    };
    assert_eq!(
        codecs
            .decode(&enc.bytes, Some(&other), Part::Value, &CodecChoice::auto())
            .await
            .codec,
        CodecId::Hex
    );
    // An explicit local schema with another message type.
    let money = codecs
        .decode(
            &enc.bytes,
            None,
            Part::Value,
            &CodecChoice {
                codec: CodecSelector::Codec(CodecId::Protobuf),
                schema: Some(SchemaRef::Local("proto".into())),
                message_type: Some("lab.orders.Order".into()),
            },
        )
        .await;
    assert_eq!(money.text.as_deref(), Some(text));

    // JSON Schema: violations listed without failing the decode; encoding refuses them.
    let kv = Target::KvBucket {
        bucket: "config".into(),
    };
    let d = codecs
        .decode(
            br#"{"ttl":-1}"#,
            Some(&kv),
            Part::Value,
            &CodecChoice::auto(),
        )
        .await;
    assert_eq!(d.codec, CodecId::Jsonschema);
    assert_eq!(d.text.as_deref(), Some(r#"{"ttl":-1}"#));
    assert!(
        d.error.as_deref().unwrap().contains("/ttl"),
        "{:?}",
        d.error
    );
    let ok = codecs
        .decode(
            br#"{"ttl":5}"#,
            Some(&kv),
            Part::Value,
            &CodecChoice::auto(),
        )
        .await;
    assert!(ok.error.is_none());
    let e = codecs
        .encode(
            Some(&kv),
            Part::Value,
            &ComposePayload {
                codec: CodecId::Jsonschema,
                text: "{}".into(),
                schema: None,
                message_type: None,
                wire_format: None,
            },
        )
        .await
        .unwrap_err();
    assert!(e.message.contains("does not match"), "{e}");

    // Avro through a topic mapping.
    let topic = Target::Topic {
        name: "orders-avro".into(),
    };
    let enc = codecs
        .encode(
            Some(&topic),
            Part::Value,
            &ComposePayload {
                codec: CodecId::Avro,
                text:
                    r#"{"id":"1","customer":"c","amount":"5.00","placedAt":"2026-11-17T00:00:00Z"}"#
                        .into(),
                schema: None,
                message_type: None,
                wire_format: None,
            },
        )
        .await
        .unwrap();
    let d = codecs
        .decode(&enc.bytes, Some(&topic), Part::Value, &CodecChoice::auto())
        .await;
    assert_eq!(d.codec, CodecId::Avro);
    assert_eq!(d.json.unwrap()["channel"], "WEB");

    // A mapping to a schema that does not compile says so and keeps the raw bytes as hex.
    let d = codecs
        .decode(
            b"\x01\x02",
            Some(&Target::Topic { name: "bad".into() }),
            Part::Value,
            &CodecChoice::auto(),
        )
        .await;
    assert_eq!((d.codec, d.text.as_deref()), (CodecId::Hex, Some("0102")));
    assert!(d.error.unwrap().contains("broken"));
    // Wire format needs a registry schema.
    let e = codecs
        .encode(
            Some(&topic),
            Part::Value,
            &ComposePayload {
                codec: CodecId::Avro,
                text: "{}".into(),
                schema: None,
                message_type: None,
                wire_format: Some(WireFormat::Confluent),
            },
        )
        .await
        .unwrap_err();
    assert!(
        e.message.contains("missing field") || e.message.contains("registry"),
        "{e}"
    );
}

#[tokio::test]
async fn descriptor_set_local_schema() {
    // Compile the lab protos once, then load them as a descriptor set.
    let compiled =
        message_codecs::schema::compile_local(&local("p", SchemaType::Protobuf, proto_files()))
            .unwrap();
    let message_codecs::CompiledSchema::Protobuf(p) = compiled else {
        panic!()
    };
    let fds = prost_reflect_types(&p);
    use base64::Engine as _;
    let schema = LocalSchema {
        id: "fds".into(),
        name: "fds".into(),
        schema_type: SchemaType::Protobuf,
        files: LocalSchemaFiles::DescriptorSet {
            descriptor_set_base64: base64::engine::general_purpose::STANDARD.encode(fds),
        },
        message_types: Some(vec!["lab.common.Money".into()]),
    };
    let codecs = Codecs::new(CodecsConfig {
        local_schemas: vec![schema],
        ..CodecsConfig::default()
    });
    assert!(codecs.issues().is_empty(), "{:?}", codecs.issues());
    let payload = ComposePayload {
        codec: CodecId::Protobuf,
        text: r#"{"currency":"VND","units":"100000"}"#.into(),
        schema: Some(SchemaRef::Local("fds".into())),
        message_type: None,
        wire_format: None,
    };
    let enc = codecs.encode(None, Part::Value, &payload).await.unwrap();
    let choice = CodecChoice {
        codec: CodecSelector::Codec(CodecId::Protobuf),
        schema: Some(SchemaRef::Local("fds".into())),
        message_type: None,
    };
    let d = codecs.decode(&enc.bytes, None, Part::Value, &choice).await;
    assert_eq!(
        d.text.as_deref(),
        Some(r#"{"currency":"VND","units":"100000"}"#)
    );
}

fn prost_reflect_types(p: &message_codecs::codec::protobuf::ProtoSchema) -> Vec<u8> {
    use prost::Message as _;
    let fds = prost_reflect::prost_types::FileDescriptorSet {
        file: p.pool.file_descriptor_protos().cloned().collect(),
    };
    fds.encode_to_vec()
}

#[tokio::test]
async fn wire_format_through_a_registry() {
    let (fake, url) = FakeRegistry::start().await;
    let money = fake.add(
        "lab/common/money.proto",
        Some("PROTOBUF"),
        MONEY_PROTO,
        json!([]),
    );
    let _ = money;
    let proto_id = fake.add(
        "orders-proto-value",
        Some("PROTOBUF"),
        ORDER_PROTO,
        json!([{ "name": "lab/common/money.proto", "subject": "lab/common/money.proto", "version": 1 }]),
    );
    let v1 = fake.add("orders-avro-value", None, ORDER_V1, json!([]));
    let v2 = fake.add("orders-avro-value", None, ORDER_V2, json!([]));
    let js = fake.add(
        "events-value",
        Some("JSON"),
        r#"{"type":"object","required":["n"]}"#,
        json!([]),
    );

    let registry = RegistryClient::new(&RegistryConfig::new(url)).unwrap();
    let codecs = Codecs::new(CodecsConfig {
        registry: Some(registry.clone()),
        ..CodecsConfig::default()
    });
    let topic = |n: &str| Target::Topic { name: n.into() };

    // Avro: no schema chosen, TopicNameStrategy picks orders-avro-value latest (v2).
    let text = r#"{"id":"o-1","customer":"c","amount":"10.00","placedAt":"2026-11-17T10:00:00Z","note":null,"channel":"PHONE"}"#;
    let enc = codecs
        .encode(
            Some(&topic("orders-avro")),
            Part::Value,
            &ComposePayload {
                codec: CodecId::Avro,
                text: text.into(),
                schema: None,
                message_type: None,
                wire_format: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(enc.schema_id, Some(v2));
    assert_eq!(&enc.bytes[..5], &wire::write(v2, None, &[])[..]);
    let d = codecs
        .decode(
            &enc.bytes,
            Some(&topic("orders-avro")),
            Part::Value,
            &CodecChoice::auto(),
        )
        .await;
    assert_eq!(
        (d.codec, d.schema_ref.as_deref()),
        (CodecId::Avro, Some(format!("registry:{v2}").as_str()))
    );
    assert_eq!(d.text.as_deref(), Some(text));

    // An older version by subject and number.
    let enc = codecs
        .encode(
            None,
            Part::Value,
            &ComposePayload {
                codec: CodecId::Avro,
                text: r#"{"id":"o","customer":"c","amount":"1.00","placedAt":0}"#.into(),
                schema: Some(SchemaRef::Registry(RegistryRef::Subject {
                    subject: "orders-avro-value".into(),
                    version: SchemaVersion::Number(1),
                })),
                message_type: None,
                wire_format: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(enc.schema_id, Some(v1));
    assert_eq!(
        enc.schema_ref.as_deref(),
        Some("registry:orders-avro-value/1")
    );

    // Protobuf with a reference: message indexes written and read.
    let text =
        r#"{"id":"o-2","total":{"currency":"EUR","units":"3"},"items":["a"],"status":"PLACED"}"#;
    let enc = codecs
        .encode(
            Some(&topic("orders-proto")),
            Part::Value,
            &ComposePayload {
                codec: CodecId::Protobuf,
                text: text.into(),
                schema: None,
                message_type: None,
                wire_format: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(enc.schema_id, Some(proto_id));
    assert_eq!(enc.bytes[5], 0, "single 0 index for the first message");
    let d = codecs
        .decode(&enc.bytes, None, Part::Value, &CodecChoice::auto())
        .await;
    assert_eq!(
        (d.codec, d.text.as_deref()),
        (CodecId::Protobuf, Some(text))
    );

    // JSON Schema in the wire format.
    let enc = codecs
        .encode(
            Some(&topic("events")),
            Part::Value,
            &ComposePayload {
                codec: CodecId::Jsonschema,
                text: r#"{"n":1}"#.into(),
                schema: None,
                message_type: None,
                wire_format: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(enc.schema_id, Some(js));
    let d = codecs
        .decode(&enc.bytes, None, Part::Value, &CodecChoice::auto())
        .await;
    assert_eq!(
        (d.codec, d.text.as_deref(), d.error),
        (CodecId::Jsonschema, Some(r#"{"n":1}"#), None)
    );
    // "raw, no wire format".
    let enc = codecs
        .encode(
            Some(&topic("events")),
            Part::Value,
            &ComposePayload {
                codec: CodecId::Jsonschema,
                text: r#"{"n":1}"#.into(),
                schema: None,
                message_type: None,
                wire_format: Some(WireFormat::None),
            },
        )
        .await
        .unwrap();
    assert_eq!(enc.bytes, br#"{"n":1}"#);

    // An id the registry does not know falls through the order; ids are cached.
    let unknown = wire::write(999, None, br#"{"a":1}"#);
    let d = codecs
        .decode(&unknown, None, Part::Value, &CodecChoice::auto())
        .await;
    assert_eq!(
        (d.codec, d.error),
        (CodecId::Hex, None),
        "999 puts 0xe7 in the header: binary"
    );
    let before = fake
        .requests()
        .iter()
        .filter(|r| r.starts_with("GET /schemas/ids/"))
        .count();
    for _ in 0..3 {
        codecs
            .decode(
                &wire::write(v2, None, &[]),
                None,
                Part::Value,
                &CodecChoice::auto(),
            )
            .await;
    }
    let after = fake
        .requests()
        .iter()
        .filter(|r| r.starts_with("GET /schemas/ids/"))
        .count();
    assert_eq!(before, after, "schemas by id are cached");

    // The registry API.
    let mut subjects = registry.subjects().await.unwrap();
    subjects.sort();
    assert!(subjects.contains(&"orders-avro-value".to_owned()));
    assert_eq!(
        registry.versions("orders-avro-value").await.unwrap(),
        vec![1, 2]
    );
    let id = registry
        .register("new-value", SchemaType::Avro, r#""string""#, &[])
        .await
        .unwrap();
    assert_eq!(
        registry.schema_by_id(id).await.unwrap().schema,
        r#""string""#
    );
    let e = registry.versions("missing").await.unwrap_err();
    assert_eq!(e.kind, message_codecs::ErrorKind::NotFound);
    assert_eq!(e.remote.unwrap().code, "40401");
}

#[tokio::test]
async fn unreachable_registry_is_a_connect_error_and_decoding_goes_on() {
    // A port nothing listens on.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let registry = RegistryClient::new(&RegistryConfig::new(url)).unwrap();
    let e = registry.subjects().await.unwrap_err();
    assert_eq!(e.kind, message_codecs::ErrorKind::Connect);
    let codecs = Codecs::new(CodecsConfig {
        registry: Some(registry),
        ..CodecsConfig::default()
    });
    let d = codecs
        .decode(
            &wire::write(1, None, &[0xff]),
            None,
            Part::Value,
            &CodecChoice::auto(),
        )
        .await;
    assert_eq!(d.codec, CodecId::Hex);
    assert!(d.error.unwrap().contains("registry schema 1"));
}
