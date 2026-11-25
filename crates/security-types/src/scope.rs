//! Scope limits of a role assignment (Mightyconsole security spec DOC-25 §3.3.3), shared so DBee
//! can reuse them.
//!
//! A **target** of kind [`PROFILE_TARGET`] names a profile and, below it, a Kubernetes context
//! and a namespace: its id is `<profileId>`, `<profileId>/ns:<namespace>` (Temporal),
//! `<profileId>/ctx:<context>` or `<profileId>/ctx:<context>/ns:<namespace>` (Kubernetes).
//!
//! A **scope** belongs to an assignment of a role: `null` (everywhere) or a list of
//! [`ScopeEntry`]s, written `personal`, `profile:<id>`, `profile:<id>/ns:<pattern>`,
//! `profile:<id>/ctx:<context>` or `profile:<id>/ctx:<context>/ns:<pattern>`. A pattern is a name
//! or a prefix ending in `*` (`team-a-*`); there are no other wildcards.
//!
//! A target is inside an entry when the entry's segments are a prefix of the target's segments,
//! the last one's pattern matching: `profile:P` covers every context and namespace of `P`;
//! `profile:P/ctx:prod/ns:team-a-*` covers `P/ctx:prod/ns:team-a-web` but not `P/ctx:prod` (a
//! cluster-wide list). `personal` covers the caller's own personal profiles, which only the
//! caller of a check can tell ([`Scope::covers`] takes it as an argument). A target of any other
//! kind is never inside a [`ScopeEntry::Profile`].

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::TargetRef;

/// The [`TargetRef::kind`] of a profile target.
pub const PROFILE_TARGET: &str = "profile";

/// Longest profile id, context or namespace a scope or target may name.
pub const MAX_SEGMENT_LEN: usize = 253;

/// A profile id: 1 to 64 characters of `A-Z a-z 0-9 _ -`.
pub fn is_profile_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A context or namespace name: printable ASCII without spaces, at most [`MAX_SEGMENT_LEN`]
/// bytes, and without the separators `/ctx:` and `/ns:`.
fn is_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_SEGMENT_LEN
        && name.bytes().all(|b| b.is_ascii_graphic())
        && !name.contains("/ctx:")
        && !name.contains("/ns:")
}

/// A profile target's id, read into its segments.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProfileTarget<'a> {
    pub profile: &'a str,
    pub context: Option<&'a str>,
    pub namespace: Option<&'a str>,
}

impl<'a> ProfileTarget<'a> {
    /// Reads a profile target's id; `None` when it is not one.
    pub fn parse(id: &'a str) -> Option<ProfileTarget<'a>> {
        let (rest, namespace) = match id.rfind("/ns:") {
            Some(at) => (&id[..at], Some(&id[at + 4..])),
            None => (id, None),
        };
        let (profile, context) = match rest.find("/ctx:") {
            Some(at) => (&rest[..at], Some(&rest[at + 5..])),
            None => (rest, None),
        };
        let ok =
            is_profile_id(profile) && context.is_none_or(is_name) && namespace.is_none_or(is_name);
        ok.then_some(ProfileTarget {
            profile,
            context,
            namespace,
        })
    }

    /// The target of `target`, when it is a profile target.
    pub fn of(target: &'a TargetRef) -> Option<ProfileTarget<'a>> {
        if target.kind == PROFILE_TARGET {
            ProfileTarget::parse(&target.id)
        } else {
            None
        }
    }

    /// The [`TargetRef`] for these segments.
    pub fn to_target(&self) -> TargetRef {
        let mut id = self.profile.to_owned();
        if let Some(context) = self.context {
            id.push_str("/ctx:");
            id.push_str(context);
        }
        if let Some(namespace) = self.namespace {
            id.push_str("/ns:");
            id.push_str(namespace);
        }
        TargetRef::new(PROFILE_TARGET, id)
    }
}

/// A namespace pattern: a name, or a prefix ending in `*`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct NamePattern(String);

impl NamePattern {
    pub fn parse(pattern: &str) -> Option<NamePattern> {
        let name = pattern.strip_suffix('*').unwrap_or(pattern);
        // A bare `*` is "every namespace": the same as leaving the segment out.
        let ok = (name.is_empty() && pattern == "*") || (is_name(name) && !name.contains('*'));
        ok.then(|| NamePattern(pattern.to_owned()))
    }

    pub fn matches(&self, name: &str) -> bool {
        match self.0.strip_suffix('*') {
            Some(prefix) => name.starts_with(prefix),
            None => self.0 == name,
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// One place an assignment applies to.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ScopeEntry {
    /// The caller's own personal profiles.
    Personal,
    /// A profile, or a context or namespace in it.
    Profile {
        profile: String,
        context: Option<String>,
        namespace: Option<NamePattern>,
    },
}

/// Why a scope entry did not read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeError(pub String);

impl fmt::Display for ScopeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{:?} is not a scope entry (personal, profile:<id>, profile:<id>/ns:<pattern>, \
             profile:<id>/ctx:<context>[/ns:<pattern>])",
            self.0
        )
    }
}

impl std::error::Error for ScopeError {}

impl FromStr for ScopeEntry {
    type Err = ScopeError;

    fn from_str(s: &str) -> Result<ScopeEntry, ScopeError> {
        let bad = || ScopeError(s.to_owned());
        if s == "personal" {
            return Ok(ScopeEntry::Personal);
        }
        let rest = s.strip_prefix("profile:").ok_or_else(bad)?;
        let (rest, namespace) = match rest.rfind("/ns:") {
            Some(at) => (
                &rest[..at],
                Some(NamePattern::parse(&rest[at + 4..]).ok_or_else(bad)?),
            ),
            None => (rest, None),
        };
        let (profile, context) = match rest.find("/ctx:") {
            Some(at) => (&rest[..at], Some(&rest[at + 5..])),
            None => (rest, None),
        };
        if !is_profile_id(profile) || context.is_some_and(|c| !is_name(c)) {
            return Err(bad());
        }
        Ok(ScopeEntry::Profile {
            profile: profile.to_owned(),
            context: context.map(str::to_owned),
            namespace,
        })
    }
}

impl fmt::Display for ScopeEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ScopeEntry::Personal => f.write_str("personal"),
            ScopeEntry::Profile {
                profile,
                context,
                namespace,
            } => {
                write!(f, "profile:{profile}")?;
                if let Some(context) = context {
                    write!(f, "/ctx:{context}")?;
                }
                if let Some(namespace) = namespace {
                    write!(f, "/ns:{}", namespace.as_str())?;
                }
                Ok(())
            }
        }
    }
}

impl Serialize for ScopeEntry {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for ScopeEntry {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<ScopeEntry, D::Error> {
        let text = String::deserialize(deserializer)?;
        text.parse().map_err(serde::de::Error::custom)
    }
}

impl ScopeEntry {
    /// Whether `target` is inside this entry. `own_personal`: the target is a personal profile
    /// of the caller (or a context, namespace or terminal in one).
    pub fn covers(&self, target: &TargetRef, own_personal: bool) -> bool {
        match self {
            ScopeEntry::Personal => own_personal,
            ScopeEntry::Profile {
                profile,
                context,
                namespace,
            } => {
                let Some(t) = ProfileTarget::of(target) else {
                    return false;
                };
                if t.profile != profile {
                    return false;
                }
                // The entry's segments must be a prefix of the target's: a context in the entry
                // needs the same context in the target, and a namespace entry without a context
                // (Temporal) does not reach into a target that has one (Kubernetes).
                match (context, t.context) {
                    (Some(c), Some(tc)) if c == tc => {}
                    (Some(_), _) => return false,
                    (None, Some(_)) if namespace.is_some() => return false,
                    (None, _) => {}
                }
                match namespace {
                    None => true,
                    Some(pattern) => t.namespace.is_some_and(|n| pattern.matches(n)),
                }
            }
        }
    }
}

/// The scope of an assignment: everywhere (`null`), or the places listed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Scope(pub Option<Vec<ScopeEntry>>);

impl Scope {
    /// Everywhere: what an unscoped assignment grants.
    pub fn everywhere() -> Scope {
        Scope(None)
    }

    pub fn only(entries: Vec<ScopeEntry>) -> Scope {
        Scope(Some(entries))
    }

    /// An assignment without limits.
    pub fn is_everywhere(&self) -> bool {
        self.0.is_none()
    }

    /// Whether `target` is inside this scope (see [`ScopeEntry::covers`]). Everywhere covers
    /// every target; an empty list covers none.
    pub fn covers(&self, target: &TargetRef, own_personal: bool) -> bool {
        match &self.0 {
            None => true,
            Some(entries) => entries.iter().any(|e| e.covers(target, own_personal)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(s: &str) -> ScopeEntry {
        s.parse().unwrap_or_else(|e| panic!("{e}"))
    }

    fn target(id: &str) -> TargetRef {
        TargetRef::new(PROFILE_TARGET, id)
    }

    #[test]
    fn entries_read_and_print_back() {
        for s in [
            "personal",
            "profile:P",
            "profile:P/ns:default",
            "profile:P/ns:team-a-*",
            "profile:P/ns:*",
            "profile:P/ctx:prod",
            "profile:P/ctx:arn:aws:eks:eu-west-1:1:cluster/prod/ns:web",
        ] {
            assert_eq!(entry(s).to_string(), s);
        }
        for bad in [
            "",
            "profile:",
            "profile:a b",
            "profile:P/ns:",
            "profile:P/ns:a*b*",
            "profile:P/ctx:",
            "profile:P/ns:a*/x",
            "namespace:x",
            "Personal",
        ] {
            assert!(bad.parse::<ScopeEntry>().is_err(), "{bad:?}");
        }
    }

    #[test]
    fn targets_read_into_segments() {
        let t = ProfileTarget::parse("P/ctx:c1/ns:n1").unwrap();
        assert_eq!(
            (t.profile, t.context, t.namespace),
            ("P", Some("c1"), Some("n1"))
        );
        assert_eq!(t.to_target(), target("P/ctx:c1/ns:n1"));
        assert_eq!(ProfileTarget::parse("P/ns:x").unwrap().namespace, Some("x"));
        assert!(ProfileTarget::parse("").is_none());
        assert!(ProfileTarget::parse("a b").is_none());
        assert!(ProfileTarget::of(&TargetRef::new("browser", "P")).is_none());
    }

    #[test]
    fn an_entry_covers_the_targets_below_it() {
        let p = entry("profile:P");
        for t in ["P", "P/ns:a", "P/ctx:c", "P/ctx:c/ns:a"] {
            assert!(p.covers(&target(t), false), "{t}");
        }
        assert!(!p.covers(&target("Q"), false));
        assert!(!p.covers(&target("PP"), false));

        let ns = entry("profile:P/ns:team-a-*");
        assert!(ns.covers(&target("P/ns:team-a-web"), false));
        assert!(!ns.covers(&target("P/ns:team-b"), false));
        assert!(
            !ns.covers(&target("P"), false),
            "a call on the profile itself"
        );
        assert!(!ns.covers(&target("P/ctx:c/ns:team-a-web"), false));

        let ctx_ns = entry("profile:P/ctx:prod/ns:team-a-*");
        assert!(ctx_ns.covers(&target("P/ctx:prod/ns:team-a-web"), false));
        assert!(!ctx_ns.covers(&target("P/ctx:prod"), false), "cluster-wide");
        assert!(!ctx_ns.covers(&target("P/ctx:dev/ns:team-a-web"), false));
        assert!(!ctx_ns.covers(&target("P/ns:team-a-web"), false));

        let ctx = entry("profile:P/ctx:prod");
        assert!(ctx.covers(&target("P/ctx:prod"), false));
        assert!(ctx.covers(&target("P/ctx:prod/ns:x"), false));
        assert!(!ctx.covers(&target("P"), false));

        let exact = entry("profile:P/ns:default");
        assert!(exact.covers(&target("P/ns:default"), false));
        assert!(!exact.covers(&target("P/ns:default2"), false));
    }

    #[test]
    fn personal_covers_only_the_callers_own() {
        let t = target("P");
        assert!(entry("personal").covers(&t, true));
        assert!(!entry("personal").covers(&t, false));
        assert!(!entry("profile:P").covers(&TargetRef::new("browser", "P"), true));
    }

    #[test]
    fn a_scope_is_everywhere_or_its_entries() {
        let t = target("P/ns:a");
        assert!(Scope::everywhere().covers(&t, false));
        assert!(Scope::everywhere().covers(&TargetRef::new("browser", "x"), false));
        assert!(!Scope::only(vec![]).covers(&t, false));
        assert!(Scope::only(vec![entry("profile:Q"), entry("profile:P/ns:a")]).covers(&t, false));
        let json = serde_json::to_string(&Scope::only(vec![entry("profile:P/ns:a*")])).unwrap();
        assert_eq!(json, r#"["profile:P/ns:a*"]"#);
        assert_eq!(serde_json::to_string(&Scope::everywhere()).unwrap(), "null");
        let back: Scope = serde_json::from_str(r#"["personal","profile:P"]"#).unwrap();
        assert_eq!(back.0.unwrap().len(), 2);
        assert!(serde_json::from_str::<Scope>(r#"["nope"]"#).is_err());
    }
}
