//! What the LangGraph Server API answers, as the UI reads it (spec §11.4).
//!
//! The server's JSON is snake_case and grows with its versions, so each type is read leniently
//! from a `Value` (a missing field becomes empty, never an error) and written camelCase. Open
//! parts (state values, metadata, config, schemas) stay JSON.

use schemars::JsonSchema;
use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

use super::budget::{self, ValueCut};

fn text(v: &Value, key: &str) -> Option<String> {
    match v.get(key) {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

fn text_or_empty(v: &Value, key: &str) -> String {
    text(v, key).unwrap_or_default()
}

fn json(v: &Value, key: &str) -> Value {
    match v.get(key) {
        Some(Value::Null) | None => Value::Object(Default::default()),
        Some(other) => other.clone(),
    }
}

fn opt_json(v: &Value, key: &str) -> Option<Value> {
    v.get(key).filter(|v| !v.is_null()).cloned()
}

fn list<'a>(v: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    v.get(key).and_then(Value::as_array).into_iter().flatten()
}

fn strings(v: &Value, key: &str) -> Vec<String> {
    list(v, key)
        .filter_map(|s| s.as_str().map(str::to_owned))
        .collect()
}

/// Items of a list answer: the array itself, or the array under `key` (`{"items": [...]}`).
pub fn items<'a>(v: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    v.as_array()
        .or_else(|| v.get(key).and_then(Value::as_array))
        .into_iter()
        .flatten()
}

/// `GET /info`.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LanggraphInfo {
    /// The LangGraph API version, when the server says it.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub version: Option<String>,
    /// The server's feature flags (`assistants`, `crons`, `store`, ...).
    pub flags: Value,
}

impl LanggraphInfo {
    pub fn from_json(v: &Value) -> LanggraphInfo {
        LanggraphInfo {
            version: text(v, "version"),
            flags: json(v, "flags"),
        }
    }
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Assistant {
    pub assistant_id: String,
    pub graph_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub version: Option<i64>,
    pub config: Value,
    pub context: Value,
    pub metadata: Value,
    pub created_at: String,
    pub updated_at: String,
}

impl Assistant {
    pub fn from_json(v: &Value) -> Assistant {
        let assistant_id = text_or_empty(v, "assistant_id");
        Assistant {
            name: text(v, "name").unwrap_or_else(|| assistant_id.clone()),
            assistant_id,
            graph_id: text_or_empty(v, "graph_id"),
            description: text(v, "description"),
            version: v.get("version").and_then(Value::as_i64),
            config: json(v, "config"),
            context: json(v, "context"),
            metadata: json(v, "metadata"),
            created_at: text_or_empty(v, "created_at"),
            updated_at: text_or_empty(v, "updated_at"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GraphNodeKind {
    Start,
    End,
    Node,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    /// Unique in the graph; with xray, a subgraph's nodes are `<subgraph>:<node>`.
    pub id: String,
    pub name: String,
    pub kind: GraphNodeKind,
    /// The node's metadata, when it has any.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    /// A branch of a conditional edge (drawn dashed).
    pub conditional: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label: Option<String>,
}

/// `GET /assistants/{id}/graph`.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AssistantGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

impl AssistantGraph {
    pub fn from_json(v: &Value) -> AssistantGraph {
        let nodes = list(v, "nodes")
            .filter_map(|n| {
                let id = text(n, "id")?;
                let kind = match id.as_str() {
                    "__start__" => GraphNodeKind::Start,
                    "__end__" => GraphNodeKind::End,
                    _ => GraphNodeKind::Node,
                };
                let data = n.get("data");
                let name = data
                    .and_then(|d| match d {
                        Value::String(s) => Some(s.clone()),
                        Value::Object(_) => text(d, "name"),
                        _ => None,
                    })
                    .unwrap_or_else(|| id.clone());
                Some(GraphNode {
                    id,
                    name,
                    kind,
                    metadata: opt_json(n, "metadata"),
                })
            })
            .collect();
        let edges = list(v, "edges")
            .filter_map(|e| {
                Some(GraphEdge {
                    source: text(e, "source")?,
                    target: text(e, "target")?,
                    conditional: e
                        .get("conditional")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    label: match e.get("data") {
                        Some(Value::String(s)) => Some(s.clone()),
                        Some(Value::Null) | None => None,
                        Some(other) => Some(other.to_string()),
                    },
                })
            })
            .collect();
        AssistantGraph { nodes, edges }
    }
}

/// `GET /assistants/{id}/schemas`.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSchemas {
    pub graph_id: String,
    pub input_schema: Value,
    pub output_schema: Value,
    pub state_schema: Value,
    pub config_schema: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub context_schema: Option<Value>,
}

impl AssistantSchemas {
    pub fn from_json(v: &Value) -> AssistantSchemas {
        AssistantSchemas {
            graph_id: text_or_empty(v, "graph_id"),
            input_schema: opt_json(v, "input_schema").unwrap_or(Value::Null),
            output_schema: opt_json(v, "output_schema").unwrap_or(Value::Null),
            state_schema: opt_json(v, "state_schema").unwrap_or(Value::Null),
            config_schema: opt_json(v, "config_schema").unwrap_or(Value::Null),
            context_schema: opt_json(v, "context_schema"),
        }
    }
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub thread_id: String,
    /// `idle`, `busy`, `interrupted` or `error`.
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub metadata: Value,
}

impl Thread {
    pub fn from_json(v: &Value) -> Thread {
        Thread {
            thread_id: text_or_empty(v, "thread_id"),
            status: text(v, "status").unwrap_or_else(|| "idle".into()),
            created_at: text_or_empty(v, "created_at"),
            updated_at: text_or_empty(v, "updated_at"),
            metadata: json(v, "metadata"),
        }
    }
}

/// A pending `interrupt()`: its value is what the graph asks the human.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Interrupt {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub id: Option<String>,
    pub value: Value,
}

impl Interrupt {
    fn from_json(v: &Value) -> Interrupt {
        Interrupt {
            id: text(v, "id").or_else(|| text(v, "interrupt_id")),
            value: v.get("value").cloned().unwrap_or(Value::Null),
        }
    }
}

/// A task of the next step: the node to run, its error, its interrupts.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StateTask {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
    pub interrupts: Vec<Interrupt>,
    /// A subgraph task's own state (when asked for subgraphs).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub state: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub result: Option<Value>,
}

/// A thread's state at a checkpoint (`GET /threads/{id}/state`, one entry of the history).
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadState {
    pub values: Value,
    /// The nodes the next step runs; empty when the graph has ended.
    pub next: Vec<String>,
    pub tasks: Vec<StateTask>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub checkpoint_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_checkpoint_id: Option<String>,
    /// The full checkpoint config (`thread_id`, `checkpoint_ns`, `checkpoint_id`, ...).
    pub checkpoint: Value,
    /// `step`, `source` (`input`, `loop`, `update`, `fork`), `writes`, ...
    pub metadata: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub created_at: Option<String>,
    /// Every pending interrupt of the state, its tasks' included.
    pub interrupts: Vec<Interrupt>,
    /// The values this reply left out, each over its share of the reply's bytes (TSK-108): the
    /// field is `null` here and the cut says what it was. Empty when nothing was cut.
    pub cuts: Vec<ValueCut>,
}

impl ThreadState {
    pub fn from_json(v: &Value) -> ThreadState {
        let checkpoint = json(v, "checkpoint");
        let parent = v.get("parent_checkpoint").filter(|p| !p.is_null());
        let tasks: Vec<StateTask> = list(v, "tasks")
            .map(|t| StateTask {
                id: text_or_empty(t, "id"),
                name: text_or_empty(t, "name"),
                error: match t.get("error") {
                    Some(Value::String(s)) => Some(s.clone()),
                    Some(Value::Null) | None => None,
                    Some(other) => Some(other.to_string()),
                },
                interrupts: list(t, "interrupts").map(Interrupt::from_json).collect(),
                state: opt_json(t, "state"),
                result: opt_json(t, "result"),
            })
            .collect();
        let mut interrupts: Vec<Interrupt> =
            list(v, "interrupts").map(Interrupt::from_json).collect();
        if interrupts.is_empty() {
            interrupts = tasks
                .iter()
                .flat_map(|t| t.interrupts.iter().cloned())
                .collect();
        }
        ThreadState {
            values: v.get("values").cloned().unwrap_or(Value::Null),
            next: strings(v, "next"),
            checkpoint_id: text(&checkpoint, "checkpoint_id").or_else(|| text(v, "checkpoint_id")),
            parent_checkpoint_id: parent.and_then(|p| text(p, "checkpoint_id")),
            checkpoint,
            metadata: json(v, "metadata"),
            created_at: text(v, "created_at"),
            tasks,
            interrupts,
            cuts: Vec::new(),
        }
    }

    /// What the state weighs in a reply, as compact JSON text: close, not exact (the names, ids and
    /// the cut notes are counted at a flat rate), which the budget's room under the frame covers.
    pub fn weight(&self) -> usize {
        let task_values: usize = self
            .tasks
            .iter()
            .map(|t| {
                256 + t.error.as_ref().map_or(0, String::len)
                    + t.state.as_ref().map_or(0, budget::json_len)
                    + t.result.as_ref().map_or(0, budget::json_len)
                    + t.interrupts
                        .iter()
                        .map(|i| 64 + budget::json_len(&i.value))
                        .sum::<usize>()
            })
            .sum();
        let interrupts: usize = self
            .interrupts
            .iter()
            .map(|i| 64 + budget::json_len(&i.value))
            .sum();
        1024 + budget::json_len(&self.values)
            + budget::json_len(&self.metadata)
            + budget::json_len(&self.checkpoint)
            + task_values
            + interrupts
            + self.next.iter().map(|n| n.len() + 3).sum::<usize>()
            + self.cuts.len() * (2 * budget::PREVIEW_CHARS + 128)
    }

    /// Cuts the biggest values (`values`, `metadata`, the tasks' `state` and `result`, the
    /// interrupts' values) until the state weighs `share` bytes or less, and records each cut.
    pub fn within(mut self, share: usize) -> ThreadState {
        let before = self.weight();
        let mut slots: Vec<(String, &mut Value)> = vec![
            ("values".into(), &mut self.values),
            ("metadata".into(), &mut self.metadata),
        ];
        for (n, task) in self.tasks.iter_mut().enumerate() {
            if let Some(v) = task.state.as_mut() {
                slots.push((format!("tasks.{n}.state"), v));
            }
            if let Some(v) = task.result.as_mut() {
                slots.push((format!("tasks.{n}.result"), v));
            }
            for (m, i) in task.interrupts.iter_mut().enumerate() {
                slots.push((format!("tasks.{n}.interrupts.{m}"), &mut i.value));
            }
        }
        for (n, i) in self.interrupts.iter_mut().enumerate() {
            slots.push((format!("interrupts.{n}"), &mut i.value));
        }
        let in_slots: usize = slots.iter().map(|(_, v)| budget::json_len(v)).sum();
        let cuts = budget::shrink(before.saturating_sub(in_slots), slots, share);
        self.cuts = cuts;
        self
    }
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub run_id: String,
    pub thread_id: String,
    pub assistant_id: String,
    /// `pending`, `running`, `success`, `error`, `timeout`, `interrupted`.
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub metadata: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub multitask_strategy: Option<String>,
    /// The values this reply left out (`metadata`), each over its share (TSK-108).
    pub cuts: Vec<ValueCut>,
}

impl Run {
    pub fn from_json(v: &Value) -> Run {
        Run {
            run_id: text_or_empty(v, "run_id"),
            thread_id: text_or_empty(v, "thread_id"),
            assistant_id: text_or_empty(v, "assistant_id"),
            status: text_or_empty(v, "status"),
            created_at: text_or_empty(v, "created_at"),
            updated_at: text_or_empty(v, "updated_at"),
            metadata: json(v, "metadata"),
            multitask_strategy: text(v, "multitask_strategy"),
            cuts: Vec::new(),
        }
    }

    /// What the run weighs in a reply, close, not exact.
    pub fn weight(&self) -> usize {
        512 + budget::json_len(&self.metadata) + self.cuts.len() * (2 * budget::PREVIEW_CHARS + 128)
    }

    /// Cuts the metadata when it is over `share` (the run's one open value).
    pub fn within(mut self, share: usize) -> Run {
        let rest = self.weight() - budget::json_len(&self.metadata);
        let cuts = budget::shrink(rest, vec![("metadata".into(), &mut self.metadata)], share);
        self.cuts = cuts;
        self
    }
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StoreItem {
    pub namespace: Vec<String>,
    pub key: String,
    pub value: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub updated_at: Option<String>,
    /// Relevance of a semantic search hit.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub score: Option<f64>,
}

impl StoreItem {
    pub fn from_json(v: &Value) -> StoreItem {
        StoreItem {
            namespace: strings(v, "namespace"),
            key: text_or_empty(v, "key"),
            value: v.get("value").cloned().unwrap_or(Value::Null),
            created_at: text(v, "created_at"),
            updated_at: text(v, "updated_at"),
            score: v.get("score").and_then(Value::as_f64),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_graph_of_the_lab_reads_with_its_subgraph_and_branches() {
        let graph = AssistantGraph::from_json(&json!({
            "nodes": [
                {"id": "__start__", "type": "runnable", "data": {"name": "__start__"}},
                {"id": "plan", "type": "runnable", "data": {"name": "plan"}},
                {"id": "__end__"},
                {"id": "summarize:remember", "type": "runnable", "data": {"name": "summarize:remember"}, "metadata": {"x": 1}},
            ],
            "edges": [
                {"source": "__start__", "target": "plan"},
                {"source": "plan", "target": "__end__", "conditional": true, "data": "done"},
            ],
        }));
        assert_eq!(graph.nodes[0].kind, GraphNodeKind::Start);
        assert_eq!(graph.nodes[2].kind, GraphNodeKind::End);
        assert_eq!(graph.nodes[2].name, "__end__");
        assert_eq!(graph.nodes[3].metadata, Some(json!({"x": 1})));
        assert!(!graph.edges[0].conditional);
        assert!(graph.edges[1].conditional);
        assert_eq!(graph.edges[1].label.as_deref(), Some("done"));
    }

    #[test]
    fn a_state_collects_its_interrupts_and_checkpoints() {
        let state = ThreadState::from_json(&json!({
            "values": {"steps": ["plan"]},
            "next": ["approve"],
            "tasks": [{"id": "t1", "name": "approve", "error": null, "interrupts": [{"value": {"question": "Send?"}, "id": "i1"}]}],
            "checkpoint": {"thread_id": "th", "checkpoint_ns": "", "checkpoint_id": "c2"},
            "parent_checkpoint": {"checkpoint_id": "c1"},
            "metadata": {"step": 3, "source": "loop"},
            "created_at": "2026-11-18T00:00:00Z",
        }));
        assert_eq!(state.next, ["approve"]);
        assert_eq!(state.checkpoint_id.as_deref(), Some("c2"));
        assert_eq!(state.parent_checkpoint_id.as_deref(), Some("c1"));
        assert_eq!(state.interrupts.len(), 1);
        assert_eq!(state.interrupts[0].id.as_deref(), Some("i1"));
        assert_eq!(state.tasks[0].error, None);
    }

    #[test]
    fn missing_fields_are_empty_not_errors() {
        let a = Assistant::from_json(&json!({"assistant_id": "a1"}));
        assert_eq!(a.name, "a1");
        assert_eq!(a.metadata, json!({}));
        let t = Thread::from_json(&json!({}));
        assert_eq!(t.status, "idle");
        let i = StoreItem::from_json(
            &json!({"namespace": ["a", "b"], "key": "k", "value": 1, "score": 0.5}),
        );
        assert_eq!(i.namespace, ["a", "b"]);
        assert_eq!(i.score, Some(0.5));
        assert_eq!(items(&json!({"items": [1, 2]}), "items").count(), 2);
        assert_eq!(items(&json!([1]), "items").count(), 1);
    }
}
