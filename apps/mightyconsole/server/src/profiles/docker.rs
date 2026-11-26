//! What a Docker profile's record must hold for its transport (DOC-23 §6, TSK-116), checked when
//! it is saved:
//!
//! - `transport` is `ssh` (also when absent: the profiles saved before TSK-116 keep working as
//!   they are), `socket` or `tcp`.
//! - Only an SSH profile names an SSH host (`sshHostId`); the others reach their Engine
//!   themselves, so a leftover host id would make that host look used.
//! - Plain TCP (`tcp` with TLS off) is saved only with the person's acceptance that anyone on the
//!   network who reaches the port is root on that host (DOC-23 §6.3, (u)). The page sends
//!   `unencrypted: { accepted: true }`; the server records who and when, as
//!   `unencrypted: { acceptedBy, acceptedAt }`. The record keeps that acceptance while the host
//!   and port stay the same; another host or port needs it again. An imported plain TCP profile
//!   arrives without one (a file cannot accept for a person), and its connect is refused until
//!   someone edits it and accepts.
//!
//! The local socket is a host-access field ([`super::spec`]): saving it needs
//! `profiles.hostAccess`.

use serde_json::{Map, Value, json};

use super::ProfileError;
use super::spec::at;

/// The record field of the transport.
pub const TRANSPORT_FIELD: &str = "transport";

/// The record field of the plain TCP acceptance.
pub const UNENCRYPTED_FIELD: &str = "unencrypted";

const TRANSPORTS: [&str; 3] = ["ssh", "socket", "tcp"];

fn invalid(field: &str, message: impl Into<String>) -> ProfileError {
    ProfileError::Invalid {
        field: field.to_owned(),
        message: message.into(),
    }
}

/// The record's transport, `ssh` when absent; `None` for a value that is not one.
pub fn transport(fields: &Value) -> Option<&str> {
    match fields.get(TRANSPORT_FIELD) {
        None | Some(Value::Null) => Some("ssh"),
        Some(Value::String(t)) if TRANSPORTS.contains(&t.as_str()) => Some(t),
        Some(_) => None,
    }
}

/// Whether the record connects over SSH (and so names an SSH host).
pub fn is_ssh(fields: &Value) -> bool {
    transport(fields) == Some("ssh")
}

/// Whether the record connects over TCP without TLS.
pub fn is_plain_tcp(fields: &Value) -> bool {
    transport(fields) == Some("tcp") && at(fields, "tls.enabled") != &Value::Bool(true)
}

/// Whether the record carries the plain TCP acceptance: the server's record of it, or a test
/// draft's tick.
pub fn unencrypted_accepted(fields: &Value) -> bool {
    let given = at(fields, UNENCRYPTED_FIELD);
    given.get("acceptedBy").is_some_and(Value::is_string)
        || given.get("accepted") == Some(&true.into())
}

/// The fields the acceptance is bound to.
fn same_engine(a: &Value, b: &Value) -> bool {
    at(a, "host") == at(b, "host") && at(a, "port") == at(b, "port")
}

/// Checks the transport and that only an SSH profile names an SSH host: what a test draft must
/// hold too (its plain TCP tick is the connect's to check).
pub fn check_transport(fields: &Value) -> Result<(), ProfileError> {
    let Some(kind) = transport(fields) else {
        return Err(invalid(
            &format!("fields.{TRANSPORT_FIELD}"),
            "ssh, socket or tcp",
        ));
    };
    let host_id = fields.get(super::ssh_hosts::HOST_FIELD);
    if kind != "ssh" && host_id.is_some_and(|v| !v.is_null() && v != "") {
        return Err(invalid(
            &format!("fields.{}", super::ssh_hosts::HOST_FIELD),
            "only a profile over SSH names an SSH host",
        ));
    }
    Ok(())
}

/// Checks a Docker record's transport fields before it is saved (see the module docs) and
/// records the plain TCP acceptance: `by` accepted at `now` (RFC 3339). `before` is the record
/// as stored (an update), `import` is true for `profiles.import`.
pub fn check_fields(
    by: &str,
    before: Option<&Value>,
    fields: &mut Value,
    import: bool,
    now: &str,
) -> Result<(), ProfileError> {
    check_transport(fields)?;
    let Some(record) = fields.as_object_mut() else {
        return Ok(());
    };
    if !is_plain_tcp(&Value::Object(record.clone())) {
        record.remove(UNENCRYPTED_FIELD);
        return Ok(());
    }
    let given = record
        .get(UNENCRYPTED_FIELD)
        .cloned()
        .unwrap_or(Value::Null);
    let kept = before.is_some_and(|before| {
        is_plain_tcp(before)
            && same_engine(before, &Value::Object(record.clone()))
            && at(before, UNENCRYPTED_FIELD).get("acceptedBy").is_some()
            && at(before, UNENCRYPTED_FIELD) == &given
    });
    if kept {
        return Ok(());
    }
    if given.get("accepted") == Some(&Value::Bool(true)) {
        let mut stamp = Map::new();
        stamp.insert("acceptedBy".into(), json!(by));
        stamp.insert("acceptedAt".into(), json!(now));
        record.insert(UNENCRYPTED_FIELD.into(), Value::Object(stamp));
        return Ok(());
    }
    if import {
        record.remove(UNENCRYPTED_FIELD);
        return Ok(());
    }
    Err(invalid(
        &format!("fields.{UNENCRYPTED_FIELD}"),
        "without TLS, anyone on the network who reaches this port is root on that host: tick that \
         you accept it, or turn TLS on",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-11-26T10:00:00Z";

    fn checked(before: Option<&Value>, mut fields: Value, import: bool) -> Result<Value, String> {
        check_fields("u1", before, &mut fields, import, NOW)
            .map(|()| fields)
            .map_err(|e| match e {
                ProfileError::Invalid { field, .. } => field,
                other => format!("{other:?}"),
            })
    }

    #[test]
    fn profiles_saved_before_transports_are_ssh() {
        let old = json!({ "sshHostId": "H1", "socketPath": "/var/run/docker.sock" });
        assert!(is_ssh(&old));
        assert_eq!(checked(None, old.clone(), false).unwrap(), old);
        assert_eq!(
            checked(None, json!({ "transport": "npipe" }), false).unwrap_err(),
            "fields.transport"
        );
    }

    #[test]
    fn only_an_ssh_profile_names_an_ssh_host() {
        let tcp = json!({ "transport": "tcp", "host": "d", "tls": { "enabled": true }, "sshHostId": "H1" });
        assert_eq!(checked(None, tcp, false).unwrap_err(), "fields.sshHostId");
        let socket = json!({ "transport": "socket", "socketPath": "/s", "sshHostId": "" });
        assert!(checked(None, socket, false).is_ok());
    }

    #[test]
    fn plain_tcp_records_who_accepted_it_and_when() {
        let plain = json!({ "transport": "tcp", "host": "d", "port": 2375 });
        assert_eq!(
            checked(None, plain.clone(), false).unwrap_err(),
            "fields.unencrypted"
        );
        // A stamp the page made up is not an acceptance.
        let forged = json!({ "transport": "tcp", "host": "d", "unencrypted": { "acceptedBy": "admin", "acceptedAt": NOW } });
        assert_eq!(
            checked(None, forged, false).unwrap_err(),
            "fields.unencrypted"
        );
        let mut ticked = plain.clone();
        ticked["unencrypted"] = json!({ "accepted": true });
        let saved = checked(None, ticked, false).unwrap();
        assert_eq!(
            saved["unencrypted"],
            json!({ "acceptedBy": "u1", "acceptedAt": NOW })
        );
        assert!(unencrypted_accepted(&saved));
        // An edit that keeps the Engine keeps the acceptance; another port needs it again.
        let mut renamed = saved.clone();
        renamed["socketPath"] = Value::Null;
        assert_eq!(
            checked(Some(&saved), renamed, false).unwrap()["unencrypted"],
            saved["unencrypted"]
        );
        let mut moved = saved.clone();
        moved["port"] = json!(2376);
        assert_eq!(
            checked(Some(&saved), moved, false).unwrap_err(),
            "fields.unencrypted"
        );
        // An import arrives without an acceptance.
        let imported = checked(None, saved.clone(), true).unwrap();
        assert!(imported.get("unencrypted").is_none());
        assert!(!unencrypted_accepted(&imported));
    }

    #[test]
    fn tls_or_another_transport_drops_the_acceptance() {
        let tls = json!({ "transport": "tcp", "host": "d", "tls": { "enabled": true }, "unencrypted": { "accepted": true } });
        assert!(
            checked(None, tls, false)
                .unwrap()
                .get("unencrypted")
                .is_none()
        );
        let ssh = json!({ "sshHostId": "H1", "unencrypted": { "accepted": true } });
        assert!(
            checked(None, ssh, false)
                .unwrap()
                .get("unencrypted")
                .is_none()
        );
    }
}
