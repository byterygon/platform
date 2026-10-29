use ambidex_cbor_spike::cbor;
use sha2::{Digest, Sha256};
use std::io::{self, BufRead};
fn main() {
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let result = std::panic::catch_unwind(|| {
            let req: serde_json::Value = serde_json::from_str(&line).unwrap();
            let s = req["hex"].as_str().unwrap();
            if s.len() > 2097152 || !s.len().is_multiple_of(2) {
                return serde_json::json!({"ok":false});
            };
            let b: Result<Vec<u8>, _> = (0..s.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&s[i..i + 2], 16))
                .collect();
            let Ok(b) = b else {
                return serde_json::json!({"ok":false});
            };
            match cbor::decode(&b, req["strict"].as_bool().unwrap_or(true)) {
                Ok(v) => {
                    let encoded = cbor::encode(&v);
                    let mut h = Sha256::new();
                    h.update(b"ambidex.input-digest.v2\0");
                    h.update(&encoded);
                    serde_json::json!({"ok":true,"hex":encoded.iter().map(|x|format!("{x:02x}")).collect::<String>(),"digest":format!("{:x}",h.finalize())})
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
