//! Independent bounded CBOR subset implementation for differential research.
use std::collections::BTreeMap;
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Int(i128),
    Text(String),
    Bytes(Vec<u8>),
    Array(Vec<Value>),
    Map(BTreeMap<String, Value>),
    Tag(u64, Box<Value>),
    Bool(bool),
    Null,
}
pub fn encode(v: &Value) -> Vec<u8> {
    fn head(o: &mut Vec<u8>, m: u8, n: u64) {
        if n < 24 {
            o.push(m * 32 + n as u8)
        } else {
            let (size, ai) = if n <= 255 {
                (1, 24)
            } else if n <= 65535 {
                (2, 25)
            } else if n <= u32::MAX as u64 {
                (4, 26)
            } else {
                (8, 27)
            };
            o.push(m * 32 + ai);
            o.extend_from_slice(&n.to_be_bytes()[8 - size..]);
        }
    }
    fn put(o: &mut Vec<u8>, v: &Value) {
        match v {
            Value::Int(n) => head(
                o,
                if *n < 0 { 1 } else { 0 },
                if *n < 0 { (-1 - *n) as u64 } else { *n as u64 },
            ),
            Value::Text(s) => {
                head(o, 3, s.len() as u64);
                o.extend_from_slice(s.as_bytes());
            }
            Value::Bytes(b) => {
                head(o, 2, b.len() as u64);
                o.extend_from_slice(b);
            }
            Value::Array(a) => {
                head(o, 4, a.len() as u64);
                for v in a {
                    put(o, v)
                }
            }
            Value::Map(m) => {
                let mut entries: Vec<_> = m
                    .iter()
                    .map(|(k, v)| (encode(&Value::Text(k.clone())), v))
                    .collect();
                entries.sort_by(|a, b| a.0.cmp(&b.0));
                head(o, 5, entries.len() as u64);
                for (k, v) in entries {
                    o.extend(k);
                    put(o, v)
                }
            }
            Value::Tag(t, v) => {
                head(o, 6, *t);
                put(o, v)
            }
            Value::Bool(b) => o.push(if *b { 245 } else { 244 }),
            Value::Null => o.push(246),
        }
    }
    let mut o = Vec::new();
    put(&mut o, v);
    o
}
pub fn decode(b: &[u8], strict: bool) -> Result<Value, &'static str> {
    struct Reader<'a> {
        b: &'a [u8],
        p: usize,
        nodes: usize,
        alloc: usize,
        strict: bool,
    }
    impl Reader<'_> {
        fn take(&mut self, n: usize) -> Result<&[u8], &'static str> {
            if n > self.b.len() - self.p {
                return Err("truncated");
            };
            let p = self.p;
            self.p += n;
            Ok(&self.b[p..p + n])
        }
        fn reserve(&mut self, n: usize) -> Result<(), &'static str> {
            self.alloc = self.alloc.checked_add(n).ok_or("allocation")?;
            if self.alloc > 8388608 {
                return Err("allocation");
            };
            Ok(())
        }
        fn value(&mut self, d: usize, parent: u64, slot: usize) -> Result<Value, &'static str> {
            if d > 64 || self.nodes >= 100000 {
                return Err("complexity");
            };
            self.nodes += 1;
            self.reserve(32)?;
            let h = self.take(1)?[0];
            let (m, ai) = (h >> 5, h & 31);
            if m == 7 {
                return match ai {
                    20 => Ok(Value::Bool(false)),
                    21 => Ok(Value::Bool(true)),
                    22 => Ok(Value::Null),
                    _ => Err("simple"),
                };
            }
            let n = if ai < 24 {
                ai as u64
            } else {
                let size = match ai {
                    24 => 1,
                    25 => 2,
                    26 => 4,
                    27 => 8,
                    _ => return Err("indefinite"),
                };
                let mut n = 0u64;
                for x in self.take(size)? {
                    n = n * 256 + *x as u64
                }
                let min = match size {
                    1 => 24,
                    2 => 256,
                    4 => 65536,
                    _ => 4294967296,
                };
                if n < min {
                    return Err("nonminimal");
                };
                n
            };
            if m == 0 {
                return Ok(Value::Int(n as i128));
            }
            if m == 1 {
                return Ok(Value::Int(-1 - n as i128));
            }
            if n > 1048576 {
                return Err("length");
            };
            let len = n as usize;
            match m {
                2 | 3 => {
                    if len > 262144 {
                        return Err("field");
                    };
                    self.reserve(len * 2)?;
                    let raw = self.take(len)?;
                    if m == 2 {
                        Ok(Value::Bytes(raw.to_vec()))
                    } else {
                        Ok(Value::Text(
                            std::str::from_utf8(raw).map_err(|_| "utf8")?.into(),
                        ))
                    }
                }
                4 => {
                    if len > 65536 {
                        return Err("array");
                    };
                    self.reserve(len * 8)?;
                    let mut a = Vec::new();
                    for i in 0..len {
                        a.push(self.value(d + 1, parent, i)?)
                    }
                    Ok(Value::Array(a))
                }
                5 => {
                    if len > 4096 {
                        return Err("map");
                    };
                    self.reserve(len * 64)?;
                    let mut map = BTreeMap::new();
                    let mut prev = Vec::new();
                    for i in 0..len {
                        let start = self.p;
                        let Value::Text(k) = self.value(d + 1, 99, 0)? else {
                            return Err("key");
                        };
                        let raw = self.b[start..self.p].to_vec();
                        if self.strict && i > 0 && prev >= raw {
                            return Err("order");
                        };
                        prev = raw;
                        if map.contains_key(&k) {
                            return Err("duplicate");
                        };
                        let v = self.value(d + 1, 99, 0)?;
                        map.insert(k, v);
                    }
                    Ok(Value::Map(map))
                }
                6 => {
                    if ![0, 4, 1004, 2, 3].contains(&n)
                        || [2, 3].contains(&n) && !(parent == 4 && slot == 1)
                    {
                        return Err("tag");
                    };
                    let v = self.value(d + 1, n, 0)?;
                    match (n, &v) {
                        (0 | 1004, Value::Text(_)) => {}
                        (2 | 3, Value::Bytes(b)) if b.len() > 8 && b.len() <= 16 && b[0] != 0 => {}
                        (4, Value::Array(a)) if a.len() == 2 => {
                            if !matches!(a[0], Value::Int(-1000..=1000))
                                || !matches!(a[1], Value::Int(_) | Value::Tag(2 | 3, _))
                            {
                                return Err("decimal");
                            }
                        }
                        _ => return Err("tag value"),
                    };
                    Ok(Value::Tag(n, Box::new(v)))
                }
                _ => Err("major"),
            }
        }
    }
    if b.len() > 1048576 {
        return Err("bytes");
    };
    let mut r = Reader {
        b,
        p: 0,
        nodes: 0,
        alloc: 0,
        strict,
    };
    let v = r.value(0, 99, 0)?;
    if r.p != b.len() {
        return Err("trailing");
    };
    Ok(v)
}
