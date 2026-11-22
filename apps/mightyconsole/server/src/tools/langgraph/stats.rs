//! Node statistics over an assistant's latest runs (TSK-96, DOC-21 §11.4.2
//! `langgraph.assistants.nodeStats`, Open question 62). The LangGraph server keeps no per-node
//! numbers, so they are read from the runs' checkpoints:
//!
//! - the assistant's threads are found by their metadata (`assistant_id`), newest updated first,
//!   or, on a server that does not write it there, every thread newest first;
//! - their runs of this assistant, newest first, until `runs` of them;
//! - each counted run's own checkpoints (`POST /threads/{id}/history` filtered by `run_id`).
//!
//! A `loop` checkpoint is one step: the nodes it ran are its `writes`' keys when the server keeps
//! them, else its parent's `next` (newer servers dropped `writes`), and its time is its
//! `created_at` minus its parent's. A failed run's error is a task with an error in its last
//! checkpoint. The reads stop at [`UPSTREAM_BUDGET`] bytes or [`MAX_THREADS`] threads; the answer
//! then says it is partial and why. Only the table crosses the WebSocket.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use ts_rs::TS;

use super::budget::{self, UPSTREAM_BUDGET};
use super::client::LangGraphClient;
use super::model::items;
use crate::core::ToolError;

/// Threads read at most for one answer.
pub const MAX_THREADS: usize = 200;
/// Threads asked for per search.
const THREADS_PAGE: usize = 20;
/// Checkpoints asked for per history call (halved when an answer is over the client's cap).
const STEPS_PAGE: usize = 25;
/// Threads named per node.
const THREADS_PER_NODE: usize = 5;

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NodeStatsInput {
    pub conn_id: String,
    pub assistant_id: String,
    /// How many of the latest runs to count: 1 to 200, 50 when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub runs: Option<u32>,
}

/// One node of the graph over the runs counted.
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NodeStat {
    pub node: String,
    /// Steps that ran it (a node that runs twice in a run counts twice).
    pub visits: u32,
    /// Runs that passed through it.
    pub runs: u32,
    /// The median and 95th percentile of its steps' times; absent without times.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub median_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub p95_ms: Option<u64>,
    /// Failed runs whose error was in this node.
    pub errors: u32,
    /// Up to five threads that passed through it, newest run first.
    pub thread_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NodeStats {
    /// The runs counted (at most what was asked).
    pub runs: u32,
    /// The threads they belong to.
    pub threads: u32,
    /// The oldest and newest counted run's start.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub to: Option<String>,
    /// Most visited first.
    pub nodes: Vec<NodeStat>,
    /// The reads stopped before all runs asked for were counted: `reason` says why.
    pub partial: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<String>,
}

/// A checkpoint as the statistics read it.
#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub id: String,
    pub parent: Option<String>,
    pub source: String,
    /// The nodes in its `writes`, when the server keeps them.
    pub writes: Option<Vec<String>>,
    pub next: Vec<String>,
    /// `created_at` in milliseconds since the epoch.
    pub created_ms: Option<i64>,
    /// Tasks with an error: (node, error).
    pub errors: Vec<(String, String)>,
}

fn checkpoint_id(v: &Value, key: &str) -> Option<String> {
    v.get(key)?
        .get("checkpoint_id")?
        .as_str()
        .map(str::to_owned)
}

/// Milliseconds since the epoch of an RFC 3339 time.
pub fn millis(text: &str) -> Option<i64> {
    let t = OffsetDateTime::parse(text, &Rfc3339).ok()?;
    i64::try_from(t.unix_timestamp_nanos() / 1_000_000).ok()
}

impl Step {
    pub fn from_json(v: &Value) -> Step {
        let meta = v.get("metadata").unwrap_or(&Value::Null);
        let strings = |list: Option<&Value>| -> Vec<String> {
            list.and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|s| s.as_str().map(str::to_owned))
                .collect()
        };
        Step {
            id: checkpoint_id(v, "checkpoint").unwrap_or_default(),
            parent: checkpoint_id(v, "parent_checkpoint"),
            source: meta
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            writes: meta
                .get("writes")
                .and_then(Value::as_object)
                .map(|w| w.keys().cloned().collect()),
            next: strings(v.get("next")),
            created_ms: v.get("created_at").and_then(Value::as_str).and_then(millis),
            errors: v
                .get("tasks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|t| {
                    let error = t.get("error").filter(|e| !e.is_null())?;
                    let name = t.get("name")?.as_str()?.to_owned();
                    let text = error
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| error.to_string());
                    Some((name, text))
                })
                .collect(),
        }
    }
}

/// A run counted, with its checkpoints newest first.
#[derive(Debug, Clone)]
pub struct CountedRun {
    pub thread_id: String,
    pub run_id: String,
    pub status: String,
    pub created_at: String,
    pub steps: Vec<Step>,
}

#[derive(Default)]
struct Acc {
    visits: u32,
    runs: BTreeSet<String>,
    times: Vec<u64>,
    errors: u32,
    threads: Vec<String>,
}

impl Acc {
    fn saw(&mut self, run: &CountedRun) {
        self.runs.insert(run.run_id.clone());
        if self.threads.len() < THREADS_PER_NODE && !self.threads.contains(&run.thread_id) {
            self.threads.push(run.thread_id.clone());
        }
    }
}

/// The value at `q` (0 to 1) of sorted times: the nearest rank.
fn quantile(sorted: &[u64], q: f64) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = (q * sorted.len() as f64).ceil() as usize;
    Some(sorted[rank.clamp(1, sorted.len()) - 1])
}

/// The table, from the runs (newest first, so the threads named are the latest).
pub fn compute(runs: &[CountedRun]) -> Vec<NodeStat> {
    let mut nodes: BTreeMap<String, Acc> = BTreeMap::new();
    for run in runs {
        let by_id: HashMap<&str, &Step> = run.steps.iter().map(|s| (s.id.as_str(), s)).collect();
        for step in &run.steps {
            if step.source != "loop" {
                continue;
            }
            let parent = step.parent.as_deref().and_then(|p| by_id.get(p).copied());
            let ran = match (&step.writes, parent) {
                (Some(w), _) => w.clone(),
                (None, Some(p)) => p.next.clone(),
                (None, None) => Vec::new(),
            };
            let time = match (step.created_ms, parent.and_then(|p| p.created_ms)) {
                (Some(end), Some(start)) if end >= start => Some((end - start) as u64),
                _ => None,
            };
            for node in ran.iter().filter(|n| !n.starts_with("__")) {
                let acc = nodes.entry(node.clone()).or_default();
                acc.visits += 1;
                acc.times.extend(time);
                acc.saw(run);
            }
        }
        if run.status == "error"
            && let Some(last) = run.steps.first()
        {
            for (node, _) in &last.errors {
                let acc = nodes.entry(node.clone()).or_default();
                acc.errors += 1;
                acc.saw(run);
            }
        }
    }
    let mut out: Vec<NodeStat> = nodes
        .into_iter()
        .map(|(node, mut acc)| {
            acc.times.sort_unstable();
            NodeStat {
                node,
                visits: acc.visits,
                runs: acc.runs.len() as u32,
                median_ms: quantile(&acc.times, 0.5),
                p95_ms: quantile(&acc.times, 0.95),
                errors: acc.errors,
                thread_ids: acc.threads,
            }
        })
        .collect();
    out.sort_by(|a, b| b.visits.cmp(&a.visits).then_with(|| a.node.cmp(&b.node)));
    out
}

fn too_big(e: &ToolError) -> bool {
    e.message.contains("length limit exceeded")
}

/// What the reads have cost and why they stopped early.
struct Reads {
    bytes: usize,
    reason: Option<String>,
}

impl Reads {
    fn add(&mut self, v: &Value) {
        self.bytes += budget::json_len(v);
        if self.bytes >= UPSTREAM_BUDGET && self.reason.is_none() {
            self.reason = Some(format!(
                "stopped after reading {} MiB from the LangGraph server",
                UPSTREAM_BUDGET / (1024 * 1024)
            ));
        }
    }

    fn done(&self) -> bool {
        self.reason.is_some()
    }
}

/// Reads and counts (`langgraph.assistants.nodeStats`).
pub async fn gather(
    client: &LangGraphClient,
    assistant: &str,
    want: usize,
) -> Result<NodeStats, ToolError> {
    let mut reads = Reads {
        bytes: 0,
        reason: None,
    };
    // A run names its assistant by id, or by its graph's id when it was started with that.
    let about = client
        .get(&format!("/assistants/{assistant}"), &[], "assistant")
        .await?;
    reads.add(&about);
    let graph = about
        .get("graph_id")
        .and_then(Value::as_str)
        .unwrap_or(assistant)
        .to_owned();
    let names = [assistant.to_owned(), graph];
    let mut found: Vec<CountedRun> = Vec::new();
    let mut threads_read = 0usize;
    let mut skipped = 0usize;
    let mut offset = 0usize;
    // Threads that name the assistant in their metadata; a server that does not write it there
    // (`langgraph dev`) gets every thread, newest first, within the same limits.
    let mut by_metadata = true;
    'threads: loop {
        let mut body = json!({ "limit": THREADS_PAGE, "offset": offset,
                               "sort_by": "updated_at", "sort_order": "desc" });
        if by_metadata {
            body["metadata"] = json!({ "assistant_id": assistant });
        }
        let page = client.post("/threads/search", &body, "thread").await?;
        reads.add(&page);
        let ids: Vec<String> = items(&page, "threads")
            .filter_map(|t| t.get("thread_id")?.as_str().map(str::to_owned))
            .collect();
        if by_metadata && offset == 0 && ids.is_empty() {
            by_metadata = false;
            continue;
        }
        for thread in &ids {
            if found.len() >= want || reads.done() {
                break 'threads;
            }
            if threads_read >= MAX_THREADS {
                reads.reason = Some(format!("stopped after {MAX_THREADS} threads"));
                break 'threads;
            }
            threads_read += 1;
            match thread_runs(client, thread, &names, want - found.len(), &mut reads).await {
                Ok(runs) => found.extend(runs),
                Err(_) => skipped += 1,
            }
        }
        if ids.len() < THREADS_PAGE || found.len() >= want || reads.done() {
            break;
        }
        offset += ids.len();
    }
    // The latest runs across the threads read.
    found.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    found.truncate(want);
    let mut counted = Vec::with_capacity(found.len());
    for mut run in found {
        if reads.done() {
            break;
        }
        match run_steps(client, &run.thread_id, &run.run_id, &mut reads).await {
            Ok(steps) => {
                run.steps = steps;
                counted.push(run);
            }
            Err(_) => skipped += 1,
        }
    }
    let threads: BTreeSet<&str> = counted.iter().map(|r| r.thread_id.as_str()).collect();
    let mut reason = reads.reason;
    if skipped > 0 {
        let note = format!(
            "{skipped} thread{} or run{} could not be read",
            if skipped == 1 { "" } else { "s" },
            if skipped == 1 { "" } else { "s" }
        );
        reason = Some(match reason {
            Some(r) => format!("{r}; {note}"),
            None => note,
        });
    }
    Ok(NodeStats {
        runs: counted.len() as u32,
        threads: threads.len() as u32,
        from: counted.last().map(|r| r.created_at.clone()),
        to: counted.first().map(|r| r.created_at.clone()),
        nodes: compute(&counted),
        partial: reason.is_some(),
        reason,
    })
}

/// A thread's runs of this assistant, newest first, at most `most`.
async fn thread_runs(
    client: &LangGraphClient,
    thread: &str,
    names: &[String],
    most: usize,
    reads: &mut Reads,
) -> Result<Vec<CountedRun>, ToolError> {
    let mut take = most.clamp(1, 50);
    let page = loop {
        let query = [("limit", take.to_string()), ("offset", "0".to_owned())];
        match client
            .get(&format!("/threads/{thread}/runs"), &query, "thread")
            .await
        {
            Err(e) if take > 1 && too_big(&e) => take /= 2,
            other => break other?,
        }
    };
    reads.add(&page);
    Ok(items(&page, "runs")
        .filter(|r| {
            r.get("assistant_id")
                .and_then(Value::as_str)
                .is_some_and(|a| names.iter().any(|n| n == a))
        })
        .filter_map(|r| {
            Some(CountedRun {
                thread_id: thread.to_owned(),
                run_id: r.get("run_id")?.as_str()?.to_owned(),
                status: r
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                created_at: r
                    .get("created_at")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                steps: Vec::new(),
            })
        })
        .take(most)
        .collect())
}

/// One run's checkpoints, newest first, a few at a time.
async fn run_steps(
    client: &LangGraphClient,
    thread: &str,
    run: &str,
    reads: &mut Reads,
) -> Result<Vec<Step>, ToolError> {
    let mut steps = Vec::new();
    let mut before: Option<String> = None;
    let mut take = STEPS_PAGE;
    loop {
        let mut body = Map::new();
        body.insert("limit".into(), take.into());
        body.insert("metadata".into(), json!({ "run_id": run }));
        if let Some(b) = &before {
            body.insert(
                "before".into(),
                json!({ "configurable": { "checkpoint_id": b } }),
            );
        }
        let page = match client
            .post(
                &format!("/threads/{thread}/history"),
                &Value::Object(body),
                "thread",
            )
            .await
        {
            Err(e) if take > 1 && too_big(&e) => {
                take /= 2;
                continue;
            }
            other => other?,
        };
        reads.add(&page);
        let got: Vec<Step> = items(&page, "history").map(Step::from_json).collect();
        let n = got.len();
        before = got.last().map(|s| s.id.clone());
        steps.extend(got);
        if n < take || reads.done() || before.is_none() {
            return Ok(steps);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(id: &str, parent: Option<&str>, source: &str, at: &str, next: &[&str]) -> Value {
        json!({
            "checkpoint": { "checkpoint_id": id },
            "parent_checkpoint": parent.map(|p| json!({ "checkpoint_id": p })),
            "metadata": { "source": source },
            "next": next,
            "created_at": at,
            "tasks": [],
        })
    }

    fn run(id: &str, thread: &str, status: &str, steps: Vec<Value>) -> CountedRun {
        CountedRun {
            thread_id: thread.into(),
            run_id: id.into(),
            status: status.into(),
            created_at: "2026-11-22T10:00:00Z".into(),
            steps: steps.iter().map(Step::from_json).collect(),
        }
    }

    #[test]
    fn steps_name_their_nodes_from_the_parent_s_next_and_time_from_the_parent() {
        // Newest first, as the history answers.
        let r1 = run(
            "r1",
            "t1",
            "success",
            vec![
                step("c3", Some("c2"), "loop", "2026-11-22T10:00:03.500Z", &[]),
                step(
                    "c2",
                    Some("c1"),
                    "loop",
                    "2026-11-22T10:00:01.500Z",
                    &["draft"],
                ),
                step(
                    "c1",
                    Some("c0"),
                    "input",
                    "2026-11-22T10:00:00.500Z",
                    &["classify"],
                ),
            ],
        );
        let stats = compute(&[r1]);
        assert_eq!(
            stats
                .iter()
                .map(|s| (s.node.as_str(), s.visits, s.median_ms))
                .collect::<Vec<_>>(),
            [("classify", 1, Some(1000)), ("draft", 1, Some(2000))]
        );
        assert_eq!(stats[0].thread_ids, ["t1"]);
        assert_eq!(stats[0].runs, 1);
    }

    #[test]
    fn writes_win_over_next_and_errors_count_against_their_node() {
        let mut with_writes = step("c2", Some("c1"), "loop", "2026-11-22T10:00:02Z", &[]);
        with_writes["metadata"]["writes"] = json!({ "retrieve": {}, "__interrupt__": {} });
        let mut failed = step("c3", Some("c2"), "loop", "2026-11-22T10:00:05Z", &["send"]);
        failed["tasks"] = json!([{ "id": "t", "name": "send", "error": "TimeoutError" }]);
        let r = run(
            "r9",
            "t2",
            "error",
            vec![
                failed,
                with_writes,
                step(
                    "c1",
                    Some("c0"),
                    "input",
                    "2026-11-22T10:00:00Z",
                    &["classify"],
                ),
            ],
        );
        let stats = compute(&[r]);
        let by: HashMap<_, _> = stats.iter().map(|s| (s.node.as_str(), s)).collect();
        assert_eq!(
            by["retrieve"].visits, 1,
            "from writes, not the parent's next"
        );
        assert!(!by.contains_key("__interrupt__"));
        assert!(!by.contains_key("classify"));
        assert_eq!(by["send"].errors, 1);
        // c3's parent c2 has no `next`: its nodes come from nothing, but its error counts.
        assert_eq!(by["send"].visits, 0);
    }

    #[test]
    fn quantiles_take_the_nearest_rank_and_threads_stop_at_five() {
        assert_eq!(quantile(&[], 0.5), None);
        assert_eq!(quantile(&[10], 0.95), Some(10));
        let times: Vec<u64> = (1..=20).map(|n| n * 100).collect();
        assert_eq!(quantile(&times, 0.5), Some(1000));
        assert_eq!(quantile(&times, 0.95), Some(1900));
        let runs: Vec<CountedRun> = (0..7)
            .map(|n| {
                run(
                    &format!("r{n}"),
                    &format!("t{n}"),
                    "success",
                    vec![
                        step("b", Some("a"), "loop", "2026-11-22T10:00:01Z", &[]),
                        step("a", None, "input", "2026-11-22T10:00:00Z", &["plan"]),
                    ],
                )
            })
            .collect();
        let stats = compute(&runs);
        assert_eq!(stats[0].visits, 7);
        assert_eq!(stats[0].runs, 7);
        assert_eq!(stats[0].thread_ids, ["t0", "t1", "t2", "t3", "t4"]);
    }

    #[test]
    fn times_parse_as_rfc_3339_with_or_without_fractions() {
        assert_eq!(millis("1970-01-01T00:00:01.250Z"), Some(1250));
        assert_eq!(millis("1970-01-01T00:00:02+00:00"), Some(2000));
        assert_eq!(millis("not a time"), None);
    }
}
