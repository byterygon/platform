//! Connecting with a stored profile (DOC-25 §3.4.7): the connect profile of each tool, built on
//! the server from the record and its secrets, as the browser built it until now (each tool's
//! `toConnect` in `ui/src/tools`). Only the secrets the chosen authentication uses go in.
//!
//! - `<tool>.connect { profileId }`: a profile the caller may use (its owner, or `<tool>.read`
//!   on a shared one); the stored secrets are opened for the connection.
//! - `<tool>.test { draft, basedOn? }`: the profile form's draft, for those who may keep
//!   profiles (`profiles.personal` or `profiles.manage`). Its secrets are used for this call only.
//!   The stored secrets of `basedOn` fill the ones it leaves empty only when the caller may edit
//!   `basedOn` and the draft keeps the target fields of their group (§3.4.8): a draft pointing at
//!   another server gets no stored secret.

use std::collections::BTreeMap;

use security_types::{Principal, TargetRef};
use serde_json::{Map, Value, json};

use super::spec::{self, ToolSpec};
use super::{ProfileError, ProfileService, check_record, check_secrets, target_of};
use crate::core::stored::{Resolved, StoredProfiles, TestDraft};
use crate::core::{ToolError, ToolErrorKind};
use crate::secrets::{Owner as SecretOwner, Secret};

/// A record and its secrets, as a tool's connect profile is built from.
pub struct View<'a> {
    pub id: Option<&'a str>,
    pub name: &'a str,
    pub fields: &'a Value,
    pub extras: &'a Value,
    pub secrets: &'a BTreeMap<String, Secret>,
}

fn text(v: &Value) -> &str {
    v.as_str().unwrap_or_default()
}

/// A trimmed, non-empty string, or `null`.
fn trimmed(v: &Value) -> Value {
    match text(v).trim() {
        "" => Value::Null,
        s => Value::String(s.to_owned()),
    }
}

/// A non-empty string as it is, or `null`.
fn non_empty(v: &Value) -> Value {
    match text(v) {
        "" => Value::Null,
        s => Value::String(s.to_owned()),
    }
}

fn array_or(v: &Value, default: Value) -> Value {
    if v.is_array() { v.clone() } else { default }
}

impl View<'_> {
    fn field(&self, path: &str) -> &Value {
        spec::at(self.fields, path)
    }

    fn extra(&self, key: &str) -> &Value {
        self.extras.get(key).unwrap_or(&Value::Null)
    }

    /// A stored secret as text, `null` when unset (or not UTF-8, which no form stores).
    fn secret(&self, path: &str) -> Value {
        match self.secrets.get(path).and_then(Secret::as_str) {
            Some(s) if !s.is_empty() => Value::String(s.to_owned()),
            _ => Value::Null,
        }
    }

    fn secret_trimmed(&self, path: &str) -> Value {
        match self
            .secrets
            .get(path)
            .and_then(Secret::as_str)
            .map(str::trim)
        {
            Some(s) if !s.is_empty() => Value::String(s.to_owned()),
            _ => Value::Null,
        }
    }
}

/// The connect profile of `tool` (its `Connect<Tool>Profile` as JSON).
pub fn connect_profile(tool: &str, view: &View<'_>) -> Result<Value, ProfileError> {
    match tool {
        "echo" => Ok(echo(view)),
        "nats" => Ok(nats(view)),
        "temporal" => Ok(temporal(view)),
        "docker" => Ok(docker(view)),
        "langgraph" => Ok(langgraph(view)),
        other => Err(ProfileError::Invalid {
            field: "tool".into(),
            message: format!("{other} has no connect profile"),
        }),
    }
}

fn echo(v: &View<'_>) -> Value {
    json!({
        "name": v.name,
        "greeting": non_empty(v.field("greeting")),
        "token": v.secret("token"),
        "schemas": array_or(v.extra("schemas"), Value::Null),
        "mappings": array_or(v.extra("mappings"), Value::Null),
    })
}

const NATS_DEFAULT_SERVER: &str = "nats://127.0.0.1:4222";
const NATS_DEFAULT_TIMEOUT_MS: u64 = 5000;
const NATS_MAX_TIMEOUT_MS: u64 = 300_000;
const NATS_AUTHS: [&str; 5] = ["none", "userPassword", "token", "nkey", "creds"];

fn nats(v: &View<'_>) -> Value {
    let auth = match text(v.field("auth")) {
        a if NATS_AUTHS.contains(&a) => a,
        _ => "none",
    };
    let servers: Vec<String> = v
        .field("servers")
        .as_array()
        .map(|list| {
            list.iter()
                .map(|s| text(s).trim().to_owned())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let servers = if servers.is_empty() {
        vec![NATS_DEFAULT_SERVER.to_owned()]
    } else {
        servers
    };
    let tls_on = v.field("tls.enabled") == &Value::Bool(true);
    let mut tls = Map::new();
    tls.insert("enabled".into(), Value::Bool(tls_on));
    if tls_on {
        tls.insert("caPem".into(), non_empty(v.field("tls.caPem")));
        tls.insert(
            "clientCertPem".into(),
            non_empty(v.field("tls.clientCertPem")),
        );
        tls.insert("serverName".into(), non_empty(v.field("tls.serverName")));
        tls.insert("clientKeyPem".into(), v.secret("tls.clientKeyPem"));
    }
    let timeout = v
        .field("requestTimeoutMs")
        .as_u64()
        .filter(|ms| (1..=NATS_MAX_TIMEOUT_MS).contains(ms))
        .unwrap_or(NATS_DEFAULT_TIMEOUT_MS);
    let only = |wanted: &str, value: Value| if auth == wanted { value } else { Value::Null };
    json!({
        "name": v.name,
        "servers": servers,
        "auth": auth,
        "user": only("userPassword", trimmed(v.field("user"))),
        "password": only("userPassword", v.secret("password")),
        "token": only("token", v.secret("token")),
        "nkeySeed": only("nkey", v.secret_trimmed("nkeySeed")),
        "creds": only("creds", v.secret("creds")),
        "tls": tls,
        "connectionName": trimmed(v.field("connectionName")),
        "jetstream": {
            "domain": trimmed(v.field("jetstream.domain")),
            "apiPrefix": trimmed(v.field("jetstream.apiPrefix")),
        },
        "inboxPrefix": trimmed(v.field("inboxPrefix")),
        "requestTimeoutMs": timeout,
        "schemas": array_or(v.extra("schemas"), json!([])),
        "mappings": array_or(v.extra("mappings"), json!([])),
        "schemaRegistry": registry(v, true),
    })
}

/// The Schema Registry of a NATS (or Kafka) profile, `fields.schemaRegistry` and its secrets
/// (`ui/src/messaging/schemas/registry.ts`). `wire_format`: whether the tool scopes the wire
/// format to subjects.
pub fn registry(v: &View<'_>, wire_format: bool) -> Value {
    let r = v.field("schemaRegistry");
    if !r.is_object() {
        return Value::Null;
    }
    let url = text(&r["url"]).trim();
    if url.is_empty() {
        return Value::Null;
    }
    let auth = match text(&r["auth"]) {
        a @ ("basic" | "bearer") => a,
        _ => "none",
    };
    let subjects: Vec<&str> = r["wireFormatSubjects"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(text)
                .filter(|s| !s.trim().is_empty())
                .collect()
        })
        .unwrap_or_default();
    json!({
        "url": url,
        "auth": auth,
        "username": if auth == "basic" { trimmed(&r["username"]) } else { Value::Null },
        "password": if auth == "basic" { v.secret("schemaRegistry.password") } else { Value::Null },
        "token": if auth == "bearer" { v.secret("schemaRegistry.token") } else { Value::Null },
        "tls": {
            "enabled": url.starts_with("https://"),
            "caPem": non_empty(&r["tls"]["caPem"]),
            "serverName": non_empty(&r["tls"]["serverName"]),
            "clientCertPem": Value::Null,
            "clientKeyPem": v.secret("schemaRegistry.tls.clientKeyPem"),
        },
        "wireFormatSubjects": if wire_format { json!(subjects) } else { Value::Null },
    })
}

/// The buckets (or origins) of a comma- or line-separated list.
fn list_of(v: &Value) -> Vec<&str> {
    text(v)
        .split(|c: char| c == ',' || c.is_whitespace())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect()
}

/// "namespace url" lines (`→`, `->` or `=` may stand between them); `None` for a line that is
/// not one.
fn codec_namespaces(lines: &str) -> Option<Vec<Value>> {
    let mut out = Vec::new();
    for line in lines.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let at = line.find("https://").or_else(|| line.find("http://"))?;
        let (head, url) = line.split_at(at);
        if url.contains(char::is_whitespace) {
            return None;
        }
        let trimmed_head = head.trim_end();
        let spaced = trimmed_head.len() != head.len();
        let (namespace, separated) = match ["→", "->", "="]
            .iter()
            .find_map(|sep| trimmed_head.strip_suffix(sep))
        {
            Some(rest) => (rest.trim_end(), true),
            None => (trimmed_head, false),
        };
        // A separator or a space stands between them: `nshttps://…` is not a line.
        if !(separated || spaced) || namespace.is_empty() || namespace.contains(char::is_whitespace)
        {
            return None;
        }
        out.push(json!({ "namespace": namespace, "endpoint": url }));
    }
    Some(out)
}

fn temporal(v: &View<'_>) -> Value {
    let tls_on = v.field("tls.enabled") == &Value::Bool(true);
    let mut tls = Map::new();
    tls.insert("enabled".into(), Value::Bool(tls_on));
    if tls_on {
        tls.insert("caPem".into(), non_empty(v.field("tls.caPem")));
        tls.insert(
            "clientCertPem".into(),
            non_empty(v.field("tls.clientCertPem")),
        );
        tls.insert("serverName".into(), non_empty(v.field("tls.serverName")));
    }
    let ext = v.field("externalStorage");
    let ext_on = ext["enabled"] == Value::Bool(true);
    let external_storage = if ext_on {
        json!({
            "enabled": true,
            "bucket": text(&ext["bucket"]).trim(),
            "readBuckets": list_of(&ext["readBuckets"]),
            "region": trimmed(&ext["region"]),
            "endpoint": trimmed(&ext["endpoint"]),
            "pathStyle": ext["pathStyle"] == Value::Bool(true),
            "caPem": trimmed(&ext["caPem"]),
            "driverName": Value::Null,
            "thresholdBytes": if ext["thresholdBytes"].is_number() { ext["thresholdBytes"].clone() } else { Value::Null },
            "maxPayloadBytes": Value::Null,
        })
    } else {
        Value::Null
    };
    let codec_server = v.field("codecServer");
    let codec_server = if ext_on && codec_server["enabled"] == Value::Bool(true) {
        let origins = match &codec_server["allowedOrigins"] {
            Value::String(_) => list_of(&codec_server["allowedOrigins"]),
            _ => vec!["http://localhost:8233", "http://127.0.0.1:8233"],
        };
        json!({ "enabled": true, "allowedOrigins": origins })
    } else {
        Value::Null
    };
    let pc = v.field("codec");
    let codec = if pc["enabled"] == Value::Bool(true) {
        json!({
            "enabled": true,
            "endpoint": text(&pc["endpoint"]).trim(),
            "namespaces": codec_namespaces(text(&pc["namespaces"])).unwrap_or_default(),
            "caPem": trimmed(&pc["caPem"]),
            "sendNamespace": pc["sendNamespace"] != Value::Bool(false),
            "encodeInputs": pc["encodeInputs"] != Value::Bool(false),
            "timeoutMs": if pc["timeoutMs"].is_number() { pc["timeoutMs"].clone() } else { Value::Null },
        })
    } else {
        Value::Null
    };
    let with_ext = |path: &str| {
        if ext_on {
            v.secret_trimmed(path)
        } else {
            Value::Null
        }
    };
    json!({
        "name": v.name,
        "codecAuthorization": if codec.is_null() { Value::Null } else { v.secret_trimmed("codecAuthorization") },
        "codec": codec,
        "profileId": v.id,
        "codecServer": codec_server,
        "address": trimmed(v.field("address")),
        "namespace": trimmed(v.field("namespace")),
        "tls": tls,
        "clientKeyPem": v.secret("clientKeyPem"),
        "apiKey": v.secret("apiKey"),
        "externalStorage": external_storage,
        "s3AccessKeyId": with_ext("s3AccessKeyId"),
        "s3SecretAccessKey": with_ext("s3SecretAccessKey"),
        "s3SessionToken": with_ext("s3SessionToken"),
    })
}

const DOCKER_DEFAULT_PORT: u64 = 22;

pub(crate) fn docker(v: &View<'_>) -> Value {
    let auth = match text(v.field("auth")) {
        a @ ("password" | "agent") => a,
        _ => "privateKey",
    };
    let host_key = v.field("hostKey");
    let host_key = match (&host_key["algorithm"], &host_key["fingerprintSha256"]) {
        (Value::String(a), Value::String(f)) => json!({ "algorithm": a, "fingerprintSha256": f }),
        _ => Value::Null,
    };
    let port = v.field("port");
    let keepalive = v.field("keepaliveSec");
    let only = |wanted: &str, value: Value| if auth == wanted { value } else { Value::Null };
    json!({
        "name": v.name,
        "host": text(v.field("host")).trim(),
        "port": if port.is_number() { port.clone() } else { json!(DOCKER_DEFAULT_PORT) },
        "username": text(v.field("username")).trim(),
        "auth": auth,
        "privateKey": only("privateKey", v.secret("privateKey")),
        "passphrase": only("privateKey", v.secret("passphrase")),
        "password": only("password", v.secret("password")),
        "hostKey": host_key,
        "socketPath": trimmed(v.field("socketPath")),
        "keepaliveSec": if keepalive.is_number() { keepalive.clone() } else { Value::Null },
    })
}

/// `Name: value` lines (the extra headers, the secret `headerValues`, DOC-25 Open question 23),
/// up to the first line that is not one.
pub fn header_lines(lines: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for line in lines.lines().map(str::trim).filter(|l| !l.is_empty()) {
        match line.find(':') {
            Some(at) if at > 0 => out.push(json!({
                "name": line[..at].trim(),
                "value": line[at + 1..].trim(),
            })),
            _ => break,
        }
    }
    out
}

fn langgraph(v: &View<'_>) -> Value {
    // A value kept as typed when it is more than spaces.
    let opt = |value: Value| match &value {
        Value::String(s) if !s.trim().is_empty() => value,
        _ => Value::Null,
    };
    let headers = v
        .secrets
        .get("headerValues")
        .and_then(Secret::as_str)
        .map(header_lines)
        .unwrap_or_default();
    json!({
        "name": v.name,
        "url": text(v.field("url")).trim(),
        "apiKey": opt(v.secret("apiKey")),
        "headers": if headers.is_empty() { Value::Null } else { json!(headers) },
        "tls": {
            "enabled": v.field("tls.enabled") == &Value::Bool(true),
            "caPem": opt(v.field("tls.caPem").clone()),
            "clientCertPem": opt(v.field("tls.clientCertPem").clone()),
            "clientKeyPem": opt(v.secret("tls.clientKeyPem")),
            "serverName": opt(v.field("tls.serverName").clone()),
        },
    })
}

fn tool_error(tool: &str, e: ProfileError) -> ToolError {
    match e {
        ProfileError::Invalid { field, message } => ToolError::invalid(tool, &field, message),
        ProfileError::NotFound => ToolError::not_found(tool, "profile", "no such profile"),
        ProfileError::Forbidden(m) => ToolError::new(ToolErrorKind::Forbidden, tool, m),
        ProfileError::Conflict(m) => ToolError::new(ToolErrorKind::Conflict, tool, m),
        ProfileError::Store(m) => ToolError::new(ToolErrorKind::Remote, tool, m),
    }
}

/// A Docker profile over SSH names its SSH host (DOC-23 §6.4).
fn needs_host(
    tool: &str,
    fields: &Value,
    host: Option<&super::table::StoredProfile>,
) -> Result<(), ProfileError> {
    let ssh =
        matches!(fields.get("transport"), None | Some(Value::Null)) || fields["transport"] == "ssh";
    if tool == "docker" && ssh && host.is_none() {
        return Err(ProfileError::Invalid {
            field: format!("fields.{}", super::ssh_hosts::HOST_FIELD),
            message: "choose the SSH host this profile connects to".into(),
        });
    }
    Ok(())
}

impl ProfileService {
    /// Every stored secret of a profile, opened.
    fn open_secrets(&self, id: &str) -> Result<BTreeMap<String, Secret>, ProfileError> {
        let owner = SecretOwner::profile(id);
        let mut out = BTreeMap::new();
        for entry in self.store.secret_entries(Some(&owner))? {
            let value = self.vault.open(&entry)?;
            out.insert(entry.field.clone(), value);
        }
        Ok(out)
    }

    fn resolve_connect(
        &self,
        p: &Principal,
        tool: &str,
        id: &str,
    ) -> Result<(Value, TargetRef), ProfileError> {
        let (profile, access) = self.get(p, id)?;
        if profile.tool != tool {
            return Err(ProfileError::Invalid {
                field: "profileId".into(),
                message: format!("{id} is a {} profile, not a {tool} one", profile.tool),
            });
        }
        if !access.may_use() {
            return Err(ProfileError::Forbidden(
                "this is another user's personal profile".into(),
            ));
        }
        let secrets = self.open_secrets(id)?;
        // A Docker profile connects with its SSH host's login (DOC-23 §6.4), checked again
        // here in case the profile changed owner since it was saved.
        let host = self.check_link(&profile.owner, &profile.fields, None)?;
        needs_host(tool, &profile.fields, host.as_ref())?;
        let (fields, secrets) = self.with_host(host, &profile.fields, secrets)?;
        let view = View {
            id: Some(&profile.id),
            name: &profile.name,
            fields: &fields,
            extras: &profile.extras,
            secrets: &secrets,
        };
        Ok((connect_profile(tool, &view)?, target_of(id)))
    }

    fn resolve_test(
        &self,
        p: &Principal,
        tool: &str,
        draft: TestDraft,
        based_on: Option<&str>,
        build: impl FnOnce(&str, &View<'_>) -> Result<Value, ProfileError>,
    ) -> Result<(Value, TargetRef), ProfileError> {
        let may_keep = self
            .authorizer
            .permits(p, crate::authz::catalogue::PROFILES_PERSONAL, None)
            || self.authorizer.permits(p, "profiles.manage", None);
        if !may_keep {
            return Err(ProfileError::Forbidden(
                "testing a profile needs profiles.personal or profiles.manage".into(),
            ));
        }
        let spec: &ToolSpec = spec::spec(tool).ok_or_else(|| ProfileError::Invalid {
            field: "tool".into(),
            message: format!("no tool {tool:?} keeps profiles"),
        })?;
        let extras = draft.extras.unwrap_or_else(|| json!({}));
        check_record(spec, &draft.fields, &extras)?;
        self.may_use_host(p, spec, &draft.fields)?;
        let mut secrets: BTreeMap<String, Secret> =
            check_secrets(spec, draft.secrets)?.into_iter().collect();
        let mut target = crate::authz::targets::browser(tool);
        let mut id = None;
        let mut host = None;
        if let Some(based_on) = based_on {
            let (stored, access) = self.get(p, based_on)?;
            if stored.tool != tool {
                return Err(ProfileError::Invalid {
                    field: "basedOn".into(),
                    message: format!("{based_on} is a {} profile, not a {tool} one", stored.tool),
                });
            }
            target = target_of(based_on);
            // Someone who only uses the profile tests it with the host it names, never another.
            if !access.may_edit()
                && super::ssh_hosts::host_id_of(&draft.fields)
                    != super::ssh_hosts::host_id_of(&stored.fields)
            {
                return Err(ProfileError::Forbidden(
                    "you may not change this profile's SSH host".into(),
                ));
            }
            host = Some(self.check_link(&stored.owner, &draft.fields, None)?);
            if access.may_edit() {
                let unbound = spec.secrets_to_unbind(&stored.fields, &draft.fields);
                for (field, value) in self.open_secrets(based_on)? {
                    if !unbound.contains(&field.as_str()) {
                        secrets.entry(field).or_insert(value);
                    }
                }
            }
            id = Some(stored.id);
        }
        let host = match host {
            Some(host) => host,
            None => self.check_draft_link(p, &draft.fields)?,
        };
        needs_host(tool, &draft.fields, host.as_ref())?;
        let (fields, secrets) = self.with_host(host, &draft.fields, secrets)?;
        let name = draft.name.unwrap_or_default();
        let name = if name.trim().is_empty() {
            "draft"
        } else {
            name.trim()
        };
        let view = View {
            id: id.as_deref(),
            name,
            fields: &fields,
            extras: &extras,
            secrets: &secrets,
        };
        Ok((build(tool, &view)?, target))
    }

    fn resolve_registry(&self, p: &Principal, id: &str) -> Result<Option<Value>, ProfileError> {
        let (profile, access) = self.get(p, id)?;
        if !access.may_use() {
            return Err(ProfileError::Forbidden(
                "this is another user's personal profile".into(),
            ));
        }
        let secrets = self.open_secrets(id)?;
        let view = View {
            id: Some(&profile.id),
            name: &profile.name,
            fields: &profile.fields,
            extras: &profile.extras,
            secrets: &secrets,
        };
        let registry = registry(&view, profile.tool == "nats");
        Ok((!registry.is_null()).then_some(registry))
    }
}

impl StoredProfiles for ProfileService {
    fn connect(&self, p: &Principal, tool: &str, profile_id: &str) -> Result<Resolved, ToolError> {
        let (profile, target) = self
            .resolve_connect(p, tool, profile_id)
            .map_err(|e| tool_error(tool, e))?;
        Ok(Resolved { profile, target })
    }

    fn test(
        &self,
        p: &Principal,
        tool: &str,
        draft: TestDraft,
        based_on: Option<&str>,
    ) -> Result<Resolved, ToolError> {
        let (profile, target) = self
            .resolve_test(p, tool, draft, based_on, connect_profile)
            .map_err(|e| tool_error(tool, e))?;
        Ok(Resolved { profile, target })
    }

    fn registry(&self, p: &Principal, profile_id: &str) -> Result<Option<Value>, ToolError> {
        self.resolve_registry(p, profile_id)
            .map_err(|e| tool_error("messaging", e))
    }

    fn test_registry(
        &self,
        p: &Principal,
        tool: &str,
        draft: TestDraft,
        based_on: Option<&str>,
    ) -> Result<Value, ToolError> {
        let wire_format = tool == "nats";
        let (registry, _) = self
            .resolve_test(p, tool, draft, based_on, |_, view| {
                Ok(registry(view, wire_format))
            })
            .map_err(|e| tool_error("messaging", e))?;
        Ok(registry)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view<'a>(
        fields: &'a Value,
        extras: &'a Value,
        secrets: &'a BTreeMap<String, Secret>,
    ) -> View<'a> {
        View {
            id: Some("P1"),
            name: "n",
            fields,
            extras,
            secrets,
        }
    }

    fn secrets(pairs: &[(&str, &str)]) -> BTreeMap<String, Secret> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), Secret::new(v.as_bytes().to_vec())))
            .collect()
    }

    #[test]
    fn only_the_chosen_authentications_secrets_go_in() {
        let fields = json!({ "auth": "token", "servers": [" nats://a:4222 ", ""] });
        let s = secrets(&[("token", "t0k"), ("password", "pw")]);
        let out = nats(&view(&fields, &json!({}), &s));
        assert_eq!(out["token"], "t0k");
        assert_eq!(out["password"], Value::Null);
        assert_eq!(out["servers"], json!(["nats://a:4222"]));
        assert_eq!(out["requestTimeoutMs"], 5000);
        assert_eq!(out["tls"], json!({ "enabled": false }));
    }

    #[test]
    fn the_registry_takes_its_secrets_by_auth() {
        let fields = json!({ "schemaRegistry": { "url": "https://r", "auth": "bearer", "wireFormatSubjects": ["a.>", " "] } });
        let s = secrets(&[
            ("schemaRegistry.token", "rt"),
            ("schemaRegistry.password", "rp"),
        ]);
        let out = registry(&view(&fields, &json!({}), &s), true);
        assert_eq!(out["token"], "rt");
        assert_eq!(out["password"], Value::Null);
        assert_eq!(out["tls"]["enabled"], true);
        assert_eq!(out["wireFormatSubjects"], json!(["a.>"]));
    }

    #[test]
    fn codec_lines_read_as_the_form_writes_them() {
        assert_eq!(
            codec_namespaces("payments https://c:8888\n\nops -> http://localhost:1\nx=https://y"),
            Some(vec![
                json!({ "namespace": "payments", "endpoint": "https://c:8888" }),
                json!({ "namespace": "ops", "endpoint": "http://localhost:1" }),
                json!({ "namespace": "x", "endpoint": "https://y" }),
            ])
        );
        assert_eq!(codec_namespaces("nshttps://c"), None);
        assert_eq!(codec_namespaces("https://c"), None);
        assert_eq!(codec_namespaces("a b https://c"), None);
    }

    #[test]
    fn header_lines_stop_at_the_first_bad_line() {
        assert_eq!(
            header_lines("X-A: 1\n\n X-B :two:three\nbad\nX-C: 3"),
            vec![
                json!({ "name": "X-A", "value": "1" }),
                json!({ "name": "X-B", "value": "two:three" }),
            ]
        );
    }

    // The checks the browser's `toConnect` tests made before TSK-139 (ui/test/*.test.ts).

    #[test]
    fn temporal_sends_tls_options_only_when_on_and_secrets_only_when_set() {
        let none = BTreeMap::new();
        let f = json!({ "tls": { "enabled": false, "caPem": "ignored" } });
        let off = temporal(&view(&f, &json!({}), &none));
        assert_eq!(off["tls"], json!({ "enabled": false }));
        let f = json!({ "address": " tc:7233 ", "namespace": "prod", "tls": { "enabled": true, "caPem": "CA", "serverName": "tc" } });
        let s = secrets(&[("apiKey", "secret")]);
        let on = temporal(&view(&f, &json!({}), &s));
        assert_eq!(on["address"], "tc:7233");
        assert_eq!(on["namespace"], "prod");
        assert_eq!(
            on["tls"],
            json!({ "enabled": true, "caPem": "CA", "clientCertPem": null, "serverName": "tc" })
        );
        assert_eq!(on["apiKey"], "secret");
        assert_eq!(on["clientKeyPem"], Value::Null);
        assert_eq!(on["profileId"], "P1");
    }

    #[test]
    fn temporal_external_storage_and_its_keys_only_when_on() {
        let f = json!({ "externalStorage": { "enabled": true, "bucket": " payloads ", "endpoint": "http://127.0.0.1:8333", "pathStyle": true, "readBuckets": "old, older\nother" } });
        let s = secrets(&[("s3AccessKeyId", "AK"), ("s3SecretAccessKey", "SK")]);
        let on = temporal(&view(&f, &json!({}), &s));
        assert_eq!(on["externalStorage"]["bucket"], "payloads");
        assert_eq!(
            on["externalStorage"]["readBuckets"],
            json!(["old", "older", "other"])
        );
        assert_eq!(on["externalStorage"]["region"], Value::Null);
        assert_eq!(
            (
                &on["s3AccessKeyId"],
                &on["s3SecretAccessKey"],
                &on["s3SessionToken"]
            ),
            (&json!("AK"), &json!("SK"), &Value::Null)
        );
        let f = json!({ "externalStorage": { "enabled": false, "bucket": "b" } });
        let off = temporal(&view(&f, &json!({}), &s));
        assert_eq!(
            (&off["externalStorage"], &off["s3AccessKeyId"]),
            (&Value::Null, &Value::Null)
        );
        let f = json!({ "externalStorage": { "enabled": true, "bucket": "b" }, "codecServer": { "enabled": true } });
        let with_endpoint = temporal(&view(&f, &json!({}), &s));
        assert_eq!(
            with_endpoint["codecServer"],
            json!({ "enabled": true, "allowedOrigins": ["http://localhost:8233", "http://127.0.0.1:8233"] })
        );
    }

    #[test]
    fn temporal_payload_codec_and_its_authorization_only_when_on() {
        let s = secrets(&[("codecAuthorization", "Bearer t")]);
        let f = json!({ "codec": { "enabled": true, "endpoint": " http://127.0.0.1:8234 ", "namespaces": "payments http://localhost:8235", "encodeInputs": false } });
        let on = temporal(&view(&f, &json!({}), &s));
        assert_eq!(
            on["codec"],
            json!({ "enabled": true, "endpoint": "http://127.0.0.1:8234", "namespaces": [{ "namespace": "payments", "endpoint": "http://localhost:8235" }], "caPem": null, "sendNamespace": true, "encodeInputs": false, "timeoutMs": null })
        );
        assert_eq!(on["codecAuthorization"], "Bearer t");
        let off = temporal(&view(&json!({}), &json!({}), &s));
        assert_eq!(off["codecAuthorization"], Value::Null);
    }

    #[test]
    fn docker_sends_only_the_chosen_methods_secrets() {
        let s = secrets(&[
            ("privateKey", "KEY"),
            ("passphrase", "PP"),
            ("password", "PW"),
        ]);
        let f = json!({ "host": " build-host.lan ", "username": "deploy", "socketPath": "/var/run/docker.sock", "keepaliveSec": 30 });
        let key = docker(&view(&f, &json!({}), &s));
        assert_eq!(
            (
                &key["host"],
                &key["port"],
                &key["auth"],
                &key["privateKey"],
                &key["passphrase"],
                &key["password"],
                &key["hostKey"],
                &key["keepaliveSec"]
            ),
            (
                &json!("build-host.lan"),
                &json!(22),
                &json!("privateKey"),
                &json!("KEY"),
                &json!("PP"),
                &Value::Null,
                &Value::Null,
                &json!(30)
            )
        );
        let f = json!({ "auth": "password" });
        let pw = docker(&view(&f, &json!({}), &s));
        assert_eq!(
            (&pw["privateKey"], &pw["passphrase"], &pw["password"]),
            (&Value::Null, &Value::Null, &json!("PW"))
        );
        let f = json!({ "auth": "agent", "hostKey": { "algorithm": "ssh-ed25519", "fingerprintSha256": "SHA256:x" } });
        let agent = docker(&view(&f, &json!({}), &s));
        assert_eq!(
            (&agent["privateKey"], &agent["password"]),
            (&Value::Null, &Value::Null)
        );
        assert_eq!(
            agent["hostKey"],
            json!({ "algorithm": "ssh-ed25519", "fingerprintSha256": "SHA256:x" })
        );
    }

    #[test]
    fn nats_defaults_tls_and_the_user() {
        let none = BTreeMap::new();
        let defaults = nats(&view(
            &json!({ "inboxPrefix": "_INBOX" }),
            &json!({}),
            &none,
        ));
        assert_eq!(defaults["servers"], json!(["nats://127.0.0.1:4222"]));
        assert_eq!(defaults["auth"], "none");
        assert_eq!(defaults["inboxPrefix"], "_INBOX");
        assert_eq!(defaults["schemaRegistry"], Value::Null);
        let f = json!({ "auth": "userPassword", "user": " lab ", "tls": { "enabled": true, "caPem": "CA" } });
        let s = secrets(&[("password", "pw")]);
        let out = nats(&view(&f, &json!({}), &s));
        assert_eq!(
            (&out["user"], &out["password"]),
            (&json!("lab"), &json!("pw"))
        );
        assert_eq!(
            out["tls"],
            json!({ "enabled": true, "caPem": "CA", "clientCertPem": null, "serverName": null, "clientKeyPem": null })
        );
    }

    #[test]
    fn langgraph_sends_its_key_headers_and_tls() {
        let f =
            json!({ "url": " https://lg.example ", "tls": { "caPem": "PEM", "serverName": "" } });
        let s = secrets(&[("apiKey", "k"), ("headerValues", "X-A: 1")]);
        let out = langgraph(&view(&f, &json!({}), &s));
        assert_eq!(out["url"], "https://lg.example");
        assert_eq!(out["apiKey"], "k");
        assert_eq!(out["headers"], json!([{ "name": "X-A", "value": "1" }]));
        assert_eq!(
            out["tls"],
            json!({ "enabled": false, "caPem": "PEM", "clientCertPem": null, "clientKeyPem": null, "serverName": null })
        );
    }

    #[test]
    fn every_connect_profile_reads_as_its_tool_s() {
        use crate::tools::{docker, echo, langgraph, nats, temporal};
        let empty = BTreeMap::new();
        let f = json!({});
        let e = json!({});
        let v = view(&f, &e, &empty);
        serde_json::from_value::<echo::ConnectEchoProfile>(echo(&v)).unwrap();
        serde_json::from_value::<nats::client::ConnectNatsProfile>(nats(&v)).unwrap();
        serde_json::from_value::<temporal::ConnectTemporalProfile>(temporal(&v)).unwrap();
        serde_json::from_value::<docker::ConnectDockerProfile>(docker(&v)).unwrap();
        serde_json::from_value::<langgraph::ConnectLanggraphProfile>(langgraph(&v)).unwrap();
    }
}
