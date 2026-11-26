//! The shared core of the server (Mightyconsole spec §2.2): what every tool uses and no tool
//! owns.
//!
//! - [`Hub`]: the live handles (`connId`), owned by the Ambidex session that created them; the
//!   `app.events` channel of each session; the terminals and their input; the client-chosen
//!   `streamId`s; stream progress.
//! - [`error`]: [`ToolError`], the typed details of every tool error.
//! - [`types`]: the wire types every tool shares.
//!
//! **One Ambidex session per WebSocket.** The login sessions (`ambidex_axum::LoginSessions`) give every
//! upgrade its own session id, so a handle belongs to one browser tab's connection: another tab,
//! or the same tab after a reconnect, gets `NotFound` for it and connects again (spec §2.2,
//! "Recovery after a lost WebSocket").
//!
//! **Releasing handles.** A handle is released by `<tool>.disconnect`, when the connection's
//! `app.events` subscription ends (the engine cancels it when the WebSocket closes, so closing a
//! tab releases its handles at once; spec Open question 5), and by the idle sweep after
//! [`IDLE_TIMEOUT`] with no call and no running stream on it. Releasing cancels the handle's
//! token, which ends its streams with `Cancelled`, and drops the core's reference to the
//! tool's client.

pub mod error;
pub mod jq;
pub mod messaging;
pub mod outbound;
pub mod route;
pub mod stored;
pub mod tls;
pub mod types;

use std::any::Any;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use security_types::{Clock, TargetRef};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;

pub use error::{
    ErrorHop, ErrorPosition, HostKeyDetails, HostKeyFingerprint, HostKeyState, RemoteError,
    ToolError, ToolErrorKind, ToolResult,
};
pub use types::{AppEvent, ConnectionState, Empty};

/// Idle time after which the sweep releases a handle with no running stream (spec §2.2).
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// How often the server runs the sweep.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(30);

/// Events buffered per session for a slow `app.events` subscriber; older ones are dropped.
const EVENTS_CAPACITY: usize = 1024;

/// Terminal input waiting for the tool (`term.write` batches every 10 ms).
const TERMINAL_INPUT_CAPACITY: usize = 256;

/// Longest client-chosen `streamId` or `terminalId`.
const MAX_CLIENT_ID_LEN: usize = 64;

/// A 128-bit random id, base32 (RFC 4648, lowercase, no padding): 26 characters.
pub fn random_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("OS randomness");
    base32(&bytes)
}

fn base32(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for &byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((buffer >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    out
}

struct HandleEntry {
    session: String,
    tool: String,
    /// What the handle acts on, for the Authorizer ([`crate::authz::targets`]).
    target: TargetRef,
    /// Other ids that name this handle (`uploadId` of a NATS upload): `(field, id)`.
    links: HashSet<(String, String)>,
    value: Arc<dyn Any + Send + Sync>,
    token: CancellationToken,
    last_used_ms: u64,
    /// Streams running on the handle; the sweep leaves it alone while any runs.
    active: usize,
    /// The message codecs of a tool that carries messages (spec §5), for `messaging.*`.
    codecs: Option<message_codecs::Codecs>,
}

struct SessionEntry {
    events: broadcast::Sender<AppEvent>,
    subscribers: usize,
    /// Who subscribed (`app.events`), for events only some people may see.
    principal: Option<security_types::Principal>,
}

struct TerminalEntry {
    input: mpsc::Sender<TermInput>,
    /// The target of the handle the terminal was opened on.
    target: TargetRef,
}

#[derive(Default)]
struct State {
    handles: HashMap<String, HandleEntry>,
    sessions: HashMap<String, SessionEntry>,
    terminals: HashMap<(String, String), TerminalEntry>,
    streams: HashSet<(String, String)>,
}

impl State {
    fn session(&mut self, session: &str) -> &mut SessionEntry {
        self.sessions
            .entry(session.to_owned())
            .or_insert_with(|| SessionEntry {
                events: broadcast::channel(EVENTS_CAPACITY).0,
                subscribers: 0,
                principal: None,
            })
    }

    fn publish(&mut self, session: &str, event: AppEvent) {
        // No receiver (no `app.events` yet) is not an error: the event has no reader.
        let _ = self.session(session).events.send(event);
    }

    /// Drops the session's entry once nothing refers to it.
    fn forget_if_unused(&mut self, session: &str) {
        let unused = self
            .sessions
            .get(session)
            .is_some_and(|s| s.subscribers == 0)
            && !self.handles.values().any(|h| h.session == session)
            && !self.terminals.keys().any(|(s, _)| s == session)
            && !self.streams.iter().any(|(s, _)| s == session);
        if unused {
            self.sessions.remove(session);
        }
    }
}

/// Live handles, events, terminals and stream ids of every session. Cheap to share as
/// `Arc<Hub>`; every method takes the lock briefly and never across an await.
pub struct Hub {
    clock: Arc<dyn Clock>,
    idle_ms: u64,
    state: Mutex<State>,
    /// The profile store the tools connect from ([`stored`]); unset in the codegen router. Weak:
    /// the store holds the Hub.
    profiles: OnceLock<std::sync::Weak<dyn stored::StoredProfiles>>,
    /// SSH sessions of routes, shared by every profile and tool going through the same jump
    /// hosts (DOC-23 (e)).
    sessions: net_route::SessionPool,
}

/// A live handle as a tool sees it.
pub struct Handle<T> {
    pub conn_id: String,
    pub value: Arc<T>,
    /// Fires when the handle is released; streams on it end with `Cancelled`.
    pub token: CancellationToken,
}

/// Held by a stream running on a handle: the sweep skips the handle until it drops.
pub struct BusyGuard {
    hub: Arc<Hub>,
    conn_id: String,
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        let now = self.hub.clock.now_unix_ms();
        let mut state = self.hub.lock();
        if let Some(entry) = state.handles.get_mut(&self.conn_id) {
            entry.active = entry.active.saturating_sub(1);
            entry.last_used_ms = now;
        }
    }
}

/// Input for a terminal, from `term.write`, `term.resize` and `term.signal`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TermInput {
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Interrupt,
    Eof,
}

/// An open terminal: the tool reads its input and reports its exit. Dropping it without
/// [`Terminal::exit`] reports "ended" without a code.
pub struct Terminal {
    hub: Arc<Hub>,
    session: String,
    terminal_id: String,
    pub input: mpsc::Receiver<TermInput>,
    exit: Option<(Option<i32>, String)>,
}

impl Terminal {
    pub fn terminal_id(&self) -> &str {
        &self.terminal_id
    }

    /// Records how the process ended; sent as `TerminalExit` when the terminal drops.
    pub fn exit(&mut self, exit_code: Option<i32>, reason: impl Into<String>) {
        self.exit = Some((exit_code, reason.into()));
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let (exit_code, reason) = self
            .exit
            .take()
            .unwrap_or_else(|| (None, "ended".to_owned()));
        let mut state = self.hub.lock();
        state
            .terminals
            .remove(&(self.session.clone(), self.terminal_id.clone()));
        state.publish(
            &self.session,
            AppEvent::TerminalExit {
                terminal_id: self.terminal_id.clone(),
                exit_code,
                reason,
            },
        );
        state.forget_if_unused(&self.session);
    }
}

/// A claimed `streamId`, released when it drops.
pub struct StreamClaim {
    hub: Arc<Hub>,
    session: String,
    stream_id: String,
}

impl StreamClaim {
    pub fn stream_id(&self) -> &str {
        &self.stream_id
    }
}

impl Drop for StreamClaim {
    fn drop(&mut self) {
        let mut state = self.hub.lock();
        state
            .streams
            .remove(&(self.session.clone(), self.stream_id.clone()));
        state.forget_if_unused(&self.session);
    }
}

/// The `app.events` side of one subscription; the last one of a session to drop releases the
/// session's handles (the WebSocket closed, or the page unsubscribed).
pub struct EventsGuard {
    hub: Arc<Hub>,
    session: String,
    pub events: broadcast::Receiver<AppEvent>,
}

impl Drop for EventsGuard {
    fn drop(&mut self) {
        let last = {
            let mut state = self.hub.lock();
            let entry = state.session(&self.session);
            entry.subscribers = entry.subscribers.saturating_sub(1);
            entry.subscribers == 0
        };
        if last {
            self.hub.release_session(
                &self.session,
                "the page closed its connection to the server",
            );
        }
    }
}

impl Hub {
    pub fn new(clock: Arc<dyn Clock>, idle: Duration) -> Hub {
        Hub {
            clock,
            idle_ms: idle.as_millis() as u64,
            state: Mutex::default(),
            profiles: OnceLock::new(),
            sessions: net_route::SessionPool::new(),
        }
    }

    /// The SSH sessions routes share (DOC-23 (e)).
    pub fn session_pool(&self) -> &net_route::SessionPool {
        &self.sessions
    }

    /// The server's clock (tests use a fake one).
    pub fn clock(&self) -> Arc<dyn Clock> {
        Arc::clone(&self.clock)
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        // Every critical section leaves the maps consistent; a panic cannot break them.
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Registers a tool's live client for `session`, acting on `target` (the stored profile it
    /// was opened with, DOC-25 §3.4.7), and announces it `Connected`.
    pub fn insert_for<T: Send + Sync + 'static>(
        &self,
        session: &str,
        tool: &str,
        value: Arc<T>,
        target: TargetRef,
    ) -> Handle<T> {
        let conn_id = random_id();
        let token = CancellationToken::new();
        let now = self.clock.now_unix_ms();
        let mut state = self.lock();
        state.handles.insert(
            conn_id.clone(),
            HandleEntry {
                session: session.to_owned(),
                tool: tool.to_owned(),
                target,
                links: HashSet::new(),
                value: value.clone(),
                token: token.clone(),
                last_used_ms: now,
                active: 0,
                codecs: None,
            },
        );
        state.publish(
            session,
            AppEvent::ConnectionStatus {
                tool: tool.to_owned(),
                conn_id: conn_id.clone(),
                status: ConnectionState::Connected,
                message: None,
            },
        );
        Handle {
            conn_id,
            value,
            token,
        }
    }

    /// The handle `conn_id` of `session` and `tool`, marked used now. Any other session, tool
    /// or type, or a released handle, is `NotFound` (`resource = "connection"`).
    pub fn get<T: Send + Sync + 'static>(
        &self,
        session: &str,
        tool: &str,
        conn_id: &str,
    ) -> Result<Handle<T>, ToolError> {
        let now = self.clock.now_unix_ms();
        let mut state = self.lock();
        let entry = state
            .handles
            .get_mut(conn_id)
            .filter(|e| e.session == session && e.tool == tool)
            .ok_or_else(|| ToolError::connection_gone(tool))?;
        let value = Arc::clone(&entry.value)
            .downcast::<T>()
            .map_err(|_| ToolError::connection_gone(tool))?;
        entry.last_used_ms = now;
        Ok(Handle {
            conn_id: conn_id.to_owned(),
            value,
            token: entry.token.clone(),
        })
    }

    /// Gives a handle of `session` its message codecs (on connect, and when the profile's local
    /// schemas change).
    pub fn set_codecs(
        &self,
        session: &str,
        conn_id: &str,
        codecs: message_codecs::Codecs,
    ) -> Result<(), ToolError> {
        let mut state = self.lock();
        let entry = state
            .handles
            .get_mut(conn_id)
            .filter(|e| e.session == session)
            .ok_or_else(|| ToolError::connection_gone(messaging::SYSTEM))?;
        entry.codecs = Some(codecs);
        Ok(())
    }

    /// The message codecs of a handle of `session`, whatever its tool; `Invalid` for a handle
    /// whose tool carries no messages.
    pub fn codecs(
        &self,
        session: &str,
        conn_id: &str,
    ) -> Result<message_codecs::Codecs, ToolError> {
        let now = self.clock.now_unix_ms();
        let mut state = self.lock();
        let entry = state
            .handles
            .get_mut(conn_id)
            .filter(|e| e.session == session)
            .ok_or_else(|| ToolError::connection_gone(messaging::SYSTEM))?;
        entry.last_used_ms = now;
        entry.codecs.clone().ok_or_else(|| {
            ToolError::invalid(
                messaging::SYSTEM,
                "connId",
                format!("a {} connection has no message codecs", entry.tool),
            )
        })
    }

    /// [`Hub::get`] for a stream: the handle stays out of the sweep until the guard drops.
    pub fn busy<T: Send + Sync + 'static>(
        self: &Arc<Self>,
        session: &str,
        tool: &str,
        conn_id: &str,
    ) -> Result<(Handle<T>, BusyGuard), ToolError> {
        let handle = self.get::<T>(session, tool, conn_id)?;
        let mut state = self.lock();
        match state.handles.get_mut(conn_id) {
            Some(entry) => entry.active += 1,
            None => return Err(ToolError::connection_gone(tool)),
        }
        drop(state);
        let guard = BusyGuard {
            hub: Arc::clone(self),
            conn_id: conn_id.to_owned(),
        };
        Ok((handle, guard))
    }

    /// The tool and target of the handle `conn_id` of `session`; `None` for any other session's
    /// or a released handle.
    pub fn handle_target(&self, session: &str, conn_id: &str) -> Option<(String, TargetRef)> {
        self.lock()
            .handles
            .get(conn_id)
            .filter(|e| e.session == session)
            .map(|e| (e.tool.clone(), e.target.clone()))
    }

    /// Lets `id` in the input field `field` name the handle `conn_id` of `session` (a NATS
    /// upload's `uploadId`), until the handle is released or [`Hub::unlink`].
    pub fn link(&self, session: &str, conn_id: &str, field: &str, id: &str) {
        if let Some(entry) = self
            .lock()
            .handles
            .get_mut(conn_id)
            .filter(|e| e.session == session)
        {
            entry.links.insert((field.to_owned(), id.to_owned()));
        }
    }

    pub fn unlink(&self, session: &str, field: &str, id: &str) {
        let key = (field.to_owned(), id.to_owned());
        for entry in self.lock().handles.values_mut() {
            if entry.session == session {
                entry.links.remove(&key);
            }
        }
    }

    /// The handle of `session` that `id` in `field` names ([`Hub::link`]).
    pub fn linked(&self, session: &str, field: &str, id: &str) -> Option<String> {
        let key = (field.to_owned(), id.to_owned());
        self.lock()
            .handles
            .iter()
            .find(|(_, e)| e.session == session && e.links.contains(&key))
            .map(|(conn_id, _)| conn_id.clone())
    }

    /// The target of the handle terminal `terminal_id` of `session` was opened on.
    pub fn terminal_target(&self, session: &str, terminal_id: &str) -> Option<TargetRef> {
        self.lock()
            .terminals
            .get(&(session.to_owned(), terminal_id.to_owned()))
            .map(|t| t.target.clone())
    }

    /// Releases one handle of `session` and `tool`; `false` when there was none (idempotent).
    pub fn remove(&self, session: &str, tool: &str, conn_id: &str) -> bool {
        let mut state = self.lock();
        let owned = state
            .handles
            .get(conn_id)
            .is_some_and(|e| e.session == session && e.tool == tool);
        if !owned {
            return false;
        }
        let entry = state.handles.remove(conn_id).expect("checked above");
        entry.token.cancel();
        state.publish(
            session,
            AppEvent::ConnectionStatus {
                tool: entry.tool,
                conn_id: conn_id.to_owned(),
                status: ConnectionState::Closed,
                message: None,
            },
        );
        state.forget_if_unused(session);
        true
    }

    /// Publishes a state change of a handle (a client reconnecting by itself, a failure).
    pub fn status(
        &self,
        session: &str,
        tool: &str,
        conn_id: &str,
        status: ConnectionState,
        message: Option<String>,
    ) {
        self.publish(
            session,
            AppEvent::ConnectionStatus {
                tool: tool.to_owned(),
                conn_id: conn_id.to_owned(),
                status,
                message,
            },
        );
    }

    pub fn publish(&self, session: &str, event: AppEvent) {
        self.lock().publish(session, event);
    }

    /// Sends `event` to every subscribed session whose principal `may_see` allows.
    pub fn publish_where(
        &self,
        event: &AppEvent,
        may_see: impl Fn(&security_types::Principal) -> bool,
    ) {
        let state = self.lock();
        for entry in state.sessions.values() {
            if entry.principal.as_ref().is_some_and(&may_see) {
                let _ = entry.events.send(event.clone());
            }
        }
    }

    /// Subscribes to the session's events (`app.events`) as `principal`.
    pub fn subscribe_as(
        self: &Arc<Self>,
        session: &str,
        principal: &security_types::Principal,
    ) -> EventsGuard {
        let guard = self.subscribe(session);
        self.lock().session(session).principal = Some(principal.clone());
        guard
    }

    /// Subscribes to the session's events (`app.events`).
    pub fn subscribe(self: &Arc<Self>, session: &str) -> EventsGuard {
        let mut state = self.lock();
        let entry = state.session(session);
        entry.subscribers += 1;
        let events = entry.events.subscribe();
        EventsGuard {
            hub: Arc::clone(self),
            session: session.to_owned(),
            events,
        }
    }

    /// Releases every handle and terminal of `session`.
    pub fn release_session(&self, session: &str, reason: &str) -> usize {
        let mut state = self.lock();
        let ids: Vec<String> = state
            .handles
            .iter()
            .filter(|(_, e)| e.session == session)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            if let Some(entry) = state.handles.remove(id) {
                entry.token.cancel();
                state.publish(
                    session,
                    AppEvent::ConnectionStatus {
                        tool: entry.tool,
                        conn_id: id.clone(),
                        status: ConnectionState::Closed,
                        message: Some(reason.to_owned()),
                    },
                );
            }
        }
        // Dropping the input senders ends the terminals' input; their tools see `None`.
        state.terminals.retain(|(s, _), _| s != session);
        state.forget_if_unused(session);
        ids.len()
    }

    /// Releases every handle, of any session, opened with the stored profile `profile_id` (it
    /// was deleted, or changed owner). Returns how many.
    pub fn release_profile(&self, profile_id: &str, reason: &str) -> usize {
        let mut state = self.lock();
        let ids: Vec<String> = state
            .handles
            .iter()
            .filter(|(_, e)| {
                e.target.kind == security_types::PROFILE_TARGET
                    && security_types::ProfileTarget::of(&e.target)
                        .is_some_and(|t| t.profile == profile_id)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            if let Some(entry) = state.handles.remove(id) {
                entry.token.cancel();
                let session = entry.session.clone();
                state.publish(
                    &session,
                    AppEvent::ConnectionStatus {
                        tool: entry.tool,
                        conn_id: id.clone(),
                        status: ConnectionState::Closed,
                        message: Some(reason.to_owned()),
                    },
                );
                state.forget_if_unused(&session);
            }
        }
        ids.len()
    }

    /// Releases every handle idle for the idle timeout with no running stream. Returns how many.
    pub fn sweep(&self) -> usize {
        let now = self.clock.now_unix_ms();
        let mut state = self.lock();
        let expired: Vec<String> = state
            .handles
            .iter()
            .filter(|(_, e)| e.active == 0 && now.saturating_sub(e.last_used_ms) >= self.idle_ms)
            .map(|(id, _)| id.clone())
            .collect();
        let minutes = self.idle_ms / 60_000;
        for id in &expired {
            if let Some(entry) = state.handles.remove(id) {
                entry.token.cancel();
                let session = entry.session.clone();
                state.publish(
                    &session,
                    AppEvent::ConnectionStatus {
                        tool: entry.tool,
                        conn_id: id.clone(),
                        status: ConnectionState::Closed,
                        message: Some(format!("closed after {minutes} minutes without use")),
                    },
                );
                state.forget_if_unused(&session);
            }
        }
        expired.len()
    }

    /// How many handles are live, for tests and the startup line.
    pub fn handle_count(&self) -> usize {
        self.lock().handles.len()
    }

    /// Claims a client-chosen `streamId` for `session`; a duplicate is `Invalid`.
    pub fn claim_stream(
        self: &Arc<Self>,
        session: &str,
        tool: &str,
        stream_id: &str,
    ) -> Result<StreamClaim, ToolError> {
        check_client_id(tool, "streamId", stream_id)?;
        let mut state = self.lock();
        if !state
            .streams
            .insert((session.to_owned(), stream_id.to_owned()))
        {
            return Err(ToolError::invalid(
                tool,
                "streamId",
                "a stream with this id is already running",
            ));
        }
        Ok(StreamClaim {
            hub: Arc::clone(self),
            session: session.to_owned(),
            stream_id: stream_id.to_owned(),
        })
    }

    /// Opens a terminal `terminal_id` for `session` on its handle `conn_id`; a duplicate is
    /// `Invalid`, a handle that is gone `NotFound`.
    pub fn open_terminal(
        self: &Arc<Self>,
        session: &str,
        tool: &str,
        conn_id: &str,
        terminal_id: &str,
    ) -> Result<Terminal, ToolError> {
        check_client_id(tool, "terminalId", terminal_id)?;
        let key = (session.to_owned(), terminal_id.to_owned());
        let mut state = self.lock();
        let target = state
            .handles
            .get(conn_id)
            .filter(|e| e.session == session && e.tool == tool)
            .map(|e| e.target.clone())
            .ok_or_else(|| ToolError::connection_gone(tool))?;
        if state.terminals.contains_key(&key) {
            return Err(ToolError::invalid(
                tool,
                "terminalId",
                "a terminal with this id is already open",
            ));
        }
        let (tx, rx) = mpsc::channel(TERMINAL_INPUT_CAPACITY);
        state
            .terminals
            .insert(key, TerminalEntry { input: tx, target });
        Ok(Terminal {
            hub: Arc::clone(self),
            session: session.to_owned(),
            terminal_id: terminal_id.to_owned(),
            input: rx,
            exit: None,
        })
    }

    /// Hands input to the terminal; `NotFound` once it ended or for another session's id.
    pub async fn terminal_input(
        &self,
        session: &str,
        terminal_id: &str,
        input: TermInput,
    ) -> Result<(), ToolError> {
        let sender = self
            .lock()
            .terminals
            .get(&(session.to_owned(), terminal_id.to_owned()))
            .map(|t| t.input.clone());
        let gone = || ToolError::not_found("term", "terminal", "this terminal has ended");
        let sender = sender.ok_or_else(gone)?;
        sender.send(input).await.map_err(|_| gone())
    }

    /// Progress counters for a stream with a `streamId`, published once a second while the
    /// returned value lives and once more when it drops.
    pub fn progress(self: &Arc<Self>, session: &str, stream_id: &str) -> Progress {
        let counters = Arc::new(Counters::default());
        let stop = CancellationToken::new();
        let reporter = Reporter {
            hub: Arc::clone(self),
            session: session.to_owned(),
            stream_id: stream_id.to_owned(),
            counters: Arc::clone(&counters),
            last: Mutex::new((self.clock.now_unix_ms(), 0, 0)),
        };
        let reporter = Arc::new(reporter);
        {
            let reporter = Arc::clone(&reporter);
            let stop = stop.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(1));
                tick.tick().await;
                loop {
                    tokio::select! {
                        () = stop.cancelled() => return,
                        _ = tick.tick() => reporter.publish(false),
                    }
                }
            });
        }
        Progress {
            counters,
            reporter,
            stop,
        }
    }
}

/// A `streamId` or `terminalId`: 1 to 64 characters, letters, digits and `-`.
fn check_client_id(tool: &str, field: &str, id: &str) -> Result<(), ToolError> {
    let ok = !id.is_empty()
        && id.len() <= MAX_CLIENT_ID_LEN
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(ToolError::invalid(
            tool,
            field,
            format!("{field} must be 1 to {MAX_CLIENT_ID_LEN} letters, digits or '-'"),
        ))
    }
}

#[derive(Default)]
struct Counters {
    scanned: AtomicU64,
    matched: AtomicU64,
    dropped: AtomicU64,
    decode_errors: AtomicU64,
    bytes: AtomicU64,
}

struct Reporter {
    hub: Arc<Hub>,
    session: String,
    stream_id: String,
    counters: Arc<Counters>,
    /// Time, matched and bytes at the last event, for the rates.
    last: Mutex<(u64, u64, u64)>,
}

impl Reporter {
    fn publish(&self, done: bool) {
        let c = &self.counters;
        let matched = c.matched.load(Ordering::Relaxed);
        let bytes = c.bytes.load(Ordering::Relaxed);
        let now = self.hub.clock.now_unix_ms();
        let (rate_per_sec, bytes_per_sec) = {
            let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
            let elapsed = now.saturating_sub(last.0);
            let rates = if elapsed == 0 {
                (0.0, 0.0)
            } else {
                let per_sec = |delta: u64| delta as f64 * 1000.0 / elapsed as f64;
                (per_sec(matched - last.1), per_sec(bytes - last.2))
            };
            *last = (now, matched, bytes);
            rates
        };
        self.hub.publish(
            &self.session,
            AppEvent::StreamProgress {
                stream_id: self.stream_id.clone(),
                scanned: c.scanned.load(Ordering::Relaxed),
                matched,
                dropped: c.dropped.load(Ordering::Relaxed),
                decode_errors: c.decode_errors.load(Ordering::Relaxed),
                rate_per_sec,
                bytes_per_sec,
                done,
            },
        );
    }
}

/// The counters of one stream; see [`Hub::progress`].
pub struct Progress {
    counters: Arc<Counters>,
    reporter: Arc<Reporter>,
    stop: CancellationToken,
}

impl Progress {
    pub fn scanned(&self, n: u64) {
        self.counters.scanned.fetch_add(n, Ordering::Relaxed);
    }

    /// `n` items sent, `bytes` bytes.
    pub fn matched(&self, n: u64, bytes: u64) {
        self.counters.matched.fetch_add(n, Ordering::Relaxed);
        self.counters.bytes.fetch_add(bytes, Ordering::Relaxed);
    }

    pub fn dropped(&self, n: u64) {
        self.counters.dropped.fetch_add(n, Ordering::Relaxed);
    }

    pub fn decode_error(&self) {
        self.counters.decode_errors.fetch_add(1, Ordering::Relaxed);
    }
}

impl Drop for Progress {
    fn drop(&mut self) {
        self.stop.cancel();
        self.reporter.publish(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_26_base32_characters() {
        let id = random_id();
        assert_eq!(id.len(), 26);
        assert!(
            id.bytes()
                .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
        );
        assert_ne!(id, random_id());
        // RFC 4648 test vector, lowercase and without padding.
        assert_eq!(base32(b"foobar"), "mzxw6ytboi");
    }

    #[test]
    fn client_ids_are_checked() {
        assert!(check_client_id("t", "streamId", "0b6f-4c1a").is_ok());
        for bad in ["", "a b", "a/b", &"x".repeat(65)] {
            let err = check_client_id("t", "streamId", bad).unwrap_err();
            assert_eq!(err.kind, ToolErrorKind::Invalid);
            assert_eq!(err.field.as_deref(), Some("streamId"));
        }
    }
}
