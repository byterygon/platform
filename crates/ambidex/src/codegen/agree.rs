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
//! A type is checked against what serde reads where it is an input, and against what serde writes
//! where it is an output or error details (schemars' deserialize and serialize contracts; see
//! [`Direction`]). The two differ in which properties may be missing, so optional properties follow
//! serde by direction. As an **input** (TypeScript must not let a client send what the server
//! refuses, nor force it to send what the server would fill in):
//!
//! - TS `k: T` against a required property: `T` must agree.
//! - TS `k?: T` against an optional property: agree, or the schema adds `null` (an `Option` with
//!   `skip_serializing_if`: never sent as `null` by TypeScript, but read).
//! - TS `k: T | null` against an optional nullable property: a plain `Option`, read as None
//!   when missing.
//! - TS `k: T` against an optional property with a `default` disagrees: the field is
//!   `#[serde(default)]`, so a client may omit it, and TypeScript must say so. Mark it
//!   `#[ts(optional = nullable)]`, which writes `k?: T` and keeps `T` as is.
//! - TS `k?: T` against a required property disagrees: a client could omit a field the server
//!   requires.
//!
//! As an **output** (TypeScript must expect everything the server may send):
//!
//! - TS `k: T` against a required property: `T` must agree, `null` included, so `#[ts(optional)]`
//!   on a plain `Option` (always written, as `null`) disagrees.
//! - TS `k?: T` against a required property: agree (a `#[serde(default)]` field, always written).
//! - TS `k?: T` against an optional property (`skip_serializing_if`): agree, or the schema adds
//!   `null`; schemars does not say whether the predicate is `Option::is_none`.
//! - TS `k: T` against an optional property disagrees: the server may leave it out.
//!
//! Fixed-size arrays (`[T; N]`) are tuples on both sides up to ts-rs's tuple limit, and a
//! `#[serde(flatten)]` map adds a type for all other properties (an open object).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;

use serde_json::Value;

use super::ts::{self, Field, Ty};
use super::{Direction, Model};

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
            (_, Some(items)) => {
                let item = from_schema(items);
                match fixed_len(obj) {
                    // `[T; N]`: ts-rs writes an N-tuple up to its tuple limit.
                    Some(n) if n <= super::ts_config().array_tuple_limit() => {
                        Ty::Tuple(vec![item; n])
                    }
                    _ => Ty::Array(Box::new(item)),
                }
            }
            _ => Ty::Array(Box::new(Ty::Any)),
        },
        "object" => match obj.get("properties") {
            Some(Value::Object(props)) => {
                let required: Vec<&str> = match obj.get("required") {
                    Some(Value::Array(r)) => r.iter().filter_map(Value::as_str).collect(),
                    _ => Vec::new(),
                };
                let fields = props
                    .iter()
                    .map(|(key, schema)| {
                        let field = Field {
                            ty: from_schema(schema),
                            optional: !required.contains(&key.as_str()),
                            has_default: schema.get("default").is_some(),
                        };
                        (key.clone(), field)
                    })
                    .collect();
                match obj.get("additionalProperties") {
                    // `#[serde(flatten)]` of a map: more properties of one type.
                    Some(rest) if *rest != Value::Bool(false) => {
                        Ty::Open(fields, Box::new(from_schema(rest)))
                    }
                    _ => Ty::Object(fields),
                }
            }
            _ => match obj.get("additionalProperties") {
                // A map; `true` (any value) for serde_json::Map.
                Some(schema) if *schema != Value::Bool(false) => {
                    Ty::Map(Box::new(from_schema(schema)))
                }
                // A struct without fields (`{"type": "object"}`).
                _ => Ty::Object(BTreeMap::new()),
            },
        },
        _ => Ty::Any,
    }
}

/// `N` when the schema fixes the array length (`minItems == maxItems == N`).
fn fixed_len(obj: &serde_json::Map<String, Value>) -> Option<usize> {
    let min = obj.get("minItems")?.as_u64()?;
    let max = obj.get("maxItems")?.as_u64()?;
    if min == max {
        usize::try_from(min).ok()
    } else {
        None
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
            // Distribute over unions: (A | B) & C = (A & C) | (B & C), then merge objects. A map
            // part (a flattened map) adds the type of all other properties.
            let mut alternatives = vec![(BTreeMap::new(), None)];
            for part in parts {
                let part = head_at(part, r, depth + 1)?;
                if part == Ty::Any {
                    continue;
                }
                let mut next = Vec::new();
                for member in part.members() {
                    let (fields, rest) = match member {
                        Ty::Object(fields) => (fields.clone(), None),
                        Ty::Open(fields, rest) => (fields.clone(), Some((**rest).clone())),
                        Ty::Map(rest) => (BTreeMap::new(), Some((**rest).clone())),
                        _ => return Err(format!("cannot intersect non-object type {member}")),
                    };
                    for acc in &alternatives {
                        next.push(merge(acc, (&fields, &rest))?);
                    }
                }
                alternatives = next;
            }
            Ok(Ty::union(alternatives.into_iter().map(
                |(fields, rest)| match rest {
                    Some(rest) => Ty::Open(fields, Box::new(rest)),
                    None => Ty::Object(fields),
                },
            )))
        }
        other => Ok(other.clone()),
    }
}

type Shape = (BTreeMap<String, Field>, Option<Ty>);

fn merge(
    a: &Shape,
    (fields, rest): (&BTreeMap<String, Field>, &Option<Ty>),
) -> Result<Shape, String> {
    let (mut out, mut out_rest) = a.clone();
    for (key, field) in fields {
        match out.get(key) {
            Some(existing) if existing != field => {
                return Err(format!("intersection defines property {key} twice"));
            }
            _ => {
                out.insert(key.clone(), field.clone());
            }
        }
    }
    match (&out_rest, rest) {
        (Some(a), Some(b)) if a != b => {
            return Err("intersection flattens two maps of different types".into());
        }
        (None, Some(b)) => out_rest = Some(b.clone()),
        _ => {}
    }
    Ok((out, out_rest))
}

/// Compares a TypeScript type with a JSON Schema type of what the server reads or writes.
pub fn compare(
    ts: &Ty,
    schema: &Ty,
    ts_defs: &dyn Resolver,
    schema_defs: &dyn Resolver,
    direction: Direction,
) -> Result<(), String> {
    Comparison::new(ts_defs, schema_defs, direction).eq(ts, schema)
}

/// One side of a check: memoizes results, so a type reached from many places, or a union of
/// unions, is compared once per pair.
pub(crate) struct Comparison<'a> {
    ts_defs: &'a dyn Resolver,
    schema_defs: &'a dyn Resolver,
    direction: Direction,
    /// Pairs being compared further up: assumed equal (coinduction for recursive types).
    stack: Vec<(Ty, Ty)>,
    /// The lowest stack position the current comparison has assumed so far.
    low: usize,
    /// Pairs that agree without any assumption still open.
    proven: HashSet<(Ty, Ty)>,
    /// Pairs that disagree. Assumptions only ever make a comparison succeed, so a failure is
    /// final whatever was assumed.
    failed: HashMap<(Ty, Ty), String>,
}

impl<'a> Comparison<'a> {
    pub(crate) fn new(
        ts_defs: &'a dyn Resolver,
        schema_defs: &'a dyn Resolver,
        direction: Direction,
    ) -> Comparison<'a> {
        Comparison {
            ts_defs,
            schema_defs,
            direction,
            stack: Vec::new(),
            low: usize::MAX,
            proven: HashSet::new(),
            failed: HashMap::new(),
        }
    }

    pub(crate) fn eq(&mut self, ts: &Ty, schema: &Ty) -> Result<(), String> {
        let pair = (ts.clone(), schema.clone());
        if self.proven.contains(&pair) {
            return Ok(());
        }
        if let Some(e) = self.failed.get(&pair) {
            return Err(e.clone());
        }
        if let Some(at) = self.stack.iter().position(|p| *p == pair) {
            self.low = self.low.min(at);
            return Ok(());
        }
        let depth = self.stack.len();
        self.stack.push(pair);
        let outer_low = std::mem::replace(&mut self.low, usize::MAX);
        let result = self.eq_heads(ts, schema);
        let pair = self.stack.pop().expect("pushed above");
        let low = self.low;
        self.low = outer_low.min(low);
        match &result {
            // Only what rests on this pair or deeper (finished) ones is settled.
            Ok(()) if low >= depth => {
                self.proven.insert(pair);
            }
            Ok(()) => {}
            Err(e) => {
                self.failed.insert(pair, e.clone());
            }
        }
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
            (Ty::Open(xs, x), Ty::Open(ys, y)) => {
                self.eq_objects(xs, ys)?;
                self.eq(x, y).map_err(|e| format!("[other keys] {e}"))
            }
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

    /// Optionality, by direction (see the module docs).
    fn eq_field(&mut self, t: &Field, s: &Field) -> Result<(), String> {
        match (self.direction, t.optional, s.optional) {
            (_, false, false) => self.eq(&t.ty, &s.ty),

            (Direction::Input, true, false) => {
                Err("is optional in TypeScript but the server requires it".into())
            }
            // `Option` with `skip_serializing_if`: the server also reads null.
            (Direction::Input, true, true) => self.eq_or_without_null(t, s),
            (Direction::Input, false, true) if s.has_default => Err(
                "is required in TypeScript but has a default (`#[serde(default)]`), so a client \
                 may omit it; mark the field `#[ts(optional = nullable)]`"
                    .into(),
            ),
            // A plain `Option`: the server reads a missing field as None; TypeScript sends null.
            (Direction::Input, false, true) => {
                let nullable = self.nullable(&t.ty, self.ts_defs)?
                    && self.nullable(&s.ty, self.schema_defs)?;
                if nullable {
                    self.eq(&t.ty, &s.ty)
                } else {
                    Err("is required in TypeScript but optional to the server".into())
                }
            }

            // Always sent (`#[serde(default)]` read optionally, written always): TypeScript may
            // be more careful than needed, but the type must match, null included.
            (Direction::Output, true, false) => self.eq(&t.ty, &s.ty),
            // `skip_serializing_if`: the server may leave the field out. schemars cannot tell
            // `Option::is_none` from other predicates, so `k?: T` is accepted against `T | null`.
            (Direction::Output, true, true) => self.eq_or_without_null(t, s),
            (Direction::Output, false, true) => {
                Err("is required in TypeScript but the server may leave it out \
                 (`skip_serializing_if`); mark the field `#[ts(optional)]`"
                    .into())
            }
        }
    }

    fn eq_or_without_null(&mut self, t: &Field, s: &Field) -> Result<(), String> {
        match self.eq(&t.ty, &s.ty) {
            Ok(()) => Ok(()),
            Err(e) => {
                let without_null = self.without_null(&s.ty)?;
                self.eq(&t.ty, &without_null).map_err(|_| e)
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
        (Ty::Object(fields) | Ty::Open(fields, _), Value::Object(map)) => {
            for (key, v) in map {
                if fields.contains_key(key) {
                    continue;
                }
                let Ty::Open(_, rest) = &ty else {
                    return Ok(false);
                };
                if !accepts(rest, v, r)? {
                    return Ok(false);
                }
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

/// Checks every procedure type and every named type of `model`: inputs against what the server
/// reads, outputs and error details against what it writes.
pub(crate) fn check_model(model: &Model) -> Result<(), Mismatch> {
    let ts_defs = TsDecls::parse(model.decls.values().map(|d| d.decl.as_str()))?;
    let input_defs = SchemaDefs::convert(&model.input_defs);
    let output_defs = SchemaDefs::convert(&model.output_defs);
    let mut input = Comparison::new(&ts_defs, &input_defs, Direction::Input);
    let mut output = Comparison::new(&ts_defs, &output_defs, Direction::Output);
    let check = |side: &mut Comparison<'_>, path: String, ts_src: &str, schema: &Value| {
        let ts = ts::parse_type(ts_src).map_err(|e| Mismatch {
            path: path.clone(),
            reason: format!("cannot parse `{ts_src}`: {e}"),
        })?;
        side.eq(&ts, &from_schema(schema))
            .map_err(|reason| Mismatch { path, reason })
    };
    for p in &model.procedures {
        let name = &p.meta.name;
        check(
            &mut input,
            format!("{name} input"),
            &p.input_ts,
            &p.input_schema,
        )?;
        check(
            &mut output,
            format!("{name} output"),
            &p.output_ts,
            &p.output_schema,
        )?;
        check(
            &mut output,
            format!("{name} error details"),
            &p.error_ts,
            &p.error_schema,
        )?;
    }
    // Named types on each side they are used on, also those only reached through the protocol.
    for (name, decl) in &ts_defs.0 {
        if !decl.params.is_empty() {
            continue;
        }
        for (side, defs, label) in [
            (&mut input, &input_defs, "as read"),
            (&mut output, &output_defs, "as written"),
        ] {
            if let Some(schema) = defs.0.get(name) {
                side.eq(&decl.body, schema).map_err(|reason| Mismatch {
                    path: format!("{name} ({label})"),
                    reason,
                })?;
            }
        }
    }
    Ok(())
}

/// Both descriptions of one type, for tests and tools: does serde's JSON for a value fit the
/// TypeScript type and the JSON Schemas, and do they agree? The type is checked as an input
/// (against what serde reads) and as an output (against what serde writes).
pub struct Checker {
    ts: Ty,
    input: Ty,
    output: Ty,
    ts_defs: TsDecls,
    input_defs: SchemaDefs,
    output_defs: SchemaDefs,
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
        let schema = |direction| {
            let mut generator = super::schema_generator(direction);
            let schema = generator.subschema_for::<T>().to_value();
            let defs = generator.take_definitions(true);
            (from_schema(&schema), SchemaDefs::convert(defs.iter()))
        };
        let (input, input_defs) = schema(Direction::Input);
        let (output, output_defs) = schema(Direction::Output);
        let ts_src = <T as ts_rs::TS>::name(&collector.cfg);
        let ts = ts::parse_type(&ts_src).map_err(|e| Mismatch {
            path: std::any::type_name::<T>().into(),
            reason: format!("cannot parse `{ts_src}`: {e}"),
        })?;
        Ok(Checker {
            ts,
            input,
            output,
            ts_defs: TsDecls::parse(collector.decls.values().map(|d| d.decl.as_str()))?,
            input_defs,
            output_defs,
        })
    }

    /// Agrees both as an input and as an output.
    pub fn agree(&self) -> Result<(), String> {
        self.agree_as(Direction::Input)
            .map_err(|e| format!("as input: {e}"))?;
        self.agree_as(Direction::Output)
            .map_err(|e| format!("as output: {e}"))
    }

    pub fn agree_as(&self, direction: Direction) -> Result<(), String> {
        let (schema, defs) = match direction {
            Direction::Input => (&self.input, &self.input_defs),
            Direction::Output => (&self.output, &self.output_defs),
        };
        compare(&self.ts, schema, &self.ts_defs, defs, direction)
    }

    pub fn ts_accepts(&self, value: &Value) -> Result<bool, String> {
        accepts(&self.ts, value, &self.ts_defs)
    }

    /// Whether the server reads `value`, as far as the schema can tell.
    pub fn input_schema_accepts(&self, value: &Value) -> Result<bool, String> {
        accepts(&self.input, value, &self.input_defs)
    }

    /// Whether `value` is something the server may write.
    pub fn output_schema_accepts(&self, value: &Value) -> Result<bool, String> {
        accepts(&self.output, value, &self.output_defs)
    }
}
