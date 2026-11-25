//! What the server knows of each tool's profile (DOC-25 §3.4.1, §3.4.8): its schema version, its
//! secret fields, and its target fields grouped with the secrets they guard. A stored secret is
//! only ever sent to the target it was stored for: when an update changes a target field and
//! does not set the secrets of its group in the same call, those secrets are removed.
//!
//! Field paths are dotted paths into the record's `fields` (`tls.caPem`); a secret's path is its
//! name in the `secrets` table. Every profile also has `routeId` as a target field of every group
//! (DOC-23). Host-access fields (§3.4.2) reach the server's own machine and need
//! `profiles.hostAccess` to be saved; none of the tools built so far has one (the Kubernetes exec
//! plugin, command hops, the system proxy and the local Docker socket come with their tasks).

use serde_json::Value;

/// A group of target fields and the secrets sent to that target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TargetGroup {
    pub targets: &'static [&'static str],
    pub secrets: &'static [&'static str],
}

/// A tool's profile, as the server checks it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolSpec {
    pub tool: &'static str,
    /// The newest profile schema version (DOC-21 §4.4).
    pub version: u32,
    /// Every secret field (§3.4.1).
    pub secrets: &'static [&'static str],
    pub groups: &'static [TargetGroup],
    /// Fields that, set to anything but their default, reach the server's own machine.
    pub host_access: &'static [&'static str],
}

/// The target field of every profile (DOC-23).
pub const ROUTE_FIELD: &str = "routeId";

pub const SPECS: [ToolSpec; 5] = [
    ToolSpec {
        tool: "echo",
        version: 1,
        secrets: &["token"],
        groups: &[],
        host_access: &[],
    },
    ToolSpec {
        tool: "nats",
        version: 1,
        secrets: &[
            "password",
            "token",
            "nkeySeed",
            "creds",
            "tls.clientKeyPem",
            "schemaRegistry.password",
            "schemaRegistry.token",
            "schemaRegistry.tls.clientKeyPem",
        ],
        groups: &[
            TargetGroup {
                targets: &["servers", "tls.caPem", "tls.serverName"],
                secrets: &["password", "token", "nkeySeed", "creds", "tls.clientKeyPem"],
            },
            TargetGroup {
                targets: &[
                    "schemaRegistry.url",
                    "schemaRegistry.tls.caPem",
                    "schemaRegistry.tls.serverName",
                ],
                secrets: &[
                    "schemaRegistry.password",
                    "schemaRegistry.token",
                    "schemaRegistry.tls.clientKeyPem",
                ],
            },
        ],
        host_access: &[],
    },
    ToolSpec {
        tool: "temporal",
        version: 1,
        secrets: &[
            "clientKeyPem",
            "apiKey",
            "s3AccessKeyId",
            "s3SecretAccessKey",
            "s3SessionToken",
            "codecAuthorization",
        ],
        groups: &[
            TargetGroup {
                targets: &["address", "tls.caPem", "tls.serverName"],
                secrets: &["clientKeyPem", "apiKey"],
            },
            TargetGroup {
                targets: &["codec.endpoint", "codec.namespaces", "codec.caPem"],
                secrets: &["codecAuthorization"],
            },
            TargetGroup {
                targets: &[
                    "externalStorage.endpoint",
                    "externalStorage.bucket",
                    "externalStorage.region",
                    "externalStorage.caPem",
                ],
                secrets: &["s3AccessKeyId", "s3SecretAccessKey", "s3SessionToken"],
            },
        ],
        host_access: &[],
    },
    ToolSpec {
        tool: "docker",
        version: 1,
        secrets: &["privateKey", "passphrase", "password", "tls.clientKeyPem"],
        groups: &[TargetGroup {
            targets: &[
                "transport",
                "host",
                "port",
                "socketPath",
                "hostKey",
                "username",
            ],
            secrets: &["privateKey", "passphrase", "password", "tls.clientKeyPem"],
        }],
        host_access: &[],
    },
    ToolSpec {
        tool: "langgraph",
        version: 1,
        secrets: &["apiKey", "headerValues", "tls.clientKeyPem"],
        groups: &[TargetGroup {
            targets: &["url", "tls.caPem", "tls.serverName"],
            secrets: &["apiKey", "headerValues", "tls.clientKeyPem"],
        }],
        host_access: &[],
    },
];

/// The spec of `tool`, `None` for a tool without stored profiles.
pub fn spec(tool: &str) -> Option<&'static ToolSpec> {
    SPECS.iter().find(|s| s.tool == tool)
}

/// The value at a dotted path of `fields` (`Value::Null` when absent).
pub fn at<'a>(fields: &'a Value, path: &str) -> &'a Value {
    let mut here = fields;
    for part in path.split('.') {
        match here.get(part) {
            Some(next) => here = next,
            None => return &Value::Null,
        }
    }
    here
}

impl ToolSpec {
    pub fn is_secret(&self, field: &str) -> bool {
        self.secrets.contains(&field)
    }

    /// The secrets whose target changed from `before` to `after` (§3.4.8): every secret when the
    /// route changed, else those of each group with a changed target field.
    pub fn secrets_to_unbind(&self, before: &Value, after: &Value) -> Vec<&'static str> {
        if at(before, ROUTE_FIELD) != at(after, ROUTE_FIELD) {
            return self.secrets.to_vec();
        }
        let mut out = Vec::new();
        for group in self.groups {
            if group.targets.iter().any(|t| at(before, t) != at(after, t)) {
                out.extend(group.secrets.iter().copied());
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Whether the fields set a host-access field.
    pub fn uses_host_access(&self, fields: &Value) -> bool {
        self.host_access.iter().any(|f| !at(fields, f).is_null())
    }

    /// The target fields, for an administrator's view of another user's personal profile
    /// (§3.4.2: name, tool, owner, target fields).
    pub fn target_view(&self, fields: &Value) -> Value {
        let mut out = serde_json::Map::new();
        let paths = self
            .groups
            .iter()
            .flat_map(|g| g.targets.iter())
            .chain(std::iter::once(&ROUTE_FIELD));
        for path in paths {
            let value = at(fields, path);
            if !value.is_null() {
                out.insert((*path).to_owned(), value.clone());
            }
        }
        Value::Object(out)
    }
}

/// Every secret path any tool names, `(tool, field)`: what the secret-field test checks the
/// connect procedures' `redact` lists against.
pub fn all_secret_fields() -> impl Iterator<Item = (&'static str, &'static str)> {
    SPECS
        .iter()
        .flat_map(|s| s.secrets.iter().map(move |f| (s.tool, *f)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_secret_of_a_group_is_a_secret_of_its_tool() {
        for spec in &SPECS {
            for group in spec.groups {
                for secret in group.secrets {
                    assert!(spec.is_secret(secret), "{} {secret}", spec.tool);
                }
            }
        }
    }

    #[test]
    fn a_changed_target_unbinds_the_secrets_of_its_group_only() {
        let nats = spec("nats").unwrap();
        let before =
            json!({ "servers": ["nats://a:4222"], "schemaRegistry": { "url": "https://r" } });
        let host =
            json!({ "servers": ["nats://evil:4222"], "schemaRegistry": { "url": "https://r" } });
        assert_eq!(
            nats.secrets_to_unbind(&before, &host),
            ["creds", "nkeySeed", "password", "tls.clientKeyPem", "token"]
        );
        let registry =
            json!({ "servers": ["nats://a:4222"], "schemaRegistry": { "url": "https://evil" } });
        assert_eq!(
            nats.secrets_to_unbind(&before, &registry),
            [
                "schemaRegistry.password",
                "schemaRegistry.tls.clientKeyPem",
                "schemaRegistry.token"
            ]
        );
        let same = json!({ "servers": ["nats://a:4222"], "schemaRegistry": { "url": "https://r" }, "name": "x" });
        assert!(nats.secrets_to_unbind(&before, &same).is_empty());
        let routed = json!({ "servers": ["nats://a:4222"], "schemaRegistry": { "url": "https://r" }, "routeId": "R1" });
        assert_eq!(
            nats.secrets_to_unbind(&before, &routed).len(),
            nats.secrets.len()
        );
    }

    #[test]
    fn the_target_view_holds_only_target_fields() {
        let docker = spec("docker").unwrap();
        let fields = json!({ "host": "h", "port": 22, "username": "u", "keepaliveSec": 5 });
        assert_eq!(
            docker.target_view(&fields),
            json!({ "host": "h", "port": 22, "username": "u" })
        );
    }
}
