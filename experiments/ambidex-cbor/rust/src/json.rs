//! Bounded syntactic validation before materializing a JSON container tree.
use serde_json::Value;
use std::collections::HashSet;
pub fn validate(bytes: &[u8]) -> Result<(), String> {
    struct Scan<'a> {
        b: &'a [u8],
        p: usize,
        nodes: usize,
        alloc: usize,
    }
    impl Scan<'_> {
        fn ws(&mut self) {
            while self
                .b
                .get(self.p)
                .is_some_and(|c| matches!(c, b' ' | b'\t' | b'\r' | b'\n'))
            {
                self.p += 1;
            }
        }
        fn reserve(&mut self, n: usize) -> Result<(), String> {
            self.alloc = self.alloc.checked_add(n).ok_or("allocation")?;
            if self.alloc > 8388608 {
                return Err("allocation".into());
            }
            Ok(())
        }
        fn string(&mut self) -> Result<String, String> {
            if self.b.get(self.p) != Some(&b'"') {
                return Err("string".into());
            }
            let start = self.p;
            self.p += 1;
            while self.p < self.b.len() {
                match self.b[self.p] {
                    b'"' => {
                        self.p += 1;
                        let raw = &self.b[start..self.p];
                        self.reserve(raw.len() * 2)?;
                        let decoded: String =
                            serde_json::from_slice(raw).map_err(|e| e.to_string())?;
                        if decoded.len() > 262144 {
                            return Err("field".into());
                        }
                        return Ok(decoded);
                    }
                    b'\\' => self.p += 1,
                    _ => {}
                }
                self.p += 1;
            }
            Err("truncated string".into())
        }
        fn value(&mut self, d: usize) -> Result<(), String> {
            self.ws();
            if d > 64 || self.nodes >= 100000 {
                return Err("complexity".into());
            }
            self.nodes += 1;
            self.reserve(32)?;
            match self.b.get(self.p).copied() {
                Some(b'"') => {
                    self.string()?;
                    Ok(())
                }
                Some(c @ (b'{' | b'[')) => {
                    self.p += 1;
                    self.ws();
                    let end = if c == b'{' { b'}' } else { b']' };
                    if self.b.get(self.p) == Some(&end) {
                        self.p += 1;
                        return Ok(());
                    }
                    let mut count = 0;
                    let mut keys = HashSet::new();
                    loop {
                        count += 1;
                        if count > if c == b'{' { 4096 } else { 65536 } {
                            return Err("container".into());
                        }
                        if c == b'{' {
                            if self.nodes >= 100000 {
                                return Err("complexity".into());
                            }
                            self.nodes += 1;
                            self.reserve(96)?;
                            self.ws();
                            let key = self.string()?;
                            if !keys.insert(key) {
                                return Err("duplicate".into());
                            }
                            self.ws();
                            if self.b.get(self.p) != Some(&b':') {
                                return Err("colon".into());
                            }
                            self.p += 1;
                        }
                        if c == b'[' {
                            self.reserve(8)?;
                        }
                        self.value(d + 1)?;
                        self.ws();
                        if self.b.get(self.p) == Some(&end) {
                            self.p += 1;
                            return Ok(());
                        }
                        if self.b.get(self.p) != Some(&b',') {
                            return Err("separator".into());
                        }
                        self.p += 1;
                    }
                }
                Some(_) => {
                    let start = self.p;
                    while self.b.get(self.p).is_some_and(|c| {
                        !matches!(c, b' ' | b'\t' | b'\r' | b'\n' | b',' | b']' | b'}')
                    }) {
                        self.p += 1;
                    }
                    if self.p == start {
                        return Err("token".into());
                    }
                    let scalar: Value = serde_json::from_slice(&self.b[start..self.p])
                        .map_err(|e| e.to_string())?;
                    if let Value::Number(n) = scalar {
                        let f = n.as_f64().ok_or("number")?;
                        if !f.is_finite() || f.fract() == 0.0 && f.abs() > 9007199254740991.0 {
                            return Err("unsafe JSON number".into());
                        }
                    }
                    Ok(())
                }
                None => Err("empty".into()),
            }
        }
    }
    if bytes.len() > 1048576 {
        return Err("bytes".into());
    }
    std::str::from_utf8(bytes).map_err(|_| "utf8")?;
    let mut s = Scan {
        b: bytes,
        p: 0,
        nodes: 0,
        alloc: 0,
    };
    s.value(0)?;
    s.ws();
    if s.p != bytes.len() {
        return Err("trailing".into());
    }
    Ok(())
}
pub fn parse(bytes: &[u8]) -> Result<Value, String> {
    validate(bytes)?;
    serde_json::from_slice(bytes).map_err(|e| e.to_string())
}
