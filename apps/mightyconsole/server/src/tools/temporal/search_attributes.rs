//! `temporal.namespaces.searchAttributes` (TSK-93): the search attributes a visibility query can
//! name in a namespace, with their types, for the query editor's completion. They come from the
//! `OperatorService`'s `ListSearchAttributes`, which gives the custom attributes by the names the
//! namespace uses. A server that does not answer it (an API key without operator rights, a
//! proxy that only forwards `WorkflowService`) gets the built-in attributes instead, and the
//! output says why, so the editor still completes the common ones.

use std::collections::HashMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::client::{TemporalClient, status_error};
use super::proto::temporal::api::enums::v1::IndexedValueType;
use super::proto::temporal::api::operatorservice::v1 as ops;
use crate::core::ToolError;

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchAttributesInput {
    pub conn_id: String,
    /// The profile's namespace when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
}

/// The value type of a search attribute (`IndexedValueType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS, JsonSchema)]
pub enum SearchAttributeType {
    Text,
    Keyword,
    Int,
    Double,
    Bool,
    Datetime,
    KeywordList,
    Unspecified,
}

impl SearchAttributeType {
    fn from_proto(value: i32) -> SearchAttributeType {
        match IndexedValueType::try_from(value) {
            Ok(IndexedValueType::Text) => SearchAttributeType::Text,
            Ok(IndexedValueType::Keyword) => SearchAttributeType::Keyword,
            Ok(IndexedValueType::Int) => SearchAttributeType::Int,
            Ok(IndexedValueType::Double) => SearchAttributeType::Double,
            Ok(IndexedValueType::Bool) => SearchAttributeType::Bool,
            Ok(IndexedValueType::Datetime) => SearchAttributeType::Datetime,
            Ok(IndexedValueType::KeywordList) => SearchAttributeType::KeywordList,
            Ok(IndexedValueType::Unspecified) | Err(_) => SearchAttributeType::Unspecified,
        }
    }
}

/// One attribute a query can name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchAttribute {
    pub name: String,
    pub value_type: SearchAttributeType,
    /// Registered for the namespace by its users, not built in.
    pub custom: bool,
}

/// The namespace's attributes: custom ones first, then the built-in ones, each by name.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchAttributesOutput {
    pub attributes: Vec<SearchAttribute>,
    /// Set when the server did not list them and these are the built-in ones only: its message.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fallback: Option<String>,
}

/// The built-in attributes users query by, for a server that does not answer
/// `ListSearchAttributes` (Temporal's `searchattribute/defs.go`, server 1.27).
const BUILT_IN: &[(&str, SearchAttributeType)] = &[
    ("BatcherUser", SearchAttributeType::Keyword),
    ("BuildIds", SearchAttributeType::KeywordList),
    ("CloseTime", SearchAttributeType::Datetime),
    ("ExecutionDuration", SearchAttributeType::Int),
    ("ExecutionStatus", SearchAttributeType::Keyword),
    ("ExecutionTime", SearchAttributeType::Datetime),
    ("HistoryLength", SearchAttributeType::Int),
    ("HistorySizeBytes", SearchAttributeType::Int),
    ("ParentRunId", SearchAttributeType::Keyword),
    ("ParentWorkflowId", SearchAttributeType::Keyword),
    ("RootRunId", SearchAttributeType::Keyword),
    ("RootWorkflowId", SearchAttributeType::Keyword),
    ("RunId", SearchAttributeType::Keyword),
    ("StartTime", SearchAttributeType::Datetime),
    ("StateTransitionCount", SearchAttributeType::Int),
    ("TaskQueue", SearchAttributeType::Keyword),
    ("TemporalChangeVersion", SearchAttributeType::KeywordList),
    ("TemporalScheduledById", SearchAttributeType::Keyword),
    ("TemporalScheduledStartTime", SearchAttributeType::Datetime),
    ("TemporalSchedulePaused", SearchAttributeType::Bool),
    ("WorkflowId", SearchAttributeType::Keyword),
    ("WorkflowType", SearchAttributeType::Keyword),
];

fn sorted(mut attributes: Vec<SearchAttribute>) -> Vec<SearchAttribute> {
    attributes.sort_by(|a, b| b.custom.cmp(&a.custom).then_with(|| a.name.cmp(&b.name)));
    attributes
}

/// `ListSearchAttributes` as the output: custom and system attributes with their types.
fn from_response(
    custom: HashMap<String, i32>,
    system: HashMap<String, i32>,
) -> Vec<SearchAttribute> {
    let entries = |map: HashMap<String, i32>, custom: bool| {
        map.into_iter().map(move |(name, value)| SearchAttribute {
            name,
            value_type: SearchAttributeType::from_proto(value),
            custom,
        })
    };
    sorted(
        entries(custom, true)
            .chain(entries(system, false))
            .collect(),
    )
}

fn built_in() -> Vec<SearchAttribute> {
    sorted(
        BUILT_IN
            .iter()
            .map(|&(name, value_type)| SearchAttribute {
                name: name.to_owned(),
                value_type,
                custom: false,
            })
            .collect(),
    )
}

/// The namespace's search attributes, or the built-in ones with the reason when the server
/// refuses `ListSearchAttributes`. A connection failure is an error, as for any other call.
pub async fn search_attributes(
    client: &TemporalClient,
    input: SearchAttributesInput,
) -> Result<SearchAttributesOutput, ToolError> {
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let response = client
        .operator()
        .list_search_attributes(client.request(
            &namespace,
            ops::ListSearchAttributesRequest {
                namespace: namespace.clone(),
            },
        ))
        .await;
    match response {
        Ok(response) => {
            let response = response.into_inner();
            Ok(SearchAttributesOutput {
                attributes: from_response(response.custom_attributes, response.system_attributes),
                fallback: None,
            })
        }
        Err(status)
            if matches!(
                status.code(),
                tonic::Code::Unavailable
                    | tonic::Code::DeadlineExceeded
                    | tonic::Code::Unauthenticated
            ) =>
        {
            Err(status_error(&client.address, &status))
        }
        Err(status) => Ok(SearchAttributesOutput {
            attributes: built_in(),
            fallback: Some(status_error(&client.address, &status).message),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_attributes_come_first_and_types_follow_the_proto_enum() {
        let custom = HashMap::from([
            ("CustomerId".to_owned(), IndexedValueType::Keyword as i32),
            ("Amount".to_owned(), IndexedValueType::Double as i32),
        ]);
        let system = HashMap::from([
            ("WorkflowType".to_owned(), IndexedValueType::Keyword as i32),
            ("StartTime".to_owned(), IndexedValueType::Datetime as i32),
            ("Odd".to_owned(), 99),
        ]);
        let names: Vec<(String, SearchAttributeType, bool)> = from_response(custom, system)
            .into_iter()
            .map(|a| (a.name, a.value_type, a.custom))
            .collect();
        assert_eq!(
            names,
            [
                ("Amount".into(), SearchAttributeType::Double, true),
                ("CustomerId".into(), SearchAttributeType::Keyword, true),
                ("Odd".into(), SearchAttributeType::Unspecified, false),
                ("StartTime".into(), SearchAttributeType::Datetime, false),
                ("WorkflowType".into(), SearchAttributeType::Keyword, false),
            ]
        );
    }

    #[test]
    fn the_fallback_lists_the_common_built_in_attributes() {
        let list = built_in();
        for name in [
            "WorkflowId",
            "WorkflowType",
            "ExecutionStatus",
            "StartTime",
            "TaskQueue",
        ] {
            assert!(list.iter().any(|a| a.name == name && !a.custom), "{name}");
        }
        assert!(list.windows(2).all(|w| w[0].name < w[1].name));
    }
}
