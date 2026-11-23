//! The filter (Mightyconsole spec §5.4): one filter for tail and search, evaluated on the server
//! after decoding so only matches cross the wire. Every part present must match (AND).
//!
//! - `key`, header values: a [`TextMatch`] (equals, contains, prefix, regex; regexes use the
//!   `regex` crate, linear time).
//! - `subject`: a NATS wildcard pattern (`*`, `>`).
//! - `headers`: each named header must exist, and match when a match is given.
//! - `text`: a case-insensitive substring of the decoded payload.
//! - `time`, `position`: inclusive ranges (RFC 3339; offset or sequence as decimal strings).
//! - `jq`: a jq program run by jaq on `{ key, value, headers, subject, source, partition, offset,
//!   sequence, timestamp }`. It matches when it yields at least one value that is neither
//!   `false` nor `null`; a program that fails on a message is no match, reported as an error.
//!
//! jq programs are compiled by [`crate::jq`], which refuses the builtins that reach outside the
//! value (spec §5.4.1). They run to completion: one that never ends (`[range(1e18)]`) stalls its
//! stream until the stream is stopped (spec Open questions 35 and 65 (f)).

use std::ops::ControlFlow;

use jaq_json::Val;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::jq::JqProgram;
use crate::message::Header;
use crate::schema::subject_matches;

/// How a text is matched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum MatchOp {
    Equals,
    Contains,
    Prefix,
    Regex,
}

/// A text match (spec §5.4, `TextMatch`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct TextMatch {
    pub op: MatchOp,
    pub value: String,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub case_sensitive: Option<bool>,
}

/// A header that must be present, and match when `match` is given.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct HeaderFilter {
    pub name: String,
    #[serde(default, rename = "match")]
    #[cfg_attr(feature = "codegen", ts(optional = nullable, rename = "match"))]
    pub matches: Option<TextMatch>,
}

/// An inclusive range of RFC 3339 times.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct TimeRange {
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub from: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub to: Option<String>,
}

/// An inclusive range of offsets or sequences, as decimal strings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct PositionRange {
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub from: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub to: Option<String>,
}

/// The filter (spec §5.4).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub key: Option<TextMatch>,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub subject: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub headers: Option<Vec<HeaderFilter>>,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub text: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub time: Option<TimeRange>,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub position: Option<PositionRange>,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub jq: Option<String>,
}

impl Filter {
    /// Whether the filter has no part (every message matches).
    pub fn is_empty(&self) -> bool {
        self.key.is_none()
            && self.subject.as_deref().is_none_or(str::is_empty)
            && self.headers.as_ref().is_none_or(Vec::is_empty)
            && self.text.as_deref().is_none_or(str::is_empty)
            && self
                .time
                .as_ref()
                .is_none_or(|t| t.from.is_none() && t.to.is_none())
            && self
                .position
                .as_ref()
                .is_none_or(|p| p.from.is_none() && p.to.is_none())
            && self.jq.as_deref().is_none_or(|j| j.trim().is_empty())
    }
}

/// A problem with one part of a filter (`messaging.filter.check`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct FilterIssue {
    /// `key`, `subject`, `headers.0`, `text`, `time.from`, `position.to`, `jq`.
    pub part: String,
    pub message: String,
    /// In the jq program, 1-based.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub column: Option<u32>,
}

impl FilterIssue {
    pub(crate) fn new(part: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            part: part.into(),
            message: message.into(),
            line: None,
            column: None,
        }
    }
}

/// What the filter reads of one decoded message.
#[derive(Debug, Clone, Copy)]
pub struct FilterInput<'a> {
    pub source: &'a str,
    pub subject: Option<&'a str>,
    pub partition: Option<i32>,
    pub offset: Option<i64>,
    pub sequence: Option<u64>,
    pub timestamp_us: i64,
    pub headers: Option<&'a [Header]>,
    /// The decoded key text.
    pub key: Option<&'a str>,
    /// The decoded payload text (for `text`).
    pub text: Option<&'a str>,
    /// The decoded payload as JSON (a string for text codecs), for jq.
    pub value: &'a serde_json::Value,
}

/// The outcome for one message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Match,
    NoMatch,
    /// The jq program failed on this message (counted as a decode error, not a match).
    JqError(String),
}

#[derive(Debug, Clone)]
enum Text {
    Equals(String, bool),
    Contains(String, bool),
    Prefix(String, bool),
    Regex(Regex),
}

impl Text {
    fn compile(m: &TextMatch) -> Result<Self, String> {
        let cs = m.case_sensitive.unwrap_or(true);
        let v = if cs {
            m.value.clone()
        } else {
            m.value.to_lowercase()
        };
        Ok(match m.op {
            MatchOp::Equals => Text::Equals(v, cs),
            MatchOp::Contains => Text::Contains(v, cs),
            MatchOp::Prefix => Text::Prefix(v, cs),
            MatchOp::Regex => Text::Regex(
                RegexBuilder::new(&m.value)
                    .case_insensitive(!cs)
                    .size_limit(1 << 20)
                    .build()
                    .map_err(|e| format!("not a valid regex: {e}"))?,
            ),
        })
    }

    fn matches(&self, s: &str) -> bool {
        let fold = |cs: bool| {
            if cs {
                std::borrow::Cow::Borrowed(s)
            } else {
                std::borrow::Cow::Owned(s.to_lowercase())
            }
        };
        match self {
            Text::Equals(v, cs) => fold(*cs) == v.as_str(),
            Text::Contains(v, cs) => fold(*cs).contains(v.as_str()),
            Text::Prefix(v, cs) => fold(*cs).starts_with(v.as_str()),
            Text::Regex(r) => r.is_match(s),
        }
    }
}

/// A compiled filter.
#[derive(Debug)]
pub struct CompiledFilter {
    key: Option<Text>,
    subject: Option<String>,
    headers: Vec<(String, Option<Text>)>,
    text: Option<String>,
    time: (Option<i64>, Option<i64>),
    position: (Option<i128>, Option<i128>),
    jq: Option<JqProgram>,
}

impl CompiledFilter {
    /// Compiles a filter, or lists every part that is wrong.
    pub fn compile(filter: &Filter) -> Result<Self, Vec<FilterIssue>> {
        let mut issues = Vec::new();
        let key = filter.key.as_ref().and_then(|m| {
            Text::compile(m)
                .map_err(|e| issues.push(FilterIssue::new("key", e)))
                .ok()
        });
        let mut headers = Vec::new();
        for (i, h) in filter.headers.iter().flatten().enumerate() {
            if h.name.is_empty() {
                issues.push(FilterIssue::new(
                    format!("headers.{i}"),
                    "a header filter needs a name",
                ));
                continue;
            }
            match h.matches.as_ref().map(Text::compile).transpose() {
                Ok(m) => headers.push((h.name.clone(), m)),
                Err(e) => issues.push(FilterIssue::new(format!("headers.{i}"), e)),
            }
        }
        let subject = filter.subject.clone().filter(|s| !s.is_empty());
        if let Some(s) = &subject
            && let Err(e) = check_subject_pattern(s)
        {
            issues.push(FilterIssue::new("subject", e));
        }
        let mut time = (None, None);
        if let Some(t) = &filter.time {
            time.0 = parse_time(t.from.as_deref(), "time.from", &mut issues);
            time.1 = parse_time(t.to.as_deref(), "time.to", &mut issues);
        }
        let mut position = (None, None);
        if let Some(p) = &filter.position {
            position.0 = parse_position(p.from.as_deref(), "position.from", &mut issues);
            position.1 = parse_position(p.to.as_deref(), "position.to", &mut issues);
        }
        let jq = match filter
            .jq
            .as_deref()
            .map(str::trim)
            .filter(|j| !j.is_empty())
        {
            None => None,
            Some(code) => match JqProgram::compile(code) {
                Ok(program) => Some(program),
                Err(mut e) => {
                    issues.append(&mut e);
                    None
                }
            },
        };
        if issues.is_empty() {
            Ok(Self {
                key,
                subject,
                headers,
                text: filter
                    .text
                    .clone()
                    .filter(|t| !t.is_empty())
                    .map(|t| t.to_lowercase()),
                time,
                position,
                jq,
            })
        } else {
            Err(issues)
        }
    }

    /// Whether the filter reads the decoded payload (so the decode cannot be skipped).
    pub fn needs_value(&self) -> bool {
        self.text.is_some() || self.jq.is_some()
    }

    /// Evaluates the filter on one message; the cheap parts first, jq last.
    pub fn evaluate(&self, m: &FilterInput<'_>) -> Outcome {
        if let Some(k) = &self.key
            && !m.key.is_some_and(|key| k.matches(key))
        {
            return Outcome::NoMatch;
        }
        if let Some(p) = &self.subject
            && !m.subject.is_some_and(|s| subject_matches(p, s))
        {
            return Outcome::NoMatch;
        }
        for (name, matcher) in &self.headers {
            let values = m
                .headers
                .into_iter()
                .flatten()
                .filter(|h| h.name.eq_ignore_ascii_case(name));
            let ok = match matcher {
                None => values.count() > 0,
                Some(t) => values
                    .into_iter()
                    .any(|h| h.text().is_some_and(|v| t.matches(v))),
            };
            if !ok {
                return Outcome::NoMatch;
            }
        }
        if self.time.0.is_some_and(|from| m.timestamp_us < from)
            || self.time.1.is_some_and(|to| m.timestamp_us > to)
        {
            return Outcome::NoMatch;
        }
        if self.position.0.is_some() || self.position.1.is_some() {
            let Some(pos) = m.offset.map(i128::from).or(m.sequence.map(i128::from)) else {
                return Outcome::NoMatch;
            };
            if self.position.0.is_some_and(|f| pos < f) || self.position.1.is_some_and(|t| pos > t)
            {
                return Outcome::NoMatch;
            }
        }
        if let Some(t) = &self.text
            && !m
                .text
                .is_some_and(|s| s.to_lowercase().contains(t.as_str()))
        {
            return Outcome::NoMatch;
        }
        if let Some(jq) = &self.jq {
            return run_jq(jq, m);
        }
        Outcome::Match
    }
}

/// Checks a filter (`messaging.filter.check`).
pub fn check(filter: &Filter) -> Vec<FilterIssue> {
    CompiledFilter::compile(filter).err().unwrap_or_default()
}

fn check_subject_pattern(p: &str) -> Result<(), String> {
    let tokens: Vec<&str> = p.split('.').collect();
    for (i, t) in tokens.iter().enumerate() {
        if t.is_empty() {
            return Err(
                "a subject pattern has no empty token (no leading, trailing or double dot)".into(),
            );
        }
        if *t == ">" && i + 1 != tokens.len() {
            return Err("> may only be the last token".into());
        }
        if t.len() > 1 && (t.contains('*') || t.contains('>')) {
            return Err(format!("{t}: wildcards stand alone as a token"));
        }
        if t.chars().any(char::is_whitespace) {
            return Err("a subject has no spaces".into());
        }
    }
    Ok(())
}

fn parse_time(s: Option<&str>, part: &str, issues: &mut Vec<FilterIssue>) -> Option<i64> {
    let s = s.map(str::trim).filter(|s| !s.is_empty())?;
    match OffsetDateTime::parse(s, &Rfc3339) {
        Ok(t) => Some((t.unix_timestamp_nanos() / 1_000) as i64),
        Err(e) => {
            issues.push(FilterIssue::new(
                part,
                format!("{s} is not an RFC 3339 time: {e}"),
            ));
            None
        }
    }
}

fn parse_position(s: Option<&str>, part: &str, issues: &mut Vec<FilterIssue>) -> Option<i128> {
    let s = s.map(str::trim).filter(|s| !s.is_empty())?;
    match s.parse::<i128>() {
        Ok(v) => Some(v),
        Err(_) => {
            issues.push(FilterIssue::new(
                part,
                format!("{s} is not an offset or sequence (a whole number)"),
            ));
            None
        }
    }
}

/// The object a jq program reads: headers as `{ name: value }`, a repeated name as an array of
/// its values, binary values as base64.
fn jq_input(m: &FilterInput<'_>) -> serde_json::Value {
    use base64::Engine as _;
    let mut headers = serde_json::Map::new();
    for h in m.headers.into_iter().flatten() {
        let v = serde_json::Value::String(match h.text() {
            Some(t) => t.to_owned(),
            None => base64::engine::general_purpose::STANDARD.encode(&h.value),
        });
        match headers.get_mut(&h.name) {
            None => {
                headers.insert(h.name.clone(), v);
            }
            Some(serde_json::Value::Array(a)) => a.push(v),
            Some(prev) => {
                let first = prev.take();
                *prev = serde_json::Value::Array(vec![first, v]);
            }
        }
    }
    let timestamp = OffsetDateTime::from_unix_timestamp_nanos(i128::from(m.timestamp_us) * 1_000)
        .ok()
        .and_then(|t| t.format(&Rfc3339).ok());
    serde_json::json!({
        "key": m.key,
        "value": m.value,
        "headers": headers,
        "subject": m.subject,
        "source": m.source,
        "partition": m.partition,
        "offset": m.offset.map(|o| o.to_string()),
        "sequence": m.sequence.map(|s| s.to_string()),
        "timestamp": timestamp,
    })
}

fn run_jq(program: &JqProgram, m: &FilterInput<'_>) -> Outcome {
    let input: Val = match serde::Deserialize::deserialize(jq_input(m)) {
        Ok(v) => v,
        Err(e) => return Outcome::JqError(format!("jq input: {e}")),
    };
    let mut matched = false;
    let run = program.run(input, |v| {
        if matches!(v, Val::Null | Val::Bool(false)) {
            ControlFlow::Continue(())
        } else {
            matched = true;
            ControlFlow::Break(())
        }
    });
    match run {
        Err(e) => Outcome::JqError(e),
        Ok(()) if matched => Outcome::Match,
        Ok(()) => Outcome::NoMatch,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tm(op: MatchOp, v: &str, cs: Option<bool>) -> TextMatch {
        TextMatch {
            op,
            value: v.into(),
            case_sensitive: cs,
        }
    }

    fn msg<'a>(value: &'a serde_json::Value, headers: &'a [Header]) -> FilterInput<'a> {
        FilterInput {
            source: "orders",
            subject: Some("orders.eu.created"),
            partition: Some(2),
            offset: Some(41),
            sequence: None,
            timestamp_us: 1_794_960_000_000_000, // 2026-11-18T00:00:00Z
            headers: Some(headers),
            key: Some("Order-17"),
            text: Some(r#"{"status":"PAID","total":12}"#),
            value,
        }
    }

    #[test]
    fn each_part() {
        let v = json!({"status": "PAID", "total": 12});
        let h = [
            Header::new("trace-id", "abc"),
            Header::new("tag", "a"),
            Header::new("tag", "b"),
            Header::new("bin", vec![0xff]),
        ];
        let m = msg(&v, &h);
        let ok = |f: Filter| CompiledFilter::compile(&f).unwrap().evaluate(&m);
        let f = Filter::default();
        assert!(f.is_empty());
        assert_eq!(ok(f), Outcome::Match);
        assert_eq!(
            ok(Filter {
                key: Some(tm(MatchOp::Prefix, "order-", Some(false))),
                ..Filter::default()
            }),
            Outcome::Match
        );
        assert_eq!(
            ok(Filter {
                key: Some(tm(MatchOp::Prefix, "order-", None)),
                ..Filter::default()
            }),
            Outcome::NoMatch
        );
        assert_eq!(
            ok(Filter {
                key: Some(tm(MatchOp::Regex, r"^Order-\d+$", None)),
                ..Filter::default()
            }),
            Outcome::Match
        );
        assert_eq!(
            ok(Filter {
                key: Some(tm(MatchOp::Equals, "Order-17", None)),
                ..Filter::default()
            }),
            Outcome::Match
        );
        assert_eq!(
            ok(Filter {
                subject: Some("orders.*.created".into()),
                ..Filter::default()
            }),
            Outcome::Match
        );
        assert_eq!(
            ok(Filter {
                subject: Some("orders.us.>".into()),
                ..Filter::default()
            }),
            Outcome::NoMatch
        );
        let hf = |name: &str, m: Option<TextMatch>| Filter {
            headers: Some(vec![HeaderFilter {
                name: name.into(),
                matches: m,
            }]),
            ..Filter::default()
        };
        assert_eq!(ok(hf("Trace-Id", None)), Outcome::Match);
        assert_eq!(ok(hf("missing", None)), Outcome::NoMatch);
        assert_eq!(
            ok(hf("tag", Some(tm(MatchOp::Equals, "b", None)))),
            Outcome::Match
        );
        assert_eq!(
            ok(hf("tag", Some(tm(MatchOp::Equals, "c", None)))),
            Outcome::NoMatch
        );
        assert_eq!(
            ok(Filter {
                text: Some("paid".into()),
                ..Filter::default()
            }),
            Outcome::Match
        );
        assert_eq!(
            ok(Filter {
                text: Some("shipped".into()),
                ..Filter::default()
            }),
            Outcome::NoMatch
        );
        let time = |from: Option<&str>, to: Option<&str>| Filter {
            time: Some(TimeRange {
                from: from.map(Into::into),
                to: to.map(Into::into),
            }),
            ..Filter::default()
        };
        assert_eq!(
            ok(time(
                Some("2026-11-17T23:00:00Z"),
                Some("2026-11-18T00:00:00Z")
            )),
            Outcome::Match
        );
        assert_eq!(
            ok(time(Some("2026-11-18T00:00:01+00:00"), None)),
            Outcome::NoMatch
        );
        let pos = |from: Option<&str>, to: Option<&str>| Filter {
            position: Some(PositionRange {
                from: from.map(Into::into),
                to: to.map(Into::into),
            }),
            ..Filter::default()
        };
        assert_eq!(ok(pos(Some("41"), Some("41"))), Outcome::Match);
        assert_eq!(ok(pos(Some("42"), None)), Outcome::NoMatch);
        // AND of every part.
        assert_eq!(
            ok(Filter {
                text: Some("paid".into()),
                subject: Some("orders.us.created".into()),
                ..Filter::default()
            }),
            Outcome::NoMatch
        );
    }

    #[test]
    fn jq_programs() {
        let v = json!({"status": "PAID", "total": 12, "items": [{"sku": "a"}]});
        let h = [Header::new("tag", "a"), Header::new("tag", "b")];
        let m = msg(&v, &h);
        let jq = |code: &str| {
            CompiledFilter::compile(&Filter {
                jq: Some(code.into()),
                ..Filter::default()
            })
            .unwrap()
            .evaluate(&m)
        };
        assert_eq!(jq(".value.total > 10"), Outcome::Match);
        assert_eq!(jq(".value.total > 100"), Outcome::NoMatch);
        assert_eq!(jq(".value.items[] | select(.sku == \"a\")"), Outcome::Match);
        assert_eq!(jq(".headers.tag | length == 2"), Outcome::Match);
        assert_eq!(
            jq(".partition == 2 and .offset == \"41\" and .key == \"Order-17\""),
            Outcome::Match
        );
        assert_eq!(
            jq(".timestamp | startswith(\"2026-11-18\")"),
            Outcome::Match
        );
        assert_eq!(jq("empty"), Outcome::NoMatch);
        assert_eq!(jq("null, false"), Outcome::NoMatch);
        assert_eq!(jq("false, 1"), Outcome::Match);
        assert!(matches!(
            jq(".value.status | tonumber"),
            Outcome::JqError(_)
        ));
        assert!(matches!(jq("error(\"no\")"), Outcome::JqError(_)));
    }

    #[test]
    fn the_filter_refuses_what_a_query_refuses() {
        // One compiler for the filter and the query (spec §5.4.1): `halt` would end the server,
        // `env` would leak its environment through matches.
        for code in [
            "env.HOME != null",
            "halt",
            "$ENV | length > 0",
            "debug",
            "input",
        ] {
            let issues = check(&Filter {
                jq: Some(code.into()),
                ..Filter::default()
            });
            assert_eq!(issues.len(), 1, "{code}: {issues:?}");
            assert!(
                issues[0].message.contains("is not available"),
                "{code}: {issues:?}"
            );
        }
    }

    #[test]
    fn compiled_filters_can_cross_threads() {
        fn send_sync<T: Send + Sync>() {}
        send_sync::<CompiledFilter>();
    }

    #[test]
    fn issues_carry_parts_and_positions() {
        let issues = check(&Filter {
            key: Some(tm(MatchOp::Regex, "(", None)),
            subject: Some("orders.>.x".into()),
            headers: Some(vec![HeaderFilter {
                name: String::new(),
                matches: None,
            }]),
            time: Some(TimeRange {
                from: Some("yesterday".into()),
                to: None,
            }),
            position: Some(PositionRange {
                from: None,
                to: Some("1.5".into()),
            }),
            jq: Some(".value |\n  select(.a ==)".into()),
            ..Filter::default()
        });
        let parts: Vec<&str> = issues.iter().map(|i| i.part.as_str()).collect();
        assert_eq!(
            parts,
            [
                "key",
                "headers.0",
                "subject",
                "time.from",
                "position.to",
                "jq"
            ],
            "{issues:?}"
        );
        let jq = issues.last().unwrap();
        assert_eq!(jq.line, Some(2), "{jq:?}");
        let undefined = check(&Filter {
            jq: Some(".a | nosuchfn".into()),
            ..Filter::default()
        });
        assert_eq!(undefined[0].column, Some(6), "{undefined:?}");
        assert!(undefined[0].message.contains("nosuchfn"));
        assert!(
            check(&Filter {
                jq: Some(".a | map(. + 1) | length".into()),
                ..Filter::default()
            })
            .is_empty()
        );
    }
}
