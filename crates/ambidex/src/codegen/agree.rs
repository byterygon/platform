//! Checks that ts-rs and schemars describe the same JSON (Ambidex spec §2).
//!
//! Both sides are reduced to a [`Ty`]: TypeScript by parsing what ts-rs writes, JSON Schema by
//! [`from_schema`]. Named types are compared by structure, not by name or text: references are
//! resolved on each side (generic TypeScript declarations are instantiated), unions are matched
//! member by member in any order, and intersections (`#[serde(flatten)]`, internally tagged
//! enums) are merged into plain objects first. Recursive types are compared coinductively.
//!
//! What JSON cannot tell apart is ignored: integer formats and ranges, `uniqueItems`,
//! `additionalProperties: false`, descriptions and titles.
//!
//! Optional properties follow serde:
//!
//! - TS `k: T` against a schema property that is required: `T` must agree.
//! - TS `k?: T` against an optional schema property: agree, or the schema adds `null` (an
//!   `Option` with `skip_serializing_if`: never sent as `null`, but accepted).
//! - TS `k: T | null` against an optional nullable schema property: an `Option` field, which
//!   serde writes as `null` and reads when missing.
//! - TS `k: T` against an optional schema property with a `default`: `#[serde(default)]`, always
//!   written, may be omitted on input.
//! - TS `k?: T` against a required schema property disagrees: a client could omit a field the
//!   server requires.

use std::collections::BTreeMap;
use std::fmt;

use serde_json::Value;

use super::Model;
use super::ts::{self, Field, Ty};

/// Where and how the two descriptions differ.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mismatch {
    /// E.g. `fixture.fail input > .code`.
    pub path: String,
    pub reason: String,
}

impl fmt::Display for Mismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.path, self.reason)
    }
}

/// Resolves named types on one side.
pub trait Resolver {
    fn resolve(&self, name: &str, args: &[Ty]) -> Option<Ty>;
}

/// TypeScript declarations by name.
#[derive(Debug, Default, Clone)]
pub struct TsDecls(pub BTreeMap<String, ts::Decl>);

impl TsDecls {
    /// Parses declarations as ts-rs writes them.
    pub fn parse<'a>(decls: impl IntoIterator<Item = &'a str>) -> Result<TsDecls, Mismatch> {
        let mut map = BTreeMap::new();
        for src in decls {
            let decl = ts::parse_decl(src).map_err(|e| Mismatch {
                path: "TypeScript".into(),
                reason: format!("cannot parse `{src}`: {e}"),
            })?;
            map.insert(decl.name.clone(), decl);
        }
        Ok(TsDecls(map))
    }
}

impl Resolver for TsDecls {
    fn resolve(&self, name: &str, args: &[Ty]) -> Option<Ty> {
        let decl = self.0.get(name)?;
        if decl.params.len() != args.len() {
            return None;
        }
        let params = decl
            .params
            .iter()
            .cloned()
            .zip(args.iter().cloned())
            .collect();
        Some(decl.body.substitute(&params))
    }
}

/// JSON Schema definitions (`$defs`) by name.
#[derive(Debug, Default, Clone)]
pub struct SchemaDefs(pub BTreeMap<String, Ty>);

impl SchemaDefs {
    pub fn convert<'a>(defs: impl IntoIterator<Item = (&'a String, &'a Value)>) -> SchemaDefs {
        SchemaDefs(
            defs.into_iter()
                .map(|(name, schema)| (name.clone(), from_schema(schema)))
                .collect(),
        )
    }
}

impl Resolver for SchemaDefs {
    fn resolve(&self, name: &str, args: &[Ty]) -> Option<Ty> {
        if args.is_empty() {
            self.0.get(name).cloned()
        } else {
            None
        }
    }
}

/// Converts a JSON Schema (as schemars writes it) into a [`Ty`]. References become
/// [`Ty::Ref`] with the `$defs` name.
pub fn from_schema(schema: &Value) -> Ty {
    let obj = match schema {
        Value::Bool(true) => return Ty::Any,
        Value::Bool(false) => return Ty::Never,
        Value::Object(obj) => obj,
        _ => return Ty::Any,
    };
    if let Some(Value::String(reference)) = obj.get("$ref") {
        let name = reference
            .rsplit_once('/')
            .map_or(reference.as_str(), |(_, n)| n);
        return Ty::Ref(name.to_owned(), Vec::new());
    }
    let mut parts = Vec::new();
    if let Some(value) = obj.get("const") {
        parts.push(Ty::literal(value));
    } else if let Some(Value::Array(values)) = obj.get("enum") {
        parts.push(Ty::union(values.iter().map(Ty::literal)));
    } else if let Some(types) = obj.get("type") {
        let types: Vec<&str> = match types {
            Value::String(t) => vec![t.as_str()],
            Value::Array(ts) => ts.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        parts.push(Ty::union(types.into_iter().map(|t| typed(t, obj))));
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(Value::Array(options)) = obj.get(key) {
            parts.push(Ty::union(options.iter().map(from_schema)));
        }
    }
    if let Some(Value::Array(all)) = obj.get("allOf") {
        parts.extend(all.iter().map(from_schema));
    }
    parts.retain(|p| *p != Ty::Any);
    match parts.len() {
        0 => Ty::Any,
        1 => parts.pop().expect("one part"),
        _ => Ty::Intersection(parts),
    }
}

fn typed(t: &str, obj: &serde_json::Map<String, Value>) -> Ty {
    match t {
        "string" => Ty::String,
        "number" | "integer" => Ty::Number,
        "boolean" => Ty::Boolean,
        "null" => Ty::Null,
        "array" => match (obj.get("prefixItems"), obj.get("items")) {
            (Some(Value::Array(items)), _) | (None, Some(Value::Array(items))) => {
                Ty::Tuple(items.iter().map(from_schema).collect())
            }
            (_, Some(items)) => Ty::Array(Box::new(from_schema(items))),
            _ => Ty::Array(Box::new(Ty::Any)),
        },
        "object" => match obj.get("properties") {
            Some(Value::Object(props)) => {
                let required: Vec<&str> = match obj.get("required") {
                    Some(Value::Array(r)) => r.iter().filter_map(Value::as_str).collect(),
                    _ => Vec::new(),
                };
                Ty::Object(
                    props
                        .iter()
                        .map(|(key, schema)| {
                            let field = Field {
                                ty: from_schema(schema),
                                optional: !required.contains(&key.as_str()),
                                has_default: schema.get("default").is_some(),
                            };
                            (key.clone(), field)
                        })
                        .collect(),
                )
            }
            _ => match obj.get("additionalProperties") {
                Some(Value::Bool(false)) => Ty::Object(BTreeMap::new()),
                Some(schema) => Ty::Map(Box::new(from_schema(schema))),
                None => Ty::Map(Box::new(Ty::Any)),
            },
        },
        _ => Ty::Any,
    }
}

/// How deep references may be chased at the head of a type before giving up.
const MAX_DEPTH: usize = 64;

/// Resolves references at the head of `ty`, flattens unions and merges intersections, so that
/// the outermost constructor is structural.
pub fn head(ty: &Ty, r: &dyn Resolver) -> Result<Ty, String> {
    head_at(ty, r, 0)
}

fn head_at(ty: &Ty, r: &dyn Resolver, depth: usize) -> Result<Ty, String> {
    if depth > MAX_DEPTH {
        return Err(format!("type {ty} does not resolve to a structure"));
    }
    match ty {
        // ts-rs's declaration of serde_json::Value: any JSON.
        Ty::Ref(name, args) if name == "JsonValue" && args.is_empty() => Ok(Ty::Any),
        Ty::Ref(name, args) => {
            let body = r
                .resolve(name, args)
                .ok_or_else(|| format!("unknown type {ty}"))?;
            head_at(&body, r, depth + 1)
        }
        Ty::Union(members) => {
            let members = members
                .iter()
                .map(|m| head_at(m, r, depth + 1))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Ty::union(members))
        }
        Ty::Intersection(parts) => {
            // Distribute over unions: (A | B) & C = (A & C) | (B & C), then merge objects.
            let mut alternatives = vec![BTreeMap::new()];
            for part in parts {
                let part = head_at(part, r, depth + 1)?;
                if part == Ty::Any {
                    continue;
                }
                let mut next = Vec::new();
                for member in part.members() {
                    let Ty::Object(fields) = member else {
                        return Err(format!("cannot intersect non-object type {member}"));
                    };
                    for acc in &alternatives {
                        next.push(merge(acc, fields)?);
                    }
                }
                alternatives = next;
            }
            Ok(Ty::union(alternatives.into_iter().map(Ty::Object)))
        }
        other => Ok(other.clone()),
    }
}

fn merge(
    a: &BTreeMap<String, Field>,
    b: &BTreeMap<String, Field>,
) -> Result<BTreeMap<String, Field>, String> {
    let mut out = a.clone();
    for (key, field) in b {
        match out.get(key) {
            Some(existing) if existing != field => {
                return Err(format!("intersection defines property {key} twice"));
            }
            _ => {
                out.insert(key.clone(), field.clone());
            }
        }
    }
    Ok(out)
}

/// Compares a TypeScript type with a JSON Schema type.
pub fn compare(
    ts: &Ty,
    schema: &Ty,
    ts_defs: &dyn Resolver,
    schema_defs: &dyn Resolver,
) -> Result<(), String> {
    Comparison {
        ts_defs,
        schema_defs,
        assumed: Vec::new(),
    }
    .eq(ts, schema)
}

struct Comparison<'a> {
    ts_defs: &'a dyn Resolver,
    schema_defs: &'a dyn Resolver,
    /// Pairs being compared further up: assumed equal (coinduction for recursive types).
    assumed: Vec<(Ty, Ty)>,
}

impl Comparison<'_> {
    fn eq(&mut self, ts: &Ty, schema: &Ty) -> Result<(), String> {
        let pair = (ts.clone(), schema.clone());
        if self.assumed.contains(&pair) {
            return Ok(());
        }
        self.assumed.push(pair);
        let result = self.eq_heads(ts, schema);
        self.assumed.pop();
        result
    }

    fn eq_heads(&mut self, ts: &Ty, schema: &Ty) -> Result<(), String> {
        let a = head(ts, self.ts_defs)?;
        let b = head(schema, self.schema_defs)?;
        let differ = || Err(format!("TypeScript `{a}` but JSON Schema `{b}`"));
        match (&a, &b) {
            (Ty::Union(_), _) | (_, Ty::Union(_)) => self.eq_unions(&a, &b),
            (Ty::Array(x), Ty::Array(y)) => self.eq(x, y).map_err(|e| format!("[] {e}")),
            (Ty::Map(x), Ty::Map(y)) => self.eq(x, y).map_err(|e| format!("[key] {e}")),
            (Ty::Tuple(xs), Ty::Tuple(ys)) if xs.len() == ys.len() => {
                for (i, (x, y)) in xs.iter().zip(ys).enumerate() {
                    self.eq(x, y).map_err(|e| format!("[{i}] {e}"))?;
                }
                Ok(())
            }
            (Ty::Object(xs), Ty::Object(ys)) => self.eq_objects(xs, ys),
            (Ty::Literal(x), Ty::Literal(y)) if literal_eq(x, y) => Ok(()),
            (Ty::Any, Ty::Any)
            | (Ty::Never, Ty::Never)
            | (Ty::String, Ty::String)
            | (Ty::Number, Ty::Number)
            | (Ty::Boolean, Ty::Boolean)
            | (Ty::Null, Ty::Null) => Ok(()),
            _ => differ(),
        }
    }

    /// Every member on each side agrees with some member on the other.
    fn eq_unions(&mut self, a: &Ty, b: &Ty) -> Result<(), String> {
        for x in a.members() {
            if !b.members().iter().any(|y| self.eq(x, y).is_ok()) {
                return Err(format!(
                    "TypeScript member `{x}` has no counterpart in JSON Schema `{b}`"
                ));
            }
        }
        for y in b.members() {
            if !a.members().iter().any(|x| self.eq(x, y).is_ok()) {
                return Err(format!(
                    "JSON Schema member `{y}` has no counterpart in TypeScript `{a}`"
                ));
            }
        }
        Ok(())
    }

    fn eq_objects(
        &mut self,
        ts: &BTreeMap<String, Field>,
        schema: &BTreeMap<String, Field>,
    ) -> Result<(), String> {
        for key in ts.keys() {
            if !schema.contains_key(key) {
                return Err(format!("property {key} is only in TypeScript"));
            }
        }
        for key in schema.keys() {
            if !ts.contains_key(key) {
                return Err(format!("property {key} is only in JSON Schema"));
            }
        }
        for (key, t) in ts {
            let s = &schema[key];
            self.eq_field(t, s).map_err(|e| format!(".{key} {e}"))?;
        }
        Ok(())
    }

    fn eq_field(&mut self, t: &Field, s: &Field) -> Result<(), String> {
        match (t.optional, s.optional) {
            (false, false) => self.eq(&t.ty, &s.ty),
            (true, false) => Err("is optional in TypeScript but required in JSON Schema".into()),
            (true, true) => match self.eq(&t.ty, &s.ty) {
                Ok(()) => Ok(()),
                // `Option` + `skip_serializing_if`: the schema also accepts null.
                Err(e) => {
                    let without_null = self.without_null(&s.ty)?;
                    self.eq(&t.ty, &without_null).map_err(|_| e)
                }
            },
            (false, true) => {
                let nullable = self.nullable(&t.ty, self.ts_defs)?
                    && self.nullable(&s.ty, self.schema_defs)?;
                if s.has_default || nullable {
                    self.eq(&t.ty, &s.ty)
                } else {
                    Err(
                        "is required in TypeScript but optional in JSON Schema without a \
                         default"
                            .into(),
                    )
                }
            }
        }
    }

    fn nullable(&self, ty: &Ty, r: &dyn Resolver) -> Result<bool, String> {
        Ok(head(ty, r)?.members().contains(&Ty::Null))
    }

    fn without_null(&self, ty: &Ty) -> Result<Ty, String> {
        let ty = head(ty, self.schema_defs)?;
        Ok(Ty::union(
            ty.members().iter().filter(|m| **m != Ty::Null).cloned(),
        ))
    }
}

fn literal_eq(a: &str, b: &str) -> bool {
    match (
        serde_json::from_str::<Value>(a),
        serde_json::from_str::<Value>(b),
    ) {
        (Ok(x), Ok(y)) => x == y || (x.as_f64().is_some() && x.as_f64() == y.as_f64()),
        _ => a == b,
    }
}

/// Whether `value` is a JSON value of type `ty`. Objects are closed: a property the type does not
/// list is rejected, so a misspelled or renamed field is caught.
pub fn accepts(ty: &Ty, value: &Value, r: &dyn Resolver) -> Result<bool, String> {
    let ty = head(ty, r)?;
    Ok(match (&ty, value) {
        (Ty::Any, _) => true,
        (Ty::Never, _) => false,
        (Ty::Union(members), _) => {
            for member in members {
                if accepts(member, value, r)? {
                    return Ok(true);
                }
            }
            false
        }
        (Ty::String, Value::String(_))
        | (Ty::Number, Value::Number(_))
        | (Ty::Boolean, Value::Bool(_))
        | (Ty::Null, Value::Null) => true,
        (Ty::Literal(lit), v) => literal_eq(lit, &v.to_string()),
        (Ty::Array(item), Value::Array(values)) => {
            for v in values {
                if !accepts(item, v, r)? {
                    return Ok(false);
                }
            }
            true
        }
        (Ty::Tuple(items), Value::Array(values)) if items.len() == values.len() => {
            for (t, v) in items.iter().zip(values) {
                if !accepts(t, v, r)? {
                    return Ok(false);
                }
            }
            true
        }
        (Ty::Map(item), Value::Object(map)) => {
            for v in map.values() {
                if !accepts(item, v, r)? {
                    return Ok(false);
                }
            }
            true
        }
        (Ty::Object(fields), Value::Object(map)) => {
            if map.keys().any(|k| !fields.contains_key(k)) {
                return Ok(false);
            }
            for (key, field) in fields {
                match map.get(key) {
                    Some(v) => {
                        if !accepts(&field.ty, v, r)? {
                            return Ok(false);
                        }
                    }
                    None if field.optional => {}
                    None => return Ok(false),
                }
            }
            true
        }
        _ => false,
    })
}

/// Checks every procedure type and every named type of `model`.
pub(crate) fn check_model(model: &Model) -> Result<(), Mismatch> {
    let ts_defs = TsDecls::parse(model.decls.values().map(|d| d.decl.as_str()))?;
    let schema_defs = SchemaDefs::convert(&model.defs);
    let check = |path: String, ts_src: &str, schema: &Value| {
        let ts = ts::parse_type(ts_src).map_err(|e| Mismatch {
            path: path.clone(),
            reason: format!("cannot parse `{ts_src}`: {e}"),
        })?;
        compare(&ts, &from_schema(schema), &ts_defs, &schema_defs)
            .map_err(|reason| Mismatch { path, reason })
    };
    for p in &model.procedures {
        let name = &p.meta.name;
        check(format!("{name} input"), &p.input_ts, &p.input_schema)?;
        check(format!("{name} output"), &p.output_ts, &p.output_schema)?;
        check(
            format!("{name} error details"),
            &p.error_ts,
            &p.error_schema,
        )?;
    }
    // Named types on both sides, also those only reached through the protocol (Code).
    for (name, decl) in &ts_defs.0 {
        if decl.params.is_empty()
            && let Some(schema) = schema_defs.0.get(name)
        {
            compare(&decl.body, schema, &ts_defs, &schema_defs).map_err(|reason| Mismatch {
                path: name.clone(),
                reason,
            })?;
        }
    }
    Ok(())
}

/// Both descriptions of one type, for tests and tools: does serde's JSON for a value fit the
/// TypeScript type and the JSON Schema, and do the two agree?
pub struct Checker {
    ts: Ty,
    schema: Ty,
    ts_defs: TsDecls,
    schema_defs: SchemaDefs,
}

impl Checker {
    pub fn of<T: super::Type>() -> Result<Checker, Mismatch> {
        let mut collector = super::Collector::new();
        super::TypeVisitor::visit::<T>(&mut collector);
        if let Some(err) = collector.error {
            return Err(Mismatch {
                path: std::any::type_name::<T>().into(),
                reason: err.to_string(),
            });
        }
        let mut generator = super::schema_generator();
        let schema = generator.subschema_for::<T>().to_value();
        let defs = generator.take_definitions(true);
        let ts_src = <T as ts_rs::TS>::name(&collector.cfg);
        let ts = ts::parse_type(&ts_src).map_err(|e| Mismatch {
            path: std::any::type_name::<T>().into(),
            reason: format!("cannot parse `{ts_src}`: {e}"),
        })?;
        Ok(Checker {
            ts,
            schema: from_schema(&schema),
            ts_defs: TsDecls::parse(collector.decls.values().map(|d| d.decl.as_str()))?,
            schema_defs: SchemaDefs::convert(defs.iter()),
        })
    }

    pub fn agree(&self) -> Result<(), String> {
        compare(&self.ts, &self.schema, &self.ts_defs, &self.schema_defs)
    }

    pub fn ts_accepts(&self, value: &Value) -> Result<bool, String> {
        accepts(&self.ts, value, &self.ts_defs)
    }

    pub fn schema_accepts(&self, value: &Value) -> Result<bool, String> {
        accepts(&self.schema, value, &self.schema_defs)
    }
}
