//! Fail-closed SQL classifier (Ambidex spec §8, DBee spec §4 and Decision 12).
//!
//! Anything not provably read-only is `Write`; text that does not tokenize (an unterminated
//! string, comment or dollar quote) is `Write`. `DROP`, `TRUNCATE`, `ALTER … DROP` and `DELETE`
//! without `WHERE` are `Destructive`. The classifier reads PostgreSQL's lexical structure only
//! (strings, `E''` strings, dollar quotes, quoted identifiers, `--` and nested `/* */`
//! comments, `;`); it does not parse statements, so a read-only statement is one whose first
//! keyword is `SELECT`, `VALUES`, `TABLE`, `SHOW`, `EXPLAIN` or `WITH` and that contains no word
//! that can modify data or state anywhere (`WITH … (DELETE …)`, `SELECT … INTO`, `EXPLAIN
//! ANALYZE`, `SELECT … FOR UPDATE` are all `Write`).
//!
//! The UI calls `query.classify` to decide whether to confirm; the server classifies again before
//! running (the dialog is UX, this is the policy input).

use crate::types::{Classification, SqlRisk};

/// Words that begin a read-only statement.
const READ_STARTS: &[&str] = &["SELECT", "VALUES", "TABLE", "SHOW", "EXPLAIN", "WITH"];

/// Words that modify data, schema, session or transaction state. Any of them anywhere in a
/// statement that starts read-only makes it `Write`.
const WRITE_WORDS: &[&str] = &[
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "CREATE",
    "ALTER",
    "DROP",
    "TRUNCATE",
    "GRANT",
    "REVOKE",
    "CALL",
    "DO",
    "COPY",
    "SET",
    "RESET",
    "LOCK",
    "VACUUM",
    "ANALYZE",
    "ANALYSE",
    "REINDEX",
    "CLUSTER",
    "REFRESH",
    "DISCARD",
    "LISTEN",
    "NOTIFY",
    "UNLISTEN",
    "LOAD",
    "SECURITY",
    "COMMENT",
    "IMPORT",
    "PREPARE",
    "EXECUTE",
    "DEALLOCATE",
    "DECLARE",
    "FETCH",
    "MOVE",
    "CLOSE",
    "BEGIN",
    "START",
    "COMMIT",
    "END",
    "ROLLBACK",
    "ABORT",
    "SAVEPOINT",
    "RELEASE",
    "INTO",
    "NEXTVAL",
    "SETVAL",
];

/// Second words after `ALTER` that make an `ALTER` destructive when a `DROP` follows anywhere.
const ALTER: &str = "ALTER";

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    /// A bare word, upper-cased (keywords and unquoted identifiers look alike).
    Word(String),
    /// A string, identifier or dollar-quoted literal (contents dropped).
    Literal,
    /// Any other single character.
    Punct(char),
}

/// Statements as token lists, or `None` when the text does not tokenize.
fn tokenize(sql: &str) -> Option<Vec<Vec<Token>>> {
    let chars: Vec<char> = sql.chars().collect();
    let mut statements = vec![Vec::new()];
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        // Line comment.
        if c == '-' && chars.get(i + 1) == Some(&'-') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        // Block comment, nested as in PostgreSQL.
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            let mut depth = 1;
            i += 2;
            while depth > 0 {
                if i >= chars.len() {
                    return None;
                }
                if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                    depth += 1;
                    i += 2;
                } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        if c == ';' {
            statements.push(Vec::new());
            i += 1;
            continue;
        }
        let current = statements.last_mut().expect("one statement always open");
        // Standard string, with '' as the escape.
        if c == '\'' {
            i = string_end(&chars, i + 1, false)?;
            current.push(Token::Literal);
            continue;
        }
        // E'...' strings also escape with a backslash.
        if (c == 'E' || c == 'e') && chars.get(i + 1) == Some(&'\'') {
            i = string_end(&chars, i + 2, true)?;
            current.push(Token::Literal);
            continue;
        }
        // Quoted identifier, with "" as the escape.
        if c == '"' {
            i += 1;
            loop {
                match chars.get(i) {
                    None => return None,
                    Some('"') if chars.get(i + 1) == Some(&'"') => i += 2,
                    Some('"') => {
                        i += 1;
                        break;
                    }
                    Some(_) => i += 1,
                }
            }
            current.push(Token::Literal);
            continue;
        }
        // Dollar quote: $tag$ ... $tag$ (the tag may be empty).
        if c == '$' {
            let mut j = i + 1;
            while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            if chars.get(j) == Some(&'$')
                && !chars[i + 1..j].first().is_some_and(char::is_ascii_digit)
            {
                let tag: String = chars[i..=j].iter().collect();
                let body_start = j + 1;
                let text: String = chars[body_start..].iter().collect();
                let end = text.find(&tag)?;
                let consumed = text[..end].chars().count() + tag.chars().count();
                i = body_start + consumed;
                current.push(Token::Literal);
                continue;
            }
            // A positional parameter ($1) or a stray dollar: punctuation.
            current.push(Token::Punct('$'));
            i += 1;
            continue;
        }
        if c.is_alphabetic() || c == '_' {
            let mut j = i;
            while j < chars.len()
                && (chars[j].is_alphanumeric() || chars[j] == '_' || chars[j] == '$')
            {
                j += 1;
            }
            let word: String = chars[i..j].iter().collect::<String>().to_ascii_uppercase();
            current.push(Token::Word(word));
            i = j;
            continue;
        }
        if c.is_ascii_digit() {
            let mut j = i;
            while j < chars.len()
                && (chars[j].is_alphanumeric() || chars[j] == '.' || chars[j] == '_')
            {
                j += 1;
            }
            current.push(Token::Literal);
            i = j;
            continue;
        }
        current.push(Token::Punct(c));
        i += 1;
    }
    statements.retain(|s| !s.is_empty());
    Some(statements)
}

/// Index just past the closing quote of a string that starts at `start` (after the opening
/// quote), or `None` if it never closes.
fn string_end(chars: &[char], mut i: usize, backslash: bool) -> Option<usize> {
    loop {
        match chars.get(i) {
            None => return None,
            Some('\\') if backslash => i += 2,
            Some('\'') if chars.get(i + 1) == Some(&'\'') => i += 2,
            Some('\'') => return Some(i + 1),
            Some(_) => i += 1,
        }
    }
}

fn word(token: &Token) -> Option<&str> {
    match token {
        Token::Word(w) => Some(w.as_str()),
        _ => None,
    }
}

fn risk_of(statement: &[Token]) -> (SqlRisk, String) {
    let words: Vec<&str> = statement.iter().filter_map(word).collect();
    let Some(&first) = words.first() else {
        return (SqlRisk::Write, "unparseable".into());
    };
    let kind = match first {
        "DROP" | "CREATE" | "ALTER" | "TRUNCATE" => match words.get(1) {
            Some(second) => format!("{first} {second}"),
            None => first.to_owned(),
        },
        _ => first.to_owned(),
    };
    let has = |w: &str| words.contains(&w);
    let risk = match first {
        "DROP" | "TRUNCATE" => SqlRisk::Destructive,
        ALTER if has("DROP") => SqlRisk::Destructive,
        "DELETE" if !has("WHERE") => SqlRisk::Destructive,
        _ if READ_STARTS.contains(&first) => {
            let writes = words.iter().any(|w| WRITE_WORDS.contains(w));
            // SELECT … FOR UPDATE / SHARE / NO KEY UPDATE / KEY SHARE takes row locks.
            let locks = words
                .windows(2)
                .any(|w| w[0] == "FOR" && matches!(w[1], "UPDATE" | "SHARE" | "NO" | "KEY"));
            if writes || locks {
                SqlRisk::Write
            } else {
                SqlRisk::Read
            }
        }
        _ => SqlRisk::Write,
    };
    (risk, kind)
}

/// Classifies `sql`: the highest risk of its statements, how many there are, and the kind of
/// the first.
pub fn classify(sql: &str) -> Classification {
    let Some(statements) = tokenize(sql) else {
        return Classification {
            risk: SqlRisk::Write,
            statements: sql
                .split(';')
                .filter(|s| !s.trim().is_empty())
                .count()
                .max(1) as u32,
            kind: "unparseable".into(),
        };
    };
    if statements.is_empty() {
        return Classification {
            risk: SqlRisk::Write,
            statements: 0,
            kind: "empty".into(),
        };
    }
    let mut risk = SqlRisk::Read;
    let mut kind = None;
    for statement in &statements {
        let (r, k) = risk_of(statement);
        risk = risk.max(r);
        kind.get_or_insert(k);
    }
    Classification {
        risk,
        statements: statements.len() as u32,
        kind: kind.unwrap_or_else(|| "empty".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn risk(sql: &str) -> SqlRisk {
        classify(sql).risk
    }

    #[test]
    fn reads() {
        for sql in [
            "select 1",
            "SELECT * FROM orders WHERE note = 'drop table x; delete'",
            "select $$delete from t$$",
            "select $q$ insert $q$, \"delete\" from t",
            "with t as (select 1) select * from t",
            "explain select * from t",
            "show server_version",
            "table orders",
            "values (1), (2)",
            "select substring('abc' from 1 for 2)",
            "-- comment\n/* nested /* comment */ */ select 1;",
            "select e'it\\'s; delete' as s",
        ] {
            assert_eq!(risk(sql), SqlRisk::Read, "{sql}");
        }
    }

    #[test]
    fn writes_and_anything_not_provably_read_only() {
        for sql in [
            "insert into t values (1)",
            "update t set a = 1",
            "delete from t where id = 1",
            "with d as (delete from t where 1=1 returning *) select * from d",
            "select * into t2 from t",
            "explain analyze select * from t",
            "select * from t for update",
            "select nextval('s')",
            "begin",
            "set search_path to x",
            "create table t (a int)",
            "alter table t add column b int",
            "copy t from stdin",
            "frobnicate",
            "",
            "   ",
        ] {
            assert_eq!(risk(sql), SqlRisk::Write, "{sql}");
        }
    }

    #[test]
    fn destructive() {
        for sql in [
            "drop table t",
            "DROP SCHEMA s CASCADE",
            "truncate t",
            "alter table t drop column a",
            "delete from t",
            "select 1; drop table t",
        ] {
            assert_eq!(risk(sql), SqlRisk::Destructive, "{sql}");
        }
        assert_eq!(classify("drop table t").kind, "DROP TABLE");
        assert_eq!(classify("alter table t drop column a").kind, "ALTER TABLE");
    }

    #[test]
    fn unterminated_text_is_write() {
        for sql in ["select 'abc", "select /* x", "select $$abc", "select \"abc"] {
            let c = classify(sql);
            assert_eq!(
                (c.risk, c.kind.as_str()),
                (SqlRisk::Write, "unparseable"),
                "{sql}"
            );
        }
    }

    #[test]
    fn counts_statements() {
        assert_eq!(classify("select 1; select 2;").statements, 2);
        assert_eq!(classify("select ';'; -- x").statements, 1);
        assert_eq!(classify("").statements, 0);
        assert_eq!(classify("select 1").kind, "SELECT");
    }
}
