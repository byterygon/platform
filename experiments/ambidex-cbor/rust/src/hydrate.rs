//! Schema-directed conversion to a codec-neutral typed logical CBOR value.
use crate::{
    cbor::Value as C,
    scalar::{Decimal, temporal},
};
use serde_json::{Value as J, json};
use std::collections::BTreeMap;
pub fn raw_json(j: J) -> Result<C, String> {
    Ok(match j {
        J::Null => C::Null,
        J::Bool(b) => C::Bool(b),
        J::String(s) => C::Text(s),
        J::Number(n) => C::Int(
            n.as_i64()
                .map(i128::from)
                .or_else(|| n.as_u64().map(i128::from))
                .or_else(|| {
                    n.as_f64()
                        .filter(|v| {
                            v.is_finite() && v.fract() == 0.0 && v.abs() <= 9007199254740991.0
                        })
                        .map(|v| v as i128)
                })
                .ok_or("nonintegral JSON outside experimental dynamic profile")?,
        ),
        J::Array(a) => C::Array(a.into_iter().map(raw_json).collect::<Result<_, _>>()?),
        J::Object(o) => C::Map(
            o.into_iter()
                .map(|(k, v)| Ok((k, raw_json(v)?)))
                .collect::<Result<_, String>>()?,
        ),
    })
}
fn kind(s: &J) -> &str {
    s.as_str().or_else(|| s["type"].as_str()).unwrap_or("")
}
fn fields(s: &J) -> Vec<(String, J, bool, bool)> {
    if let Some(a) = s["fields"].as_array() {
        a.iter()
            .map(|f| {
                (
                    f["name"].as_str().unwrap().into(),
                    f["schema"].clone(),
                    f["optional"].as_bool().unwrap_or(false),
                    f["flatten"].as_bool().unwrap_or(false),
                )
            })
            .collect()
    } else {
        s["fields"]
            .as_object()
            .map(|o| {
                o.iter()
                    .map(|(k, s)| (k.clone(), s.clone(), false, false))
                    .collect()
            })
            .unwrap_or_default()
    }
}
pub fn hydrate(raw: &C, schema: &J, json_codec: bool) -> Result<C, String> {
    let defs = schema.get("definitions").cloned().unwrap_or(json!({}));
    let s = schema.get("root").unwrap_or(schema);
    walk(raw, s, &defs, json_codec, 0)
}
fn walk(raw: &C, s: &J, defs: &J, j: bool, depth: usize) -> Result<C, String> {
    if depth > 64 {
        return Err("schema depth".into());
    }
    if let Some(name) = s["ref"].as_str() {
        let target = defs
            .get(format!("{name}.Input"))
            .or_else(|| defs.get(format!("{name}.Output")))
            .ok_or("unknown nominal ref")?;
        return walk(raw, target, defs, j, depth + 1);
    }
    let t = kind(s);
    if ["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64"].contains(&t) {
        let n = if j && ["i64", "u64"].contains(&t) {
            let C::Text(text) = raw else {
                return Err("integer wire type".into());
            };
            if text.len() > 20 {
                return Err("integer length".into());
            }
            let n: i128 = text.parse().map_err(|_| "integer")?;
            if n.to_string() != *text {
                return Err("noncanonical integer".into());
            }
            n
        } else {
            let C::Int(n) = raw else {
                return Err("integer wire type".into());
            };
            *n
        };
        let bits: u32 = t[1..].parse().map_err(|_| "integer type")?;
        let (min, max) = if t.starts_with('i') {
            (-(1i128 << (bits - 1)), (1i128 << (bits - 1)) - 1)
        } else {
            (0, (1i128 << bits) - 1)
        };
        if n < min || n > max {
            return Err("integer range".into());
        }
        if let Some(minimum) = s["minimum"].as_str()
            && n < minimum.parse::<i128>().map_err(|_| "minimum metadata")?
        {
            return Err("field minimum".into());
        }
        if let Some(maximum) = s["maximum"].as_str()
            && n > maximum.parse::<i128>().map_err(|_| "maximum metadata")?
        {
            return Err("field maximum".into());
        }
        if s["mapping"] == "checked-number" && n.abs() > 9007199254740991 {
            return Err("unsafe number".into());
        }
        return Ok(C::Int(n));
    }
    match t {
        "bytes" => {
            if j {
                let C::Text(s) = raw else {
                    return Err("base64 text".into());
                };
                Ok(C::Bytes(crate::bytes::decode(s)?))
            } else if let C::Bytes(_) = raw {
                Ok(raw.clone())
            } else {
                Err("bytes".into())
            }
        }
        "decimal" => {
            let mut d = if j {
                let C::Text(s) = raw else {
                    return Err("decimal text".into());
                };
                Decimal::parse(s)?
            } else {
                Decimal::from_cbor(raw)?
            };
            if s["scaleSignificant"] == false {
                if d.coefficient == 0 {
                    d.scale = 0;
                } else {
                    while d.coefficient % 10 == 0 && d.scale > -1000 {
                        d.coefficient /= 10;
                        d.scale -= 1;
                    }
                }
            }
            if let Some(precision) = s["precision"].as_str()
                && d.coefficient.abs().to_string().len()
                    > precision
                        .parse::<usize>()
                        .map_err(|_| "precision metadata")?
            {
                return Err("field precision".into());
            }
            if let Some(scale) = s["maxAbsScale"].as_str()
                && d.scale.abs() > scale.parse::<i32>().map_err(|_| "scale metadata")?
            {
                return Err("field scale".into());
            }
            Ok(d.cbor())
        }
        "instant" | "date" | "local" | "time" | "duration" => {
            let value = if !j && ["instant", "date"].contains(&t) {
                let C::Tag(tag, v) = raw else {
                    return Err("temporal tag".into());
                };
                if *tag != if t == "instant" { 0 } else { 1004 } {
                    return Err("temporal tag".into());
                }
                v.as_ref()
            } else {
                raw
            };
            let C::Text(text) = value else {
                return Err("temporal text".into());
            };
            let normalized = temporal(text, t)?;
            if let Some(p) = s["precision"].as_str() {
                let precision = p.parse::<usize>().map_err(|_| "time metadata")?;
                let count = normalized
                    .split_once('.')
                    .map(|(_, f)| f.bytes().take_while(|x| x.is_ascii_digit()).count())
                    .unwrap_or(0);
                if count > precision {
                    return Err("field time precision".into());
                }
            }
            let text = C::Text(normalized);
            Ok(if t == "instant" {
                C::Tag(0, Box::new(text))
            } else if t == "date" {
                C::Tag(1004, Box::new(text))
            } else {
                text
            })
        }
        "string" => {
            if matches!(raw, C::Text(_)) {
                Ok(raw.clone())
            } else {
                Err("string".into())
            }
        }
        "bool" => {
            if matches!(raw, C::Bool(_)) {
                Ok(raw.clone())
            } else {
                Err("bool".into())
            }
        }
        "unit" => {
            if matches!(raw, C::Null) {
                Ok(C::Null)
            } else {
                Err("unit".into())
            }
        }
        "nullable" => {
            if *raw == C::Null {
                Ok(C::Null)
            } else {
                walk(raw, &s["inner"], defs, j, depth + 1)
            }
        }
        "array" | "tuple" => {
            let C::Array(a) = raw else {
                return Err("array".into());
            };
            if t == "tuple" && a.len() != s["items"].as_array().ok_or("tuple metadata")?.len() {
                return Err("tuple length".into());
            }
            Ok(C::Array(
                a.iter()
                    .enumerate()
                    .map(|(i, v)| {
                        walk(
                            v,
                            if t == "tuple" {
                                &s["items"][i]
                            } else {
                                &s["items"]
                            },
                            defs,
                            j,
                            depth + 1,
                        )
                    })
                    .collect::<Result<_, _>>()?,
            ))
        }
        "map" => {
            let C::Map(m) = raw else {
                return Err("map".into());
            };
            Ok(C::Map(
                m.iter()
                    .map(|(k, v)| Ok((k.clone(), walk(v, &s["values"], defs, j, depth + 1)?)))
                    .collect::<Result<_, String>>()?,
            ))
        }
        "object" => {
            let C::Map(m) = raw else {
                return Err("object".into());
            };
            let mut out = BTreeMap::new();
            let mut remaining = m.clone();
            let mut ordered = fields(s);
            ordered.sort_by_key(|f| f.3);
            for (name, s, optional, flatten) in ordered {
                if flatten {
                    let C::Map(extra) = walk(&C::Map(remaining.clone()), &s, defs, j, depth + 1)?
                    else {
                        return Err("flatten object".into());
                    };
                    for (k, v) in extra {
                        remaining.remove(&k);
                        out.insert(k, v);
                    }
                    continue;
                }
                if let Some(v) = remaining.remove(&name) {
                    out.insert(name, walk(&v, &s, defs, j, depth + 1)?);
                } else if !optional {
                    return Err(format!("missing {name}"));
                }
            }
            if !remaining.is_empty() && s["unknownFields"] != "ignore" {
                return Err("unknown field".into());
            }
            Ok(C::Map(out))
        }
        "enum" => {
            let variants = s["variants"].as_array().ok_or("variants")?;
            if s["untagged"] == true {
                for v in variants {
                    if let Ok(v) = walk(raw, &v["schema"], defs, j, depth + 1) {
                        return Ok(v);
                    }
                }
                return Err("untagged variants".into());
            }
            let tag = s["tag"].as_str();
            let content = s["content"].as_str();
            let (name, payload) = match (raw, tag) {
                (C::Text(name), None) => (name.clone(), C::Null),
                (C::Map(m), None) if m.len() == 1 => {
                    let (k, v) = m.iter().next().unwrap();
                    (k.clone(), v.clone())
                }
                (C::Map(m), Some(tag)) => {
                    let Some(C::Text(name)) = m.get(tag) else {
                        return Err("enum tag".into());
                    };
                    let payload = if let Some(content) = content {
                        if m.len() != 2 {
                            return Err("adjacent fields".into());
                        }
                        m.get(content).cloned().ok_or("enum content")?
                    } else {
                        C::Map(
                            m.iter()
                                .filter(|(k, _)| k.as_str() != tag)
                                .map(|(k, v)| (k.clone(), v.clone()))
                                .collect(),
                        )
                    };
                    (name.clone(), payload)
                }
                _ => return Err("enum wire".into()),
            };
            let branch = variants
                .iter()
                .find(|v| v["name"] == name)
                .ok_or("enum variant")?;
            let payload = walk(&payload, &branch["schema"], defs, j, depth + 1)?;
            if let Some(tag) = tag {
                let mut map = BTreeMap::from([(tag.into(), C::Text(name))]);
                if let Some(content) = content {
                    map.insert(content.into(), payload);
                } else if let C::Map(m) = payload {
                    map.extend(m);
                } else if payload != C::Null {
                    return Err("internal enum payload".into());
                }
                Ok(C::Map(map))
            } else if payload == C::Null {
                Ok(C::Text(name))
            } else {
                Ok(C::Map(BTreeMap::from([(name, payload)])))
            }
        }
        "dynamic" => {
            fn safe(v: &C) -> bool {
                match v {
                    C::Tag(_, _) | C::Bytes(_) => false,
                    C::Int(n) => n.abs() <= 9007199254740991,
                    C::Array(a) => a.iter().all(safe),
                    C::Map(m) => m.values().all(safe),
                    _ => true,
                }
            }
            if safe(raw) {
                Ok(raw.clone())
            } else {
                Err("dynamic domain".into())
            }
        }
        _ => Err(format!("unsupported type {t}")),
    }
}
/// JSON emission uses semantic scalars, never JS-number intermediate values.
pub fn json_value(v: &C, lossless: bool) -> Result<J, String> {
    Ok(match v {
        C::Int(n) => {
            if lossless {
                J::String(n.to_string())
            } else if let Ok(n) = i64::try_from(*n) {
                json!(n)
            } else {
                json!(u64::try_from(*n).map_err(|_| "native integer range")?)
            }
        }
        C::Text(s) => json!(s),
        C::Bytes(b) => json!(crate::bytes::encode(b)),
        C::Bool(b) => json!(b),
        C::Null => J::Null,
        C::Array(a) => J::Array(
            a.iter()
                .map(|v| json_value(v, lossless))
                .collect::<Result<_, _>>()?,
        ),
        C::Map(m) => J::Object(
            m.iter()
                .map(|(k, v)| Ok((k.clone(), json_value(v, lossless)?)))
                .collect::<Result<_, String>>()?,
        ),
        C::Tag(4, _) => json!(Decimal::from_cbor(v)?.text()),
        C::Tag(0 | 1004, v) => json_value(v, lossless)?,
        _ => return Err("unsupported JSON value".into()),
    })
}
/// Emit a lossless JSON wire value using the same semantic graph.
pub fn emit(v: &C, schema: &J) -> Result<J, String> {
    fn walk(v: &C, s: &J, defs: &J, depth: usize) -> Result<J, String> {
        if depth > 64 {
            return Err("schema depth".into());
        }
        if let Some(name) = s["ref"].as_str() {
            let target = defs
                .get(format!("{name}.Input"))
                .or_else(|| defs.get(format!("{name}.Output")))
                .ok_or("ref")?;
            return walk(v, target, defs, depth + 1);
        }
        let t = kind(s);
        match t {
            "i64" | "u64" => {
                let C::Int(n) = v else {
                    return Err("integer".into());
                };
                Ok(json!(n.to_string()))
            }
            "nullable" => {
                if *v == C::Null {
                    Ok(J::Null)
                } else {
                    walk(v, &s["inner"], defs, depth + 1)
                }
            }
            "array" | "tuple" => {
                let C::Array(a) = v else {
                    return Err("array".into());
                };
                Ok(J::Array(
                    a.iter()
                        .enumerate()
                        .map(|(i, v)| {
                            walk(
                                v,
                                if t == "tuple" {
                                    &s["items"][i]
                                } else {
                                    &s["items"]
                                },
                                defs,
                                depth + 1,
                            )
                        })
                        .collect::<Result<_, _>>()?,
                ))
            }
            "map" => {
                let C::Map(m) = v else {
                    return Err("map".into());
                };
                Ok(J::Object(
                    m.iter()
                        .map(|(k, v)| Ok((k.clone(), walk(v, &s["values"], defs, depth + 1)?)))
                        .collect::<Result<_, String>>()?,
                ))
            }
            "object" => {
                let C::Map(m) = v else {
                    return Err("object".into());
                };
                let mut out = serde_json::Map::new();
                for (name, s, _, flatten) in fields(s) {
                    if flatten {
                        let mut selected = BTreeMap::new();
                        if kind(&s) == "map" {
                            for (k, v) in m {
                                if !out.contains_key(k) {
                                    selected.insert(k.clone(), v.clone());
                                }
                            }
                        } else {
                            for (k, _, _, _) in fields(&s) {
                                if let Some(v) = m.get(&k) {
                                    selected.insert(k, v.clone());
                                }
                            }
                        }
                        if let J::Object(extra) = walk(&C::Map(selected), &s, defs, depth + 1)? {
                            out.extend(extra);
                        }
                    } else if let Some(v) = m.get(&name) {
                        out.insert(name, walk(v, &s, defs, depth + 1)?);
                    }
                }
                Ok(J::Object(out))
            }
            "enum" => {
                let variants = s["variants"].as_array().ok_or("variants")?;
                if s["untagged"] == true {
                    for branch in variants {
                        if walk_hydrated(v, &branch["schema"], defs, depth).is_ok() {
                            return walk(v, &branch["schema"], defs, depth + 1);
                        }
                    }
                    return Err("untagged".into());
                }
                let tag = s["tag"].as_str();
                let content = s["content"].as_str();
                if let Some(tag) = tag {
                    let C::Map(m) = v else {
                        return Err("enum".into());
                    };
                    let Some(C::Text(name)) = m.get(tag) else {
                        return Err("tag".into());
                    };
                    let branch = variants
                        .iter()
                        .find(|x| x["name"] == *name)
                        .ok_or("variant")?;
                    let mut out = serde_json::Map::from_iter([(tag.into(), json!(name))]);
                    if let Some(content) = content {
                        out.insert(
                            content.into(),
                            walk(
                                m.get(content).ok_or("content")?,
                                &branch["schema"],
                                defs,
                                depth + 1,
                            )?,
                        );
                    } else {
                        let payload = C::Map(
                            m.iter()
                                .filter(|(k, _)| k.as_str() != tag)
                                .map(|(k, v)| (k.clone(), v.clone()))
                                .collect(),
                        );
                        if let J::Object(extra) =
                            walk(&payload, &branch["schema"], defs, depth + 1)?
                        {
                            out.extend(extra);
                        }
                    }
                    Ok(J::Object(out))
                } else if let C::Map(m) = v {
                    let (name, payload) = m.iter().next().ok_or("enum")?;
                    let branch = variants
                        .iter()
                        .find(|x| x["name"] == *name)
                        .ok_or("variant")?;
                    Ok(json!({name:walk(payload,&branch["schema"],defs,depth+1)?}))
                } else {
                    json_value(v, false)
                }
            }
            _ => json_value(v, false),
        }
    }
    fn walk_hydrated(v: &C, s: &J, defs: &J, d: usize) -> Result<C, String> {
        super::hydrate::walk(v, s, defs, false, d)
    }
    let defs = schema.get("definitions").cloned().unwrap_or(json!({}));
    walk(v, schema.get("root").unwrap_or(schema), &defs, 0)
}
