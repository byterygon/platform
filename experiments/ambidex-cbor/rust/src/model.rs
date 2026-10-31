//! Nominal, direction-aware semantic graph. No hand-maintained field registry.
pub use semantic_derive::Semantic;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Input,
    Output,
}
impl Direction {
    fn suffix(self) -> &'static str {
        if self == Self::Input {
            "Input"
        } else {
            "Output"
        }
    }
}
#[derive(Default)]
pub struct Graph {
    pub definitions: BTreeMap<String, Value>,
    owners: BTreeMap<String, &'static str>,
}
impl Graph {
    pub fn begin<T: Semantic>(&mut self, name: &str, d: Direction) -> Result<bool, String> {
        let key = format!("{name}.{}", d.suffix());
        let owner = std::any::type_name::<T>();
        if let Some(existing) = self.owners.get(&key) {
            if *existing != owner {
                return Err(format!("nominal collision: {name}"));
            }
            return Ok(false);
        }
        self.owners.insert(key.clone(), owner);
        self.definitions.insert(key, Value::Null);
        Ok(true)
    }
    pub fn finish(&mut self, name: &str, d: Direction, v: Value) {
        self.definitions.insert(format!("{name}.{}", d.suffix()), v);
    }
    pub fn document<T: Semantic>(direction: Direction) -> Result<Value, String> {
        let mut g = Self::default();
        let root = T::describe(&mut g, direction)?;
        Ok(json!({"direction":direction.suffix(),"root":root,"definitions":g.definitions}))
    }
}
pub trait Semantic: 'static {
    fn accepts_missing() -> bool {
        false
    }
    fn name() -> String;
    fn describe(g: &mut Graph, d: Direction) -> Result<Value, String>;
}
macro_rules! ints{($($ty:ty),*)=>{$(impl Semantic for $ty{fn name()->String{stringify!($ty).into()}fn describe(_: &mut Graph,_:Direction)->Result<Value,String>{Ok(json!({"type":stringify!($ty),"minimum":<$ty>::MIN.to_string(),"maximum":<$ty>::MAX.to_string()}))}})*}}
ints!(i8, i16, i32, i64, u8, u16, u32, u64);
macro_rules! simple{($ty:ty,$name:literal)=>{impl Semantic for $ty{fn name()->String{$name.into()}fn describe(_:&mut Graph,_:Direction)->Result<Value,String>{Ok(json!({"type":$name}))}}}}
simple!(String, "string");
simple!(bool, "bool");
simple!(serde_json::Value, "dynamic");
impl<T: Semantic> Semantic for Option<T> {
    fn accepts_missing() -> bool {
        true
    }
    fn name() -> String {
        format!("Option<{}>", T::name())
    }
    fn describe(g: &mut Graph, d: Direction) -> Result<Value, String> {
        Ok(json!({"type":"nullable","inner":T::describe(g,d)?}))
    }
}
impl<T: Semantic> Semantic for Box<T> {
    fn name() -> String {
        T::name()
    }
    fn describe(g: &mut Graph, d: Direction) -> Result<Value, String> {
        T::describe(g, d)
    }
}
impl<T: Semantic> Semantic for Vec<T> {
    fn name() -> String {
        format!("Vec<{}>", T::name())
    }
    fn describe(g: &mut Graph, d: Direction) -> Result<Value, String> {
        Ok(json!({"type":"array","items":T::describe(g,d)?}))
    }
}
impl<T: Semantic> Semantic for BTreeMap<String, T> {
    fn name() -> String {
        format!("Map<{}>", T::name())
    }
    fn describe(g: &mut Graph, d: Direction) -> Result<Value, String> {
        Ok(json!({"type":"map","values":T::describe(g,d)?}))
    }
}
/// Canonical model encoding: JSON grammar containing only strings, booleans,
/// null, arrays and maps. UTF-8 key order, no ignored keys and no JSON numbers.
/// Untagged branch order is retained; derive sorts named fields/tagged branches.
pub fn canonical(v: &Value) -> Result<Vec<u8>, String> {
    fn check(v: &Value) -> Result<(), String> {
        match v {
            Value::Number(_) => Err("numeric metadata must be exact decimal text".into()),
            Value::Array(a) => {
                for v in a {
                    check(v)?;
                }
                Ok(())
            }
            Value::Object(o) => {
                for v in o.values() {
                    check(v)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
    check(v)?;
    fn emit(v: &Value, out: &mut Vec<u8>) -> Result<(), String> {
        match v {
            Value::Object(o) => {
                out.push(b'{');
                let mut keys: Vec<_> = o.keys().collect();
                keys.sort();
                for (i, k) in keys.into_iter().enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    out.extend(serde_json::to_vec(k).map_err(|e| e.to_string())?);
                    out.push(b':');
                    emit(&o[k], out)?;
                }
                out.push(b'}');
            }
            Value::Array(a) => {
                out.push(b'[');
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    emit(v, out)?;
                }
                out.push(b']');
            }
            _ => out.extend(serde_json::to_vec(v).map_err(|e| e.to_string())?),
        }
        Ok(())
    }
    let mut out = Vec::new();
    emit(v, &mut out)?;
    Ok(out)
}
pub fn fingerprint(domain: &str, v: &Value) -> Result<String, String> {
    let mut h = Sha256::new();
    h.update(domain);
    h.update([0]);
    h.update(canonical(v)?);
    Ok(format!("sha256:{:x}", h.finalize()))
}
/// Extend, rather than replace, the production directional agreement checker.
/// serde/ts-rs agreement is checked before the semantic graph is exported.
pub fn checked<T: Semantic + ambidex::codegen::Type>(d: Direction) -> Result<Value, String> {
    ambidex::codegen::agree::Checker::of::<T>()
        .map_err(|e| e.to_string())?
        .agree_as(if d == Direction::Input {
            ambidex::codegen::Direction::Input
        } else {
            ambidex::codegen::Direction::Output
        })?;
    Graph::document::<T>(d)
}

/// Default values participate in contract identity with exact numeric lexemes.
pub fn default_metadata<T: Default + serde::Serialize>() -> Result<Value, String> {
    fn exact(v: Value) -> Value {
        match v {
            Value::Number(n) => json!({"exactNumber":n.to_string()}),
            Value::Array(a) => Value::Array(a.into_iter().map(exact).collect()),
            Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, exact(v))).collect()),
            v => v,
        }
    }
    serde_json::to_value(T::default())
        .map(exact)
        .map_err(|e| e.to_string())
}
