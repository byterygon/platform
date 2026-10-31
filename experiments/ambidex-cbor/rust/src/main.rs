use ambidex_cbor_spike::cbor;
use sha2::{Digest, Sha256};
use std::io::{self, BufRead};
fn main() {
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let result = std::panic::catch_unwind(|| {
            let Ok(req): Result<serde_json::Value, _> = serde_json::from_str(&line) else {
                return serde_json::json!({"ok":false,"error":"invalid request"});
            };
            if req.get("jsonPayload").is_some() {
                return typed_json(&req);
            }
            let Some(s) = req["hex"].as_str() else {
                return serde_json::json!({"ok":false,"error":"missing hex"});
            };
            if s.len() > 2097152 || !s.len().is_multiple_of(2) || !s.is_ascii() {
                return serde_json::json!({"ok":false});
            };
            let b: Result<Vec<u8>, _> = (0..s.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&s[i..i + 2], 16))
                .collect();
            let Ok(b) = b else {
                return serde_json::json!({"ok":false});
            };
            match cbor::decode_with_budget(
                &b,
                req["strict"].as_bool().unwrap_or(true),
                req["budget"].as_u64().unwrap_or(8388608) as usize,
            ) {
                Ok(mut v) => {
                    if let Some(schema) = req.get("schema") {
                        match ambidex_cbor_spike::hydrate::hydrate(&v, schema, false) {
                            Ok(logical) => v = logical,
                            Err(e) => return serde_json::json!({"ok":false,"error":e}),
                        }
                    }
                    let encoded = cbor::encode(&v);
                    let mut h = Sha256::new();
                    h.update(b"ambidex.input-digest.v2\0");
                    h.update(&encoded);
                    serde_json::json!({"ok":true,"hex":encoded.iter().map(|x|format!("{x:02x}")).collect::<String>(),"digest":format!("{:x}",h.finalize()),"json":req.get("schema").and_then(|s|ambidex_cbor_spike::hydrate::emit(&v,s).ok())})
                }
                Err(e) => serde_json::json!({"ok":false,"error":e}),
            }
        });
        println!(
            "{}",
            result.unwrap_or(serde_json::json!({"ok":false,"panic":true}))
        );
    }
}

fn typed_json(req: &serde_json::Value) -> serde_json::Value {
    use ambidex_cbor_spike::{hydrate, json};
    let result = (|| -> Result<serde_json::Value, String> {
        let raw = json::parse(req["jsonPayload"].as_str().ok_or("payload")?.as_bytes())?;
        if req["jsonSyntaxOnly"] == true {
            return Ok(serde_json::json!({"ok":true}));
        }
        let raw = hydrate::raw_json(raw)?;
        let v = hydrate::hydrate(&raw, &req["schema"], true)?;
        let bytes = cbor::encode(&v);
        let mut h = Sha256::new();
        h.update(b"ambidex.input-digest.v2\0");
        h.update(&bytes);
        Ok(
            serde_json::json!({"ok":true,"hex":bytes.iter().map(|b|format!("{b:02x}")).collect::<String>(),"json":hydrate::emit(&v,&req["schema"])?,"digest":format!("{:x}",h.finalize())}),
        )
    })();
    result.unwrap_or_else(|e| serde_json::json!({"ok":false,"error":e}))
}
