//! Built-in account conformance (DOC-25 §3.2.6, §6 "Built-in accounts"): the real
//! `ambidex-axum` account routes and session store, served by the WebSocket harness, with
//! accounts in a [`MemoryAccountStore`]. A [`Visitor`] keeps cookies and sends the requests the
//! sign-in page would.
//!
//! Every case runs on a fresh server ([`run`]); times (lockouts, the address limit, setup links,
//! sessions) are on the fixture's [`ManualClock`](crate::ManualClock). Hashes use small Argon2id
//! parameters so the cases stay fast; `ambidex-axum`'s own tests check the spec's parameters.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use ambidex::engine::BoxFuture;
use ambidex_axum::accounts::{
    Account, AccountHooks, Accounts, AccountsConfig, CreatedBy, MemoryAccountStore, PasswordHasher,
    Signup,
};
use ambidex_axum::oidc::{AuthEvent, LoginRoutes, SignInRefusal, SignedIn};
use ambidex_axum::{LoginSessions, NoSessionEvents};
use axum::http::{HeaderMap, header};
use bytes::Bytes;
use http_body_util::Full;
use security_types::{Clock, Principal, PrincipalKind, SessionId, TenantId};
use serde_json::Value;

use crate::client::Client;
use crate::fixture::Fixture;
use crate::harness::Harness;
use crate::oidc::{Answer, LIMITS, send};
use crate::ws::{HOST, ORIGIN, Ws};

/// The anti-CSRF header the routes are configured with.
pub const CSRF_HEADER: &str = "x-test-csrf";
/// The pre-session cookie the routes are configured with.
pub const PRE_COOKIE: &str = "__Host-test_pre";
/// A password every policy check accepts.
pub const GOOD_PASSWORD: &str = "correct horse battery staple";

/// Records every event and maps an account to `human:account:<id>`.
#[derive(Default)]
pub struct RecordingHooks {
    events: Mutex<Vec<AuthEvent>>,
    changed: Mutex<Vec<String>>,
}

impl RecordingHooks {
    pub fn events(&self) -> MutexGuard<'_, Vec<AuthEvent>> {
        self.events.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Accounts whose password changed, in order.
    pub fn changed(&self) -> Vec<String> {
        self.changed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

impl AccountHooks for RecordingHooks {
    fn sign_in<'a>(
        &'a self,
        account: &'a Account,
    ) -> BoxFuture<'a, Result<SignedIn, SignInRefusal>> {
        let user = account.principal_id();
        let principal = Principal {
            kind: PrincipalKind::Human,
            id: user.clone(),
            tenant: TenantId::new("default"),
            on_behalf_of: None,
            roles: vec![],
            session: SessionId::new("set per connection"),
        };
        Box::pin(async move { Ok(SignedIn { user, principal }) })
    }

    fn record(&self, event: AuthEvent) {
        self.events().push(event);
    }

    /// The account named `admin` is the administrator (`auth.require_totp = "admins"`).
    fn is_administrator(&self, account: &Account) -> bool {
        account.username == "admin"
    }

    fn password_changed(&self, account: &Account) {
        self.changed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(account.id.clone());
    }
}

pub type TestAccounts = Accounts<Arc<MemoryAccountStore>, Arc<RecordingHooks>>;

/// A WebSocket harness serving the account routes.
pub struct AccountServer {
    pub ws: Ws,
    pub store: Arc<MemoryAccountStore>,
    pub hooks: Arc<RecordingHooks>,
    pub accounts: TestAccounts,
}

impl AccountServer {
    pub async fn start(signup: Signup) -> AccountServer {
        let mut config = AccountsConfig::new("Conformance");
        config.signup = signup;
        AccountServer::start_with(config).await
    }

    pub async fn start_with(config: AccountsConfig) -> AccountServer {
        let fixture = Fixture::new();
        let clock: Arc<dyn Clock> = fixture.clock.clone();
        let sessions = Arc::new(LoginSessions::new(
            Arc::clone(&clock),
            LIMITS,
            Arc::new(NoSessionEvents),
        ));
        let mut routes = LoginRoutes::new(ORIGIN);
        routes.pre_cookie = PRE_COOKIE.into();
        routes.csrf_header = header::HeaderName::from_static(CSRF_HEADER);
        let store = Arc::new(MemoryAccountStore::new());
        let hooks = Arc::new(RecordingHooks::default());
        let hasher = PasswordHasher::with_params(8, 1, 1, 4).expect("valid parameters");
        let accounts = Accounts::new(
            Arc::clone(&store),
            Arc::clone(&hooks),
            Arc::clone(&sessions),
            routes,
            config,
            hasher,
            clock,
        );
        let router = accounts.routes();
        let ws = Ws::start_with(fixture, sessions, move |_| router).await;
        AccountServer {
            ws,
            store,
            hooks,
            accounts,
        }
    }

    pub fn clock(&self) -> &crate::ManualClock {
        &self.ws.fixture().clock
    }

    pub fn sessions(&self) -> &Arc<LoginSessions> {
        self.ws.sessions()
    }

    /// A visitor that loaded the signed-out page (so it holds a pre-session token).
    pub fn visitor(&self) -> Visitor<'_> {
        let pre = self.accounts.pre_session(&HeaderMap::new());
        let mut cookies = HashMap::new();
        cookies.insert(PRE_COOKIE.to_owned(), pre.token.clone());
        Visitor {
            server: self,
            cookies,
            pre_token: pre.token,
            set_cookies: Vec::new(),
        }
    }

    /// An account made directly (as an administrator or the server would).
    pub async fn account(
        &self,
        username: &str,
        password: Option<&str>,
        must_change: bool,
    ) -> Account {
        self.accounts
            .create_account(
                username,
                None,
                password.map(|p| p.to_owned().into()),
                must_change,
                CreatedBy::Server,
            )
            .await
            .expect("a new account")
    }

    /// Hashes computed so far.
    pub fn hashes(&self) -> usize {
        self.accounts.hasher().computed()
    }

    pub async fn shutdown(self) {
        self.ws.shutdown().await;
    }
}

/// Runs an account case on a fresh server, on a current-thread runtime.
pub fn run<F>(signup: Signup, case: F)
where
    F: AsyncFnOnce(&AccountServer),
{
    let mut config = AccountsConfig::new("Conformance");
    config.signup = signup;
    run_with(config, case);
}

/// [`run`] with every setting.
pub fn run_with<F>(config: AccountsConfig, case: F)
where
    F: AsyncFnOnce(&AccountServer),
{
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(async {
            let server = AccountServer::start_with(config).await;
            case(&server).await;
            server.shutdown().await;
        });
}

/// A browser on the sign-in page: its cookies and pre-session token.
pub struct Visitor<'s> {
    server: &'s AccountServer,
    pub cookies: HashMap<String, String>,
    pub pre_token: String,
    /// Every `Set-Cookie` the server sent, in order.
    pub set_cookies: Vec<String>,
}

impl Visitor<'_> {
    pub fn session_cookie(&self) -> Option<&str> {
        self.cookies
            .get(ambidex_axum::DEFAULT_SESSION_COOKIE)
            .map(String::as_str)
    }

    /// A `POST` with a body and the given headers (nothing added).
    pub async fn raw_post(&mut self, path: &str, headers: &[(&str, &str)], body: &str) -> Answer {
        let stream = self.server.ws.tls().await;
        let mut builder = hyper::Request::builder()
            .method("POST")
            .uri(path)
            .header(header::HOST, HOST);
        if !self.cookies.is_empty() {
            let jar: Vec<String> = self
                .cookies
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect();
            builder = builder.header(header::COOKIE, jar.join("; "));
        }
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        let answer = send(
            stream,
            builder
                .body(Full::new(Bytes::from(body.to_owned())))
                .expect("request"),
        )
        .await;
        for value in answer.headers.get_all(header::SET_COOKIE) {
            let text = value.to_str().expect("ASCII cookie").to_owned();
            let (pair, attributes) = text.split_once(';').unwrap_or((&text, ""));
            let (name, value) = pair.split_once('=').expect("name=value");
            if attributes.contains("Max-Age=0") {
                self.cookies.remove(name);
            } else {
                self.cookies.insert(name.into(), value.into());
            }
            self.set_cookies.push(text);
        }
        answer
    }

    /// A `POST` as the sign-in page sends it: Origin, JSON, the pre-session token.
    pub async fn post(&mut self, path: &str, body: Value) -> Answer {
        let token = self.pre_token.clone();
        self.raw_post(
            path,
            &[
                ("origin", ORIGIN),
                ("content-type", "application/json"),
                (CSRF_HEADER, &token),
            ],
            &body.to_string(),
        )
        .await
    }

    pub async fn sign_in(&mut self, username: &str, password: &str) -> Answer {
        self.post(
            "/auth/password",
            serde_json::json!({ "username": username, "password": password }),
        )
        .await
    }

    /// `POST /auth/totp { code }` for the pending sign-in.
    pub async fn code(&mut self, code: &str) -> Answer {
        self.post("/auth/totp", serde_json::json!({ "code": code }))
            .await
    }

    pub async fn sign_up(&mut self, username: &str, password: &str) -> Answer {
        self.post(
            "/auth/signup",
            serde_json::json!({ "username": username, "password": password }),
        )
        .await
    }

    /// A WebSocket client on the visitor's session (Hello done).
    pub async fn connect(&self) -> Client {
        let cookie = self.session_cookie().expect("signed in");
        let csrf = self
            .server
            .sessions()
            .csrf_token(cookie)
            .expect("live session")
            .to_string();
        let socket = self
            .server
            .ws
            .upgrade(HOST, Some(ORIGIN), Some(cookie))
            .await
            .expect("upgrade");
        let mut client = Ws::client(socket, &csrf);
        client.handshake().await;
        client
    }
}

/// The JSON body of an answer.
pub fn body(answer: &Answer) -> Value {
    serde_json::from_str(&answer.body).unwrap_or(Value::Null)
}
