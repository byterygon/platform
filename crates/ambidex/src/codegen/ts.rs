//! A small structural model of the TypeScript types ts-rs writes, and a parser for them.
//!
//! [`agree`](super::agree) converts JSON Schemas into the same [`Ty`] and compares the two, so a
//! type is checked by meaning, not by text. The parser covers the subset ts-rs produces: keywords,
//! literals, `Array<T>`, tuples, object literals, mapped types (`{ [key in K]?: V }`), unions,
//! intersections, parentheses and named references with type arguments.

use std::collections::BTreeMap;
use std::fmt;

use serde_json::Value;

/// A type, as far as JSON can tell types apart.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Ty {
    /// Any JSON value (`unknown`, `any`, ts-rs's `JsonValue`, the `true` schema).
    Any,
    /// No value (`never`, the `false` schema).
    Never,
    String,
    /// Any JSON number; integer formats and ranges are not visible in TypeScript.
    Number,
    Boolean,
    Null,
    /// One JSON value, as canonical JSON text.
    Literal(String),
    Array(Box<Ty>),
    Tuple(Vec<Ty>),
    /// An object with arbitrary string keys and values of one type.
    Map(Box<Ty>),
    Object(BTreeMap<String, Field>),
    /// Flattened, sorted, without duplicates, at least two members.
    Union(Vec<Ty>),
    /// Kept only while a part is still a reference; see [`agree`](super::agree).
    Intersection(Vec<Ty>),
    /// A named type with type arguments.
    Ref(String, Vec<Ty>),
}

/// One object property.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Field {
    pub ty: Ty,
    /// `k?: T` in TypeScript; not in `required` in a schema.
    pub optional: bool,
    /// The schema states a `default` (serde fills the field in when it is missing).
    pub has_default: bool,
}

impl Ty {
    pub fn literal(value: &Value) -> Ty {
        Ty::Literal(value.to_string())
    }

    /// A union of `members`, normalized.
    pub fn union(members: impl IntoIterator<Item = Ty>) -> Ty {
        let mut flat = Vec::new();
        for member in members {
            match member {
                Ty::Union(inner) => flat.extend(inner),
                Ty::Never => {}
                other => flat.push(other),
            }
        }
        if flat.contains(&Ty::Any) {
            return Ty::Any;
        }
        flat.sort();
        flat.dedup();
        match flat.len() {
            0 => Ty::Never,
            1 => flat.pop().expect("one member"),
            _ => Ty::Union(flat),
        }
    }

    pub(crate) fn members(&self) -> &[Ty] {
        match self {
            Ty::Union(members) => members,
            other => std::slice::from_ref(other),
        }
    }

    /// Replaces type parameters by name.
    pub(crate) fn substitute(&self, params: &BTreeMap<String, Ty>) -> Ty {
        let sub = |t: &Ty| t.substitute(params);
        match self {
            Ty::Ref(name, args) if args.is_empty() && params.contains_key(name) => {
                params[name].clone()
            }
            Ty::Ref(name, args) => Ty::Ref(name.clone(), args.iter().map(sub).collect()),
            Ty::Array(t) => Ty::Array(Box::new(sub(t))),
            Ty::Map(t) => Ty::Map(Box::new(sub(t))),
            Ty::Tuple(items) => Ty::Tuple(items.iter().map(sub).collect()),
            Ty::Union(items) => Ty::union(items.iter().map(sub)),
            Ty::Intersection(items) => Ty::Intersection(items.iter().map(sub).collect()),
            Ty::Object(fields) => Ty::Object(
                fields
                    .iter()
                    .map(|(k, f)| {
                        let field = Field {
                            ty: sub(&f.ty),
                            ..f.clone()
                        };
                        (k.clone(), field)
                    })
                    .collect(),
            ),
            other => other.clone(),
        }
    }
}

impl fmt::Display for Ty {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let join = |f: &mut fmt::Formatter<'_>, items: &[Ty], sep: &str| {
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    f.write_str(sep)?;
                }
                write!(f, "{item}")?;
            }
            Ok(())
        };
        match self {
            Ty::Any => f.write_str("unknown"),
            Ty::Never => f.write_str("never"),
            Ty::String => f.write_str("string"),
            Ty::Number => f.write_str("number"),
            Ty::Boolean => f.write_str("boolean"),
            Ty::Null => f.write_str("null"),
            Ty::Literal(json) => f.write_str(json),
            Ty::Array(t) => write!(f, "Array<{t}>"),
            Ty::Map(t) => write!(f, "{{ [key: string]: {t} }}"),
            Ty::Tuple(items) => {
                f.write_str("[")?;
                join(f, items, ", ")?;
                f.write_str("]")
            }
            Ty::Object(fields) => {
                f.write_str("{ ")?;
                for (key, field) in fields {
                    let opt = if field.optional { "?" } else { "" };
                    write!(f, "{key}{opt}: {}, ", field.ty)?;
                }
                f.write_str("}")
            }
            Ty::Union(items) => join(f, items, " | "),
            Ty::Intersection(items) => join(f, items, " & "),
            Ty::Ref(name, args) if args.is_empty() => f.write_str(name),
            Ty::Ref(name, args) => {
                write!(f, "{name}<")?;
                join(f, args, ", ")?;
                f.write_str(">")
            }
        }
    }
}

/// A parsed `type Name<P...> = body;` declaration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decl {
    pub name: String,
    pub params: Vec<String>,
    pub body: Ty,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError(pub String);

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Parses a type expression such as `Array<Item> | null`.
pub fn parse_type(src: &str) -> Result<Ty, ParseError> {
    let mut p = Parser::new(src)?;
    let ty = p.ty()?;
    p.expect_end()?;
    Ok(ty)
}

/// Parses a declaration as ts-rs writes it, `type Name<T> = ...;`, optionally `export`ed.
pub fn parse_decl(src: &str) -> Result<Decl, ParseError> {
    let mut p = Parser::new(src)?;
    if p.peek_ident("export") {
        p.next();
    }
    p.keyword("type")?;
    let name = p.ident()?;
    let mut params = Vec::new();
    if p.eat(&Tok::Punct('<')) {
        loop {
            params.push(p.ident()?);
            if !p.eat(&Tok::Punct(',')) {
                break;
            }
        }
        p.punct('>')?;
    }
    p.punct('=')?;
    let body = p.ty()?;
    p.eat(&Tok::Punct(';'));
    p.expect_end()?;
    Ok(Decl { name, params, body })
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Ident(String),
    Str(String),
    Num(String),
    Punct(char),
}

struct Parser {
    toks: Vec<Tok>,
    pos: usize,
}

impl Parser {
    fn new(src: &str) -> Result<Parser, ParseError> {
        Ok(Parser {
            toks: tokenize(src)?,
            pos: 0,
        })
    }

    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos)
    }

    fn peek_ident(&self, word: &str) -> bool {
        matches!(self.peek(), Some(Tok::Ident(w)) if w == word)
    }

    fn next(&mut self) -> Option<Tok> {
        let tok = self.toks.get(self.pos).cloned();
        self.pos += 1;
        tok
    }

    fn eat(&mut self, tok: &Tok) -> bool {
        if self.peek() == Some(tok) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn err<T>(&self, what: &str) -> Result<T, ParseError> {
        Err(ParseError(format!(
            "expected {what} at token {} ({:?})",
            self.pos,
            self.peek()
        )))
    }

    fn punct(&mut self, c: char) -> Result<(), ParseError> {
        if self.eat(&Tok::Punct(c)) {
            Ok(())
        } else {
            self.err(&format!("`{c}`"))
        }
    }

    fn keyword(&mut self, word: &str) -> Result<(), ParseError> {
        if self.peek_ident(word) {
            self.pos += 1;
            Ok(())
        } else {
            self.err(&format!("`{word}`"))
        }
    }

    fn ident(&mut self) -> Result<String, ParseError> {
        match self.next() {
            Some(Tok::Ident(name)) => Ok(name),
            _ => {
                self.pos -= 1;
                self.err("an identifier")
            }
        }
    }

    fn expect_end(&self) -> Result<(), ParseError> {
        if self.pos == self.toks.len() {
            Ok(())
        } else {
            self.err("end of input")
        }
    }

    fn ty(&mut self) -> Result<Ty, ParseError> {
        self.eat(&Tok::Punct('|'));
        let mut members = vec![self.intersection()?];
        while self.eat(&Tok::Punct('|')) {
            members.push(self.intersection()?);
        }
        Ok(if members.len() == 1 {
            members.pop().expect("one member")
        } else {
            Ty::union(members)
        })
    }

    fn intersection(&mut self) -> Result<Ty, ParseError> {
        let mut parts = vec![self.postfix()?];
        while self.eat(&Tok::Punct('&')) {
            parts.push(self.postfix()?);
        }
        Ok(if parts.len() == 1 {
            parts.pop().expect("one part")
        } else {
            Ty::Intersection(parts)
        })
    }

    fn postfix(&mut self) -> Result<Ty, ParseError> {
        let mut ty = self.primary()?;
        while self.toks.get(self.pos) == Some(&Tok::Punct('['))
            && self.toks.get(self.pos + 1) == Some(&Tok::Punct(']'))
        {
            self.pos += 2;
            ty = Ty::Array(Box::new(ty));
        }
        Ok(ty)
    }

    fn primary(&mut self) -> Result<Ty, ParseError> {
        match self.next() {
            Some(Tok::Punct('(')) => {
                let ty = self.ty()?;
                self.punct(')')?;
                Ok(ty)
            }
            Some(Tok::Punct('{')) => self.object(),
            Some(Tok::Punct('[')) => {
                let mut items = Vec::new();
                while !self.eat(&Tok::Punct(']')) {
                    items.push(self.ty()?);
                    if !self.eat(&Tok::Punct(',')) {
                        self.punct(']')?;
                        break;
                    }
                }
                Ok(Ty::Tuple(items))
            }
            Some(Tok::Str(s)) => Ok(Ty::literal(&Value::String(s))),
            Some(Tok::Num(n)) => {
                let value: Value = serde_json::from_str(&n)
                    .map_err(|_| ParseError(format!("bad number literal {n}")))?;
                Ok(Ty::literal(&value))
            }
            Some(Tok::Punct('-')) => match self.next() {
                Some(Tok::Num(n)) => {
                    let value: Value = serde_json::from_str(&format!("-{n}"))
                        .map_err(|_| ParseError(format!("bad number literal -{n}")))?;
                    Ok(Ty::literal(&value))
                }
                _ => self.err("a number"),
            },
            Some(Tok::Ident(name)) => {
                let mut args = Vec::new();
                if self.eat(&Tok::Punct('<')) {
                    loop {
                        args.push(self.ty()?);
                        if !self.eat(&Tok::Punct(',')) {
                            break;
                        }
                    }
                    self.punct('>')?;
                }
                Ok(named(name, args))
            }
            _ => {
                self.pos -= 1;
                self.err("a type")
            }
        }
    }

    fn object(&mut self) -> Result<Ty, ParseError> {
        let mut fields = BTreeMap::new();
        let mut map: Option<Ty> = None;
        while !self.eat(&Tok::Punct('}')) {
            if self.eat(&Tok::Punct('[')) {
                // `[key in K]?: V` or `[key: K]: V`
                self.ident()?;
                if self.peek_ident("in") {
                    self.next();
                } else {
                    self.punct(':')?;
                }
                self.ty()?;
                self.punct(']')?;
                self.eat(&Tok::Punct('?'));
                self.punct(':')?;
                map = Some(self.ty()?);
            } else {
                let key = match self.next() {
                    Some(Tok::Ident(k) | Tok::Str(k)) => k,
                    _ => {
                        self.pos -= 1;
                        return self.err("a property name");
                    }
                };
                let optional = self.eat(&Tok::Punct('?'));
                self.punct(':')?;
                let ty = self.ty()?;
                fields.insert(
                    key,
                    Field {
                        ty,
                        optional,
                        has_default: false,
                    },
                );
            }
            if !self.eat(&Tok::Punct(',')) && !self.eat(&Tok::Punct(';')) {
                self.punct('}')?;
                break;
            }
        }
        match map {
            Some(value) if fields.is_empty() => Ok(Ty::Map(Box::new(value))),
            Some(_) => Err(ParseError(
                "objects mixing properties and an index signature are not supported".into(),
            )),
            None => Ok(Ty::Object(fields)),
        }
    }
}

fn named(name: String, mut args: Vec<Ty>) -> Ty {
    match (name.as_str(), args.len()) {
        ("string", 0) => Ty::String,
        ("number" | "bigint", 0) => Ty::Number,
        ("boolean", 0) => Ty::Boolean,
        ("null", 0) => Ty::Null,
        ("true", 0) => Ty::literal(&Value::Bool(true)),
        ("false", 0) => Ty::literal(&Value::Bool(false)),
        ("never", 0) => Ty::Never,
        ("unknown" | "any", 0) => Ty::Any,
        ("Array", 1) => Ty::Array(Box::new(args.pop().expect("one argument"))),
        ("Record", 2) => Ty::Map(Box::new(args.pop().expect("two arguments"))),
        _ => Ty::Ref(name, args),
    }
}

fn tokenize(src: &str) -> Result<Vec<Tok>, ParseError> {
    let chars: Vec<char> = src.chars().collect();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            let end = (i + 2..chars.len().saturating_sub(1))
                .find(|&j| chars[j] == '*' && chars[j + 1] == '/')
                .ok_or_else(|| ParseError("unterminated comment".into()))?;
            i = end + 2;
        } else if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '"' {
            let start = i;
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                i += if chars[i] == '\\' { 2 } else { 1 };
            }
            let text: String = chars[start..=i.min(chars.len() - 1)].iter().collect();
            let s: String = serde_json::from_str(&text)
                .map_err(|_| ParseError(format!("bad string literal {text}")))?;
            toks.push(Tok::Str(s));
            i += 1;
        } else if c.is_ascii_digit() {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '.') {
                i += 1;
            }
            toks.push(Tok::Num(chars[start..i].iter().collect()));
        } else if c.is_alphabetic() || c == '_' || c == '$' {
            let start = i;
            while i < chars.len()
                && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '$')
            {
                i += 1;
            }
            toks.push(Tok::Ident(chars[start..i].iter().collect()));
        } else if "{}[]()<>|&,:;?=-".contains(c) {
            toks.push(Tok::Punct(c));
            i += 1;
        } else {
            return Err(ParseError(format!("unexpected character {c:?}")));
        }
    }
    Ok(toks)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(ty: Ty, optional: bool) -> Field {
        Field {
            ty,
            optional,
            has_default: false,
        }
    }

    #[test]
    fn parses_ts_rs_shapes() {
        assert_eq!(
            parse_type("Array<Item> | null").unwrap(),
            Ty::union([
                Ty::Array(Box::new(Ty::Ref("Item".into(), vec![]))),
                Ty::Null
            ])
        );
        assert_eq!(
            parse_type("{ [key in string]?: number }").unwrap(),
            Ty::Map(Box::new(Ty::Number))
        );
        let decl = parse_decl(
            "type Page<T> = { /** The rows. */ items: Array<T>, \"next-cursor\"?: string, };",
        )
        .unwrap();
        assert_eq!(decl.name, "Page");
        assert_eq!(decl.params, ["T"]);
        assert_eq!(
            decl.body,
            Ty::Object(BTreeMap::from([
                (
                    "items".to_owned(),
                    field(Ty::Array(Box::new(Ty::Ref("T".into(), vec![]))), false)
                ),
                ("next-cursor".to_owned(), field(Ty::String, true)),
            ]))
        );
        assert_eq!(
            parse_type("[string, number]").unwrap(),
            Ty::Tuple(vec![Ty::String, Ty::Number])
        );
        assert_eq!(
            parse_type("{ \"kind\": \"A\" } & B").unwrap(),
            Ty::Intersection(vec![
                Ty::Object(BTreeMap::from([(
                    "kind".to_owned(),
                    field(Ty::literal(&Value::from("A")), false)
                )])),
                Ty::Ref("B".into(), vec![]),
            ])
        );
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_type("{ a: }").is_err());
        assert!(parse_type("string string").is_err());
        assert!(parse_decl("interface X {}").is_err());
    }
}
