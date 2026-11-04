//! Subscriptions: server-push JSON events (Ambidex spec §5, Open questions 21 and 23).
//!
//! A client starts a subscription with a `Subscribe` frame carrying the `Call` payload
//! `{procedure, input, timeout_ms?}`. The procedure's handler runs like a call's: same session and
//! principal, same authorization, approvals and audit, same [`CallScope`] (deadline and
//! cancellation token). It sends events through an [`EventSink`]; each becomes one JSON `Event`
//! frame on the subscription's call id, in order. The subscription then ends with exactly one
//! terminal frame:
//!
//! - `Result` with payload `null` when the handler returns `Ok(())`;
//! - `Error` when it returns an error, or when its token fired (`Cancel`, deadline, an event the
//!   server could not buffer), exactly as for calls;
//! - nothing after `Unsubscribe`: the server sends no further frame for that call id. The handler
//!   is cancelled (`Cancelled`) and gets [`ServerConfig::cancel_grace`] like any cancelled call;
//!   the id stays in flight, counting against `max_concurrent_calls`, until it stops.
//!
//! Session revocation, Goaway and disconnect end subscriptions the way they end calls: every
//! token fires, and the connection closes with Goaway (revocation) or without any frame.
//!
//! # Deadlines
//!
//! Unlike calls, subscriptions have no default deadline (spec Open question 24f): the client's
//! `timeout_ms` applies, capped by a `timeout_max` the procedure declares, and a subscription
//! with neither runs until one of the ends above. Authorization is checked once, at `Subscribe`:
//! a role change does not end a running subscription; revoking the session does (accepted risk,
//! spec §7).
//!
//! # Bounded buffering
//!
//! [`EventSink::send`] never waits for the client. Events the transport has not taken yet are
//! buffered per subscription, up to [`ServerConfig::subscription_buffer_events`] events and
//! [`ServerConfig::subscription_buffer_bytes`] bytes of payload (one event up to the frame limit
//! always fits an empty buffer). An event counts until the connection's writer has handed it to
//! the transport, including while it waits in the connection's outbound queue. An event that
//! does not fit ends the subscription with `ResourceExhausted`: the token fires, the handler gets
//! its grace period, the events buffered before it are still delivered, then the `Error`.
//! Credit-based flow control, where `send` waits for the client, is M2 (spec §6).
//!
//! `Unsubscribe` discards the events still waiting in the engine. Events already in the
//! outbound queue (at most half of it, see [`crate::engine`]) are in flight: they are still
//! written, and the client drops them (spec Open question 23a).
//!
//! [`ServerConfig::cancel_grace`]: crate::ServerConfig::cancel_grace
//! [`ServerConfig::subscription_buffer_events`]: crate::ServerConfig::subscription_buffer_events
//! [`ServerConfig::subscription_buffer_bytes`]: crate::ServerConfig::subscription_buffer_bytes

use std::fmt;
use std::marker::PhantomData;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::mpsc;

use crate::cancel::CallScope;
use crate::error::{IntoErrorPayload, NoDetails, RpcError};
use crate::frame::{Frame, Kind};
use crate::message::{Code, ErrorPayload};

/// Where a subscription's events go: the engine's side, untyped (JSON payloads).
///
/// [`Dispatch::subscribe`](crate::Dispatch::subscribe) receives one per subscription; handlers use
/// the typed [`EventSink`] built on it. Cheap to clone; clones feed the same subscription.
#[derive(Clone)]
pub struct Events {
    inner: Arc<EventsInner>,
}

struct EventsInner {
    call_id: u32,
    scope: CallScope,
    queue: mpsc::UnboundedSender<Queued>,
    budget: Arc<Budget>,
    max_frame_bytes: u32,
}

/// An encoded `Event` frame waiting for the connection to write it. `held` is its share of the
/// subscription's buffer; it is released when it is dropped (after the writer handed the frame
/// to the transport, when `Unsubscribe` discards it, or when the connection closes).
pub(crate) struct Queued {
    pub(crate) call_id: u32,
    pub(crate) bytes: Vec<u8>,
    pub(crate) held: Held,
}

/// The per-subscription buffer budget: events and payload bytes not yet taken by the transport.
struct Budget {
    max_events: usize,
    max_bytes: usize,
    used: Mutex<(usize, usize)>,
}

impl Budget {
    /// Takes room for one event of `bytes`, or `None` when it does not fit. One event always fits
    /// an empty buffer, so an event up to the frame limit can be sent at all.
    fn take(self: &Arc<Self>, bytes: usize) -> Option<Held> {
        let mut used = lock(&self.used);
        let (events, total) = *used;
        let fits = events == 0 || (events < self.max_events && total + bytes <= self.max_bytes);
        if !fits {
            return None;
        }
        *used = (events + 1, total + bytes);
        Some(Held {
            budget: Arc::clone(self),
            bytes,
        })
    }
}

/// One event's share of its subscription's buffer, released on drop.
pub(crate) struct Held {
    budget: Arc<Budget>,
    bytes: usize,
}

impl Drop for Held {
    fn drop(&mut self) {
        let mut used = lock(&self.budget.used);
        used.0 -= 1;
        used.1 -= self.bytes;
    }
}

impl Events {
    pub(crate) fn new(
        call_id: u32,
        scope: CallScope,
        queue: mpsc::UnboundedSender<Queued>,
        max_events: usize,
        max_bytes: usize,
        max_frame_bytes: u32,
    ) -> Events {
        Events {
            inner: Arc::new(EventsInner {
                call_id,
                scope,
                queue,
                budget: Arc::new(Budget {
                    max_events: max_events.max(1),
                    max_bytes,
                    used: Mutex::new((0, 0)),
                }),
                max_frame_bytes,
            }),
        }
    }

    /// Queues one event, already encoded as JSON.
    ///
    /// Fails once the subscription is over, with the reason: `Cancelled` (Cancel, Unsubscribe,
    /// disconnect), `DeadlineExceeded`, or `ResourceExhausted` when this event does not fit the
    /// buffer or the frame limit, which ends the subscription.
    pub fn send_json(&self, payload: Vec<u8>) -> Result<(), SubscriptionEnded> {
        let inner = &*self.inner;
        if let Some(code) = inner.scope.check() {
            return Err(SubscriptionEnded { code });
        }
        if payload.len() > inner.max_frame_bytes as usize {
            return Err(self.fail(
                Code::ResourceExhausted,
                "event exceeds the frame size limit",
            ));
        }
        let Some(held) = inner.budget.take(payload.len()) else {
            return Err(self.fail(Code::ResourceExhausted, "subscription event buffer is full"));
        };
        let bytes = Frame::new(Kind::Event, inner.call_id, payload)
            .encode(inner.max_frame_bytes)
            .expect("payload checked against the frame limit");
        let queued = Queued {
            call_id: inner.call_id,
            bytes,
            held,
        };
        // The receiver lives as long as the connection; once it is gone the token has fired.
        inner.queue.send(queued).map_err(|_| SubscriptionEnded {
            code: Code::Cancelled,
        })
    }

    /// Whether the subscription is over (its token fired); later events are refused.
    pub fn is_closed(&self) -> bool {
        self.inner.scope.is_cancelled()
    }

    /// Resolves once the subscription is over.
    pub async fn closed(&self) {
        self.inner.scope.cancelled().await
    }

    /// Ends the subscription with `code` (the first reason wins) and reports why it is over.
    fn fail(&self, code: Code, message: &'static str) -> SubscriptionEnded {
        self.inner.scope.fail(code, message);
        SubscriptionEnded {
            code: self.inner.scope.reason().unwrap_or(code),
        }
    }
}

impl fmt::Debug for Events {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Events")
            .field("call_id", &self.inner.call_id)
            .field("closed", &self.is_closed())
            .finish()
    }
}

/// A subscription handler's typed event sink (spec §5): the last argument of a
/// `#[rpc::subscription]` method.
///
/// ```text
/// #[rpc::subscription(perm = "jobs.watch", risk = Risk::Read)]
/// async fn progress(&self, ctx: Ctx, input: JobId, events: EventSink<Progress>) -> Result<(), RpcError> {
///     while let Some(p) = self.jobs.next_progress(&input).await {
///         events.send(&p).await?;   // Err once the subscription is over
///     }
///     Ok(())                         // ends it with Result
/// }
/// ```
///
/// `send` fails once the subscription is over (see [`Events::send_json`]), so a loop that uses
/// `?` stops by itself on Cancel, Unsubscribe, deadline, disconnect or a full buffer. Whatever the
/// handler returns after that, the client gets the reason (or nothing, after Unsubscribe). `?`
/// converts [`SubscriptionEnded`] into `RpcError<E>`; a handler with another error type maps it
/// (any value will do, it is never sent).
pub struct EventSink<E> {
    events: Events,
    _event: PhantomData<fn(&E)>,
}

impl<E> Clone for EventSink<E> {
    fn clone(&self) -> Self {
        EventSink {
            events: self.events.clone(),
            _event: PhantomData,
        }
    }
}

impl<E: Serialize> EventSink<E> {
    pub fn new(events: Events) -> EventSink<E> {
        EventSink {
            events,
            _event: PhantomData,
        }
    }

    /// Sends one event. Never waits for the client in M1: an event that does not fit the
    /// subscription's buffer ends it with `ResourceExhausted` instead (see the module docs).
    pub async fn send(&self, event: &E) -> Result<(), SubscriptionEnded> {
        match serde_json::to_vec(event) {
            Ok(payload) => self.events.send_json(payload),
            // A type that cannot serialize is a handler bug: end the subscription without detail.
            Err(_) => Err(self.events.fail(Code::Internal, "internal error")),
        }
    }

    /// Whether the subscription is over; later events are refused.
    pub fn is_closed(&self) -> bool {
        self.events.is_closed()
    }

    /// Resolves once the subscription is over (Cancel, Unsubscribe, deadline, disconnect, full
    /// buffer), for handlers that wait for something other than `send`.
    pub async fn closed(&self) {
        self.events.closed().await
    }
}

impl<E> fmt::Debug for EventSink<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("EventSink").field(&self.events).finish()
    }
}

/// [`EventSink::send`] refused an event: the subscription is over, for this reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubscriptionEnded {
    code: Code,
}

impl SubscriptionEnded {
    /// `Cancelled`, `DeadlineExceeded`, `ResourceExhausted` or `Internal`.
    pub fn code(&self) -> Code {
        self.code
    }
}

impl fmt::Display for SubscriptionEnded {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "subscription ended ({:?})", self.code)
    }
}

impl std::error::Error for SubscriptionEnded {}

/// The client never sees this error: once a subscription is over, its answer is the reason the
/// token fired (or nothing, after Unsubscribe).
impl IntoErrorPayload for SubscriptionEnded {
    type Details = NoDetails;

    fn into_error_payload(self) -> ErrorPayload {
        ErrorPayload::new(self.code, "subscription ended")
    }
}

/// Lets a handler whose error type is `RpcError<E>` use `?` on [`EventSink::send`].
impl<E> From<SubscriptionEnded> for RpcError<E> {
    fn from(ended: SubscriptionEnded) -> Self {
        RpcError::new(ended.code, "subscription ended")
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cancel::CallScope;

    fn events(max_events: usize, max_bytes: usize) -> (Events, mpsc::UnboundedReceiver<Queued>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let scope = CallScope::new(None);
        (Events::new(7, scope, tx, max_events, max_bytes, 64), rx)
    }

    #[test]
    fn events_are_bounded_by_count() {
        let (events, mut rx) = events(2, 1024);
        events.send_json(b"1".to_vec()).unwrap();
        events.send_json(b"2".to_vec()).unwrap();
        let err = events.send_json(b"3".to_vec()).unwrap_err();
        assert_eq!(err.code(), Code::ResourceExhausted);
        assert!(events.is_closed(), "a full buffer ends the subscription");
        // Taking an event frees room, but the subscription is already over.
        drop(rx.try_recv().unwrap());
        assert_eq!(
            events.send_json(b"4".to_vec()).unwrap_err().code(),
            Code::ResourceExhausted
        );
    }

    #[test]
    fn events_are_bounded_by_bytes_but_one_always_fits() {
        let (events, mut rx) = events(10, 4);
        // Larger than the byte budget, but the buffer is empty.
        events.send_json(b"\"abcdef\"".to_vec()).unwrap();
        let first = rx.try_recv().unwrap();
        assert_eq!(first.call_id, 7);
        assert_eq!(first.bytes[1], Kind::Event as u8);
        // Still buffered: the next event must fit next to it.
        assert_eq!(
            events.send_json(b"1".to_vec()).unwrap_err().code(),
            Code::ResourceExhausted
        );
    }

    #[test]
    fn released_room_is_reused() {
        let (events, mut rx) = events(1, 1024);
        for n in 0..5 {
            events.send_json(format!("{n}").into_bytes()).unwrap();
            drop(rx.try_recv().unwrap());
        }
    }

    #[test]
    fn oversize_event_ends_the_subscription() {
        let (events, _rx) = events(10, 1024);
        let err = events.send_json(vec![b'1'; 65]).unwrap_err();
        assert_eq!(err.code(), Code::ResourceExhausted);
        assert!(events.is_closed());
    }

    #[test]
    fn sends_after_the_token_fired_report_its_reason() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let scope = CallScope::new(None);
        let events = Events::new(1, scope.clone(), tx, 4, 1024, 64);
        scope.fire(Code::DeadlineExceeded);
        assert_eq!(
            events.send_json(b"1".to_vec()).unwrap_err().code(),
            Code::DeadlineExceeded
        );
    }
}
