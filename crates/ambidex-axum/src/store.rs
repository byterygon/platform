//! Server-side login sessions: [`LoginSessions`].

use std::collections::HashMap;
use std::fmt;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use ambidex::engine::BoxFuture;
use ambidex::{CancellationToken, Session};
use security_types::{Clock, Principal, SessionId};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::session::{WebSession, WebSessions};

/// Timeouts and caps of [`LoginSessions`] (DOC-25 §3.2.4 and §3.6.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionLimits {
    /// A session with no activity for this long ends (`auth.session_idle`, default 60 minutes).
    pub idle: Duration,
    /// A session ends this long after sign-in, whatever its activity (`auth.session_absolute`,
    /// default 12 hours).
    pub absolute: Duration,
    /// Sessions per user; the oldest ends when one more starts (default 10).
    pub max_per_user: usize,
    /// Sessions in all; a sign-in beyond it is refused (default 1,000).
    pub max_total: usize,
}

impl Default for SessionLimits {
    fn default() -> Self {
        SessionLimits {
            idle: Duration::from_secs(60 * 60),
            absolute: Duration::from_secs(12 * 60 * 60),
            max_per_user: 10,
            max_total: 1000,
        }
    }
}

/// How a session was signed in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginMethod {
    Oidc,
    Password,
    /// A password and a second factor (TOTP or a recovery code).
    Totp,
}

impl LoginMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            LoginMethod::Oidc => "oidc",
            LoginMethod::Password => "password",
            LoginMethod::Totp => "totp",
        }
    }
}

/// Why a session ended (the audit detail `reason`, DOC-25 §3.5.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndReason {
    /// No activity for [`SessionLimits::idle`].
    Idle,
    /// Older than [`SessionLimits::absolute`].
    Absolute,
    /// Revoked by its user or an administrator.
    Revoked,
    /// A new sign-in in the same browser replaced it (no session fixation).
    Replaced,
    /// The user's session cap made room for a newer one.
    Limit,
    /// Signed out.
    Logout,
}

impl EndReason {
    pub fn as_str(self) -> &'static str {
        match self {
            EndReason::Idle => "idle",
            EndReason::Absolute => "absolute",
            EndReason::Revoked => "revoked",
            EndReason::Replaced => "replaced",
            EndReason::Limit => "limit",
            EndReason::Logout => "logout",
        }
    }
}

/// What a sign-in hands to [`LoginSessions::create`].
pub struct NewSession {
    /// The user's stable id (the principal id), used for revocation by user and the caps.
    pub user: String,
    /// Who acts on the session's connections. Its `session` field is set per connection.
    pub principal: Principal,
    /// The user's groups as of this sign-in (shown only; authorization reads live state).
    pub groups: Vec<String>,
    pub method: LoginMethod,
    /// When the user authenticated (Unix ms), for re-authentication checks.
    pub auth_time_ms: u64,
    /// The ID token, kept only for RP-initiated logout (`id_token_hint`).
    pub id_token: Option<Zeroizing<String>>,
    pub client: Option<IpAddr>,
    /// The session may only change the password (DOC-25 §3.2.6, `mustChangePassword`): the
    /// product's Authorizer reads [`SessionInfo::must_change_password`] and refuses everything
    /// else until [`LoginSessions::set_must_change`] clears it.
    pub must_change_password: bool,
    /// The session must enrol a second factor first (`auth.require_totp`): the product's
    /// Authorizer allows only the enrolment and `app.me` until [`LoginSessions::set_must_enrol`]
    /// clears it.
    pub must_enrol_totp: bool,
}

impl fmt::Debug for NewSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NewSession")
            .field("user", &self.user)
            .field("method", &self.method)
            .finish_non_exhaustive()
    }
}

/// A new session's cookie value and public id.
pub struct IssuedLogin {
    pub cookie: Zeroizing<String>,
    pub session_id: String,
}

impl fmt::Debug for IssuedLogin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IssuedLogin")
            .field("session_id", &self.session_id)
            .finish_non_exhaustive()
    }
}

/// A sign-in was refused because [`SessionLimits::max_total`] sessions are live.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionsFull;

/// A live session, as `app.me` and the session lists show it. Holds no credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInfo {
    /// `ls_` and 26 base32 characters; public.
    pub id: String,
    pub user: String,
    pub method: LoginMethod,
    pub groups: Vec<String>,
    pub created_ms: u64,
    pub last_activity_ms: u64,
    pub auth_time_ms: u64,
    pub idle_expires_ms: u64,
    pub absolute_expires_ms: u64,
    pub client: Option<IpAddr>,
    /// Only `app.account.changePassword` and `app.me` are allowed (DOC-25 §3.2.6).
    pub must_change_password: bool,
    /// Only the TOTP enrolment and `app.me` are allowed (`auth.require_totp`).
    pub must_enrol_totp: bool,
}

/// What a page load of a signed-in browser gets.
pub struct PageSession {
    pub info: SessionInfo,
    /// The session's anti-CSRF token, for the page's `<meta>`.
    pub csrf_token: Zeroizing<String>,
}

impl fmt::Debug for PageSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PageSession")
            .field("info", &self.info)
            .finish_non_exhaustive()
    }
}

/// A session that just ended.
pub struct EndedSession {
    pub id: String,
    pub user: String,
    pub reason: EndReason,
    /// The ID token it was signed in with, for RP-initiated logout.
    pub id_token: Option<Zeroizing<String>>,
}

impl fmt::Debug for EndedSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EndedSession")
            .field("id", &self.id)
            .field("user", &self.user)
            .field("reason", &self.reason)
            .finish_non_exhaustive()
    }
}

/// Told about every session that ends without a sign-out, for the audit log
/// (`auth.session.end`, DOC-25 §3.5.1). Called outside the store's lock.
pub trait SessionEvents: Send + Sync + 'static {
    /// `by` is the id of whoever revoked it, when someone did.
    fn session_ended(&self, ended: &EndedSession, by: Option<&str>);
}

/// Ignores every event.
pub struct NoSessionEvents;

impl SessionEvents for NoSessionEvents {
    fn session_ended(&self, _: &EndedSession, _: Option<&str>) {}
}

struct Entry {
    id: String,
    user: String,
    principal: Principal,
    groups: Vec<String>,
    method: LoginMethod,
    cookie_hash: [u8; 32],
    csrf_token: Zeroizing<String>,
    created_ms: u64,
    last_activity_ms: u64,
    auth_time_ms: u64,
    id_token: Option<Zeroizing<String>>,
    client: Option<IpAddr>,
    must_change_password: bool,
    must_enrol_totp: bool,
    revoked: CancellationToken,
}

#[derive(Default)]
struct Inner {
    by_id: HashMap<String, Entry>,
    by_cookie: HashMap<[u8; 32], String>,
}

impl Inner {
    fn remove(&mut self, id: &str, reason: EndReason) -> Option<EndedSession> {
        let entry = self.by_id.remove(id)?;
        self.by_cookie.remove(&entry.cookie_hash);
        entry.revoked.cancel();
        Some(EndedSession {
            id: entry.id,
            user: entry.user,
            reason,
            id_token: entry.id_token,
        })
    }
}

/// Server-side login sessions (DOC-25 §3.2.4), shared by every way of signing in.
///
/// - The session cookie is 32 random bytes, hex. The store keeps only its SHA-256, so a dump of
///   the table cannot be replayed as cookies. Each session has its own anti-CSRF token, which the
///   page receives and every Hello must carry (unchanged from [`crate::PlaceholderSessions`]).
/// - A session ends when it has been idle for [`SessionLimits::idle`] or has lived for
///   [`SessionLimits::absolute`], on logout, and on revocation (by session, by user, or all).
///   Ending it fires the token behind [`WebSessions::revocation`], so every connection opened
///   with it gets Goaway `Unauthenticated` and its calls and streams are cancelled.
/// - Activity is a page load ([`LoginSessions::page`]) or a call a client starts on one of the
///   session's connections ([`WebSessions::touch`], called by the transport). Events the server
///   pushes are not activity.
/// - At most [`SessionLimits::max_per_user`] sessions per user (the oldest ends when another
///   starts) and [`SessionLimits::max_total`] in all (a new one is then refused).
/// - Memory only (DOC-25 Open question 11): a restart ends every session.
///
/// Each WebSocket gets an Ambidex session of its own, `<login session id>.<connection id>`, so
/// live handles stay per connection. The principal is the one the sign-in built on the server.
pub struct LoginSessions {
    clock: Arc<dyn Clock>,
    limits: SessionLimits,
    events: Arc<dyn SessionEvents>,
    inner: Mutex<Inner>,
}

impl LoginSessions {
    pub fn new(
        clock: Arc<dyn Clock>,
        limits: SessionLimits,
        events: Arc<dyn SessionEvents>,
    ) -> LoginSessions {
        LoginSessions {
            clock,
            limits,
            events,
            inner: Mutex::default(),
        }
    }

    pub fn limits(&self) -> SessionLimits {
        self.limits
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // Every mutation keeps both maps consistent before it can panic.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn now(&self) -> u64 {
        self.clock.now_unix_ms()
    }

    fn expiry(&self, entry: &Entry, now: u64) -> Option<EndReason> {
        if now.saturating_sub(entry.created_ms) >= millis(self.limits.absolute) {
            Some(EndReason::Absolute)
        } else if now.saturating_sub(entry.last_activity_ms) >= millis(self.limits.idle) {
            Some(EndReason::Idle)
        } else {
            None
        }
    }

    fn info(&self, entry: &Entry) -> SessionInfo {
        SessionInfo {
            id: entry.id.clone(),
            user: entry.user.clone(),
            method: entry.method,
            groups: entry.groups.clone(),
            created_ms: entry.created_ms,
            last_activity_ms: entry.last_activity_ms,
            auth_time_ms: entry.auth_time_ms,
            idle_expires_ms: entry
                .last_activity_ms
                .saturating_add(millis(self.limits.idle)),
            absolute_expires_ms: entry
                .created_ms
                .saturating_add(millis(self.limits.absolute)),
            client: entry.client,
            must_change_password: entry.must_change_password,
            must_enrol_totp: entry.must_enrol_totp,
        }
    }

    fn report(&self, ended: Vec<EndedSession>, by: Option<&str>) {
        for ended in &ended {
            self.events.session_ended(ended, by);
        }
    }

    /// Starts a session with a new random cookie. Expired sessions are swept first; the user's
    /// oldest sessions end when they are at [`SessionLimits::max_per_user`].
    pub fn create(&self, new: NewSession) -> Result<IssuedLogin, SessionsFull> {
        let now = self.now();
        let cookie = Zeroizing::new(random_hex());
        let cookie_hash = hash(&cookie);
        let id = session_id();
        let mut ended = self.sweep_locked(now);
        let result = {
            let mut inner = self.lock();
            let mut mine: Vec<(u64, String)> = inner
                .by_id
                .values()
                .filter(|e| e.user == new.user)
                .map(|e| (e.created_ms, e.id.clone()))
                .collect();
            mine.sort();
            let over = (mine.len() + 1).saturating_sub(self.limits.max_per_user.max(1));
            if inner.by_id.len() - over.min(mine.len()) >= self.limits.max_total {
                Err(SessionsFull)
            } else {
                for (_, old) in mine.into_iter().take(over) {
                    ended.extend(inner.remove(&old, EndReason::Limit));
                }
                inner.by_cookie.insert(cookie_hash, id.clone());
                inner.by_id.insert(
                    id.clone(),
                    Entry {
                        id: id.clone(),
                        user: new.user,
                        principal: new.principal,
                        groups: new.groups,
                        method: new.method,
                        cookie_hash,
                        csrf_token: Zeroizing::new(random_hex()),
                        created_ms: now,
                        last_activity_ms: now,
                        auth_time_ms: new.auth_time_ms,
                        id_token: new.id_token,
                        client: new.client,
                        must_change_password: new.must_change_password,
                        must_enrol_totp: new.must_enrol_totp,
                        revoked: CancellationToken::new(),
                    },
                );
                Ok(IssuedLogin {
                    cookie,
                    session_id: id,
                })
            }
        };
        self.report(ended, None);
        result
    }

    /// The live session a cookie names, ending it first if it has expired. `touch` records
    /// activity.
    fn by_cookie(&self, cookie: &str, touch: bool) -> Option<(SessionInfo, Zeroizing<String>)> {
        let now = self.now();
        let key = hash(cookie);
        let (found, ended) = {
            let mut inner = self.lock();
            let id = inner.by_cookie.get(&key)?.clone();
            let entry = inner.by_id.get(&id)?;
            match self.expiry(entry, now) {
                Some(reason) => (None, inner.remove(&id, reason)),
                None => {
                    let entry = inner.by_id.get_mut(&id)?;
                    if touch {
                        entry.last_activity_ms = entry.last_activity_ms.max(now);
                    }
                    let entry = &inner.by_id[&id];
                    (Some((self.info(entry), entry.csrf_token.clone())), None)
                }
            }
        };
        self.report(ended.into_iter().collect(), None);
        found
    }

    /// A page load: the session the cookie names, which counts as activity.
    pub fn page(&self, cookie: &str) -> Option<PageSession> {
        self.by_cookie(cookie, true)
            .map(|(info, csrf_token)| PageSession { info, csrf_token })
    }

    /// The session the cookie names, without counting as activity.
    pub fn peek(&self, cookie: &str) -> Option<SessionInfo> {
        self.by_cookie(cookie, false).map(|(info, _)| info)
    }

    /// The anti-CSRF token of the session the cookie names, without counting as activity.
    pub fn csrf_token(&self, cookie: &str) -> Option<Zeroizing<String>> {
        self.by_cookie(cookie, false).map(|(_, token)| token)
    }

    /// The live session with this id.
    pub fn get(&self, id: &str) -> Option<SessionInfo> {
        let now = self.now();
        let inner = self.lock();
        let entry = inner.by_id.get(id)?;
        self.expiry(entry, now).is_none().then(|| self.info(entry))
    }

    /// Records activity on a session (a call a client started).
    pub fn touch_id(&self, id: &str) {
        let now = self.now();
        let mut inner = self.lock();
        let Some(entry) = inner.by_id.get(id) else {
            return;
        };
        if self.expiry(entry, now).is_some() {
            return;
        }
        if let Some(entry) = inner.by_id.get_mut(id) {
            entry.last_activity_ms = entry.last_activity_ms.max(now);
        }
    }

    /// Sets or clears the "may only change the password" restriction of a live session.
    pub fn set_must_change(&self, id: &str, must_change: bool) {
        if let Some(entry) = self.lock().by_id.get_mut(id) {
            entry.must_change_password = must_change;
        }
    }

    /// Sets or clears the "must enrol a second factor first" restriction of a live session.
    pub fn set_must_enrol(&self, id: &str, must_enrol: bool) {
        if let Some(entry) = self.lock().by_id.get_mut(id) {
            entry.must_enrol_totp = must_enrol;
        }
    }

    /// Ends every session of `user` except `keep` (the caller's own): a password change ends the
    /// others. Returns how many ended.
    pub fn revoke_user_except(&self, user: &str, keep: Option<&str>, by: Option<&str>) -> usize {
        let ended = {
            let mut inner = self.lock();
            let ids: Vec<String> = inner
                .by_id
                .values()
                .filter(|e| e.user == user && Some(e.id.as_str()) != keep)
                .map(|e| e.id.clone())
                .collect();
            ids.iter()
                .filter_map(|id| inner.remove(id, EndReason::Revoked))
                .collect::<Vec<_>>()
        };
        let count = ended.len();
        self.report(ended, by);
        count
    }

    /// Ends a session. `by` names who revoked it. Returns whether it was live.
    pub fn end(&self, id: &str, reason: EndReason, by: Option<&str>) -> bool {
        let ended = self.lock().remove(id, reason);
        let live = ended.is_some();
        if reason != EndReason::Logout {
            self.report(ended.into_iter().collect(), by);
        }
        live
    }

    /// Signs out the session the cookie names: it ends as on revocation, and the caller gets its
    /// ID token for RP-initiated logout. Not reported to [`SessionEvents`] (the caller records
    /// the sign-out itself).
    pub fn logout(&self, cookie: &str) -> Option<EndedSession> {
        let key = hash(cookie);
        let mut inner = self.lock();
        let id = inner.by_cookie.get(&key)?.clone();
        inner.remove(&id, EndReason::Logout)
    }

    /// Ends every session of a user. Returns how many were live.
    pub fn revoke_user(&self, user: &str, by: Option<&str>) -> usize {
        let ended = {
            let mut inner = self.lock();
            let ids: Vec<String> = inner
                .by_id
                .values()
                .filter(|e| e.user == user)
                .map(|e| e.id.clone())
                .collect();
            ids.iter()
                .filter_map(|id| inner.remove(id, EndReason::Revoked))
                .collect::<Vec<_>>()
        };
        let count = ended.len();
        self.report(ended, by);
        count
    }

    /// Ends every session except `keep` (the caller's own). Returns how many ended.
    pub fn revoke_all(&self, keep: Option<&str>, by: Option<&str>) -> usize {
        let ended = {
            let mut inner = self.lock();
            let ids: Vec<String> = inner
                .by_id
                .keys()
                .filter(|id| Some(id.as_str()) != keep)
                .cloned()
                .collect();
            ids.iter()
                .filter_map(|id| inner.remove(id, EndReason::Revoked))
                .collect::<Vec<_>>()
        };
        let count = ended.len();
        self.report(ended, by);
        count
    }

    /// Every live session, oldest first.
    pub fn list(&self) -> Vec<SessionInfo> {
        let now = self.now();
        let inner = self.lock();
        let mut all: Vec<SessionInfo> = inner
            .by_id
            .values()
            .filter(|e| self.expiry(e, now).is_none())
            .map(|e| self.info(e))
            .collect();
        all.sort_by(|a, b| (a.created_ms, &a.id).cmp(&(b.created_ms, &b.id)));
        all
    }

    /// A user's live sessions, oldest first.
    pub fn list_user(&self, user: &str) -> Vec<SessionInfo> {
        let mut mine = self.list();
        mine.retain(|s| s.user == user);
        mine
    }

    /// How many sessions are held (expired ones not swept yet included).
    pub fn len(&self) -> usize {
        self.lock().by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn sweep_locked(&self, now: u64) -> Vec<EndedSession> {
        let mut inner = self.lock();
        let expired: Vec<(String, EndReason)> = inner
            .by_id
            .values()
            .filter_map(|e| self.expiry(e, now).map(|r| (e.id.clone(), r)))
            .collect();
        expired
            .into_iter()
            .filter_map(|(id, reason)| inner.remove(&id, reason))
            .collect()
    }

    /// Ends every expired session, so their connections get Goaway. Returns how many ended.
    pub fn sweep(&self) -> usize {
        let ended = self.sweep_locked(self.now());
        let count = ended.len();
        self.report(ended, None);
        count
    }

    /// Runs [`LoginSessions::sweep`] every `every` until the store is dropped.
    pub fn spawn_sweeper(self: &Arc<Self>, every: Duration) -> tokio::task::JoinHandle<()> {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(every);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                let Some(store) = weak.upgrade() else {
                    return;
                };
                store.sweep();
            }
        })
    }
}

impl WebSessions for LoginSessions {
    fn lookup<'a>(&'a self, cookie: &'a str) -> BoxFuture<'a, Option<WebSession>> {
        let now = self.now();
        let key = hash(cookie);
        let (found, ended) = {
            let mut inner = self.lock();
            match inner.by_cookie.get(&key).cloned() {
                None => (None, None),
                Some(id) => match inner.by_id.get(&id).map(|e| self.expiry(e, now)) {
                    None => (None, None),
                    Some(Some(reason)) => (None, inner.remove(&id, reason)),
                    Some(None) => {
                        let entry = &inner.by_id[&id];
                        let connection = format!("{}.{}", entry.id, &random_hex()[..16]);
                        let mut principal = entry.principal.clone();
                        principal.session = SessionId::new(connection.clone());
                        (
                            Some(WebSession {
                                session: Session {
                                    id: connection,
                                    principal,
                                },
                                csrf_token: entry.csrf_token.to_string(),
                            }),
                            None,
                        )
                    }
                },
            }
        };
        self.report(ended.into_iter().collect(), None);
        Box::pin(async move { found })
    }

    fn revocation(&self, session: &Session) -> Option<CancellationToken> {
        let id = login_session_of(&session.id);
        match self.lock().by_id.get(id) {
            Some(entry) => Some(entry.revoked.clone()),
            // Ended between the upgrade and Hello: refuse the connection.
            None => {
                let token = CancellationToken::new();
                token.cancel();
                Some(token)
            }
        }
    }

    fn touch(&self, session: &Session) {
        self.touch_id(login_session_of(&session.id));
    }
}

/// The login session id of a connection's Ambidex session id (`<login session>.<connection>`).
pub fn login_session_of(connection_session: &str) -> &str {
    connection_session
        .split_once('.')
        .map_or(connection_session, |(id, _)| id)
}

fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

fn hash(cookie: &str) -> [u8; 32] {
    Sha256::digest(cookie.as_bytes()).into()
}

/// 256 random bits, hex.
pub(crate) fn random_hex() -> String {
    let bytes = random_bytes::<32>();
    let mut out = String::with_capacity(64);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

pub(crate) fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    // No OS randomness means no safe session at all; there is nothing to fall back to.
    getrandom::fill(&mut bytes).expect("OS randomness");
    bytes
}

/// `ls_` and 26 lowercase base32 characters (128 random bits).
fn session_id() -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let value = u128::from_be_bytes(random_bytes::<16>());
    let mut out = String::from("ls_");
    for i in (0..26).rev() {
        let index = ((value >> (i * 5)) & 31) as usize;
        out.push(char::from(ALPHABET[index]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use security_types::{PrincipalKind, TenantId};
    use std::sync::atomic::{AtomicU64, Ordering};

    #[derive(Default)]
    struct TestClock(AtomicU64);

    impl TestClock {
        fn advance(&self, by: Duration) {
            self.0.fetch_add(millis(by), Ordering::SeqCst);
        }
    }

    impl Clock for TestClock {
        fn now_unix_ms(&self) -> u64 {
            1_800_000_000_000 + self.0.load(Ordering::SeqCst)
        }

        fn sleep_until(&self, _: u64) -> security_types::BoxFuture<'_, ()> {
            Box::pin(std::future::pending())
        }
    }

    #[derive(Default)]
    struct Recorded(Mutex<Vec<(String, EndReason, Option<String>)>>);

    impl SessionEvents for Recorded {
        fn session_ended(&self, ended: &EndedSession, by: Option<&str>) {
            self.0
                .lock()
                .unwrap()
                .push((ended.user.clone(), ended.reason, by.map(str::to_owned)));
        }
    }

    fn new_session(user: &str) -> NewSession {
        NewSession {
            user: user.into(),
            principal: Principal {
                kind: PrincipalKind::Human,
                id: user.into(),
                tenant: TenantId::new("default"),
                on_behalf_of: None,
                roles: vec![],
                session: SessionId::new("unset"),
            },
            groups: vec![],
            method: LoginMethod::Oidc,
            auth_time_ms: 0,
            id_token: Some(Zeroizing::new("id-token".into())),
            client: None,
            must_change_password: false,
            must_enrol_totp: false,
        }
    }

    fn store(limits: SessionLimits) -> (Arc<TestClock>, Arc<Recorded>, LoginSessions) {
        let clock = Arc::new(TestClock::default());
        let events = Arc::new(Recorded::default());
        let store = LoginSessions::new(clock.clone(), limits, events.clone());
        (clock, events, store)
    }

    #[tokio::test]
    async fn a_session_resolves_per_connection_and_keeps_only_the_cookie_hash() {
        let (_, _, store) = store(SessionLimits::default());
        let issued = store.create(new_session("human:oidc:a")).unwrap();
        assert_eq!(issued.cookie.len(), 64);
        assert!(issued.session_id.starts_with("ls_"));
        assert_eq!(issued.session_id.len(), 29);
        let a = store.lookup(&issued.cookie).await.unwrap();
        let b = store.lookup(&issued.cookie).await.unwrap();
        assert_ne!(a.session.id, b.session.id);
        assert_eq!(login_session_of(&a.session.id), issued.session_id);
        assert_eq!(a.session.principal.session.as_str(), a.session.id);
        assert_eq!(a.csrf_token.len(), 64);
        assert!(store.lookup("forged").await.is_none());
        let inner = store.lock();
        assert!(!inner.by_cookie.contains_key(&[0; 32]));
        assert!(
            inner
                .by_cookie
                .keys()
                .all(|k| k.as_slice() != issued.cookie.as_bytes())
        );
        assert!(!format!("{issued:?}").contains(issued.cookie.as_str()));
    }

    #[tokio::test]
    async fn idle_and_absolute_limits_end_the_session_and_fire_revocation() {
        let limits = SessionLimits {
            idle: Duration::from_secs(60),
            absolute: Duration::from_secs(300),
            ..SessionLimits::default()
        };
        let (clock, events, store) = store(limits);
        let issued = store.create(new_session("u")).unwrap();
        let web = store.lookup(&issued.cookie).await.unwrap();
        let token = store.revocation(&web.session).unwrap();
        // Activity keeps it alive up to the absolute limit.
        for _ in 0..4 {
            clock.advance(Duration::from_secs(59));
            store.touch(&web.session);
            assert!(store.peek(&issued.cookie).is_some());
        }
        clock.advance(Duration::from_secs(59));
        assert!(!token.is_cancelled());
        assert_eq!(store.sweep(), 0);
        clock.advance(Duration::from_secs(70));
        assert_eq!(store.sweep(), 1);
        assert!(token.is_cancelled());
        assert!(store.lookup(&issued.cookie).await.is_none());
        assert_eq!(events.0.lock().unwrap()[0].1, EndReason::Absolute);

        let issued = store.create(new_session("u")).unwrap();
        clock.advance(Duration::from_secs(60));
        // An expired session is refused even before a sweep.
        assert!(store.page(&issued.cookie).is_none());
        assert_eq!(events.0.lock().unwrap()[1].1, EndReason::Idle);
    }

    #[tokio::test]
    async fn revocation_by_session_user_and_all() {
        let (_, events, store) = store(SessionLimits::default());
        let a1 = store.create(new_session("a")).unwrap();
        let a2 = store.create(new_session("a")).unwrap();
        let b = store.create(new_session("b")).unwrap();
        let web = store.lookup(&a1.cookie).await.unwrap();
        let token = store.revocation(&web.session).unwrap();
        assert!(store.end(&a1.session_id, EndReason::Revoked, Some("admin")));
        assert!(token.is_cancelled());
        assert!(!store.end(&a1.session_id, EndReason::Revoked, None));
        assert_eq!(store.revoke_user("a", Some("admin")), 1);
        assert!(store.peek(&a2.cookie).is_none());
        let b2 = store.create(new_session("b")).unwrap();
        assert_eq!(store.revoke_all(Some(&b2.session_id), Some("b")), 1);
        assert!(store.peek(&b.cookie).is_none());
        assert!(store.peek(&b2.cookie).is_some());
        let recorded = events.0.lock().unwrap();
        assert_eq!(recorded.len(), 3);
        assert!(recorded.iter().all(|(_, r, _)| *r == EndReason::Revoked));
        // A session that ended between upgrade and Hello gets a fired token.
        assert!(store.revocation(&web.session).unwrap().is_cancelled());
    }

    #[test]
    fn caps_per_user_and_in_total() {
        let limits = SessionLimits {
            max_per_user: 2,
            max_total: 3,
            ..SessionLimits::default()
        };
        let (clock, events, store) = store(limits);
        let first = store.create(new_session("a")).unwrap();
        clock.advance(Duration::from_millis(1));
        store.create(new_session("a")).unwrap();
        clock.advance(Duration::from_millis(1));
        store.create(new_session("a")).unwrap();
        assert!(store.peek(&first.cookie).is_none());
        assert_eq!(events.0.lock().unwrap()[0].1, EndReason::Limit);
        store.create(new_session("b")).unwrap();
        assert_eq!(store.len(), 3);
        assert_eq!(store.create(new_session("c")).err(), Some(SessionsFull));
        // A user at their own cap can still replace their oldest session.
        assert!(store.create(new_session("a")).is_ok());
        assert_eq!(store.len(), 3);
    }

    #[test]
    fn logout_hands_back_the_id_token_and_is_not_reported_as_an_end() {
        let (_, events, store) = store(SessionLimits::default());
        let issued = store.create(new_session("a")).unwrap();
        let ended = store.logout(&issued.cookie).unwrap();
        assert_eq!(ended.reason, EndReason::Logout);
        assert_eq!(
            ended.id_token.as_deref().map(String::as_str),
            Some("id-token")
        );
        assert!(store.logout(&issued.cookie).is_none());
        assert!(events.0.lock().unwrap().is_empty());
        assert!(!format!("{ended:?}").contains("id-token"));
    }
}
