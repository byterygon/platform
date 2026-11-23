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
//! `jq-worker`, spec §5.4.1); the filter still runs in process (spec Open question 65 (f)).

use std::fmt;
use std::io::{self, Read, Write};
use std::ops::ControlFlow;

use jaq_core::load::{Arena, File, Loader};
use jaq_core::{Ctx, Vars, data};
use jaq_json::Val;

use crate::error::Position;
use crate::filter::FilterIssue;

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
pub mod wire {
    pub const RESULT: &str = "R ";
    pub const ISSUES: &str = "E ";
    pub const FAILED: &str = "F ";
    pub const CUT: &str = "S";
    pub const DONE: &str = "D";
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

    #[test]
    fn programs_can_cross_threads() {
        fn send_sync<T: Send + Sync>() {}
        send_sync::<JqProgram>();
    }
}
