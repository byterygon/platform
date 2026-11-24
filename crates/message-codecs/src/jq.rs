//! jq programs, compiled once for the filter (spec §5.4) and for a query on one value (§5.4.1).
//!
//! jaq (`jaq-core`, `jaq-std`, `jaq-json`) with the builtins that reach outside the value
//! removed, so a program means the same wherever it runs: [`REFUSED`] lists them with the reason
//! the compiler gives. Running a program never ends the process: `halt` is refused, and
//! [`JqProgram::run`] turns any halt into an error instead of calling `std::process::exit` as
//! `jaq_core::unwrap_valr` does.
//!
//! What this module cannot stop on its own: a program that never ends (`def f: f; f`), one that
//! overflows the stack (`def f: 1 + f; f` aborts the process) or one that grows without bound.
//! A query on a value therefore runs in a child process with a deadline and limits (the server's
//! `jq-worker`, spec §5.4.1, [`serve_worker`]), and so does the filter's program: one long-lived
//! worker per stream that evaluates the stream's messages in order ([`serve_filter_worker`], spec
//! §5.4, TSK-143).

use std::fmt;
use std::io::{self, BufRead, Read, Write};
use std::ops::ControlFlow;

use jaq_core::load::{Arena, File, Loader};
use jaq_core::{Ctx, Vars, data};
use jaq_json::Val;

use crate::error::Position;
use crate::filter::{FilterIssue, Outcome, jq_outcome};

/// Builtins a program may not use, with the reason the compiler gives. Read from `jaq-core`
/// 3.1.2, `jaq-std` 3.0.4 and `jaq-json` 2.0.3 (TSK-113): these are the ones that read or write
/// outside the value, or end the process.
pub const REFUSED: &[(&str, &str)] = &[
    ("env", "a query cannot read the server's environment"),
    ("$ENV", "a query cannot read the server's environment"),
    ("input", "a query reads only the value it is given"),
    ("inputs", "a query reads only the value it is given"),
    ("debug", "a query cannot write to the server's log"),
    ("stderr", "a query cannot write to the server's log"),
    ("debug_empty", "a query cannot write to the server's log"),
    ("stderr_empty", "a query cannot write to the server's log"),
    ("halt", "a query cannot stop the server"),
    ("halt_error", "a query cannot stop the server"),
    (
        "localtime",
        "it reads the server's time zone; use gmtime, which works in UTC",
    ),
    (
        "strflocaltime",
        "it reads the server's time zone; use strftime, which works in UTC",
    ),
];

/// Why `include` and `import` fail.
const MODULES: &str = "include and import are not available: a query cannot read files";

/// The refused builtin `name` names (a filter, or a variable with or without its `$`).
fn refused(name: &str) -> Option<(&'static str, &'static str)> {
    REFUSED
        .iter()
        .find(|(n, _)| *n == name || n.strip_prefix('$') == Some(name))
        .copied()
}

type JqFilter = jaq_core::compile::Filter<jaq_core::Native<data::JustLut<Val>>>;

/// A compiled jq program.
pub struct JqProgram {
    filter: JqFilter,
}

impl fmt::Debug for JqProgram {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JqProgram")
    }
}

impl JqProgram {
    /// Compiles a program; errors name the part `jq` with the line and column.
    pub fn compile(code: &str) -> Result<Self, Vec<FilterIssue>> {
        compile(code).map(|filter| Self { filter })
    }

    /// Runs the program on one value and hands each output to `each`, which may stop the run.
    /// An error (a jq error, or a halt) ends the run with its message.
    pub fn run(
        &self,
        input: Val,
        mut each: impl FnMut(Val) -> ControlFlow<()>,
    ) -> Result<(), String> {
        let ctx = Ctx::<data::JustLut<Val>>::new(&self.filter.lut, Vars::new([]));
        for out in self.filter.id.run((ctx, input)) {
            match out {
                Ok(v) => {
                    if each(v).is_break() {
                        return Ok(());
                    }
                }
                Err(exn) => {
                    return Err(match exn.get_err() {
                        Ok(e) => format!("jq: {e}"),
                        Err(_) => {
                            "jq: halt is not available: a query cannot stop the server".to_owned()
                        }
                    });
                }
            }
        }
        Ok(())
    }
}

/// One line the worker writes (spec §5.4.1): `R <json>` per result, `E <issues>` when the program
/// does not compile, `F <message>` when it fails, `S` when the next result would pass the
/// output cap, and `D` at the end of a run that was not stopped by the server.
///
/// The filter's worker ([`super::serve_filter_worker`]) writes `E <issues>` or `K` (compiled,
/// ready) first, then one line per message, in order: `M` (match), `N` (no match) or
/// `F <message>` (the program failed on it).
pub mod wire {
    pub const RESULT: &str = "R ";
    pub const ISSUES: &str = "E ";
    pub const FAILED: &str = "F ";
    pub const CUT: &str = "S";
    pub const DONE: &str = "D";
    pub const READY: &str = "K";
    pub const MATCH: &str = "M";
    pub const NO_MATCH: &str = "N";
}

/// The worker's side of a stream's filter (TSK-143): reads the program as a JSON string on the
/// first line of `input`, compiles it and answers `K` (or `E <issues>` and ends), then reads one
/// message per line (the object of [`crate::filter::jq_input_line`]) and answers each, in order,
/// with a [`wire`] line, until `input` ends. Every answer is flushed at once: the server times
/// each message from the previous answer, so an answer held in a buffer would be blamed on the
/// next message. A message is decided exactly as [`crate::filter::CompiledFilter::evaluate`]
/// decides it in process.
pub fn serve_filter_worker(input: impl Read, out: impl Write) -> io::Result<()> {
    let mut input = io::BufReader::with_capacity(256 * 1024, input);
    let mut out = io::BufWriter::with_capacity(4096, out);
    let mut line = Vec::new();
    let answer = |out: &mut io::BufWriter<_>, tag: &str, body: &str| -> io::Result<()> {
        out.write_all(tag.as_bytes())?;
        out.write_all(body.as_bytes())?;
        out.write_all(b"\n")?;
        out.flush()
    };
    if input.read_until(b'\n', &mut line)? == 0 {
        return Ok(());
    }
    let code: String = match serde_json::from_slice(trim_newline(&line)) {
        Ok(code) => code,
        Err(e) => {
            return answer(
                &mut out,
                wire::FAILED,
                &json_string(&format!("bad request: {e}")),
            );
        }
    };
    let program = match JqProgram::compile(code.trim()) {
        Ok(p) => p,
        Err(issues) => {
            let body = serde_json::to_string(&issues).unwrap_or_else(|_| "[]".into());
            return answer(&mut out, wire::ISSUES, &body);
        }
    };
    answer(&mut out, wire::READY, "")?;
    loop {
        line.clear();
        if input.read_until(b'\n', &mut line)? == 0 {
            return Ok(());
        }
        let outcome = match serde_json::from_slice::<Val>(trim_newline(&line)) {
            Ok(value) => jq_outcome(&program, value),
            Err(e) => Outcome::JqError(format!("jq input: {e}")),
        };
        match outcome {
            Outcome::Match => answer(&mut out, wire::MATCH, "")?,
            Outcome::NoMatch => answer(&mut out, wire::NO_MATCH, "")?,
            Outcome::JqError(message) => answer(
                &mut out,
                wire::FAILED,
                &json_string(&cut(&message, MAX_REASON_CHARS)),
            )?,
        }
    }
}

/// The longest error the filter's worker sends for a message, in characters. jq's errors quote
/// the value they failed on (`cannot index "<a 1 MiB string>" with "a"`), and the error is only
/// the reason a message counted as a decode error: the start of it says what went wrong.
pub const MAX_REASON_CHARS: usize = 500;

/// `text` cut to at most `max` characters, with an ellipsis when it was cut.
fn cut(text: &str, max: usize) -> std::borrow::Cow<'_, str> {
    match text.char_indices().nth(max) {
        None => text.into(),
        Some((end, _)) => format!("{}…", &text[..end]).into(),
    }
}

fn trim_newline(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\n").unwrap_or(line)
}

/// The worker's side of a query (the server's `jq-worker`): reads the program as a JSON string on
/// the first line of `input` and the value's JSON text after it, runs the program and writes
/// [`wire`] lines to `out`. Results are kept until their JSON text would pass `max_bytes`. The
/// first [`FLUSH_EACH`] results are flushed one by one, so the server keeps what arrived when it
/// stops a run at its deadline; after them, every [`FLUSH_EVERY`] or when the buffer fills, so a
/// program with a million small results is not a million writes.
pub fn serve_worker(input: impl Read, out: impl Write, max_bytes: usize) -> io::Result<()> {
    let mut out = io::BufWriter::with_capacity(64 * 1024, out);
    serve(input, &mut out, max_bytes)?;
    out.flush()
}

/// Results flushed one by one, then at most every [`FLUSH_EVERY`].
pub const FLUSH_EACH: usize = 1000;
pub const FLUSH_EVERY: std::time::Duration = std::time::Duration::from_millis(20);

fn serve(mut input: impl Read, mut out: impl Write, max_bytes: usize) -> io::Result<()> {
    let mut buf = Vec::new();
    input.read_to_end(&mut buf)?;
    let split = buf.iter().position(|b| *b == b'\n').unwrap_or(buf.len());
    let (head, value) = buf.split_at(split);
    let value = value.get(1..).unwrap_or_default();
    let line = |out: &mut dyn Write, tag: &str, body: &str| -> io::Result<()> {
        out.write_all(tag.as_bytes())?;
        out.write_all(body.as_bytes())?;
        out.write_all(b"\n")?;
        out.flush()
    };
    let code: String = match serde_json::from_slice(head) {
        Ok(code) => code,
        Err(e) => {
            return line(
                &mut out,
                wire::FAILED,
                &json_string(&format!("bad request: {e}")),
            );
        }
    };
    let program = match JqProgram::compile(code.trim()) {
        Ok(p) => p,
        Err(issues) => {
            let body = serde_json::to_string(&issues).unwrap_or_else(|_| "[]".into());
            return line(&mut out, wire::ISSUES, &body);
        }
    };
    let value = match jaq_json::read::parse_single(value) {
        Ok(v) => v,
        Err(e) => {
            return line(
                &mut out,
                wire::FAILED,
                &json_string(&format!("the value is not JSON: {e}")),
            );
        }
    };
    let mut bytes = 0usize;
    let mut count = 0usize;
    let mut flushed = std::time::Instant::now();
    let mut io_error = None;
    let mut result = |out: &mut dyn Write, text: &str| -> io::Result<()> {
        out.write_all(wire::RESULT.as_bytes())?;
        out.write_all(text.as_bytes())?;
        out.write_all(b"\n")?;
        count += 1;
        if count <= FLUSH_EACH || flushed.elapsed() >= FLUSH_EVERY {
            flushed = std::time::Instant::now();
            out.flush()?;
        }
        Ok(())
    };
    let run = program.run(value, |v| {
        let text = v.to_string();
        if bytes + text.len() > max_bytes {
            if let Err(e) = line(&mut out, wire::CUT, "") {
                io_error = Some(e);
            }
            return ControlFlow::Break(());
        }
        bytes += text.len();
        match result(&mut out, &text) {
            Ok(()) => ControlFlow::Continue(()),
            Err(e) => {
                io_error = Some(e);
                ControlFlow::Break(())
            }
        }
    });
    if let Some(e) = io_error {
        return Err(e);
    }
    if let Err(message) = run {
        line(&mut out, wire::FAILED, &json_string(&message))?;
    }
    line(&mut out, wire::DONE, "")
}

fn json_string(s: &str) -> String {
    serde_json::Value::String(s.to_owned()).to_string()
}

fn offset_in(code: &str, s: &str) -> Option<usize> {
    let base = code.as_ptr() as usize;
    let p = s.as_ptr() as usize;
    (p >= base && p <= base + code.len()).then(|| p - base)
}

fn issue(code: &str, span: &str, message: String) -> FilterIssue {
    let mut issue = FilterIssue::new("jq", message);
    if let Some(offset) = offset_in(code, span) {
        let p = Position::of_offset(code, offset);
        issue.line = Some(p.line);
        issue.column = Some(p.column);
    }
    issue
}

fn compile(code: &str) -> Result<JqFilter, Vec<FilterIssue>> {
    let defs = jaq_core::defs()
        .chain(jaq_std::defs())
        .chain(jaq_json::defs())
        .filter(|d| refused(d.name).is_none());
    let funs = jaq_core::funs()
        .chain(jaq_std::funs())
        .chain(jaq_json::funs())
        .filter(|f| refused(f.0).is_none());
    let loader = Loader::new(defs);
    let arena = Arena::default();
    let modules =
        loader
            .load(&arena, File { code, path: () })
            .map_err(|errs| {
                let mut out = Vec::new();
                for (_, e) in errs {
                    match e {
                        jaq_core::load::Error::Io(v) => {
                            out.extend(
                                v.into_iter()
                                    .map(|(s, _)| issue(code, s, MODULES.to_owned())),
                            );
                        }
                        jaq_core::load::Error::Lex(v) => {
                            out.extend(v.into_iter().map(|(exp, s)| {
                                issue(code, s, format!("expected {}", exp.as_str()))
                            }));
                        }
                        jaq_core::load::Error::Parse(v) => {
                            out.extend(v.into_iter().map(|(exp, s)| {
                                let found = if s.is_empty() {
                                    "the end".to_owned()
                                } else {
                                    format!("{:?}", s.chars().take(20).collect::<String>())
                                };
                                issue(code, s, format!("expected {}, found {found}", exp.as_str()))
                            }));
                        }
                    }
                }
                out
            })?;
    jaq_core::Compiler::default()
        .with_funs(funs)
        .compile(modules)
        .map_err(|errs| {
            errs.into_iter()
                .flat_map(|(_, v)| v)
                .map(|(s, undefined)| {
                    if let Some((name, why)) = refused(s) {
                        return issue(code, s, format!("{name} is not available: {why}"));
                    }
                    let what = match undefined {
                        jaq_core::compile::Undefined::Mod => "module",
                        jaq_core::compile::Undefined::Var => "variable",
                        jaq_core::compile::Undefined::Label => "label",
                        jaq_core::compile::Undefined::Filter(_) => "filter",
                        _ => "name",
                    };
                    issue(code, s, format!("undefined {what} {s}"))
                })
                .collect()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn first_error(code: &str) -> FilterIssue {
        JqProgram::compile(code).unwrap_err().remove(0)
    }

    fn outputs(code: &str, input: &str) -> Result<Vec<String>, String> {
        let p = JqProgram::compile(code).map_err(|e| e[0].message.clone())?;
        let mut out = Vec::new();
        p.run(
            jaq_json::read::parse_single(input.as_bytes()).unwrap(),
            |v| {
                out.push(v.to_string());
                ControlFlow::Continue(())
            },
        )?;
        Ok(out)
    }

    #[test]
    fn every_refused_builtin_is_refused_with_its_reason() {
        for (code, needle) in [
            (
                "env",
                "env is not available: a query cannot read the server's environment",
            ),
            ("env.HOME", "env is not available"),
            (
                "$ENV",
                "$ENV is not available: a query cannot read the server's environment",
            ),
            ("$ENV.PATH", "is not available"),
            (
                "input",
                "input is not available: a query reads only the value it is given",
            ),
            ("[inputs]", "inputs is not available"),
            (
                "debug",
                "debug is not available: a query cannot write to the server's log",
            ),
            ("debug(\"x\")", "debug is not available"),
            ("stderr", "stderr is not available"),
            ("debug_empty", "debug_empty is not available"),
            ("stderr_empty", "stderr_empty is not available"),
            (
                "halt",
                "halt is not available: a query cannot stop the server",
            ),
            ("halt(1)", "halt is not available"),
            ("halt_error", "halt_error is not available"),
            ("halt_error(2)", "halt_error is not available"),
            (
                "0 | localtime",
                "localtime is not available: it reads the server's time zone",
            ),
            (
                "0 | strflocaltime(\"%H\")",
                "strflocaltime is not available",
            ),
            ("include \"x\"; .", MODULES),
            ("import \"x\" as x; .", MODULES),
        ] {
            let e = first_error(code);
            assert_eq!(e.part, "jq", "{code}");
            assert!(e.message.contains(needle), "{code}: {}", e.message);
        }
        // The position points at the refused name.
        let e = first_error(".a |\n  env");
        assert_eq!((e.line, e.column), (Some(2), Some(3)), "{e:?}");
    }

    #[test]
    fn the_rest_of_the_library_still_works() {
        let doc = r#"{"items":[{"sku":"a","qty":2},{"sku":"b","qty":5},{"sku":"a","qty":1}]}"#;
        for (code, want) in [
            (".items | length", vec!["3"]),
            ("[.items[].qty] | add", vec!["8"]),
            (
                ".items | group_by(.sku) | map({sku: .[0].sku, n: length})",
                vec![r#"[{"sku":"a","n":2},{"sku":"b","n":1}]"#],
            ),
            ("[paths(type == \"number\")] | length", vec!["3"]),
            ("[.items[].sku] | unique", vec![r#"["a","b"]"#]),
            ("0 | todateiso8601", vec![r#""1970-01-01T00:00:00Z""#]),
            ("0 | gmtime | .[0]", vec!["1970"]),
            ("0 | strftime(\"%Y\")", vec![r#""1970""#]),
            ("now | type", vec![r#""number""#]),
            (
                "def f: if . > 3 then . else . + 1 | f end; 0 | f",
                vec!["4"],
            ),
        ] {
            assert_eq!(outputs(code, doc).unwrap(), want, "{code}");
        }
    }

    #[test]
    fn a_failing_program_returns_its_error_and_never_halts() {
        let e = outputs(".a + 1", r#"{"a":"x"}"#).unwrap_err();
        assert!(e.starts_with("jq: "), "{e}");
        let e = outputs("error(\"no\")", "null").unwrap_err();
        assert!(e.contains("no"), "{e}");
    }

    #[test]
    fn the_caller_can_stop_a_run() {
        let p = JqProgram::compile("repeat(1)").unwrap();
        let mut n = 0;
        p.run(Val::Null, |_| {
            n += 1;
            if n == 5 {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        })
        .unwrap();
        assert_eq!(n, 5);
    }

    fn worker(code: &str, value: &str, max: usize) -> Vec<String> {
        let input = format!("{}\n{value}", json_string(code));
        let mut out = Vec::new();
        serve_worker(input.as_bytes(), &mut out, max).unwrap();
        String::from_utf8(out)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn the_worker_writes_one_line_per_result_and_ends_with_done() {
        let lines = worker(
            ".items[] | .qty",
            r#"{"items":[{"qty":2},{"qty":5}]}"#,
            1024,
        );
        assert_eq!(lines, ["R 2", "R 5", "D"]);
        // Cut before the result that would pass the cap; nothing after it runs.
        let lines = worker("range(100)", "null", 10);
        assert_eq!(lines.last().map(String::as_str), Some("D"));
        assert_eq!(lines[lines.len() - 2], "S");
        let kept: usize = lines
            .iter()
            .filter_map(|l| l.strip_prefix("R "))
            .map(str::len)
            .sum();
        assert!(kept <= 10, "{lines:?}");
        // Compile errors, refused builtins, failures and a value that is not JSON.
        let lines = worker("env", "{}", 1024);
        assert!(
            lines[0].starts_with("E [") && lines[0].contains("not available"),
            "{lines:?}"
        );
        assert_eq!(lines.len(), 1);
        let lines = worker(".a + 1", r#"{"a":"x"}"#, 1024);
        assert!(lines[0].starts_with("F \"jq: "), "{lines:?}");
        assert_eq!(lines[1], "D");
        let lines = worker(".", "{nope", 1024);
        assert!(
            lines[0].starts_with("F \"the value is not JSON"),
            "{lines:?}"
        );
    }

    fn filter_worker(code: &str, messages: &[&str]) -> Vec<String> {
        let mut input = format!("{}\n", json_string(code));
        for m in messages {
            input.push_str(m);
            input.push('\n');
        }
        let mut out = Vec::new();
        serve_filter_worker(input.as_bytes(), &mut out).unwrap();
        String::from_utf8(out)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn the_filter_worker_answers_each_message_in_order() {
        let lines = filter_worker(
            ".value.n > 1",
            &[
                r#"{"value":{"n":1}}"#,
                r#"{"value":{"n":2}}"#,
                r#"{"value":{"n":"x"}}"#,
                r#"{"value":null}"#,
                "{nope",
            ],
        );
        assert_eq!(lines[..3], ["K", "N", "M"]);
        // A string is greater than a number in jq; null > 1 is false.
        assert_eq!(lines[3..5], ["M", "N"]);
        assert!(lines[5].starts_with("F \"jq input: "), "{lines:?}");
        assert_eq!(lines.len(), 6);
        // A failure on one message is that message's answer; the next is evaluated.
        let lines = filter_worker(
            ".value | tonumber > 1",
            &[r#"{"value":"x"}"#, r#"{"value":"5"}"#],
        );
        assert_eq!(lines[0], "K");
        assert!(lines[1].starts_with("F \"jq: "), "{lines:?}");
        assert_eq!(lines[2], "M");
        // A program that does not compile (or is refused) is the only answer.
        let lines = filter_worker("env", &[r#"{"value":1}"#]);
        assert_eq!(lines.len(), 1);
        assert!(
            lines[0].starts_with("E [") && lines[0].contains("not available"),
            "{lines:?}"
        );
        // No messages: ready, then the end.
        assert_eq!(filter_worker(".", &[]), ["K"]);
        // An error quoting a large value is cut: it is a reason, not a copy of the message.
        let big = format!(r#"{{"value":"{}"}}"#, "é".repeat(1 << 20));
        let lines = filter_worker(".value.a", &[&big]);
        let reason: String = serde_json::from_str(lines[1].strip_prefix("F ").unwrap()).unwrap();
        assert!(reason.starts_with("jq: "), "{reason}");
        assert!(reason.ends_with('…'));
        assert_eq!(reason.chars().count(), MAX_REASON_CHARS + 1);
    }

    #[test]
    fn the_filter_worker_decides_as_the_filter_does() {
        use crate::filter::{CompiledFilter, Filter, FilterInput, jq_input_line};
        let value = serde_json::json!({ "total": 12.5, "items": [{ "qty": 0 }, { "qty": 2 }], "big": 18446744073709551615u64, "note": null });
        let headers = [crate::message::Header::new("tag", "a"), crate::message::Header::new("tag", "b")];
        let m = FilterInput {
            source: "orders",
            subject: Some("orders.eu.created"),
            partition: Some(2),
            offset: Some(41),
            sequence: None,
            timestamp_us: 1_794_960_000_123_456,
            headers: Some(&headers),
            key: Some("k-1"),
            text: None,
            value: &value,
        };
        let line = String::from_utf8(jq_input_line(&m)).unwrap();
        for code in [
            ".value.total > 12",
            ".value.total == 12.5",
            ".value.items | any(.qty > 1)",
            ".value.big > 1e19",
            ".value.big | tostring | length > 5",
            ".value.note",
            ".headers.tag | length == 2",
            ".timestamp | endswith(\"Z\")",
            ".partition == 2 and .offset == \"41\" and .sequence == null",
            "false, null",
            "empty",
            ".key | tonumber",
            "error(\"no\")",
        ] {
            let filter = CompiledFilter::compile(&Filter {
                jq: Some(code.into()),
                ..Filter::default()
            })
            .unwrap();
            let answer = filter_worker(code, &[&line]).remove(1);
            let want = match filter.evaluate(&m) {
                Outcome::Match => "M".to_owned(),
                Outcome::NoMatch => "N".to_owned(),
                Outcome::JqError(e) => format!("F {}", json_string(&e)),
            };
            assert_eq!(answer, want, "{code}");
        }
    }

    #[test]
    fn programs_can_cross_threads() {
        fn send_sync<T: Send + Sync>() {}
        send_sync::<JqProgram>();
    }
}
