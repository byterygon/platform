//! Kafka subject naming strategies (Mightyconsole spec §5.3): which registry subject a topic's
//! key or value uses, and which topics use a subject.
//!
//! - `TopicNameStrategy`: `<topic>-key`, `<topic>-value` (the default).
//! - `RecordNameStrategy`: `<fully.qualified.Name>`.
//! - `TopicRecordNameStrategy`: `<topic>-<fully.qualified.Name>`.

use crate::types::{NamingConfig, NamingStrategy, Part};
use crate::{CodecError, Result};

impl NamingConfig {
    /// The strategy a topic uses: its override, else the default.
    pub fn strategy_for(&self, topic: &str) -> NamingStrategy {
        self.topics
            .iter()
            .find(|t| t.topic == topic)
            .map_or(self.default, |t| t.strategy)
    }

    /// The subject of a topic's key or value. `record_name` is the fully qualified name of the
    /// record (Avro record, Protobuf message, JSON Schema `title`), needed by the record
    /// strategies.
    pub fn subject(&self, topic: &str, part: Part, record_name: Option<&str>) -> Result<String> {
        subject(self.strategy_for(topic), topic, part, record_name)
    }

    /// The topics (of `topics`) whose key or value uses `subject`, by their strategies.
    ///
    /// With `RecordNameStrategy` a subject names no topic, so a topic is listed only when the
    /// profile names it with that strategy explicitly (spec Open question 11); scanning topics
    /// for schema ids is later.
    pub fn topics_for_subject(
        &self,
        subject: &str,
        topics: &[String],
    ) -> Vec<(String, Option<Part>)> {
        let mut out = Vec::new();
        for topic in topics {
            match self.strategy_for(topic) {
                NamingStrategy::TopicNameStrategy => {
                    if subject == format!("{topic}-key") {
                        out.push((topic.clone(), Some(Part::Key)));
                    } else if subject == format!("{topic}-value") {
                        out.push((topic.clone(), Some(Part::Value)));
                    }
                }
                NamingStrategy::TopicRecordNameStrategy => {
                    if let Some(rest) = subject
                        .strip_prefix(topic.as_str())
                        .and_then(|r| r.strip_prefix('-'))
                        && is_record_name(rest)
                    {
                        out.push((topic.clone(), None));
                    }
                }
                NamingStrategy::RecordNameStrategy => {
                    let explicit = self.topics.iter().any(|t| &t.topic == topic);
                    if explicit && is_record_name(subject) {
                        out.push((topic.clone(), None));
                    }
                }
            }
        }
        out
    }
}

/// The subject a strategy gives.
pub fn subject(
    strategy: NamingStrategy,
    topic: &str,
    part: Part,
    record_name: Option<&str>,
) -> Result<String> {
    let record = || {
        record_name.filter(|n| !n.is_empty()).ok_or_else(|| {
            CodecError::invalid(format!(
                "{strategy:?} needs the record's fully qualified name"
            ))
        })
    };
    Ok(match strategy {
        NamingStrategy::TopicNameStrategy => format!("{topic}-{}", part.as_str()),
        NamingStrategy::RecordNameStrategy => record()?.to_owned(),
        NamingStrategy::TopicRecordNameStrategy => format!("{topic}-{}", record()?),
    })
}

fn is_record_name(s: &str) -> bool {
    !s.is_empty()
        && s.split('.').all(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::TopicNaming;

    #[test]
    fn subjects() {
        let n = NamingConfig {
            default: NamingStrategy::TopicNameStrategy,
            topics: vec![
                TopicNaming {
                    topic: "events".into(),
                    strategy: NamingStrategy::RecordNameStrategy,
                },
                TopicNaming {
                    topic: "audit".into(),
                    strategy: NamingStrategy::TopicRecordNameStrategy,
                },
            ],
        };
        assert_eq!(n.subject("orders", Part::Key, None).unwrap(), "orders-key");
        assert_eq!(
            n.subject("orders", Part::Value, Some("lab.Order")).unwrap(),
            "orders-value"
        );
        assert_eq!(
            n.subject("events", Part::Value, Some("lab.orders.Order"))
                .unwrap(),
            "lab.orders.Order"
        );
        assert_eq!(
            n.subject("audit", Part::Value, Some("lab.Audit")).unwrap(),
            "audit-lab.Audit"
        );
        assert!(n.subject("events", Part::Value, None).is_err());

        let topics: Vec<String> = ["orders", "events", "audit", "other"]
            .map(String::from)
            .to_vec();
        assert_eq!(
            n.topics_for_subject("orders-value", &topics),
            vec![("orders".into(), Some(Part::Value))]
        );
        assert_eq!(
            n.topics_for_subject("audit-lab.Audit", &topics),
            vec![("audit".into(), None)]
        );
        assert_eq!(
            n.topics_for_subject("lab.orders.Order", &topics),
            vec![("events".into(), None)]
        );
        assert!(n.topics_for_subject("nothing-here", &topics).is_empty());
    }
}
