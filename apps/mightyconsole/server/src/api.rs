//! The shared procedures of spec §2.7: `app.info`, `app.events` and `term.*`; `app.me` and a
//! built-in account's own `app.account.*` (DOC-25 §3.2.6). Each tool's own
//! procedures (`<tool>.connect`, `<tool>.disconnect`, ...) are in [`crate::tools`].

use std::sync::Arc;

use ambidex::{Ctx, EventSink, RpcError, rpc};
use base64::Engine as _;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast::error::RecvError;
use ts_rs::TS;

use crate::core::{AppEvent, Empty, Hub, TermInput, ToolError, ToolResult};

/// Largest decoded `term.write` payload (spec §2.7).
pub const MAX_TERM_WRITE_BYTES: usize = 64 * 1024;

/// What `app.info` reports about the running server.
#[derive(Debug, Clone)]
pub struct ServerFacts {
    pub listen: String,
    pub public_origin: String,
    pub certificate_fingerprint: String,
}

/// Everything the shared procedures need.
pub struct AppState {
    pub hub: Arc<Hub>,
    pub facts: ServerFacts,
    /// The login sessions, for `app.me`.
    pub sessions: Arc<ambidex_axum::LoginSessions>,
    /// The built-in accounts, for `app.account.*` (`None` only in the codegen router).
    pub accounts: Option<crate::sessions::McAccounts>,
    /// The destroy confirmations, for `app.confirmations.*`.
    pub confirmations: Arc<crate::authz::confirm::Confirmations>,
    /// Roles and users, for `app.me` (`None` only in the codegen router).
    pub management: Option<Arc<crate::management::Management>>,
    /// The secret store, for `admin.secrets.*` (`None` only in the codegen router).
    pub secrets: Option<Arc<crate::secrets::service::SecretService>>,
    /// Stored profiles, for `profiles.*` and `secrets.*` (`None` only in the codegen router).
    pub profiles: Option<Arc<crate::profiles::ProfileService>>,
}

/// A tool built into the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    /// The tool's namespace: `echo`, `nats`, `kafka`, `k8s`, `temporal`, `docker`, `langgraph`.
    pub id: String,
    /// The version of the tool's main library, or of the server for built-in samples.
    pub version: String,
}

/// Output of `app.info`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub api_version: String,
    pub schema_hash: String,
    /// The address the server listens on.
    pub listen: String,
    pub public_origin: String,
    /// SHA-256 of the server certificate, `AB:CD:…`, for About.
    pub certificate_fingerprint: String,
    pub os: String,
    pub tools: Vec<ToolInfo>,
    /// Payload codecs the server decodes (the messaging core, TSK-80).
    pub codecs: Vec<String>,
}

pub struct AppApi(pub Arc<AppState>);

#[rpc::router(namespace = "app")]
impl AppApi {
    /// About and feature gating.
    #[rpc::query(perm = "app.read", risk = Risk::Read)]
    async fn info(&self, _ctx: Ctx, _input: Empty) -> Result<AppInfo, RpcError> {
        let facts = &self.0.facts;
        Ok(AppInfo {
            version: crate::VERSION.into(),
            api_version: crate::API_VERSION.into(),
            schema_hash: crate::SCHEMA_HASH.clone(),
            listen: facts.listen.clone(),
            public_origin: facts.public_origin.clone(),
            certificate_fingerprint: facts.certificate_fingerprint.clone(),
            os: std::env::consts::OS.into(),
            tools: crate::tools::infos(),
            codecs: crate::core::messaging::codec_ids(),
        })
    }

    /// Connection status, stream progress and terminal exits of this connection. One per page;
    /// when it ends (the WebSocket closed, or the page unsubscribed) the connection's live
    /// handles are released.
    #[rpc::subscription(perm = "app.read", risk = Risk::Read)]
    async fn events(
        &self,
        ctx: Ctx,
        _input: Empty,
        events: EventSink<AppEvent>,
    ) -> Result<(), RpcError> {
        let mut guard = self.0.hub.subscribe_as(&ctx.session().id, ctx.principal());
        loop {
            tokio::select! {
                biased;
                () = ctx.cancelled() => return Ok(()),
                received = guard.events.recv() => match received {
                    Ok(event) => events.send(&event).await?,
                    // A slow page missed events; the next ones still describe the state.
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => return Ok(()),
                },
            }
        }
    }
}

/// Input of `term.write`.
#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TermWriteInput {
    pub terminal_id: String,
    /// The bytes typed or pasted, base64; at most 64 KiB decoded.
    pub data: String,
}

// What is typed into a terminal may be a password: never in a log line or a panic message.
impl std::fmt::Debug for TermWriteInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TermWriteInput")
            .field("terminal_id", &self.terminal_id)
            .field("data_len", &self.data.len())
            .finish_non_exhaustive()
    }
}

/// Input of `term.resize`.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TermResizeInput {
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
}

/// What `term.signal` sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TermSignal {
    Interrupt,
    Eof,
}

/// Input of `term.signal`.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TermSignalInput {
    pub terminal_id: String,
    pub signal: TermSignal,
}

pub struct TermApi(pub Arc<AppState>);

#[rpc::router(namespace = "term")]
impl TermApi {
    /// Keystrokes and pastes for a terminal opened by this connection.
    #[rpc::mutation(perm = "term.write", risk = Risk::Write, redact = ["data"])]
    async fn write(&self, ctx: Ctx, input: TermWriteInput) -> ToolResult<Empty> {
        let data = base64::engine::general_purpose::STANDARD
            .decode(input.data.as_bytes())
            .map_err(|_| ToolError::invalid("term", "data", "data must be base64"))?;
        if data.len() > MAX_TERM_WRITE_BYTES {
            return Err(ToolError::invalid(
                "term",
                "data",
                format!("at most {MAX_TERM_WRITE_BYTES} bytes per call"),
            )
            .into());
        }
        self.0
            .hub
            .terminal_input(&ctx.session().id, &input.terminal_id, TermInput::Data(data))
            .await?;
        Ok(Empty {})
    }

    /// The terminal's new size in character cells.
    #[rpc::mutation(perm = "term.write", risk = Risk::Write)]
    async fn resize(&self, ctx: Ctx, input: TermResizeInput) -> ToolResult<Empty> {
        if input.cols == 0 || input.rows == 0 {
            return Err(ToolError::invalid("term", "cols", "the size must be at least 1x1").into());
        }
        self.0
            .hub
            .terminal_input(
                &ctx.session().id,
                &input.terminal_id,
                TermInput::Resize {
                    cols: input.cols,
                    rows: input.rows,
                },
            )
            .await?;
        Ok(Empty {})
    }

    /// Interrupt or end of input, for the toolbar buttons (Ctrl+C and Ctrl+D also arrive as
    /// bytes through `term.write`).
    #[rpc::mutation(perm = "term.write", risk = Risk::Write)]
    async fn signal(&self, ctx: Ctx, input: TermSignalInput) -> ToolResult<Empty> {
        let signal = match input.signal {
            TermSignal::Interrupt => TermInput::Interrupt,
            TermSignal::Eof => TermInput::Eof,
        };
        self.0
            .hub
            .terminal_input(&ctx.session().id, &input.terminal_id, signal)
            .await?;
        Ok(Empty {})
    }
}

/// Output of `app.me`: who is signed in on this connection, and what the session still needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    /// `human:account:<id>` or `human:oidc:<sub>`.
    pub user: String,
    /// The login session (`ls_…`), as the session lists show it.
    pub session: String,
    /// `password`, `totp` or `oidc`.
    pub method: String,
    /// A built-in account (it has a password, and may have TOTP).
    pub account: bool,
    /// The user name of a built-in account.
    pub username: Option<String>,
    pub display_name: Option<String>,
    /// The account has TOTP.
    pub totp: bool,
    /// Only `app.account.changePassword` and `app.me` work until the password is changed.
    pub must_change_password: bool,
    /// Only the TOTP enrolment and `app.me` work until it is done (`auth.require_totp`).
    pub must_enrol_totp: bool,
    /// When the session ends without activity, and at the latest (Unix ms).
    pub idle_expires_ms: u64,
    pub absolute_expires_ms: u64,
    /// An OIDC user's e-mail; shown only.
    pub email: Option<String>,
    /// The server's tenant (`auth.tenant`).
    pub tenant: String,
    /// The roles in force on this session, and how each reached the person (DOC-25 §3.3.7).
    pub roles: Vec<crate::admin_api::RoleGrant>,
    /// What those roles grant, and where, for the UI to adapt. `app.self` is implied and not
    /// listed. On their own personal profiles a person holds every permission of the tool.
    pub permissions: Vec<crate::admin_api::PermissionGrant>,
}

/// Input of `app.account.changePassword`.
#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChangePasswordInput {
    pub current: String,
    pub new: String,
}

// Debug by hand: the passwords never reach a log line, an error or a panic message (TSK-141).
impl std::fmt::Debug for ChangePasswordInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChangePasswordInput")
            .finish_non_exhaustive()
    }
}

/// Input of `app.account.totp.confirm`.
#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TotpConfirmInput {
    /// The six-digit code the authenticator shows.
    pub code: String,
}

impl std::fmt::Debug for TotpConfirmInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TotpConfirmInput").finish_non_exhaustive()
    }
}

/// Input of `app.account.totp.remove`.
#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TotpRemoveInput {
    /// The current password.
    pub current: String,
}

impl std::fmt::Debug for TotpRemoveInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TotpRemoveInput").finish_non_exhaustive()
    }
}

/// Output of `app.account.totp.begin`: shown once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TotpEnrolmentOutput {
    /// The `otpauth://totp/…` URI an authenticator app reads.
    pub uri: String,
    /// Its QR code as an SVG image (no script), made on the server.
    pub qr_svg: String,
}

/// Output of `app.account.totp.confirm`: the recovery codes, shown once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCodes {
    pub codes: Vec<String>,
}

const ACCOUNT: &str = "app";

fn the_accounts(state: &AppState) -> Result<&crate::sessions::McAccounts, ToolError> {
    state.accounts.as_ref().ok_or_else(|| {
        ToolError::new(
            crate::core::ToolErrorKind::Invalid,
            ACCOUNT,
            "built-in accounts are turned off on this server (auth.accounts = false)",
        )
    })
}

fn not_an_account() -> ToolError {
    ToolError::new(
        crate::core::ToolErrorKind::Invalid,
        ACCOUNT,
        "only a built-in account has a password and a second factor",
    )
}

fn store_failed(e: impl std::fmt::Display) -> ToolError {
    ToolError::new(crate::core::ToolErrorKind::Remote, ACCOUNT, e.to_string())
}

#[rpc::router(namespace = "app")]
impl MeApi {
    /// Who is signed in on this connection, and what the session still needs (a password change,
    /// a TOTP enrolment). Always allowed; a call counts as activity for the idle timeout.
    #[rpc::query(perm = "app.self", risk = Risk::Read)]
    async fn me(&self, ctx: Ctx, _input: Empty) -> ToolResult<Me> {
        let user = ctx.principal().id.clone();
        let login = ambidex_axum::login_session_of(&ctx.session().id).to_owned();
        let session = self.0.sessions.get(&login).ok_or_else(|| {
            ToolError::new(
                crate::core::ToolErrorKind::Auth,
                ACCOUNT,
                "the session has ended",
            )
        })?;
        let account = match (
            ambidex_axum::accounts::account_id_of(&user),
            self.0.accounts.as_ref(),
        ) {
            (Some(id), Some(accounts)) => {
                use ambidex_axum::accounts::AccountStore as _;
                accounts.store().by_id(id).await.map_err(store_failed)?
            }
            _ => None,
        };
        let (roles, permissions, email) = match &self.0.management {
            Some(m) => {
                let policy = m.policy.current();
                let in_force = policy.in_force(&user, &session.groups);
                let email = if account.is_none() {
                    let store = Arc::clone(&m.store);
                    let id = user.clone();
                    tokio::task::spawn_blocking(move || store.oidc_user(&id))
                        .await
                        .ok()
                        .and_then(Result::ok)
                        .flatten()
                        .and_then(|u| u.email)
                } else {
                    None
                };
                (
                    crate::admin_api::role_grants(&in_force),
                    crate::admin_api::permission_grants(&policy, &in_force),
                    email,
                )
            }
            None => (Vec::new(), Vec::new(), None),
        };
        Ok(Me {
            tenant: ctx.principal().tenant.to_string(),
            roles,
            permissions,
            email,
            user,
            session: session.id,
            method: session.method.as_str().to_owned(),
            account: account.is_some(),
            username: account.as_ref().map(|a| a.username.clone()),
            display_name: account.as_ref().map(|a| a.display_name.clone()),
            totp: account.as_ref().is_some_and(|a| a.totp.is_some()),
            must_change_password: session.must_change_password,
            must_enrol_totp: session.must_enrol_totp,
            idle_expires_ms: session.idle_expires_ms,
            absolute_expires_ms: session.absolute_expires_ms,
        })
    }
}

/// `app.me`.
pub struct MeApi(pub Arc<AppState>);

/// `app.account.*`: a built-in account's own password (DOC-25 §3.2.6).
pub struct AccountApi(pub Arc<AppState>);

#[rpc::router(namespace = "app.account")]
impl AccountApi {
    /// Changes the caller's password: needs the current one (a wrong one counts towards the
    /// lockout), checks the policy, ends the account's other sessions and lifts this session's
    /// `mustChangePassword`.
    #[rpc::mutation(
        name = "changePassword",
        perm = "app.self",
        risk = Risk::Write,
        redact = ["current", "new"]
    )]
    async fn change_password(&self, ctx: Ctx, input: ChangePasswordInput) -> ToolResult<Empty> {
        use ambidex_axum::accounts::ChangePasswordError as E;
        let accounts = the_accounts(&self.0)?;
        let login = ambidex_axum::login_session_of(&ctx.session().id).to_owned();
        let result = accounts
            .change_password(
                &ctx.principal().id,
                &login,
                zeroize::Zeroizing::new(input.current),
                zeroize::Zeroizing::new(input.new),
                None,
            )
            .await;
        match result {
            Ok(()) => Ok(Empty {}),
            Err(E::NotAnAccount) => Err(not_an_account().into()),
            Err(E::WrongPassword) => {
                Err(ToolError::invalid(ACCOUNT, "current", "the current password is wrong").into())
            }
            Err(E::Rejected(why)) => {
                Err(ToolError::invalid(ACCOUNT, "new", why.to_string()).into())
            }
            Err(e) => Err(store_failed(e).into()),
        }
    }
}

/// `app.account.totp.*`: the caller's second factor (DOC-25 §3.2.6, Open question 8).
pub struct TotpApi(pub Arc<AppState>);

fn totp_error(e: ambidex_axum::accounts::TotpError) -> ToolError {
    use ambidex_axum::accounts::TotpError as E;
    match e {
        E::NotAnAccount => not_an_account(),
        E::NoEnrolment => ToolError::invalid(ACCOUNT, "code", "begin the set-up again"),
        E::WrongCode => ToolError::invalid(ACCOUNT, "code", "the code does not match"),
        E::WrongPassword => ToolError::invalid(ACCOUNT, "current", "the current password is wrong"),
        E::Required => ToolError::new(
            crate::core::ToolErrorKind::Forbidden,
            ACCOUNT,
            "two-step sign-in is required for this account on this server",
        ),
        e => store_failed(e),
    }
}

#[rpc::router(namespace = "app.account.totp")]
impl TotpApi {
    /// Starts setting up TOTP: a new key, shown once as an `otpauth://` URI and its QR image,
    /// kept for 10 minutes until `confirm`. Replaces nothing until then.
    #[rpc::mutation(perm = "app.self", risk = Risk::Write)]
    async fn begin(&self, ctx: Ctx, _input: Empty) -> ToolResult<TotpEnrolmentOutput> {
        let accounts = the_accounts(&self.0)?;
        let enrolment = accounts
            .totp_begin(&ctx.principal().id)
            .await
            .map_err(totp_error)?;
        Ok(TotpEnrolmentOutput {
            uri: enrolment.uri.to_string(),
            qr_svg: enrolment.qr_svg.to_string(),
        })
    }

    /// Turns TOTP on with a code from the new key, and answers 10 recovery codes, shown once.
    #[rpc::mutation(perm = "app.self", risk = Risk::Write, redact = ["code"])]
    async fn confirm(&self, ctx: Ctx, input: TotpConfirmInput) -> ToolResult<RecoveryCodes> {
        let accounts = the_accounts(&self.0)?;
        let login = ambidex_axum::login_session_of(&ctx.session().id).to_owned();
        let codes = accounts
            .totp_confirm(&ctx.principal().id, &login, &input.code)
            .await
            .map_err(totp_error)?;
        Ok(RecoveryCodes {
            codes: codes.iter().map(|c| c.to_string()).collect(),
        })
    }

    /// Removes the caller's TOTP and recovery codes; needs the current password. Refused when
    /// `auth.require_totp` applies to the account.
    #[rpc::mutation(perm = "app.self", risk = Risk::Write, redact = ["current"])]
    async fn remove(&self, ctx: Ctx, input: TotpRemoveInput) -> ToolResult<Empty> {
        let accounts = the_accounts(&self.0)?;
        accounts
            .totp_remove(
                &ctx.principal().id,
                zeroize::Zeroizing::new(input.current),
                None,
            )
            .await
            .map_err(totp_error)?;
        Ok(Empty {})
    }
}

/// Input of `app.confirmations.get`.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationIdInput {
    /// From `ApprovalRequired`'s details.
    pub approval_id: String,
}

/// Input of `app.confirmations.confirm`.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmInput {
    pub approval_id: String,
    /// What the person typed; must equal the phrase exactly (case-sensitive, not trimmed).
    pub typed: String,
}

/// Output of `app.confirmations.get`: what a destroy needs confirmed (DOC-25 §3.3.6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Confirmation {
    /// The procedure, e.g. `nats.kv.delete`.
    pub action: String,
    pub tool: String,
    /// The profile's name; absent for a draft, and for a profile the caller cannot see.
    pub profile_name: Option<String>,
    pub context: Option<String>,
    pub namespace: Option<String>,
    /// `key`, `stream`, `container`, `workflow`, ...
    pub resource_kind: String,
    pub resource_name: String,
    /// What the person types to confirm: the name, its first 12 characters when it is longer
    /// than 32, or a count (`3 containers`).
    pub phrase: String,
    /// When the challenge expires (Unix ms).
    pub expires_at: u64,
    /// Whether the confirmation needs a fresh sign-in (`auth.reauth_for_destroy`; not built yet,
    /// always false).
    pub reauth: bool,
}

const CONFIRMATIONS: &str = "app";

fn confirm_error(e: crate::authz::confirm::ConfirmError) -> RpcError<ToolError> {
    use crate::authz::confirm::ConfirmError as E;
    use crate::core::ToolErrorKind as K;
    match e {
        E::NotFound => ToolError::not_found(
            CONFIRMATIONS,
            "confirmation",
            "this confirmation does not exist or belongs to another session",
        )
        .into(),
        E::Expired => ToolError::new(
            K::Conflict,
            CONFIRMATIONS,
            "this confirmation expired; start the action again",
        )
        .into(),
        E::Answered => ToolError::new(
            K::Conflict,
            CONFIRMATIONS,
            "this confirmation was answered already",
        )
        .into(),
        E::Wrong => {
            ToolError::invalid(CONFIRMATIONS, "typed", "that is not the name to type").into()
        }
        E::Paused { .. } => RpcError::new(
            ambidex::Code::ResourceExhausted,
            "too many wrong answers; wait a minute",
        ),
    }
}

/// `app.confirmations.*`: a person answers the server's destroy challenge (DOC-25 §3.3.6).
pub struct ConfirmationsApi(pub Arc<AppState>);

#[rpc::router(namespace = "app.confirmations")]
impl ConfirmationsApi {
    /// The challenge of a refused Destructive call, to this login session only.
    #[rpc::query(perm = "app.self", risk = Risk::Read)]
    async fn get(&self, ctx: Ctx, input: ConfirmationIdInput) -> ToolResult<Confirmation> {
        let login = ambidex_axum::login_session_of(&ctx.session().id);
        let view = self
            .0
            .confirmations
            .get(login, &input.approval_id)
            .map_err(confirm_error)?;
        // The name of the stored profile the call acts on, as the caller sees it (a profile
        // they cannot see has no name here; a draft or a browser profile has none).
        let profile_name = view
            .target
            .as_ref()
            .and_then(security_types::ProfileTarget::of)
            .and_then(|t| {
                let profiles = self.0.profiles.as_ref()?;
                let (profile, _) = profiles.get(ctx.principal(), t.profile).ok()?;
                Some(profile.name)
            });
        Ok(Confirmation {
            action: view.action,
            tool: view.tool,
            profile_name,
            context: view.context,
            namespace: view.namespace,
            resource_kind: view.subject.kind,
            resource_name: view.subject.name,
            phrase: view.subject.phrase,
            expires_at: view.expires_ms,
            reauth: false,
        })
    }

    /// Confirms the challenge with the typed phrase; the same call sent again within a minute is
    /// then allowed once.
    #[rpc::mutation(perm = "app.self", risk = Risk::Write)]
    async fn confirm(&self, ctx: Ctx, input: ConfirmInput) -> ToolResult<Empty> {
        self.0
            .confirmations
            .confirm(ctx.principal(), &input.approval_id, &input.typed)
            .map_err(confirm_error)?;
        Ok(Empty {})
    }
}
