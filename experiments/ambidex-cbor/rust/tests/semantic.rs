#![allow(dead_code)]
use ambidex_cbor_spike::{
    cbor,
    fixture::EditInput,
    hydrate, json as raw_json,
    model::{self, Direction, Graph, Semantic},
    scalar::{Decimal, temporal},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use ts_rs::TS;
#[derive(Serialize, Deserialize, JsonSchema, TS, Semantic)]
#[serde(rename = "Node")]
struct Node {
    value: u64,
    next: Option<Box<Node>>,
}
#[derive(Semantic)]
#[serde(rename = "Choice", untagged)]
enum First {
    A(u32),
    B(String),
}
#[derive(Semantic)]
#[serde(rename = "Choice", untagged)]
enum Second {
    B(String),
    A(u32),
}
#[derive(Semantic)]
#[serde(rename = "Choice")]
enum TaggedFirst {
    A(u32),
    B(String),
}
#[derive(Semantic)]
#[serde(rename = "Choice")]
enum TaggedSecond {
    B(String),
    A(u32),
}
#[derive(Serialize, Deserialize, JsonSchema, TS, Semantic)]
struct Defaults {
    #[serde(default)]
    #[ts(optional = nullable)]
    count: u32,
}
#[test]
fn recursive_graph_and_directional_agreement() {
    let model = model::checked::<Node>(Direction::Input).unwrap();
    assert_eq!(
        model["definitions"]["Node.Input"]["fields"][0]["schema"]["inner"]["ref"],
        "Node"
    );
    let defaults = model::checked::<Defaults>(Direction::Input).unwrap();
    assert_eq!(
        defaults["definitions"]["Defaults.Input"]["fields"][0]["optional"],
        true
    );
    assert_ne!(
        defaults,
        model::checked::<Defaults>(Direction::Output).unwrap()
    );
}
#[test]
fn enum_order_and_exact_bounds() {
    assert_ne!(
        Graph::document::<First>(Direction::Input).unwrap(),
        Graph::document::<Second>(Direction::Input).unwrap()
    );
    assert_eq!(
        Graph::document::<TaggedFirst>(Direction::Input).unwrap(),
        Graph::document::<TaggedSecond>(Direction::Input).unwrap()
    );
    assert_ne!(
        Graph::document::<u32>(Direction::Input).unwrap(),
        Graph::document::<u64>(Direction::Input).unwrap()
    );
    assert_ne!(
        Graph::document::<i64>(Direction::Input).unwrap(),
        Graph::document::<u64>(Direction::Input).unwrap()
    );
    assert!(model::canonical(&json!({"bound":1})).is_err());
    assert_eq!(
        model::canonical(&json!({"b":"2","a":"1"})).unwrap(),
        model::canonical(&json!({"a":"1","b":"2"})).unwrap()
    );
}
#[test]
fn typed_rust_pipeline() {
    let schema = model::checked::<EditInput>(Direction::Input).unwrap();
    let text = r#"{"id":"18446744073709551615","amount":"1.2300","at":"2026-10-29T19:34:56.123456789+07:00","date":"2026-02-28","local":"2026-10-29T12:34:56.123456789","secret":"hidden"}"#;
    let raw = hydrate::raw_json(raw_json::parse(text.as_bytes()).unwrap()).unwrap();
    let logical = hydrate::hydrate(&raw, &schema, true).unwrap();
    let native = hydrate::json_value(&logical, false).unwrap();
    let typed: EditInput = serde_json::from_value(native).unwrap();
    assert_eq!(typed.id, u64::MAX);
    assert_eq!(typed.amount.0, "1.2300");
    assert_eq!(typed.at.0, "2026-10-29T12:34:56.123456789Z");
    let bytes = cbor::encode(&logical);
    assert_eq!(
        hydrate::hydrate(&cbor::decode(&bytes, true).unwrap(), &schema, false).unwrap(),
        logical
    );
    let wire = hydrate::emit(&logical, &schema).unwrap();
    assert_eq!(wire["id"], "18446744073709551615");
    let _ = ambidex_cbor_spike::fixture::edit(typed);
}
#[test]
fn decimal_and_temporal_boundaries() {
    for s in [
        "NaN",
        "Infinity",
        "1e1001",
        "1e-1001",
        "1e+2",
        "01",
        "1.",
        "123456789012345678901234567890123456789",
    ] {
        assert!(Decimal::parse(s).is_err(), "{s}");
    }
    for s in [
        "1.2300",
        "-1.2300",
        "12345678901234567890123456789012345678",
        "1e1000",
        "0.0000",
    ] {
        let d = Decimal::parse(s).unwrap();
        assert_eq!(Decimal::from_cbor(&d.cbor()).unwrap(), d);
    }
    assert!(temporal("2026-02-29", "date").is_err());
    assert!(temporal("2026-10-29T23:59:60Z", "instant").is_err());
    assert!(temporal("2026-10-29T12:34:56.1234567891Z", "instant").is_err());
    assert_eq!(
        temporal("2026-10-29T19:34:56.123456789+07:00", "instant").unwrap(),
        "2026-10-29T12:34:56.123456789Z"
    );
}
#[test]
fn json_raw_duplicate_and_resource_rejection() {
    for s in [
        r#"{"x":{"a":1,"a":2}}"#,
        r#"{"a":1,"\u0061":2}"#,
        "9007199254740993",
        "[1]true",
        r#""\ud800""#,
    ] {
        assert!(raw_json::parse(s.as_bytes()).is_err(), "{s}");
    }
    assert!(raw_json::parse(&vec![b' '; 1048577]).is_err());
}
#[test]
fn library_defaults_need_validator() {
    let raw = hex("a2616101616102");
    let library: ciborium::Value = ciborium::de::from_reader(raw.as_slice()).unwrap();
    assert!(matches!(library,ciborium::Value::Map(ref m)if m.len()==2));
    assert!(cbor::decode(&raw, true).is_err());
}
fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
#[test]
fn standalone_router_auth_binding_redaction_and_real_typed_handler() {
    use ambidex_cbor_spike::router::{self, Binding, Guard, Session};
    struct Allow;
    impl Guard for Allow {
        fn access(&self, _: &Session) -> bool {
            true
        }
        fn authorize(&self, b: &Binding) -> bool {
            b.version == 2 && b.procedure == "fixture.edit"
        }
    }
    struct Deny;
    impl Guard for Deny {
        fn access(&self, _: &Session) -> bool {
            false
        }
        fn authorize(&self, _: &Binding) -> bool {
            panic!("must not authorize after access deny")
        }
    }
    let bytes=br#"{"id":"18446744073709551615","amount":"1.2300","at":"2026-10-29T12:34:56.123456789Z","date":"2026-02-28","local":"2026-10-29T12:34:56.123456789","secret":"sensitive"}"#;
    let session = Session {
        principal: "human:alice".into(),
        target: "db:1".into(),
        context: "session:1".into(),
    };
    let reply = router::dispatch(bytes, "json", &session, &Allow, true).unwrap();
    let schema = Graph::document::<EditInput>(Direction::Input).unwrap();
    let logical = hydrate::hydrate(
        &hydrate::raw_json(raw_json::parse(bytes).unwrap()).unwrap(),
        &schema,
        true,
    )
    .unwrap();
    let binary = cbor::encode(&logical);
    let cb = router::dispatch(&binary, "cbor", &session, &Allow, false).unwrap();
    assert_eq!(reply.binding, cb.binding);
    assert_eq!(reply.log.unwrap()["secret"], "<redacted>");
    assert!(cb.log.is_none());
    assert_eq!(reply.output["amount"], "1.2300");
    assert_eq!(
        reply.events,
        vec![
            "bounded-syntax",
            "authenticated-session",
            "access-gate",
            "hydrate",
            "digest-v2",
            "bound-authorization",
            "redact-log",
            "typed-dispatch"
        ]
    );
    let invalid = br#"{"id":"not-an-integer"}"#;
    assert_eq!(
        router::dispatch(invalid, "json", &session, &Deny, false)
            .err()
            .unwrap(),
        "PermissionDenied"
    );
}
#[test]
fn semantic_hash_mutation_matrix_and_codec_independence() {
    use ambidex_cbor_spike::model::fingerprint;
    let original = Graph::document::<EditInput>(Direction::Input).unwrap();
    let h = fingerprint("ambidex.semantic-schema.v2", &original).unwrap();
    let fields = original["definitions"]["EditInput.Input"]["fields"]
        .as_array()
        .unwrap();
    for which in [
        "integer-domain",
        "decimal-precision",
        "time-precision",
        "requiredness",
    ] {
        let mut changed = original.clone();
        let fields = changed["definitions"]["EditInput.Input"]["fields"]
            .as_array_mut()
            .unwrap();
        match which {
            "integer-domain" => {
                fields.iter_mut().find(|f| f["name"] == "id").unwrap()["schema"]["type"] =
                    json!("i64")
            }
            "decimal-precision" => {
                fields.iter_mut().find(|f| f["name"] == "amount").unwrap()["schema"]["precision"] =
                    json!("37")
            }
            "time-precision" => {
                fields.iter_mut().find(|f| f["name"] == "at").unwrap()["schema"]["precision"] =
                    json!("6")
            }
            _ => fields[0]["optional"] = json!(true),
        }
        assert_ne!(
            h,
            fingerprint("ambidex.semantic-schema.v2", &changed).unwrap(),
            "{which}"
        );
    }
    assert!(!fields.is_empty());
    assert_ne!(h, fingerprint("ambidex.policy.v2", &original).unwrap());
}
#[test]
fn policy_drift_is_independent_from_contract() {
    let contract = Graph::document::<EditInput>(Direction::Input).unwrap();
    let before = model::fingerprint("ambidex.semantic-schema.v2", &contract).unwrap();
    let policy = json!({"perm":"fixture.edit","risk":"write","agent":"hidden","deprecated":false,"timeoutDefaultMs":"30000","timeoutMaxMs":"300000"});
    let p = model::fingerprint("ambidex.policy.v2", &policy).unwrap();
    for key in [
        "perm",
        "risk",
        "agent",
        "deprecated",
        "timeoutDefaultMs",
        "timeoutMaxMs",
    ] {
        let mut changed = policy.clone();
        changed[key] = if key == "deprecated" {
            json!(true)
        } else {
            json!("changed")
        };
        assert_ne!(
            p,
            model::fingerprint("ambidex.policy.v2", &changed).unwrap()
        );
        assert_eq!(
            before,
            model::fingerprint("ambidex.semantic-schema.v2", &contract).unwrap()
        );
    }
}
#[test]
fn frozen_vectors_cross_checked_with_independent_library() {
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("../../fixtures/golden.json")).unwrap();
    for vector in vectors.as_array().unwrap() {
        let bytes = hex(vector["cbor"].as_str().unwrap());
        let value: ciborium::Value = ciborium::de::from_reader(bytes.as_slice()).unwrap();
        let mut encoded = Vec::new();
        ciborium::ser::into_writer(&value, &mut encoded).unwrap();
        assert_eq!(encoded, bytes, "{}", vector["id"]);
    }
}
#[test]
fn typed_error_contract_matches_handler() {
    let input:EditInput=serde_json::from_value(json!({"id":0,"amount":"1.2300","at":"2026-10-29T12:34:56.123456789Z","date":"2026-02-28","local":"2026-10-29T12:34:56.123456789","secret":"hidden"})).unwrap();
    let error = ambidex_cbor_spike::fixture::try_edit(input).err().unwrap();
    assert_eq!(
        serde_json::to_value(error).unwrap(),
        json!({"code":"bounds","details":{"field":"id"}})
    );
    model::checked::<ambidex_cbor_spike::fixture::FixtureError>(Direction::Output).unwrap();
}
#[test]
fn decimal_minimum_i128_endpoint_rejects_before_formatting() {
    let raw = cbor::decode(&hex("c48200c3507fffffffffffffffffffffffffffffff"), true).unwrap();
    assert!(Decimal::from_cbor(&raw).is_err());
}
