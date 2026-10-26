//! Principals (Ambidex spec §8).

use serde::{Deserialize, Serialize};

macro_rules! string_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn new(id: impl Into<String>) -> Self {
                Self(id.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}
pub(crate) use string_id;

string_id!(
    /// Tenant (workspace) the principal belongs to.
    TenantId
);
string_id!(
    /// A role, scoped to a tenant.
    RoleId
);
string_id!(
    /// The session the principal is acting in. An identifier, never a credential.
    SessionId
);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PrincipalKind {
    Human,
    Agent,
    Plugin,
    System,
}

/// Who is acting.
///
/// Agents and plugins act for a human through `on_behalf_of`; their effective permission is the
/// intersection along the whole chain (see [`crate::effective_permissions`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Principal {
    pub kind: PrincipalKind,
    /// `"human:oidc:<sub>"`, `"human:local:<os-user>"`, `"agent:token:…"`,
    /// `"plugin:org.byterygon.dbee.postgres@0.1.0"`.
    pub id: String,
    pub tenant: TenantId,
    pub on_behalf_of: Option<Box<Principal>>,
    pub roles: Vec<RoleId>,
    pub session: SessionId,
}

impl Principal {
    /// This principal followed by every principal it acts for, nearest first.
    pub fn chain(&self) -> impl Iterator<Item = &Principal> {
        std::iter::successors(Some(self), |p| p.on_behalf_of.as_deref())
    }

    /// The principal at the end of the chain (usually the human).
    pub fn origin(&self) -> &Principal {
        self.chain().last().unwrap_or(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn principal(kind: PrincipalKind, id: &str, on_behalf_of: Option<Principal>) -> Principal {
        Principal {
            kind,
            id: id.into(),
            tenant: TenantId::new("t1"),
            on_behalf_of: on_behalf_of.map(Box::new),
            roles: vec![],
            session: SessionId::new("s1"),
        }
    }

    #[test]
    fn chain_is_nearest_first() {
        let human = principal(PrincipalKind::Human, "human:oidc:alice", None);
        let agent = principal(PrincipalKind::Agent, "agent:token:a", Some(human));
        let plugin = principal(PrincipalKind::Plugin, "plugin:p@0.1.0", Some(agent));

        let ids: Vec<_> = plugin.chain().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["plugin:p@0.1.0", "agent:token:a", "human:oidc:alice"]);
        assert_eq!(plugin.origin().id, "human:oidc:alice");
    }

    #[test]
    fn serde_uses_camel_case() {
        let human = principal(PrincipalKind::Human, "human:local:me", None);
        let agent = principal(PrincipalKind::Agent, "agent:token:a", Some(human));
        let json = serde_json::to_value(&agent).unwrap();
        assert_eq!(json["onBehalfOf"]["kind"], "Human");
        assert_eq!(serde_json::from_value::<Principal>(json).unwrap(), agent);
    }
}
