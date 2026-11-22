//! Byte budgets for the thread data a reply carries (TSK-108, spec §9 "Replies and the frame
//! limit"). One Ambidex frame is at most 16 MiB (`DEFAULT_MAX_FRAME_BYTES`) and a thread can hold
//! far more: hundreds of runs with big metadata, checkpoints of tens of megabytes. So a reply is
//! counted in bytes as it is built, not in items:
//!
//! - a list reply (`threads.history`, `runs.list`) stops at [`REPLY_BUDGET`] and says where the
//!   next page starts;
//! - a value over its share ([`ITEM_SHARE`] in a list, [`STATE_SHARE`] or [`FULL_SHARE`] for one
//!   state) is replaced by `null` and a [`ValueCut`] that names the field, its size, its JSON type and
//!   a preview; nothing is dropped without saying so;
//! - the whole value is read on demand, one checkpoint or run at a time, by the same procedure
//!   with a larger share or, over that, by `langgraph.threads.readValue` as a stream.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

const KIB: usize = 1024;
const MIB: usize = 1024 * KIB;

/// The most one list reply carries: well under the 16 MiB frame (the JSON the UI reads is a little
/// larger than what is counted here, which is the compact text).
pub const REPLY_BUDGET: usize = 4 * MIB;
/// What one item of a list reply may weigh before its biggest values are cut.
pub const ITEM_SHARE: usize = MIB;
/// What the current state, or one checkpoint, may weigh in a reply of its own.
pub const STATE_SHARE: usize = 8 * MIB;
/// What "load the whole value" may weigh in one reply: still under the frame, with room for the
/// rest of the reply. Over this the value is read as a stream.
pub const FULL_SHARE: usize = 12 * MIB;
/// A value this small is never cut, however the rest weighs.
const KEEP_UNDER: usize = 16 * KIB;
/// The characters of a cut value shown as its preview.
pub const PREVIEW_CHARS: usize = 400;
/// What one reply may read from upstream in all (its calls together): a page that costs more than
/// this stops here and says where the next one starts, so a call does not take minutes.
pub const UPSTREAM_BUDGET: usize = 48 * MIB;
/// What one upstream call should weigh at most, to stay far from the client's 64 MiB cap.
const UPSTREAM_TARGET: usize = 16 * MIB;
/// How many items the first upstream call asks for.
pub const FIRST_PAGE: usize = 3;

/// What one run event's data may weigh in a `jsonl` line: over it the line carries a note instead
/// (a `values` event repeats the whole state, which can be tens of megabytes).
pub const EVENT_SHARE: usize = 4 * MIB;

/// A value that was left out of a reply because it was over its share.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ValueCut {
    /// Where it was: `values`, `metadata`, `tasks.<n>.state`, `tasks.<n>.result`,
    /// `interrupts.<n>` or `tasks.<n>.interrupts.<m>`.
    pub field: String,
    /// Its size as compact JSON text.
    pub bytes: u64,
    /// `object`, `array`, `string`, `number`, `boolean` or `null`.
    pub kind: String,
    /// The first characters of its JSON text.
    pub preview: String,
}

/// A note for JSON text that is over its share, made without parsing it: its size, its type from
/// its first character and its first characters.
pub fn cut_text(field: &str, text: &str) -> ValueCut {
    let kind = match text.trim_start().chars().next() {
        Some('{') => "object",
        Some('[') => "array",
        Some('"') => "string",
        Some('t' | 'f') => "boolean",
        Some('n') => "null",
        _ => "number",
    };
    ValueCut {
        field: field.to_owned(),
        bytes: text.len() as u64,
        kind: kind.to_owned(),
        preview: text.chars().take(PREVIEW_CHARS).collect(),
    }
}

/// The size of a value as compact JSON text, without building the text.
pub fn json_len(value: &Value) -> usize {
    match value {
        Value::Null => 4,
        Value::Bool(true) => 4,
        Value::Bool(false) => 5,
        Value::Number(n) => n.to_string().len(),
        Value::String(s) => string_len(s),
        Value::Array(items) => {
            2 + items.iter().map(json_len).sum::<usize>() + items.len().saturating_sub(1)
        }
        Value::Object(map) => {
            2 + map
                .iter()
                .map(|(k, v)| string_len(k) + 1 + json_len(v))
                .sum::<usize>()
                + map.len().saturating_sub(1)
        }
    }
}

/// A JSON string's size with its quotes and escapes. Counted by bytes: a multi-byte character
/// has no byte that needs an escape, so its UTF-8 length is its JSON length.
fn string_len(s: &str) -> usize {
    2 + s
        .bytes()
        .map(|b| match b {
            b'"' | b'\\' | b'\n' | b'\r' | b'\t' | 0x08 | 0x0c => 2,
            0..=0x1f => 6,
            _ => 1,
        })
        .sum::<usize>()
}

pub fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// The first [`PREVIEW_CHARS`] characters of a value's JSON text (cut at a character, not a byte).
pub fn preview_of(value: &Value) -> String {
    // A huge string would be serialised whole for 400 characters: take its start directly.
    if let Value::String(s) = value {
        let head: String = s.chars().take(PREVIEW_CHARS).collect();
        let text = serde_json::to_string(&head).unwrap_or_default();
        return text.trim_end_matches('"').to_owned();
    }
    let text = serde_json::to_string(value).unwrap_or_default();
    text.chars().take(PREVIEW_CHARS).collect()
}

/// Takes the value out of its place (it becomes `null`) and describes it.
pub fn cut(slot: &mut Value, field: impl Into<String>) -> ValueCut {
    let value = std::mem::replace(slot, Value::Null);
    ValueCut {
        field: field.into(),
        bytes: json_len(&value) as u64,
        kind: kind_of(&value).to_owned(),
        preview: preview_of(&value),
    }
}

/// Cuts the biggest of `slots` (name, value) while their total is over `share`, never one under
/// `KEEP_UNDER` (16 KiB). `rest` is what the item weighs besides these values.
pub fn shrink(rest: usize, mut slots: Vec<(String, &mut Value)>, share: usize) -> Vec<ValueCut> {
    let mut sizes: Vec<usize> = slots.iter().map(|(_, v)| json_len(v)).collect();
    let mut total = rest + sizes.iter().sum::<usize>();
    let mut cuts = Vec::new();
    while total > share {
        let Some((at, &biggest)) = sizes.iter().enumerate().max_by_key(|(_, s)| **s) else {
            break;
        };
        if biggest < KEEP_UNDER {
            break;
        }
        let (name, slot) = &mut slots[at];
        cuts.push(cut(slot, name.clone()));
        // `null` stays where the value was.
        total = total - biggest + 4;
        sizes[at] = 4;
    }
    cuts
}

/// How many items the next upstream call asks for, given the last page's weight: about
/// `UPSTREAM_TARGET` (16 MiB) bytes, between 1 and `most`.
pub fn next_page_size(page_bytes: usize, page_items: usize, most: usize) -> usize {
    if page_items == 0 {
        return most.max(1);
    }
    let each = (page_bytes / page_items).max(1);
    (UPSTREAM_TARGET / each).clamp(1, most.max(1))
}

/// What a list reply collects: items while they fit the budget.
#[derive(Debug)]
pub struct Page<T> {
    pub items: Vec<T>,
    used: usize,
    budget: usize,
}

impl<T> Page<T> {
    pub fn new(budget: usize) -> Self {
        Self {
            items: Vec::new(),
            used: 0,
            budget,
        }
    }

    /// Whether an item of `bytes` fits: the first always does (a single item is already cut to its
    /// share, so a page is never empty).
    pub fn fits(&self, bytes: usize) -> bool {
        self.items.is_empty() || self.used + bytes <= self.budget
    }

    pub fn add(&mut self, item: T, bytes: usize) {
        self.used += bytes;
        self.items.push(item);
    }

    pub fn used(&self) -> usize {
        self.used
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text_of(n: usize) -> Value {
        Value::String("x".repeat(n))
    }

    #[test]
    fn json_len_matches_the_compact_text() {
        for v in [
            json!(null),
            json!(true),
            json!(12.5),
            json!("a\"b\\c\n\u{1}é€😀"),
            json!([1, [2, 3], {"a": "b", "c": [null, false]}]),
            json!({}),
            json!([]),
            json!({"k": {"k2": "v"}, "é": 1}),
        ] {
            assert_eq!(
                json_len(&v),
                serde_json::to_string(&v).unwrap().len(),
                "{v}"
            );
        }
    }

    #[test]
    fn a_cut_names_what_it_took() {
        let mut slot = json!({"messages": ["x".repeat(1000)]});
        let c = cut(&mut slot, "values");
        assert_eq!(slot, Value::Null);
        assert_eq!(c.field, "values");
        assert_eq!(c.kind, "object");
        assert_eq!(c.bytes, 1000 + "{\"messages\":[\"\"]}".len() as u64);
        assert_eq!(c.preview.chars().count(), PREVIEW_CHARS);
        assert!(c.preview.starts_with("{\"messages\":[\"xxx"));
    }

    #[test]
    fn text_is_cut_without_being_parsed() {
        let text = format!("[{}]", "1,".repeat(MIB));
        let c = cut_text("data", &text);
        assert_eq!((c.field.as_str(), c.kind.as_str()), ("data", "array"));
        assert_eq!(c.bytes, text.len() as u64);
        assert_eq!(c.preview.len(), PREVIEW_CHARS);
        assert_eq!(cut_text("data", "  {\"a\":1}").kind, "object");
        assert_eq!(cut_text("data", "\"abc\"").kind, "string");
        assert_eq!(cut_text("data", "true").kind, "boolean");
        assert_eq!(cut_text("data", "12").kind, "number");
    }

    #[test]
    fn the_preview_of_a_string_is_cut_at_a_character() {
        let mut slot = Value::String("é".repeat(1000));
        let c = cut(&mut slot, "values");
        assert_eq!(c.kind, "string");
        assert_eq!(c.bytes, 2002);
        assert!(c.preview.starts_with("\"éé"));
        assert!(c.preview.chars().count() <= PREVIEW_CHARS + 1);
    }

    #[test]
    fn shrink_cuts_the_biggest_first_and_stops_at_the_share() {
        let (mut a, mut b, mut c) = (text_of(600 * KIB), text_of(300 * KIB), text_of(200 * KIB));
        let cuts = shrink(
            0,
            vec![
                ("a".into(), &mut a),
                ("b".into(), &mut b),
                ("c".into(), &mut c),
            ],
            MIB,
        );
        // 1.1 MiB over 1 MiB: the biggest goes, and then it fits.
        assert_eq!(cuts.len(), 1);
        assert_eq!(cuts[0].field, "a");
        assert_eq!(a, Value::Null);
        assert_ne!(b, Value::Null);
        assert_ne!(c, Value::Null);
    }

    #[test]
    fn shrink_counts_the_rest_and_keeps_small_values() {
        let mut small = text_of(10 * KIB);
        // Over the share only because of the rest, but this value is under KEEP_UNDER.
        assert!(shrink(2 * MIB, vec![("s".into(), &mut small)], MIB).is_empty());
        assert_ne!(small, Value::Null);
        // Exactly the share is not over it.
        let mut exact = text_of(100 * KIB - 2);
        assert!(shrink(0, vec![("e".into(), &mut exact)], 100 * KIB).is_empty());
        let mut over = text_of(100 * KIB - 1);
        assert_eq!(shrink(0, vec![("o".into(), &mut over)], 100 * KIB).len(), 1);
    }

    #[test]
    fn shrink_cuts_several_when_each_is_big() {
        let (mut a, mut b) = (text_of(MIB), text_of(MIB));
        let cuts = shrink(0, vec![("a".into(), &mut a), ("b".into(), &mut b)], MIB / 2);
        assert_eq!(cuts.len(), 2);
    }

    #[test]
    fn a_page_takes_items_up_to_the_budget_and_always_the_first() {
        let mut page = Page::new(100);
        assert!(page.fits(500), "the first item always fits");
        page.add("big", 500);
        assert!(!page.fits(1));
        let mut page = Page::new(100);
        for n in 0..10 {
            assert!(page.fits(10), "exactly the budget fits");
            page.add(n, 10);
        }
        assert!(!page.fits(1));
        assert_eq!(page.items.len(), 10);
        assert_eq!(page.used(), 100);
    }

    #[test]
    fn the_upstream_page_follows_the_weight() {
        assert_eq!(next_page_size(0, 0, 50), 50);
        // Small items: as many as allowed.
        assert_eq!(next_page_size(50 * 1000, 50, 50), 50);
        // 5 MiB each: three at a time keeps an answer near 16 MiB.
        assert_eq!(next_page_size(15 * MIB, 3, 50), 3);
        // Bigger than the target alone: one at a time.
        assert_eq!(next_page_size(40 * MIB, 1, 50), 1);
        assert_eq!(next_page_size(1, 1, 0), 1);
    }
}
