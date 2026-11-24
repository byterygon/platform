//! Built-in accounts (DOC-25 §3.2.6): sign-up, sign-in with a password, password changes and
//! one-time setup links, beside the OIDC sign-in and on the same [`LoginSessions`].
//!
//! The product stores the accounts behind [`AccountStore`] (Mightyconsole on `store.redb`),
//! builds the principal and records the events ([`AccountHooks`]). Routes, under the base path,
//! all `POST` with a JSON body:
//!
//! - `/auth/signup { username, displayName?, password, next? }` (with [`Signup::Open`]): creates
//!   the account and signs it in. 5 sign-ups per client address per hour.
//! - `/auth/password { username, password, next? }`: signs in; for an account with TOTP it
//!   answers `200 {"totp": true}` and keeps a pending sign-in for 5 minutes (bound to the browser
//!   by a `SameSite=Strict` cookie), which:
//! - `/auth/totp { code }` completes with a six-digit code or a recovery code.
//! - `/auth/setup { token, password, next? }`: redeems a setup link
//!   ([`Accounts::create_setup_link`]): sets the password and signs in. Single use, 24 hours.
//!
//! Every one needs the exact `Origin`, `Content-Type: application/json` and the pre-session
//! token ([`Accounts::pre_session`]: a `__Host-` cookie, `SameSite=Strict`, whose value the
//! signed-out page also gets in a `<meta>`) in the anti-CSRF header, so another site cannot sign
//! a browser in or up. A success answers `200 {"ok": true, "next", "mustChangePassword"}` with
//! a new session cookie; the browser's previous session, if any, ends (no fixation). The session
//! is created only after every factor.
//!
//! The second factor ([`totp`], DOC-25 Open question 8): optional per account, enrolled from a
//! signed-in session ([`Accounts::totp_begin`], [`Accounts::totp_confirm`], which also makes 10
//! recovery codes kept as Argon2id hashes). With [`RequireTotp`] an account without TOTP gets a
//! session that must enrol first ([`crate::SessionInfo::must_enrol_totp`]).
//!
//! Guessing (DOC-25 §3.2.6): a wrong password and an unknown user name get the same answer
//! (`401 {"error": "invalid"}`) at the same cost (one Argon2id hash either way, against a dummy
//! hash for an unknown name). Five failures for an account within 15 minutes lock it for 15
//! minutes; the answer stays the same and the lockout goes to the hooks for the audit log. Twenty
//! failures from one client address within 15 minutes answer 429 for 15 minutes.
//!
//! Passwords, hashes, setup tokens and cookies never reach an event, an error or a `Debug`
//! output; they are held in zeroizing buffers where this module holds them.

mod limits;
mod memory;
pub mod password;
#[cfg(test)]
mod tests;
pub mod totp;

use std::collections::HashMap;
use std::fmt;
use std::net::{IpAddr, Ipv6Addr};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use security_types::Clock;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use ambidex::engine::BoxFuture;

use crate::ClientAddr;
use crate::oidc::{AuthEvent, LoginError, LoginRoutes, SignInRefusal, SignedIn};
use crate::session::constant_time_eq;
use crate::store::{EndReason, LoginMethod, LoginSessions, NewSession, random_bytes, random_hex};
use crate::web::{self, SameSite};

use limits::{
    ACCOUNT_FAILURES, ACCOUNT_WINDOW_MS, ADDRESS_FAILURES, ADDRESS_WINDOW_MS, SIGNUP_WINDOW_MS,
    SIGNUPS_PER_HOUR, Windows,
};
pub use memory::MemoryAccountStore;
pub use password::{
    HashError, MAX_PASSWORD_CHARS, MIN_PASSWORD_CHARS, PasswordHasher, PasswordRejection,
    check_policy,
};
pub use totp::{RECOVERY_CODES, TotpRecord, code_at};

/// How long a setup link works.
pub const SETUP_LINK_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// Largest request body the account routes read.
pub const MAX_BODY: usize = 16 * 1024;
/// Shortest and longest user name.
pub const MIN_USERNAME: usize = 3;
pub const MAX_USERNAME: usize = 64;
/// Longest display name, in characters.
pub const MAX_DISPLAY_NAME: usize = 128;
/// How long a sign-in waits for its second factor.
pub const PENDING_TOTP_TTL: Duration = Duration::from_secs(5 * 60);
/// Codes tried on one pending sign-in before it is dropped.
pub const PENDING_TOTP_ATTEMPTS: u32 = 5;
/// How long a TOTP enrolment waits for its confirmation.
pub const TOTP_ENROLMENT_TTL: Duration = Duration::from_secs(10 * 60);
/// Pending sign-ins and enrolments kept at once; the oldest goes first.
pub const MAX_PENDING_TOTP: usize = 1024;

/// Who made an account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreatedBy {
    /// Sign-up.
    SelfSignup,
    /// The server (the default administrator).
    Server,
    /// An administrator: their principal id.
    Administrator(String),
}

/// A built-in account (DOC-25 §3.2.6).
#[derive(Clone, PartialEq, Eq)]
pub struct Account {
    /// A ULID: the principal is `human:account:<id>`, so the user name can change.
    pub id: String,
    /// 3 to 64 of `a-z 0-9 . _ -`, stored in lower case, unique.
    pub username: String,
    pub display_name: String,
    /// The Argon2id PHC string; `None` until a setup link sets one (nothing signs in).
    pub password_hash: Option<String>,
    /// The next session may only change the password.
    pub must_change_password: bool,
    pub created_by: CreatedBy,
    pub created_ms: u64,
    pub last_seen_ms: Option<u64>,
    pub disabled: bool,
    /// Locked after too many failures, until then (an administrator can unlock it).
    pub locked_until_ms: Option<u64>,
    /// The second factor, when enrolled.
    pub totp: Option<TotpRecord>,
    /// Argon2id hashes of the recovery codes not used yet.
    pub recovery_codes: Vec<String>,
}

impl Account {
    /// `human:account:<id>` (DOC-25 §3.2.3).
    pub fn principal_id(&self) -> String {
        principal_id(&self.id)
    }
}

impl fmt::Debug for Account {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Account")
            .field("id", &self.id)
            .field("username", &self.username)
            .field("display_name", &self.display_name)
            .field(
                "password_hash",
                &self.password_hash.as_ref().map(|_| "<redacted>"),
            )
            .field("must_change_password", &self.must_change_password)
            .field("created_by", &self.created_by)
            .field("disabled", &self.disabled)
            .field("locked_until_ms", &self.locked_until_ms)
            .field("totp", &self.totp.is_some())
            .field("recovery_codes", &self.recovery_codes.len())
            .finish_non_exhaustive()
    }
}

/// `human:account:<id>`.
pub fn principal_id(account_id: &str) -> String {
    format!("human:account:{account_id}")
}

/// The account id of a `human:account:<id>` principal.
pub fn account_id_of(principal_id: &str) -> Option<&str> {
    principal_id.strip_prefix("human:account:")
}

/// The store failed. The message names what failed, never a value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreError(pub String);

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "account store: {}", self.0)
    }
}

impl std::error::Error for StoreError {}

/// Why an account could not be created.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateError {
    UsernameTaken,
    Store(StoreError),
}

impl From<StoreError> for CreateError {
    fn from(e: StoreError) -> Self {
        CreateError::Store(e)
    }
}

/// Where the accounts live. User names are given in lower case.
pub trait AccountStore: Send + Sync + 'static {
    /// Adds an account; its user name must be free.
    fn create<'a>(&'a self, account: Account) -> BoxFuture<'a, Result<(), CreateError>>;

    fn by_username<'a>(
        &'a self,
        username: &'a str,
    ) -> BoxFuture<'a, Result<Option<Account>, StoreError>>;

    fn by_id<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Account>, StoreError>>;

    /// Sets the password hash and `mustChangePassword`. `false` when there is no such account.
    fn set_password<'a>(
        &'a self,
        id: &'a str,
        hash: String,
        must_change: bool,
    ) -> BoxFuture<'a, Result<bool, StoreError>>;

    fn set_locked_until<'a>(
        &'a self,
        id: &'a str,
        until_ms: Option<u64>,
    ) -> BoxFuture<'a, Result<(), StoreError>>;

    fn set_last_seen<'a>(
        &'a self,
        id: &'a str,
        at_ms: u64,
    ) -> BoxFuture<'a, Result<(), StoreError>>;

    /// Keeps a setup link: the SHA-256 of its token, the account, its expiry. A new link for an
    /// account replaces its older ones.
    fn put_setup_token<'a>(
        &'a self,
        token_hash: [u8; 32],
        account_id: &'a str,
        expires_ms: u64,
    ) -> BoxFuture<'a, Result<(), StoreError>>;

    /// The account of a live setup link, leaving it in place.
    fn peek_setup_token<'a>(
        &'a self,
        token_hash: [u8; 32],
        now_ms: u64,
    ) -> BoxFuture<'a, Result<Option<String>, StoreError>>;

    /// Removes a setup link and returns its account if it was live: a link works once, even
    /// when two requests race.
    fn take_setup_token<'a>(
        &'a self,
        token_hash: [u8; 32],
        now_ms: u64,
    ) -> BoxFuture<'a, Result<Option<String>, StoreError>>;

    /// Sets (or with `None` removes) the account's TOTP and replaces its recovery code hashes.
    fn set_totp<'a>(
        &'a self,
        id: &'a str,
        totp: Option<TotpRecord>,
        recovery_codes: Vec<String>,
    ) -> BoxFuture<'a, Result<(), StoreError>>;

    /// Records `step` as the last TOTP step used, if it is later than the one kept. `false` when
    /// it is not (a reused code) or the account has no TOTP: a step works once even when two
    /// requests race.
    fn advance_totp_step<'a>(
        &'a self,
        id: &'a str,
        step: u64,
    ) -> BoxFuture<'a, Result<bool, StoreError>>;

    /// Removes one recovery code hash. `false` when it was already gone (used once only).
    fn remove_recovery_code<'a>(
        &'a self,
        id: &'a str,
        hash: &'a str,
    ) -> BoxFuture<'a, Result<bool, StoreError>>;
}

impl<S: AccountStore> AccountStore for Arc<S> {
    fn create<'a>(&'a self, account: Account) -> BoxFuture<'a, Result<(), CreateError>> {
        (**self).create(account)
    }
    fn by_username<'a>(
        &'a self,
        username: &'a str,
    ) -> BoxFuture<'a, Result<Option<Account>, StoreError>> {
        (**self).by_username(username)
    }
    fn by_id<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Account>, StoreError>> {
        (**self).by_id(id)
    }
    fn set_password<'a>(
        &'a self,
        id: &'a str,
        hash: String,
        must_change: bool,
    ) -> BoxFuture<'a, Result<bool, StoreError>> {
        (**self).set_password(id, hash, must_change)
    }
    fn set_locked_until<'a>(
        &'a self,
        id: &'a str,
        until_ms: Option<u64>,
    ) -> BoxFuture<'a, Result<(), StoreError>> {
        (**self).set_locked_until(id, until_ms)
    }
    fn set_last_seen<'a>(
        &'a self,
        id: &'a str,
        at_ms: u64,
    ) -> BoxFuture<'a, Result<(), StoreError>> {
        (**self).set_last_seen(id, at_ms)
    }
    fn put_setup_token<'a>(
        &'a self,
        token_hash: [u8; 32],
        account_id: &'a str,
        expires_ms: u64,
    ) -> BoxFuture<'a, Result<(), StoreError>> {
        (**self).put_setup_token(token_hash, account_id, expires_ms)
    }
    fn peek_setup_token<'a>(
        &'a self,
        token_hash: [u8; 32],
        now_ms: u64,
    ) -> BoxFuture<'a, Result<Option<String>, StoreError>> {
        (**self).peek_setup_token(token_hash, now_ms)
    }
    fn take_setup_token<'a>(
        &'a self,
        token_hash: [u8; 32],
        now_ms: u64,
    ) -> BoxFuture<'a, Result<Option<String>, StoreError>> {
        (**self).take_setup_token(token_hash, now_ms)
    }
    fn set_totp<'a>(
        &'a self,
        id: &'a str,
        totp: Option<TotpRecord>,
        recovery_codes: Vec<String>,
    ) -> BoxFuture<'a, Result<(), StoreError>> {
        (**self).set_totp(id, totp, recovery_codes)
    }
    fn advance_totp_step<'a>(
        &'a self,
        id: &'a str,
        step: u64,
    ) -> BoxFuture<'a, Result<bool, StoreError>> {
        (**self).advance_totp_step(id, step)
    }
    fn remove_recovery_code<'a>(
        &'a self,
        id: &'a str,
        hash: &'a str,
    ) -> BoxFuture<'a, Result<bool, StoreError>> {
        (**self).remove_recovery_code(id, hash)
    }
}

/// The product side of the built-in accounts.
pub trait AccountHooks: Send + Sync + 'static {
    /// Maps an account that proved its password to the user and principal, or refuses it.
    fn sign_in<'a>(
        &'a self,
        account: &'a Account,
    ) -> BoxFuture<'a, Result<SignedIn, SignInRefusal>>;

    /// Records an event (the same events as the OIDC sign-in, plus sign-ups and lockouts).
    /// Called outside every lock; must not block for long.
    fn record(&self, event: AuthEvent);

    /// The account's password was changed by its owner or through a setup link (Mightyconsole
    /// deletes `DATA/admin-password`). The default does nothing.
    fn password_changed(&self, account: &Account) {
        let _ = account;
    }

    /// Whether the account holds the administrator role, for `auth.require_totp = "admins"`.
    /// The default says no.
    fn is_administrator(&self, account: &Account) -> bool {
        let _ = account;
        false
    }
}

impl<H: AccountHooks> AccountHooks for Arc<H> {
    fn sign_in<'a>(
        &'a self,
        account: &'a Account,
    ) -> BoxFuture<'a, Result<SignedIn, SignInRefusal>> {
        (**self).sign_in(account)
    }
    fn record(&self, event: AuthEvent) {
        (**self).record(event);
    }
    fn password_changed(&self, account: &Account) {
        (**self).password_changed(account);
    }
    fn is_administrator(&self, account: &Account) -> bool {
        (**self).is_administrator(account)
    }
}

/// `auth.signup`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signup {
    /// Anyone who reaches the sign-in page can make an account (the default).
    Open,
    /// Only an administrator makes accounts (with a setup link).
    Off,
}

/// `auth.require_totp`: who must have the second factor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequireTotp {
    /// Optional for everyone (the default).
    None,
    /// Required for accounts holding the administrator role ([`AccountHooks::is_administrator`]).
    Admins,
    All,
}

/// The built-in accounts' settings.
#[derive(Debug, Clone)]
pub struct AccountsConfig {
    pub signup: Signup,
    pub require_totp: RequireTotp,
    /// The issuer an authenticator app shows (`Mightyconsole`).
    pub totp_issuer: String,
}

impl AccountsConfig {
    pub fn new(totp_issuer: impl Into<String>) -> AccountsConfig {
        AccountsConfig {
            signup: Signup::Open,
            require_totp: RequireTotp::None,
            totp_issuer: totp_issuer.into(),
        }
    }
}

/// A TOTP enrolment to show once: the `otpauth://` URI and its QR image.
pub struct TotpEnrolment {
    pub uri: Zeroizing<String>,
    /// An SVG image (no script), made on the server.
    pub qr_svg: Zeroizing<String>,
}

impl fmt::Debug for TotpEnrolment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TotpEnrolment").finish_non_exhaustive()
    }
}

/// Why a TOTP operation was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TotpError {
    /// The caller is not a built-in account.
    NotAnAccount,
    /// No enrolment was begun, or it is older than [`TOTP_ENROLMENT_TTL`].
    NoEnrolment,
    /// The code does not match.
    WrongCode,
    /// The current password is wrong (it counts towards the lockout), or the account is locked.
    WrongPassword,
    /// `auth.require_totp` applies to this account: it cannot remove its own second factor.
    Required,
    Hash,
    Store(StoreError),
}

impl fmt::Display for TotpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TotpError::NotAnAccount => f.write_str("only a built-in account has a second factor"),
            TotpError::NoEnrolment => f.write_str("begin the enrolment again"),
            TotpError::WrongCode => f.write_str("the code does not match"),
            TotpError::WrongPassword => f.write_str("the current password is wrong"),
            TotpError::Required => f.write_str("the second factor is required for this account"),
            TotpError::Hash => f.write_str("the recovery codes could not be hashed"),
            TotpError::Store(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for TotpError {}

impl From<StoreError> for TotpError {
    fn from(e: StoreError) -> Self {
        TotpError::Store(e)
    }
}

/// The signed-out page's pre-session token.
pub struct PreSession {
    /// For the page's `<meta>`; the browser echoes it in the anti-CSRF header.
    pub token: String,
    /// Set when the browser had no valid pre-session cookie yet.
    pub set_cookie: Option<HeaderValue>,
}

impl fmt::Debug for PreSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PreSession")
            .field("new", &self.set_cookie.is_some())
            .finish_non_exhaustive()
    }
}

/// A new setup link.
pub struct SetupLink {
    /// `<public origin><base>/auth/setup?token=<token>`, to hand to the person.
    pub url: Zeroizing<String>,
    pub expires_ms: u64,
}

impl fmt::Debug for SetupLink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SetupLink")
            .field("expires_ms", &self.expires_ms)
            .finish_non_exhaustive()
    }
}

/// Why a password change was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangePasswordError {
    /// The caller is not a built-in account.
    NotAnAccount,
    /// The current password is wrong (it counts towards the lockout), or the account is locked.
    WrongPassword,
    /// The new password breaks the policy.
    Rejected(PasswordRejection),
    Hash,
    Store(StoreError),
}

impl fmt::Display for ChangePasswordError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ChangePasswordError::NotAnAccount => {
                f.write_str("only a built-in account has a password")
            }
            ChangePasswordError::WrongPassword => f.write_str("the current password is wrong"),
            ChangePasswordError::Rejected(r) => write!(f, "{r}"),
            ChangePasswordError::Hash => f.write_str("the password could not be hashed"),
            ChangePasswordError::Store(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ChangePasswordError {}

impl From<StoreError> for ChangePasswordError {
    fn from(e: StoreError) -> Self {
        ChangePasswordError::Store(e)
    }
}

#[derive(Default)]
struct Guards {
    /// Failures per account id.
    accounts: Windows<String>,
    /// Failures per client address.
    addresses: Windows<IpAddr>,
    /// Sign-ups per client address.
    signups: Windows<IpAddr>,
}

/// A sign-in waiting for its second factor.
struct PendingSignIn {
    account_id: String,
    next: String,
    created_ms: u64,
    attempts: u32,
}

/// A TOTP enrolment waiting for its confirmation.
struct PendingEnrolment {
    key: Zeroizing<Vec<u8>>,
    created_ms: u64,
}

#[derive(Default)]
struct Pending {
    /// By the SHA-256 of the pending sign-in cookie.
    sign_ins: HashMap<[u8; 32], PendingSignIn>,
    /// By account id.
    enrolments: HashMap<String, PendingEnrolment>,
}

impl Pending {
    fn sweep(&mut self, now: u64) {
        self.sign_ins
            .retain(|_, p| now.saturating_sub(p.created_ms) < millis(PENDING_TOTP_TTL));
        self.enrolments
            .retain(|_, p| now.saturating_sub(p.created_ms) < millis(TOTP_ENROLMENT_TTL));
        while self.sign_ins.len() >= MAX_PENDING_TOTP {
            let oldest = self
                .sign_ins
                .iter()
                .min_by_key(|(_, p)| p.created_ms)
                .map(|(k, _)| *k);
            match oldest {
                Some(k) => self.sign_ins.remove(&k),
                None => break,
            };
        }
        while self.enrolments.len() >= MAX_PENDING_TOTP {
            let oldest = self
                .enrolments
                .iter()
                .min_by_key(|(_, p)| p.created_ms)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => self.enrolments.remove(&k),
                None => break,
            };
        }
    }
}

struct Inner<S, H> {
    store: S,
    hooks: H,
    sessions: Arc<LoginSessions>,
    clock: Arc<dyn Clock>,
    routes: LoginRoutes,
    config: AccountsConfig,
    hasher: PasswordHasher,
    guards: Mutex<Guards>,
    pending: Mutex<Pending>,
}

/// The built-in accounts. See the [module docs](self).
pub struct Accounts<S, H> {
    inner: Arc<Inner<S, H>>,
}

impl<S, H> Clone for Accounts<S, H> {
    fn clone(&self) -> Self {
        Accounts {
            inner: Arc::clone(&self.inner),
        }
    }
}

/// A sign-in that passed every check.
struct Proven {
    account: Account,
}

/// What a failed attempt answers.
enum Refused {
    /// `401 invalid` (wrong user name or password, a locked account, a used or expired link).
    Invalid,
    /// `403 disabled`: the password was right but the account is disabled.
    Disabled,
    /// `429`.
    TooMany,
    /// `500`.
    Internal,
}

impl<S: AccountStore, H: AccountHooks> Accounts<S, H> {
    /// `routes` is shared with the OIDC sign-in: the public origin, base path, session cookie,
    /// pre-session cookie and anti-CSRF header. `hasher` is [`PasswordHasher::new`] outside
    /// tests.
    pub fn new(
        store: S,
        hooks: H,
        sessions: Arc<LoginSessions>,
        routes: LoginRoutes,
        config: AccountsConfig,
        hasher: PasswordHasher,
        clock: Arc<dyn Clock>,
    ) -> Accounts<S, H> {
        Accounts {
            inner: Arc::new(Inner {
                store,
                hooks,
                sessions,
                clock,
                routes,
                config,
                hasher,
                guards: Mutex::default(),
                pending: Mutex::default(),
            }),
        }
    }

    pub fn store(&self) -> &S {
        &self.inner.store
    }

    pub fn sessions(&self) -> &Arc<LoginSessions> {
        &self.inner.sessions
    }

    pub fn signup(&self) -> Signup {
        self.inner.config.signup
    }

    pub fn config(&self) -> &AccountsConfig {
        &self.inner.config
    }

    pub fn hasher(&self) -> &PasswordHasher {
        &self.inner.hasher
    }

    /// `/auth/signup`, `/auth/password`, `/auth/totp` and `/auth/setup` under the base path.
    pub fn routes(&self) -> Router {
        let base = &self.inner.routes.base_path;
        Router::new()
            .route(&format!("{base}/auth/signup"), post(signup::<S, H>))
            .route(&format!("{base}/auth/password"), post(password::<S, H>))
            .route(&format!("{base}/auth/totp"), post(totp_code::<S, H>))
            .route(&format!("{base}/auth/setup"), post(setup::<S, H>))
            .layer(DefaultBodyLimit::max(MAX_BODY))
            .with_state(Arc::clone(&self.inner))
    }

    /// The pre-session token for a signed-out page: the browser's own when its cookie holds a
    /// well-formed one, else a new one with the cookie to set.
    pub fn pre_session(&self, headers: &HeaderMap) -> PreSession {
        if let Some(token) = web::cookie(headers, &self.inner.routes.pre_cookie)
            && is_token(token)
        {
            return PreSession {
                token: token.to_owned(),
                set_cookie: None,
            };
        }
        let token = random_hex();
        let set_cookie = web::set_cookie(
            &self.inner.routes.pre_cookie,
            &token,
            SameSite::Strict,
            None,
        );
        PreSession {
            token,
            set_cookie: Some(set_cookie),
        }
    }

    /// Makes an account (for an administrator's `admin.users.create`, or the server's default
    /// administrator). With `password` the account signs in with it; without, it has no password
    /// until a setup link sets one. The user name is checked; the password is not checked
    /// against the policy (the caller generated it or will send a setup link).
    pub async fn create_account(
        &self,
        username: &str,
        display_name: Option<&str>,
        password: Option<Zeroizing<String>>,
        must_change_password: bool,
        created_by: CreatedBy,
    ) -> Result<Account, CreateAccountError> {
        let username = normalize_username(username).ok_or(CreateAccountError::InvalidUsername)?;
        let display_name = match display_name {
            Some(name) => valid_display_name(name).ok_or(CreateAccountError::InvalidDisplayName)?,
            None => username.clone(),
        };
        let password_hash = match password {
            Some(password) => Some(
                self.inner
                    .hasher
                    .hash(password)
                    .await
                    .map_err(|_| CreateAccountError::Hash)?,
            ),
            None => None,
        };
        let account = Account {
            id: new_ulid(self.inner.clock.now_unix_ms()),
            username,
            display_name,
            password_hash,
            must_change_password,
            created_by,
            created_ms: self.inner.clock.now_unix_ms(),
            last_seen_ms: None,
            disabled: false,
            locked_until_ms: None,
            totp: None,
            recovery_codes: vec![],
        };
        match self.inner.store.create(account.clone()).await {
            Ok(()) => Ok(account),
            Err(CreateError::UsernameTaken) => Err(CreateAccountError::UsernameTaken),
            Err(CreateError::Store(e)) => Err(CreateAccountError::Store(e)),
        }
    }

    /// A one-time setup link for an account (`admin.users.create`, `admin.users.resetPassword`):
    /// 32 random bytes kept as SHA-256, valid [`SETUP_LINK_TTL`]. The caller ends the account's
    /// sessions when it resets a password.
    pub async fn create_setup_link(&self, account_id: &str) -> Result<SetupLink, StoreError> {
        let token = Zeroizing::new(random_hex());
        let expires_ms = self
            .inner
            .clock
            .now_unix_ms()
            .saturating_add(millis(SETUP_LINK_TTL));
        self.inner
            .store
            .put_setup_token(sha256(token.as_bytes()), account_id, expires_ms)
            .await?;
        let routes = &self.inner.routes;
        Ok(SetupLink {
            url: Zeroizing::new(format!(
                "{}{}/auth/setup?token={}",
                routes.public_origin,
                routes.base_path,
                token.as_str()
            )),
            expires_ms,
        })
    }

    /// Unlocks an account (an administrator's unlock, `reset-admin`) and forgets its failures.
    pub async fn unlock(&self, account_id: &str) -> Result<(), StoreError> {
        self.inner.store.set_locked_until(account_id, None).await?;
        self.inner.guards().accounts.clear(&account_id.to_owned());
        Ok(())
    }

    /// `app.account.changePassword { current, new }` for the session `session_id` of `user`
    /// (`human:account:<id>`). Ends the account's other sessions and lifts this one's
    /// `mustChangePassword` restriction. A wrong current password counts towards the lockout.
    pub async fn change_password(
        &self,
        user: &str,
        session_id: &str,
        current: Zeroizing<String>,
        new: Zeroizing<String>,
        client: Option<IpAddr>,
    ) -> Result<(), ChangePasswordError> {
        let inner = &self.inner;
        let id = account_id_of(user).ok_or(ChangePasswordError::NotAnAccount)?;
        let account = inner.store.by_id(id).await?;
        let hash = account.as_ref().and_then(|a| a.password_hash.clone());
        let matches = inner.hasher.verify(current, hash).await;
        let Some(account) = account else {
            return Err(ChangePasswordError::NotAnAccount);
        };
        let now = inner.clock.now_unix_ms();
        if !matches || account.locked_until_ms.is_some_and(|until| now < until) {
            self.failed(Some(&account), matches, client, "wrong current password")
                .await;
            return Err(ChangePasswordError::WrongPassword);
        }
        check_policy(&account.username, &new).map_err(ChangePasswordError::Rejected)?;
        let hash = inner
            .hasher
            .hash(new)
            .await
            .map_err(|_| ChangePasswordError::Hash)?;
        inner.store.set_password(&account.id, hash, false).await?;
        inner
            .sessions
            .revoke_user_except(user, Some(session_id), Some(user));
        inner.sessions.set_must_change(session_id, false);
        inner.guards().accounts.clear(&account.id);
        inner.hooks.password_changed(&account);
        Ok(())
    }

    /// Whether `auth.require_totp` applies to the account.
    pub fn totp_required(&self, account: &Account) -> bool {
        match self.inner.config.require_totp {
            RequireTotp::None => false,
            RequireTotp::All => true,
            RequireTotp::Admins => self.inner.hooks.is_administrator(account),
        }
    }

    /// `app.account.totp.begin`: a new key for the caller's account, kept for
    /// [`TOTP_ENROLMENT_TTL`] until [`Accounts::totp_confirm`]; the URI and its QR image are
    /// shown once. An enrolled account may begin again to replace its key.
    pub async fn totp_begin(&self, user: &str) -> Result<TotpEnrolment, TotpError> {
        let inner = &self.inner;
        let id = account_id_of(user).ok_or(TotpError::NotAnAccount)?;
        let account = inner
            .store
            .by_id(id)
            .await?
            .ok_or(TotpError::NotAnAccount)?;
        let key = totp::new_key();
        let uri =
            totp::uri(&key, &inner.config.totp_issuer, &account.username).ok_or(TotpError::Hash)?;
        let qr_svg = Zeroizing::new(totp::qr_svg(&uri).ok_or(TotpError::Hash)?);
        let now = inner.clock.now_unix_ms();
        let mut pending = inner.pending();
        pending.sweep(now);
        pending.enrolments.insert(
            account.id,
            PendingEnrolment {
                key,
                created_ms: now,
            },
        );
        Ok(TotpEnrolment { uri, qr_svg })
    }

    /// `app.account.totp.confirm { code }`: turns TOTP on when the code matches the key begun,
    /// and answers [`RECOVERY_CODES`] recovery codes, shown once and kept as Argon2id hashes.
    /// Lifts the session's `mustEnrolTotp` restriction.
    pub async fn totp_confirm(
        &self,
        user: &str,
        session_id: &str,
        code: &str,
    ) -> Result<Vec<Zeroizing<String>>, TotpError> {
        let inner = &self.inner;
        let id = account_id_of(user).ok_or(TotpError::NotAnAccount)?;
        let now = inner.clock.now_unix_ms();
        let key = {
            let mut pending = inner.pending();
            pending.sweep(now);
            let enrolment = pending.enrolments.get(id).ok_or(TotpError::NoEnrolment)?;
            enrolment.key.clone()
        };
        let step = totp::check(&key, code.trim(), now).ok_or(TotpError::WrongCode)?;
        let mut codes = Vec::with_capacity(RECOVERY_CODES);
        let mut hashes = Vec::with_capacity(RECOVERY_CODES);
        for _ in 0..RECOVERY_CODES {
            let code = totp::new_recovery_code();
            let plain = totp::normalize_recovery_code(&code).ok_or(TotpError::Hash)?;
            hashes.push(
                inner
                    .hasher
                    .hash(plain)
                    .await
                    .map_err(|_| TotpError::Hash)?,
            );
            codes.push(code);
        }
        inner
            .store
            .set_totp(
                id,
                Some(TotpRecord {
                    key,
                    last_step: step,
                    enrolled_ms: now,
                }),
                hashes,
            )
            .await?;
        inner.pending().enrolments.remove(id);
        inner.sessions.set_must_enrol(session_id, false);
        Ok(codes)
    }

    /// `app.account.totp.remove { current }`: the owner removes their second factor, giving the
    /// current password (a wrong one counts towards the lockout). Refused when
    /// `auth.require_totp` applies to the account.
    pub async fn totp_remove(
        &self,
        user: &str,
        current: Zeroizing<String>,
        client: Option<IpAddr>,
    ) -> Result<(), TotpError> {
        let inner = &self.inner;
        let id = account_id_of(user).ok_or(TotpError::NotAnAccount)?;
        let account = inner.store.by_id(id).await?;
        let hash = account.as_ref().and_then(|a| a.password_hash.clone());
        let matches = inner.hasher.verify(current, hash).await;
        let Some(account) = account else {
            return Err(TotpError::NotAnAccount);
        };
        let now = inner.clock.now_unix_ms();
        if !matches || account.locked_until_ms.is_some_and(|until| now < until) {
            self.failed(Some(&account), matches, client, "wrong current password")
                .await;
            return Err(TotpError::WrongPassword);
        }
        if self.totp_required(&account) {
            return Err(TotpError::Required);
        }
        inner.store.set_totp(id, None, vec![]).await?;
        Ok(())
    }

    /// Removes an account's TOTP and recovery codes (an administrator's reset with
    /// `removeTotp`, `reset-admin`).
    pub async fn clear_totp(&self, account_id: &str) -> Result<(), StoreError> {
        self.inner.store.set_totp(account_id, None, vec![]).await
    }

    /// Answers a proven password of an account with TOTP: a pending sign-in, bound to the
    /// browser by a cookie, that `/auth/totp` completes.
    fn await_code(&self, proven: Proven, next: &str) -> Response {
        let inner = &self.inner;
        let now = inner.clock.now_unix_ms();
        let token = Zeroizing::new(random_hex());
        {
            let mut pending = inner.pending();
            pending.sweep(now);
            pending.sign_ins.insert(
                sha256(token.as_bytes()),
                PendingSignIn {
                    account_id: proven.account.id,
                    next: next.to_owned(),
                    created_ms: now,
                    attempts: 0,
                },
            );
        }
        let mut response = answer(StatusCode::OK, json!({ "totp": true }));
        response.headers_mut().append(
            header::SET_COOKIE,
            web::set_cookie(
                &inner.routes.totp_cookie,
                &token,
                SameSite::Strict,
                Some(PENDING_TOTP_TTL.as_secs()),
            ),
        );
        response
    }

    /// Checks a second factor: a six-digit code whose step was not used yet, or an unused
    /// recovery code (then removed). `Err` holds the reason for the events.
    async fn check_code(&self, account: &Account, code: &str) -> Result<(), &'static str> {
        let inner = &self.inner;
        let Some(record) = account.totp.as_ref() else {
            return Err("no second factor enrolled");
        };
        if totp::is_totp_code(code) {
            let now = inner.clock.now_unix_ms();
            let Some(step) = totp::check(&record.key, code, now) else {
                return Err("wrong code");
            };
            return match inner.store.advance_totp_step(&account.id, step).await {
                Ok(true) => Ok(()),
                Ok(false) => Err("code already used"),
                Err(_) => Err("store failure"),
            };
        }
        let Some(plain) = totp::normalize_recovery_code(code) else {
            return Err("wrong code");
        };
        for hash in &account.recovery_codes {
            if inner.hasher.verify(plain.clone(), Some(hash.clone())).await {
                return match inner.store.remove_recovery_code(&account.id, hash).await {
                    Ok(true) => Ok(()),
                    Ok(false) => Err("recovery code already used"),
                    Err(_) => Err("store failure"),
                };
            }
        }
        Err("wrong recovery code")
    }

    /// Counts a failure for the client address and, when the password was checked and wrong,
    /// for the account, locking it at the fifth within the window.
    async fn failed(
        &self,
        account: Option<&Account>,
        password_matched: bool,
        client: Option<IpAddr>,
        reason: &str,
    ) {
        let inner = &self.inner;
        let now = inner.clock.now_unix_ms();
        let address = address_key(client);
        let lock = {
            let mut guards = inner.guards();
            if guards.addresses.record(&address, now, ADDRESS_WINDOW_MS) >= ADDRESS_FAILURES {
                guards
                    .addresses
                    .block(&address, now + ADDRESS_WINDOW_MS, now);
            }
            match account {
                Some(account)
                    if !password_matched
                        && !account.locked_until_ms.is_some_and(|until| now < until) =>
                {
                    let count = guards.accounts.record(&account.id, now, ACCOUNT_WINDOW_MS);
                    if count >= ACCOUNT_FAILURES {
                        guards.accounts.clear(&account.id);
                        Some(now + ACCOUNT_WINDOW_MS)
                    } else {
                        None
                    }
                }
                _ => None,
            }
        };
        let who = account
            .map(|a| format!(" ({})", a.principal_id()))
            .unwrap_or_default();
        inner.hooks.record(AuthEvent::SignInFailed {
            error: LoginError::Invalid,
            reason: format!("{reason}{who}"),
            client,
        });
        if let (Some(until), Some(account)) = (lock, account) {
            // The lock is kept with the account, so an administrator (or `reset-admin`) can
            // lift it. A store failure leaves the account unlocked: the address limit still holds.
            let _ = inner.store.set_locked_until(&account.id, Some(until)).await;
            inner.hooks.record(AuthEvent::Lockout {
                user: account.principal_id(),
                client,
                until_ms: until,
            });
        }
    }

    /// Checks a user name and password: one hash whatever happens.
    async fn prove(
        &self,
        username: &str,
        password: Zeroizing<String>,
        client: Option<IpAddr>,
    ) -> Result<Proven, Refused> {
        let inner = &self.inner;
        let account = match normalize_username(username) {
            Some(name) => match inner.store.by_username(&name).await {
                Ok(found) => found,
                Err(_) => {
                    // Still one hash, so a store failure is not a timing signal either.
                    inner.hasher.verify(password, None).await;
                    return Err(Refused::Internal);
                }
            },
            None => None,
        };
        let hash = account.as_ref().and_then(|a| a.password_hash.clone());
        let matches = inner.hasher.verify(password, hash).await;
        let now = inner.clock.now_unix_ms();
        let Some(account) = account else {
            self.failed(None, false, client, "unknown user name").await;
            return Err(Refused::Invalid);
        };
        if account.locked_until_ms.is_some_and(|until| now < until) {
            self.failed(Some(&account), matches, client, "account locked")
                .await;
            return Err(Refused::Invalid);
        }
        if !matches {
            let reason = if account.password_hash.is_none() {
                "no password set"
            } else {
                "wrong password"
            };
            self.failed(Some(&account), false, client, reason).await;
            return Err(Refused::Invalid);
        }
        if account.disabled {
            inner.hooks.record(AuthEvent::SignInFailed {
                error: LoginError::Disabled,
                reason: format!("the account is disabled ({})", account.principal_id()),
                client,
            });
            return Err(Refused::Disabled);
        }
        // The failures are forgotten once every factor passed (`start_session`), so a known
        // password does not reset the count of wrong codes.
        if account.locked_until_ms.is_some() {
            let _ = inner.store.set_locked_until(&account.id, None).await;
        }
        Ok(Proven { account })
    }

    /// Creates the session for a proven account and answers with its cookie.
    async fn start_session(
        &self,
        proven: Proven,
        headers: &HeaderMap,
        client: Option<IpAddr>,
        next: &str,
        method: LoginMethod,
    ) -> Response {
        let inner = &self.inner;
        let account = proven.account;
        inner.guards().accounts.clear(&account.id);
        let must_enrol_totp = account.totp.is_none() && self.totp_required(&account);
        let signed_in = match inner.hooks.sign_in(&account).await {
            Ok(signed_in) => signed_in,
            Err(SignInRefusal::Disabled) => {
                inner.hooks.record(AuthEvent::SignInFailed {
                    error: LoginError::Disabled,
                    reason: format!("the user is disabled ({})", account.principal_id()),
                    client,
                });
                return answer(StatusCode::FORBIDDEN, json!({ "error": "disabled" }));
            }
        };
        if let Some(old) = web::cookie(headers, &inner.routes.session_cookie)
            && let Some(info) = inner.sessions.peek(old)
        {
            inner.sessions.end(&info.id, EndReason::Replaced, None);
        }
        let now = inner.clock.now_unix_ms();
        let roles = signed_in
            .principal
            .roles
            .iter()
            .map(|r| r.as_str().to_owned())
            .collect();
        let issued = match inner.sessions.create(NewSession {
            user: signed_in.user.clone(),
            principal: signed_in.principal,
            groups: vec![],
            method,
            auth_time_ms: now,
            id_token: None,
            client,
            must_change_password: account.must_change_password,
            must_enrol_totp,
        }) {
            Ok(issued) => issued,
            Err(_) => {
                inner.hooks.record(AuthEvent::SignInFailed {
                    error: LoginError::Busy,
                    reason: "too many sessions".into(),
                    client,
                });
                return answer(StatusCode::SERVICE_UNAVAILABLE, json!({ "error": "busy" }));
            }
        };
        let _ = inner.store.set_last_seen(&account.id, now).await;
        inner.hooks.record(AuthEvent::SignedIn {
            user: signed_in.user,
            session: issued.session_id.clone(),
            method,
            client,
            groups: 0,
            roles,
        });
        let mut response = answer(
            StatusCode::OK,
            json!({
                "ok": true,
                "next": next,
                "mustChangePassword": account.must_change_password,
                "mustEnrolTotp": must_enrol_totp,
            }),
        );
        response.headers_mut().append(
            header::SET_COOKIE,
            web::set_cookie(
                &inner.routes.session_cookie,
                &issued.cookie,
                SameSite::Strict,
                None,
            ),
        );
        response
    }
}

/// Why [`Accounts::create_account`] failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateAccountError {
    InvalidUsername,
    InvalidDisplayName,
    UsernameTaken,
    Hash,
    Store(StoreError),
}

impl fmt::Display for CreateAccountError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CreateAccountError::InvalidUsername => {
                f.write_str("a user name is 3 to 64 characters of a-z 0-9 . _ -")
            }
            CreateAccountError::InvalidDisplayName => {
                f.write_str("a display name is 1 to 128 printable characters")
            }
            CreateAccountError::UsernameTaken => f.write_str("this user name is taken"),
            CreateAccountError::Hash => f.write_str("the password could not be hashed"),
            CreateAccountError::Store(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for CreateAccountError {}

impl<S, H> Inner<S, H> {
    fn guards(&self) -> MutexGuard<'_, Guards> {
        // The counters hold no invariant a panicking writer could break.
        self.guards.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn pending(&self) -> MutexGuard<'_, Pending> {
        // Each map entry is inserted or removed whole.
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The user name in lower case, if it is 3 to 64 of `a-z 0-9 . _ -`.
pub fn normalize_username(username: &str) -> Option<String> {
    let lower = username.to_ascii_lowercase();
    let ok = (MIN_USERNAME..=MAX_USERNAME).contains(&lower.len())
        && lower.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        });
    ok.then_some(lower)
}

/// A display name: trimmed, 1 to 128 characters, no control characters.
fn valid_display_name(name: &str) -> Option<String> {
    let name = name.trim();
    let count = name.chars().count();
    ((1..=MAX_DISPLAY_NAME).contains(&count) && !name.chars().any(char::is_control))
        .then(|| name.to_owned())
}

/// A ULID: 48 bits of Unix milliseconds and 80 random bits, Crockford base32.
pub fn new_ulid(now_ms: u64) -> String {
    const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let random = random_bytes::<10>();
    let mut value: u128 = u128::from(now_ms & 0xFFFF_FFFF_FFFF) << 80;
    for (i, b) in random.iter().enumerate() {
        value |= u128::from(*b) << (8 * (9 - i));
    }
    (0..26)
        .rev()
        .map(|i| char::from(ALPHABET[((value >> (i * 5)) & 31) as usize]))
        .collect()
}

fn is_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// Requests without a peer address (in-process tests) share one key.
fn address_key(client: Option<IpAddr>) -> IpAddr {
    client.unwrap_or(IpAddr::V6(Ipv6Addr::UNSPECIFIED))
}

fn answer(status: StatusCode, body: Value) -> Response {
    let mut response = (status, body.to_string()).into_response();
    let headers = response.headers_mut();
    web::auth_headers(headers);
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    if status == StatusCode::TOO_MANY_REQUESTS {
        headers.insert(header::RETRY_AFTER, HeaderValue::from_static("900"));
    }
    response
}

fn refused(refusal: Refused) -> Response {
    match refusal {
        Refused::Invalid => answer(StatusCode::UNAUTHORIZED, json!({ "error": "invalid" })),
        Refused::Disabled => answer(StatusCode::FORBIDDEN, json!({ "error": "disabled" })),
        Refused::TooMany => answer(
            StatusCode::TOO_MANY_REQUESTS,
            json!({ "error": "too_many" }),
        ),
        Refused::Internal => answer(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "internal" }),
        ),
    }
}

/// The checks every account route makes before reading the body: the exact `Origin`, a JSON
/// body, and the pre-session token in the anti-CSRF header equal to the pre-session cookie.
fn cross_site_check(routes: &LoginRoutes, headers: &HeaderMap) -> Option<Response> {
    let forbidden = || answer(StatusCode::FORBIDDEN, json!({ "error": "forbidden" }));
    if web::single_header(headers, header::ORIGIN) != Some(routes.public_origin.as_str()) {
        return Some(forbidden());
    }
    let json_body = web::single_header(headers, header::CONTENT_TYPE).is_some_and(|ct| {
        ct.split(';')
            .next()
            .is_some_and(|t| t.trim().eq_ignore_ascii_case("application/json"))
    });
    if !json_body {
        return Some(answer(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            json!({ "error": "json_only" }),
        ));
    }
    let cookie = web::cookie(headers, &routes.pre_cookie).unwrap_or("");
    let given = web::single_header(headers, routes.csrf_header.clone()).unwrap_or("");
    if !is_token(cookie) || !constant_time_eq(cookie.as_bytes(), given.as_bytes()) {
        return Some(forbidden());
    }
    None
}

fn client_of(ext: Option<&ClientAddr>) -> Option<IpAddr> {
    ext.map(|c| c.0.ip())
}

fn parse<T: for<'de> Deserialize<'de>>(body: &[u8]) -> Option<T> {
    serde_json::from_slice(body).ok()
}

fn bad_request() -> Response {
    answer(StatusCode::BAD_REQUEST, json!({ "error": "bad_request" }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignupBody {
    username: String,
    display_name: Option<String>,
    password: Zeroizing<String>,
    next: Option<String>,
}

#[derive(Deserialize)]
struct PasswordBody {
    username: String,
    password: Zeroizing<String>,
    next: Option<String>,
}

#[derive(Deserialize)]
struct TotpBody {
    code: Zeroizing<String>,
}

#[derive(Deserialize)]
struct SetupBody {
    token: Zeroizing<String>,
    password: Zeroizing<String>,
    next: Option<String>,
}

/// The address limit: 429 while the client address is blocked.
fn address_blocked<S, H: AccountHooks>(
    inner: &Inner<S, H>,
    client: Option<IpAddr>,
    route: &'static str,
) -> bool {
    let now = inner.clock.now_unix_ms();
    let address = address_key(client);
    let blocked = inner.guards().addresses.blocked(&address, now);
    if blocked {
        inner.hooks.record(AuthEvent::RateLimited {
            route,
            client: address,
        });
    }
    blocked
}

async fn signup<S: AccountStore, H: AccountHooks>(
    State(inner): State<Arc<Inner<S, H>>>,
    client: Option<axum::Extension<ClientAddr>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let accounts = Accounts { inner };
    let inner = &accounts.inner;
    let client = client_of(client.as_deref());
    if let Some(response) = cross_site_check(&inner.routes, &headers) {
        return response;
    }
    if inner.config.signup == Signup::Off {
        return answer(StatusCode::FORBIDDEN, json!({ "error": "signup_off" }));
    }
    let now = inner.clock.now_unix_ms();
    let address = address_key(client);
    if inner
        .guards()
        .signups
        .record(&address, now, SIGNUP_WINDOW_MS)
        > SIGNUPS_PER_HOUR
    {
        inner.hooks.record(AuthEvent::RateLimited {
            route: "/auth/signup",
            client: address,
        });
        return refused(Refused::TooMany);
    }
    let body: SignupBody = match parse(&body) {
        Some(body) => body,
        None => return bad_request(),
    };
    let Some(username) = normalize_username(&body.username) else {
        return answer(
            StatusCode::BAD_REQUEST,
            json!({ "error": "invalid_username" }),
        );
    };
    let display_name = match body.display_name.as_deref() {
        Some(name) => match valid_display_name(name) {
            Some(name) => Some(name),
            None => {
                return answer(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": "invalid_display_name" }),
                );
            }
        },
        None => None,
    };
    if let Err(rejection) = check_policy(&username, &body.password) {
        return answer(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({ "error": "weak_password", "reason": rejection.as_str() }),
        );
    }
    let account = match accounts
        .create_account(
            &username,
            display_name.as_deref(),
            Some(body.password),
            false,
            CreatedBy::SelfSignup,
        )
        .await
    {
        Ok(account) => account,
        Err(CreateAccountError::UsernameTaken) => {
            return answer(StatusCode::CONFLICT, json!({ "error": "username_taken" }));
        }
        Err(_) => return refused(Refused::Internal),
    };
    inner.hooks.record(AuthEvent::SignedUp {
        user: account.principal_id(),
        client,
    });
    let next = web::safe_next(body.next.as_deref(), &inner.routes.base_path);
    accounts
        .start_session(
            Proven { account },
            &headers,
            client,
            &next,
            LoginMethod::Password,
        )
        .await
}

async fn password<S: AccountStore, H: AccountHooks>(
    State(inner): State<Arc<Inner<S, H>>>,
    client: Option<axum::Extension<ClientAddr>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let accounts = Accounts { inner };
    let inner = &accounts.inner;
    let client = client_of(client.as_deref());
    if let Some(response) = cross_site_check(&inner.routes, &headers) {
        return response;
    }
    if address_blocked(inner, client, "/auth/password") {
        return refused(Refused::TooMany);
    }
    let body: PasswordBody = match parse(&body) {
        Some(body) => body,
        None => return bad_request(),
    };
    let next = web::safe_next(body.next.as_deref(), &inner.routes.base_path);
    match accounts.prove(&body.username, body.password, client).await {
        Ok(proven) if proven.account.totp.is_some() => accounts.await_code(proven, &next),
        Ok(proven) => {
            accounts
                .start_session(proven, &headers, client, &next, LoginMethod::Password)
                .await
        }
        Err(refusal) => refused(refusal),
    }
}

async fn setup<S: AccountStore, H: AccountHooks>(
    State(inner): State<Arc<Inner<S, H>>>,
    client: Option<axum::Extension<ClientAddr>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let accounts = Accounts { inner };
    let inner = &accounts.inner;
    let client = client_of(client.as_deref());
    if let Some(response) = cross_site_check(&inner.routes, &headers) {
        return response;
    }
    if address_blocked(inner, client, "/auth/setup") {
        return refused(Refused::TooMany);
    }
    let body: SetupBody = match parse(&body) {
        Some(body) => body,
        None => return bad_request(),
    };
    let now = inner.clock.now_unix_ms();
    let token_hash = sha256(body.token.as_bytes());
    let invalid_link = async || {
        accounts
            .failed(None, false, client, "setup link unknown, used or expired")
            .await;
        answer(StatusCode::UNAUTHORIZED, json!({ "error": "invalid_link" }))
    };
    // Look first, take last: a password the policy refuses does not use the link up.
    let account = match inner.store.peek_setup_token(token_hash, now).await {
        Ok(Some(id)) => match inner.store.by_id(&id).await {
            Ok(Some(account)) => account,
            Ok(None) => return invalid_link().await,
            Err(_) => return refused(Refused::Internal),
        },
        Ok(None) => return invalid_link().await,
        Err(_) => return refused(Refused::Internal),
    };
    if let Err(rejection) = check_policy(&account.username, &body.password) {
        return answer(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({ "error": "weak_password", "reason": rejection.as_str() }),
        );
    }
    let Ok(hash) = inner.hasher.hash(body.password).await else {
        return refused(Refused::Internal);
    };
    match inner.store.take_setup_token(token_hash, now).await {
        Ok(Some(id)) if id == account.id => {}
        Ok(_) => return invalid_link().await,
        Err(_) => return refused(Refused::Internal),
    }
    if inner
        .store
        .set_password(&account.id, hash, false)
        .await
        .is_err()
        || inner
            .store
            .set_locked_until(&account.id, None)
            .await
            .is_err()
    {
        return refused(Refused::Internal);
    }
    inner.guards().accounts.clear(&account.id);
    let account = Account {
        must_change_password: false,
        locked_until_ms: None,
        ..account
    };
    inner.hooks.password_changed(&account);
    if account.disabled {
        return refused(Refused::Disabled);
    }
    let next = web::safe_next(body.next.as_deref(), &inner.routes.base_path);
    accounts
        .start_session(
            Proven { account },
            &headers,
            client,
            &next,
            LoginMethod::Password,
        )
        .await
}

async fn totp_code<S: AccountStore, H: AccountHooks>(
    State(inner): State<Arc<Inner<S, H>>>,
    client: Option<axum::Extension<ClientAddr>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let accounts = Accounts { inner };
    let inner = &accounts.inner;
    let client = client_of(client.as_deref());
    if let Some(response) = cross_site_check(&inner.routes, &headers) {
        return response;
    }
    if address_blocked(inner, client, "/auth/totp") {
        return refused(Refused::TooMany);
    }
    let body: TotpBody = match parse(&body) {
        Some(body) => body,
        None => return bad_request(),
    };
    let now = inner.clock.now_unix_ms();
    let expired = || {
        let mut response = answer(StatusCode::UNAUTHORIZED, json!({ "error": "expired" }));
        response.headers_mut().append(
            header::SET_COOKIE,
            web::clear_cookie(&inner.routes.totp_cookie, SameSite::Strict),
        );
        response
    };
    let Some(cookie) = web::cookie(&headers, &inner.routes.totp_cookie) else {
        return expired();
    };
    let key = sha256(cookie.as_bytes());
    let (account_id, next) = {
        let mut pending = inner.pending();
        pending.sweep(now);
        match pending.sign_ins.get(&key) {
            Some(p) => (p.account_id.clone(), p.next.clone()),
            None => return expired(),
        }
    };
    let account = match inner.store.by_id(&account_id).await {
        Ok(Some(account)) => account,
        Ok(None) => return expired(),
        Err(_) => return refused(Refused::Internal),
    };
    let locked = account.locked_until_ms.is_some_and(|until| now < until);
    let checked = if locked {
        Err("account locked")
    } else {
        accounts.check_code(&account, body.code.trim()).await
    };
    if let Err(reason) = checked {
        accounts
            .failed(Some(&account), locked, client, reason)
            .await;
        let mut pending = inner.pending();
        if let Some(p) = pending.sign_ins.get_mut(&key) {
            p.attempts += 1;
            if p.attempts >= PENDING_TOTP_ATTEMPTS {
                pending.sign_ins.remove(&key);
            }
        }
        return refused(Refused::Invalid);
    }
    inner.pending().sign_ins.remove(&key);
    if account.disabled {
        return refused(Refused::Disabled);
    }
    let mut response = accounts
        .start_session(
            Proven { account },
            &headers,
            client,
            &next,
            LoginMethod::Totp,
        )
        .await;
    response.headers_mut().append(
        header::SET_COOKIE,
        web::clear_cookie(&inner.routes.totp_cookie, SameSite::Strict),
    );
    response
}
