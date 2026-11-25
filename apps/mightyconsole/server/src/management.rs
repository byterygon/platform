//! Changing who may do what (DOC-25 §3.3.5, §3.3.7): the state behind the management
//! procedures ([`crate::admin_api`]) and the rules every change follows.
//!
//! A change is computed on a copy of the policy, checked, written to the store, and only then put
//! in force, all under one lock, so the store and the policy in force never disagree:
//!
//! - **The last administrator** (DOC-25 §3.2.7): a change that would leave no enabled user
//!   holding `admin` unscoped (directly, through a mapping of their groups at their last sign-in,
//!   or as the default administrator) and no pinned mapping granting it is refused with
//!   `FailedPrecondition` "this would remove the last administrator".
//! - **Losing permissions ends sessions** (DOC-25 §3.2.4): after a change, every live session
//!   whose user lost a permission (or a scope of one) is revoked, so streams and subscriptions
//!   authorized before it end. Gains apply to the next call without that.

use std::collections::BTreeSet;
use std::sync::Arc;

use ambidex_axum::LoginSessions;
use security_types::Scope;
use tokio::sync::Mutex;

use crate::authz::catalogue;
use crate::authz::policy::{InForce, Policy, PolicyHandle, PolicyParts};
use crate::sessions::McAccounts;
use crate::store::Store;

/// Why a change was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangeError {
    /// It would leave no administrator.
    LastAdministrator,
    /// The store did not take it.
    Store(String),
}

impl std::fmt::Display for ChangeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChangeError::LastAdministrator => {
                f.write_str("this would remove the last administrator")
            }
            ChangeError::Store(e) => write!(f, "the store: {e}"),
        }
    }
}

/// What the management procedures change, and the lock their changes take.
pub struct Management {
    pub store: Arc<Store>,
    pub policy: PolicyHandle,
    pub sessions: Arc<LoginSessions>,
    /// The built-in accounts (`None` when the server has none mounted, in tests).
    pub accounts: Option<McAccounts>,
    changes: Mutex<()>,
}

/// What a user holds, to tell whether a change takes something away: every (permission, scope)
/// pair of their assignments in force; nothing for a disabled user.
fn grants(policy: &Policy, user: &str, groups: &[String]) -> BTreeSet<(String, String)> {
    if policy.is_disabled(user) {
        return BTreeSet::new();
    }
    let mut out = BTreeSet::new();
    for a in policy.in_force(user, groups) {
        let scope = serde_json::to_string(&a.scope).unwrap_or_default();
        for perm in policy.role_permissions(&a.role).into_iter().flatten() {
            out.insert((perm.clone(), scope.clone()));
        }
    }
    out
}

fn is_admin(in_force: &[InForce]) -> bool {
    crate::authz::is_administrator(in_force)
}

impl Management {
    pub fn new(
        store: Arc<Store>,
        policy: PolicyHandle,
        sessions: Arc<LoginSessions>,
        accounts: Option<McAccounts>,
    ) -> Management {
        Management {
            store,
            policy,
            sessions,
            accounts,
            changes: Mutex::new(()),
        }
    }

    /// Whether `policy` leaves an administrator: a pinned unscoped `admin` mapping, or an enabled
    /// user (an account, or an OIDC user with their groups at their last sign-in) holding `admin`
    /// unscoped.
    pub fn has_administrator(&self, policy: &Policy) -> Result<bool, ChangeError> {
        let parts = policy.parts();
        if parts
            .pinned
            .iter()
            .any(|m| m.role == catalogue::ADMIN_ROLE && m.scope == Scope::everywhere())
        {
            return Ok(true);
        }
        let store = |e: ambidex_axum::accounts::StoreError| ChangeError::Store(e.0);
        for account in self.store.accounts().map_err(store)? {
            let user = account.principal_id();
            if !account.disabled
                && !policy.is_disabled(&user)
                && is_admin(&policy.in_force(&user, &[]))
            {
                return Ok(true);
            }
        }
        for oidc in self.store.oidc_users().map_err(store)? {
            if !oidc.disabled
                && !policy.is_disabled(&oidc.id)
                && is_admin(&policy.in_force(&oidc.id, &oidc.groups))
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Applies a change: `change` edits a copy of the policy's parts; `persist` writes what the
    /// store keeps. Refused when it would leave no administrator; otherwise put in force, and the
    /// sessions of every user who lost a permission are revoked (`by` names who changed it).
    pub async fn change<T>(
        &self,
        by: &str,
        change: impl FnOnce(&mut PolicyParts),
        persist: impl FnOnce(&Store) -> Result<T, String>,
    ) -> Result<T, ChangeError> {
        let _guard = self.changes.lock().await;
        let before = self.policy.current();
        let mut parts = before.parts().clone();
        change(&mut parts);
        let after = Policy::new(parts);
        if self.has_administrator(&before)? && !self.has_administrator(&after)? {
            return Err(ChangeError::LastAdministrator);
        }
        let out = persist(&self.store).map_err(ChangeError::Store)?;
        self.policy.replace(after);
        let after = self.policy.current();
        self.revoke_losers(&before, &after, by);
        Ok(out)
    }

    /// Revokes the sessions of every user who holds less under `after` than under `before`.
    pub fn revoke_losers(&self, before: &Policy, after: &Policy, by: &str) -> usize {
        let mut revoked = BTreeSet::new();
        for session in self.sessions.list() {
            if revoked.contains(&session.user) {
                continue;
            }
            let had = grants(before, &session.user, &session.groups);
            let has = grants(after, &session.user, &session.groups);
            if !had.is_subset(&has) {
                self.sessions.revoke_user(&session.user, Some(by));
                revoked.insert(session.user);
            }
        }
        revoked.len()
    }
}
