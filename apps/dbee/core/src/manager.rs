//! Connections, grants, sessions and events (DBee spec §4, Decisions 4–10).
//!
//! A connection record is a grant plus settings. Creating a connection *is* approving its grant:
//! [`Manager::preview`] resolves the host and builds exactly what the grant will contain, and
//! [`Manager::create`] rebuilds it from the draft, refuses when it differs from the preview the
//! approver saw (`PreviewStale`), stores the password first, then asks the Plugin Host
//! `GrantStore` with the calling principal as approver, and only then writes the record. A grant
//! change (`replaces`) revokes the old grant once the new one is active.
//!
//! Grants live in the Plugin Host store in memory; the records are durable. At startup
//! [`Manager::restore`] rebuilds the store from the records, as the owner, with an audit detail
//! saying so.
//!
//! Sessions wrap a `db_driver::Connection` opened through a broker scope bound to the calling
//! principal: one browser session per connection (reused), one editor session per tab.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ambidex::CancellationToken;
use db_driver::{Connection, ConnectionBroker, DbError, ExecuteOptions, NextItem, OperationId};
use plugin_host::grant::address_policy;
use plugin_host::{
    AddressPolicy, BrokerConfig, Caller, ContractBroker, Eligibility, GrantError, GrantId,
    GrantRequest, GrantStore, Host, IpNet, NativeBroker, SecretBinding, ServerTrust, TlsMode,
    TlsPolicy, TlsSettings,
};
use security_types::{
    AuditDetail, AuditSink, Digest, Principal, PrincipalKind, SessionId, SystemClock, TenantId,
    unix_now_ms,
};
use sha2::{Digest as _, Sha256};
use tokio::sync::broadcast;

use crate::authz::DbeeAuthorizer;
use crate::driver::{
    ArcResolver, BuiltinDriver, CREDENTIAL_TEMPLATE, DriverFactory, Resolve, TRANSPORT_TEMPLATE,
};
use crate::export::{IpcDecoder, cell_text};
use crate::secrets::{Secret, Secrets};
use crate::types::{
    AppEvent, ConnectionDraft, ConnectionError, ConnectionStatus, ConnectionSummary,
    CreateConnectionInput, DeniedReason, GrantPreview, GrantState, GrantSummary, SessionError,
    SessionPurpose, TlsDraft, TlsKind, TlsPreview, UpdateConnectionInput,
};
use crate::workspace::{
    ConnectionRecord, StoredDriver, StoredGrant, StoredSecret, StoredTls, Workspace,
};
use crate::{Failure, random_id};

/// Lead time of the `GrantExpiring` event (TSK-23, DBee spec Decision 9).
pub const EXPIRY_WARNING: Duration = Duration::from_secs(15 * 60);

/// Events buffered per subscriber before the slowest one misses some.
const EVENT_BUFFER: usize = 256;

/// One open database session.
pub struct DbSession {
    pub id: String,
    pub connection_id: String,
    pub purpose: SessionPurpose,
    /// The principal that opened it; only that principal may use it.
    pub principal_id: String,
    pub conn: Arc<dyn Connection>,
    operations: AtomicU64,
}

impl DbSession {
    /// A fresh operation id for the connection (never reused, as the contract requires).
    pub fn next_operation(&self) -> OperationId {
        let n = self.operations.fetch_add(1, Ordering::Relaxed);
        OperationId(format!("{}-{n}", self.id))
    }
}

/// What the manager is built from.
pub struct ManagerParts {
    pub workspace: Arc<Workspace>,
    pub secrets: Arc<Secrets>,
    pub audit: Arc<dyn AuditSink>,
    pub resolver: Arc<dyn Resolve>,
    pub driver: BuiltinDriver,
    pub factory: Arc<dyn DriverFactory>,
    pub tenant: TenantId,
    pub deployment_roots: Arc<rustls::RootCertStore>,
}

pub struct Manager {
    workspace: Arc<Workspace>,
    secrets: Arc<Secrets>,
    grants: Arc<GrantStore>,
    broker: Arc<NativeBroker<ArcResolver>>,
    resolver: Arc<dyn Resolve>,
    driver: BuiltinDriver,
    factory: Arc<dyn DriverFactory>,
    authz: DbeeAuthorizer,
    tenant: TenantId,
    sessions: Mutex<HashMap<String, Arc<DbSession>>>,
    statuses: Mutex<HashMap<String, ConnectionStatus>>,
    /// Expiry watchers by connection id; cancelled when the grant is replaced or deleted.
    watchers: Mutex<HashMap<String, CancellationToken>>,
    /// The live grant of each connection, by connection id. The grant store issues ids the
    /// records only keep as text; this is the handle revocation and checks need.
    live: Mutex<HashMap<String, GrantId>>,
    events: broadcast::Sender<AppEvent>,
}

impl Manager {
    pub fn new(parts: ManagerParts) -> Manager {
        let grants = Arc::new(GrantStore::new(Arc::new(SystemClock), parts.audit));
        let broker = NativeBroker::new(
            Arc::clone(&grants),
            ArcResolver(Arc::clone(&parts.resolver)),
            BrokerConfig {
                deployment_roots: parts.deployment_roots,
                ..BrokerConfig::default()
            },
        );
        let (events, _) = broadcast::channel(EVENT_BUFFER);
        Manager {
            workspace: parts.workspace,
            secrets: parts.secrets,
            grants,
            broker,
            resolver: parts.resolver,
            driver: parts.driver,
            factory: parts.factory,
            authz: DbeeAuthorizer::new(parts.tenant.clone()),
            tenant: parts.tenant,
            sessions: Mutex::default(),
            statuses: Mutex::default(),
            watchers: Mutex::default(),
            live: Mutex::default(),
            events,
        }
    }

    pub fn driver(&self) -> &BuiltinDriver {
        &self.driver
    }

    pub fn grants(&self) -> &Arc<GrantStore> {
        &self.grants
    }

    pub fn secrets(&self) -> &Arc<Secrets> {
        &self.secrets
    }

    pub fn workspace(&self) -> &Arc<Workspace> {
        &self.workspace
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.events.subscribe()
    }

    fn emit(&self, event: AppEvent) {
        let _ = self.events.send(event);
    }

    // ------------------------------------------------------------------------------------------
    // Startup
    // ------------------------------------------------------------------------------------------

    /// Rebuilds the grant store from the records: active grants are created again as their
    /// owner (with an audit detail `origin = workspace_restore`), expired ones are marked so.
    /// A grant the store refuses stays in the record (its connection cannot open) and the
    /// reason goes to stderr.
    pub async fn restore(self: &Arc<Self>) {
        let now = unix_now_ms();
        let detail = AuditDetail::new([("origin", "workspace_restore")]).expect("valid detail");
        for record in self.workspace.connections() {
            if record.grant.state != GrantState::Active {
                continue;
            }
            if record.grant.expires_at.is_some_and(|t| now >= t) {
                self.mark(&record.id, GrantState::Expired);
                self.set_status(&record.id, ConnectionStatus::Expired);
                continue;
            }
            let owner = Principal {
                kind: PrincipalKind::Human,
                id: record.grant.owner.clone(),
                tenant: self.tenant.clone(),
                on_behalf_of: None,
                roles: vec![],
                session: SessionId::new("restore"),
            };
            let Ok(request) = self.request_from_record(&record) else {
                eprintln!(
                    "dbee: connection {} has an unreadable grant; skipped",
                    record.id
                );
                continue;
            };
            let correlation_id = random_id().unwrap_or_default();
            let created = crate::audit::with_detail(
                detail.clone(),
                self.grants.create(
                    &self.authz,
                    &owner,
                    &self.driver.plugin,
                    request,
                    &correlation_id,
                ),
            )
            .await;
            match created {
                Ok(grant) => {
                    let id = grant.id.to_string();
                    lock(&self.live).insert(record.id.clone(), grant.id.clone());
                    let _ = self.workspace.update_connections(|records| {
                        if let Some(r) = records.iter_mut().find(|r| r.id == record.id) {
                            r.grant.id = id;
                        }
                    });
                    self.watch_expiry(&record.id, record.grant.expires_at);
                }
                Err(e) => eprintln!(
                    "dbee: connection {} could not be restored: {e}; it cannot connect",
                    record.id
                ),
            }
        }
    }

    /// The grant request a stored record stands for.
    fn request_from_record(&self, record: &ConnectionRecord) -> Result<GrantRequest, String> {
        let tls = tls_policy_from_stored(&record.grant.tls)?;
        let nets: Vec<&str> = record.grant.addresses.iter().map(String::as_str).collect();
        let addresses = address_policy(&nets).map_err(|_| "invalid address policy".to_owned())?;
        Ok(GrantRequest {
            tenant: self.tenant.clone(),
            owner: record.grant.owner.clone(),
            eligible: Eligibility {
                principals: [record.grant.owner.clone()].into_iter().collect(),
                roles: Default::default(),
            },
            connection_id: record.id.clone(),
            target_id: record.grant.target_id.clone(),
            template_id: record.grant.template_id.clone(),
            host: record.grant.host.clone(),
            port: record.grant.port,
            tls,
            addresses,
            secret: record.secret.as_ref().map(|s| SecretBinding {
                template_id: s.template_id.clone(),
                secret_ref: s.secret_ref.clone(),
            }),
            allow_cancel_connection: record.grant.allow_cancel_connection,
            expires_at_unix_ms: record.grant.expires_at,
        })
    }

    // ------------------------------------------------------------------------------------------
    // Listing
    // ------------------------------------------------------------------------------------------

    pub fn list(&self) -> Vec<ConnectionSummary> {
        self.workspace
            .connections()
            .iter()
            .map(|r| self.summary(r))
            .collect()
    }

    pub fn summary_of(&self, id: &str) -> Option<ConnectionSummary> {
        self.workspace.connection(id).map(|r| self.summary(&r))
    }

    fn has_secret(&self, record: &ConnectionRecord) -> bool {
        record.secret.is_some() || self.secrets.session.has(&record.id)
    }

    fn summary(&self, record: &ConnectionRecord) -> ConnectionSummary {
        let status = match record.grant.state {
            GrantState::Active => self
                .statuses
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&record.id)
                .copied()
                .unwrap_or(ConnectionStatus::Disconnected),
            GrantState::Expired => ConnectionStatus::Expired,
            GrantState::Revoked => ConnectionStatus::Disconnected,
        };
        ConnectionSummary {
            id: record.id.clone(),
            name: record.name.clone(),
            description: record.description.clone(),
            colour: record.colour.clone(),
            driver: record.driver.id.clone(),
            host: record.grant.host.clone(),
            port: record.grant.port,
            database: record.database.clone(),
            user: record.user.clone(),
            tls: record.grant.tls.kind,
            has_secret: self.has_secret(record),
            allow_cancel_connection: record.grant.allow_cancel_connection,
            status,
            grant: GrantSummary {
                id: record.grant.id.clone(),
                state: record.grant.state,
                expires_at: record.grant.expires_at,
                created_at: record.grant.created_at,
            },
        }
    }

    fn set_status(&self, connection_id: &str, status: ConnectionStatus) {
        self.statuses
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(connection_id.to_owned(), status);
        self.emit(AppEvent::ConnectionStatus {
            connection_id: connection_id.to_owned(),
            status,
        });
    }

    fn mark(&self, connection_id: &str, state: GrantState) {
        let _ = self.workspace.update_connections(|records| {
            if let Some(r) = records.iter_mut().find(|r| r.id == connection_id) {
                r.grant.state = state;
            }
        });
    }

    // ------------------------------------------------------------------------------------------
    // Prepare and create
    // ------------------------------------------------------------------------------------------

    /// Validates the draft, resolves the host and builds the preview the approver sees, with
    /// the grant request it stands for. Connects to nothing.
    pub async fn preview(
        &self,
        draft: &ConnectionDraft,
        approver: &Principal,
        replaces: Option<&str>,
    ) -> Result<Prepared, ConnectionError> {
        let invalid = |field: &str, message: &str| ConnectionError::InvalidTarget {
            field: field.into(),
            message: message.into(),
        };
        if draft.name.trim().is_empty() {
            return Err(invalid("name", "a name is required"));
        }
        let taken = self
            .workspace
            .connections()
            .iter()
            .any(|r| r.name == draft.name && Some(r.id.as_str()) != replaces);
        if taken {
            return Err(invalid("name", "a connection with this name exists"));
        }
        let host = Host::parse(draft.host.trim())
            .ok_or_else(|| invalid("host", "a host name or IP literal is required"))?;
        if draft.port == 0 {
            return Err(invalid("port", "the port must be between 1 and 65535"));
        }
        if draft.database.is_empty() {
            return Err(invalid("database", "a database is required"));
        }
        if draft.user.is_empty() {
            return Err(invalid("user", "a user is required"));
        }
        if let Some(expires_at) = draft.expires_at
            && expires_at <= unix_now_ms()
        {
            return Err(invalid("expiresAt", "the expiry is in the past"));
        }
        let (tls, stored_tls, tls_preview) = tls_from_draft(&draft.tls, &host)?;

        let resolved = self.resolve(&host, draft.port).await?;
        let proposed: Vec<IpNet> = match &draft.allowed_addresses {
            Some(list) => {
                let nets: Result<Vec<IpNet>, _> = list.iter().map(|n| n.parse()).collect();
                let nets = nets.map_err(|_| {
                    invalid("allowedAddresses", "networks must be in CIDR notation")
                })?;
                if nets.is_empty() {
                    return Err(invalid(
                        "allowedAddresses",
                        "at least one network is required",
                    ));
                }
                let policy = AddressPolicy::new(nets.iter().copied());
                if let Some(outside) = resolved.iter().find(|ip| !policy.permits(**ip)) {
                    return Err(invalid(
                        "allowedAddresses",
                        &format!("{outside} (resolved now) is not in the allowed addresses"),
                    ));
                }
                nets
            }
            None if matches!(&host, Host::Dns(name) if name == "localhost") => {
                AddressPolicy::loopback().allowed
            }
            None => resolved.iter().map(|ip| IpNet::host(*ip)).collect(),
        };
        let addresses = AddressPolicy::new(proposed.iter().copied());
        let mut preview = GrantPreview {
            driver: self.driver.info.clone(),
            template: TRANSPORT_TEMPLATE.into(),
            host: host.to_string(),
            port: draft.port,
            resolved_addresses: resolved.iter().map(ToString::to_string).collect(),
            proposed_addresses: proposed.iter().map(ToString::to_string).collect(),
            tls: tls_preview,
            allow_cancel_connection: draft.allow_cancel_connection,
            expires_at: draft.expires_at,
            secret_binding: draft.has_secret,
            approver: approver.id.clone(),
            preview_digest: String::new(),
        };
        preview.preview_digest = preview_digest(&preview);
        Ok(Prepared {
            preview,
            host,
            tls,
            stored_tls,
            addresses,
        })
    }

    async fn resolve(&self, host: &Host, port: u16) -> Result<Vec<IpAddr>, ConnectionError> {
        match host {
            Host::Ip(ip) => Ok(vec![*ip]),
            Host::Dns(name) => {
                let addrs = self.resolver.resolve(name, port).await.map_err(|e| {
                    ConnectionError::ResolveFailed {
                        message: format!("{:?}", e.kind()),
                    }
                })?;
                if addrs.is_empty() {
                    return Err(ConnectionError::ResolveFailed {
                        message: "no address".into(),
                    });
                }
                Ok(addrs)
            }
        }
    }

    /// Approves and stores a connection (see the module docs). `correlation_id` is the DBee
    /// call's; the grant operations get ids of their own, parented by the audit sink.
    pub async fn create(
        self: &Arc<Self>,
        approver: &Principal,
        input: CreateConnectionInput,
    ) -> Result<ConnectionSummary, Failure<ConnectionError>> {
        if approver.kind != PrincipalKind::Human || approver.on_behalf_of.is_some() {
            return Err(ConnectionError::GrantRefused {
                reason: "only a human acting directly may approve a connection".into(),
            }
            .into());
        }
        let replaced = match &input.replaces {
            Some(id) => Some(
                self.workspace
                    .connection(id)
                    .ok_or(ConnectionError::NotFound)?,
            ),
            None => None,
        };
        let prepared = self
            .preview(&input.draft, approver, input.replaces.as_deref())
            .await?;
        if prepared.preview.preview_digest != input.preview_digest {
            return Err(ConnectionError::PreviewStale.into());
        }

        // The secret first (DBee spec §5): a secret the grant cannot be created for is removed
        // again below.
        let mut carried = false;
        let secret = match (&input.secret, &replaced) {
            (Some(given), _) => {
                let Some(store) = &self.secrets.durable else {
                    return Err(ConnectionError::SecretStoreUnavailable {
                        reason: self
                            .secrets
                            .unavailable_reason
                            .clone()
                            .unwrap_or_else(|| "no keychain".into()),
                    }
                    .into());
                };
                let secret_ref = random_id().map_err(|_| Failure::Internal)?;
                store
                    .set(&secret_ref, Secret::new(given.password.clone()))
                    .await
                    .map_err(|e| ConnectionError::SecretStoreUnavailable { reason: e.0 })?;
                Some(StoredSecret {
                    template_id: CREDENTIAL_TEMPLATE.into(),
                    secret_ref,
                })
            }
            (None, Some(old)) if input.draft.has_secret && old.secret.is_some() => {
                carried = true;
                old.secret.clone()
            }
            (None, _) if input.draft.has_secret => {
                return Err(ConnectionError::InvalidTarget {
                    field: "hasSecret".into(),
                    message: "no password was given".into(),
                }
                .into());
            }
            (None, _) => None,
        };
        let new_secret_ref = (!carried)
            .then(|| secret.as_ref().map(|s| s.secret_ref.clone()))
            .flatten();
        let remove_new_secret = || async {
            if let (Some(store), Some(secret_ref)) = (&self.secrets.durable, &new_secret_ref) {
                let _ = store.delete(secret_ref).await;
            }
        };

        let connection_id = match &replaced {
            Some(old) => old.id.clone(),
            None => format!("conn-{}", random_id().map_err(|_| Failure::Internal)?),
        };
        let target_id = format!("tgt-{}", random_id().map_err(|_| Failure::Internal)?);
        let request = GrantRequest {
            tenant: self.tenant.clone(),
            owner: approver.id.clone(),
            eligible: Eligibility {
                principals: [approver.id.clone()].into_iter().collect(),
                roles: Default::default(),
            },
            connection_id: connection_id.clone(),
            target_id: target_id.clone(),
            template_id: TRANSPORT_TEMPLATE.into(),
            host: prepared.host.to_string(),
            port: input.draft.port,
            tls: prepared.tls.clone(),
            addresses: prepared.addresses.clone(),
            secret: secret.as_ref().map(|s| SecretBinding {
                template_id: s.template_id.clone(),
                secret_ref: s.secret_ref.clone(),
            }),
            allow_cancel_connection: input.draft.allow_cancel_connection,
            expires_at_unix_ms: input.draft.expires_at,
        };
        let correlation_id = random_id().map_err(|_| Failure::Internal)?;
        let grant = match self
            .grants
            .create(
                &self.authz,
                approver,
                &self.driver.plugin,
                request,
                &correlation_id,
            )
            .await
        {
            Ok(grant) => grant,
            Err(e) => {
                remove_new_secret().await;
                return Err(match e {
                    GrantError::Unavailable => Failure::Unavailable,
                    GrantError::Denied(reason) => ConnectionError::GrantRefused {
                        reason: format!("{reason:?}"),
                    }
                    .into(),
                    GrantError::Invalid(what) => ConnectionError::InvalidTarget {
                        field: "draft".into(),
                        message: what.to_owned(),
                    }
                    .into(),
                    GrantError::TargetInUse | GrantError::NotFound | GrantError::Internal => {
                        Failure::Internal
                    }
                });
            }
        };

        let record = ConnectionRecord {
            id: connection_id.clone(),
            name: input.draft.name.clone(),
            description: input.draft.description.clone().filter(|s| !s.is_empty()),
            colour: input.draft.colour.clone().filter(|s| !s.is_empty()),
            driver: StoredDriver {
                id: self.driver.info.id.clone(),
                version: self.driver.info.version.clone(),
                digest: self.driver.info.digest.clone(),
            },
            grant: StoredGrant {
                id: grant.id.to_string(),
                state: GrantState::Active,
                tenant: self.tenant.to_string(),
                owner: approver.id.clone(),
                target_id,
                template_id: TRANSPORT_TEMPLATE.into(),
                host: prepared.host.to_string(),
                port: input.draft.port,
                tls: prepared.stored_tls,
                addresses: prepared
                    .addresses
                    .allowed
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
                allow_cancel_connection: input.draft.allow_cancel_connection,
                created_at: grant.created_at_unix_ms,
                expires_at: grant.expires_at_unix_ms,
                approver: approver.id.clone(),
            },
            database: input.draft.database.clone(),
            user: input.draft.user.clone(),
            secret,
        };
        let written = self.workspace.update_connections(|records| {
            records.retain(|r| r.id != connection_id);
            records.push(record.clone());
        });
        if let Err(e) = written {
            eprintln!("dbee: {e}");
            let _ = self
                .grants
                .revoke(&self.authz, approver, &grant.id, &correlation_id)
                .await;
            remove_new_secret().await;
            return Err(Failure::Internal);
        }

        if let Some(old) = replaced {
            self.retire(&old, approver, !carried, "replaced").await;
        }
        lock(&self.live).insert(connection_id.clone(), grant.id.clone());
        self.watch_expiry(&connection_id, grant.expires_at_unix_ms);
        self.set_status(&connection_id, ConnectionStatus::Disconnected);
        Ok(self.summary(&record))
    }

    /// Revokes a record's grant, closes its sessions and (optionally) removes its secret. The
    /// record itself is left to the caller.
    async fn retire(
        &self,
        old: &ConnectionRecord,
        approver: &Principal,
        drop_secret: bool,
        why: &str,
    ) {
        if let Some(token) = self
            .watchers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&old.id)
        {
            token.cancel();
        }
        let live = lock(&self.live).remove(&old.id);
        if let Some(id) = live {
            let correlation_id = random_id().unwrap_or_default();
            let _ = self
                .grants
                .revoke(&self.authz, approver, &id, &correlation_id)
                .await;
        }
        self.end_sessions_of(&old.id, why);
        if drop_secret {
            if let (Some(store), Some(secret)) = (&self.secrets.durable, &old.secret) {
                let _ = store.delete(&secret.secret_ref).await;
            }
            self.secrets.session.remove(&old.id);
        }
    }

    pub async fn update(
        &self,
        input: UpdateConnectionInput,
    ) -> Result<ConnectionSummary, Failure<ConnectionError>> {
        if let Some(name) = &input.name {
            if name.trim().is_empty() {
                return Err(ConnectionError::InvalidTarget {
                    field: "name".into(),
                    message: "a name is required".into(),
                }
                .into());
            }
            if self
                .workspace
                .connections()
                .iter()
                .any(|r| r.name == *name && r.id != input.id)
            {
                return Err(ConnectionError::InvalidTarget {
                    field: "name".into(),
                    message: "a connection with this name exists".into(),
                }
                .into());
            }
        }
        let updated = self
            .workspace
            .update_connections(|records| {
                let record = records.iter_mut().find(|r| r.id == input.id)?;
                if let Some(name) = &input.name {
                    record.name = name.clone();
                }
                if let Some(description) = &input.description {
                    record.description = Some(description.clone()).filter(|s| !s.is_empty());
                }
                if let Some(colour) = &input.colour {
                    record.colour = Some(colour.clone()).filter(|s| !s.is_empty());
                }
                Some(record.clone())
            })
            .map_err(|e| {
                eprintln!("dbee: {e}");
                Failure::Internal
            })?;
        let record = updated.ok_or(ConnectionError::NotFound)?;
        Ok(self.summary(&record))
    }

    /// Stores, replaces or removes the password. With a keychain the record's binding changes;
    /// without one the password stays in memory for this process.
    pub async fn set_secret(
        &self,
        id: &str,
        password: Option<Secret>,
    ) -> Result<bool, Failure<ConnectionError>> {
        let record = self
            .workspace
            .connection(id)
            .ok_or(ConnectionError::NotFound)?;
        match &self.secrets.durable {
            Some(store) => {
                let binding = match password {
                    Some(secret) => {
                        let secret_ref = match &record.secret {
                            Some(s) => s.secret_ref.clone(),
                            None => random_id().map_err(|_| Failure::Internal)?,
                        };
                        store
                            .set(&secret_ref, secret)
                            .await
                            .map_err(|e| ConnectionError::SecretStoreUnavailable { reason: e.0 })?;
                        Some(StoredSecret {
                            template_id: CREDENTIAL_TEMPLATE.into(),
                            secret_ref,
                        })
                    }
                    None => {
                        if let Some(s) = &record.secret {
                            store.delete(&s.secret_ref).await.map_err(|e| {
                                ConnectionError::SecretStoreUnavailable { reason: e.0 }
                            })?;
                        }
                        None
                    }
                };
                let has = binding.is_some();
                self.workspace
                    .update_connections(|records| {
                        if let Some(r) = records.iter_mut().find(|r| r.id == id) {
                            r.secret = binding;
                        }
                    })
                    .map_err(|e| {
                        eprintln!("dbee: {e}");
                        Failure::Internal
                    })?;
                Ok(has)
            }
            None => {
                match password {
                    Some(secret) => self.secrets.session.set(id, secret),
                    None => self.secrets.session.remove(id),
                }
                Ok(self.secrets.session.has(id))
            }
        }
    }

    pub async fn delete(
        &self,
        approver: &Principal,
        id: &str,
    ) -> Result<(), Failure<ConnectionError>> {
        let record = self
            .workspace
            .connection(id)
            .ok_or(ConnectionError::NotFound)?;
        self.retire(&record, approver, true, "deleted").await;
        self.workspace
            .update_connections(|records| records.retain(|r| r.id != id))
            .map_err(|e| {
                eprintln!("dbee: {e}");
                Failure::Internal
            })?;
        self.statuses
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        Ok(())
    }

    // ------------------------------------------------------------------------------------------
    // Expiry
    // ------------------------------------------------------------------------------------------

    fn watch_expiry(self: &Arc<Self>, connection_id: &str, expires_at: Option<u64>) {
        let Some(expires_at) = expires_at else { return };
        let token = CancellationToken::new();
        if let Some(old) = self
            .watchers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(connection_id.to_owned(), token.clone())
        {
            old.cancel();
        }
        let manager = Arc::clone(self);
        let connection_id = connection_id.to_owned();
        tokio::spawn(async move {
            let warn_at = expires_at.saturating_sub(EXPIRY_WARNING.as_millis() as u64);
            let sleep_until = |at: u64| async move {
                let now = unix_now_ms();
                if at > now {
                    tokio::time::sleep(Duration::from_millis(at - now)).await;
                }
            };
            tokio::select! {
                () = token.cancelled() => return,
                () = sleep_until(warn_at) => {}
            }
            manager.emit(AppEvent::GrantExpiring {
                connection_id: connection_id.clone(),
                expires_at,
            });
            tokio::select! {
                () = token.cancelled() => return,
                () = sleep_until(expires_at) => {}
            }
            manager.mark(&connection_id, GrantState::Expired);
            manager.end_sessions_of(&connection_id, "grant-expired");
            manager.set_status(&connection_id, ConnectionStatus::Expired);
            manager.emit(AppEvent::GrantExpired {
                connection_id,
                expired_at: expires_at,
            });
        });
    }

    // ------------------------------------------------------------------------------------------
    // Sessions
    // ------------------------------------------------------------------------------------------

    /// The session, if it exists and `principal` opened it.
    pub fn session(&self, id: &str, principal: &Principal) -> Option<Arc<DbSession>> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .filter(|s| s.principal_id == principal.id)
            .cloned()
    }

    fn browser_session(
        &self,
        connection_id: &str,
        principal: &Principal,
    ) -> Option<Arc<DbSession>> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .find(|s| {
                s.connection_id == connection_id
                    && s.purpose == SessionPurpose::Browser
                    && s.principal_id == principal.id
            })
            .cloned()
    }

    /// Opens a database session for `connection_id` as `principal`. A browser session of the
    /// connection is reused.
    pub async fn open_session(
        &self,
        connection_id: &str,
        purpose: SessionPurpose,
        principal: &Principal,
        correlation_id: &str,
    ) -> Result<(Arc<DbSession>, String), Failure<SessionError>> {
        let record = self
            .workspace
            .connection(connection_id)
            .ok_or(SessionError::NotFound)?;
        match record.grant.state {
            GrantState::Active => {}
            GrantState::Expired => {
                return Err(SessionError::PermissionDenied {
                    reason: DeniedReason::Expired {
                        expired_at: record.grant.expires_at.unwrap_or_default(),
                    },
                }
                .into());
            }
            GrantState::Revoked => {
                return Err(SessionError::PermissionDenied {
                    reason: DeniedReason::Revoked,
                }
                .into());
            }
        }
        if purpose == SessionPurpose::Browser
            && let Some(existing) = self.browser_session(connection_id, principal)
        {
            let version = self.server_version(&existing).await;
            return Ok((existing, version));
        }
        let live = lock(&self.live).get(connection_id).cloned();
        if !live.is_some_and(|id| self.grants.is_active(&id)) {
            return Err(SessionError::PermissionDenied {
                reason: DeniedReason::Refused,
            }
            .into());
        }
        // DNS-rebinding defence is the broker's; this check explains a mismatch to the user.
        let host = Host::parse(&record.grant.host).ok_or(Failure::Internal)?;
        if let Ok(resolved) = self.resolve(&host, record.grant.port).await {
            let nets: Vec<&str> = record.grant.addresses.iter().map(String::as_str).collect();
            let policy = address_policy(&nets).map_err(|_| Failure::Internal)?;
            if let Some(outside) = resolved.iter().find(|ip| !policy.permits(**ip)) {
                return Err(SessionError::PermissionDenied {
                    reason: DeniedReason::AddressNotAllowed {
                        address: outside.to_string(),
                    },
                }
                .into());
            }
        }

        self.set_status(connection_id, ConnectionStatus::Connecting);
        let caller = Caller {
            plugin_id: self.driver.plugin.id.clone(),
            plugin_digest: self.driver.plugin.digest,
            driver_kind: self.driver.plugin.driver_kind,
            principal: principal.clone(),
            correlation_id: correlation_id.to_owned(),
        };
        let broker: Arc<dyn ConnectionBroker> =
            Arc::new(ContractBroker::new(self.broker.scope(caller)));
        let credential_ref = record.secret.as_ref().map(|s| s.secret_ref.as_str());
        let had_password = record.secret.is_some() || self.secrets.session.has(connection_id);
        let conn = match self
            .factory
            .connect(broker, &record.grant.target_id, credential_ref)
            .await
        {
            Ok(conn) => conn,
            Err(e) => {
                let status = if self.has_sessions(connection_id) {
                    ConnectionStatus::Connected
                } else {
                    ConnectionStatus::Error
                };
                self.set_status(connection_id, status);
                return Err(open_error(e, &record, had_password));
            }
        };
        let session = Arc::new(DbSession {
            id: format!("sess-{}", random_id().map_err(|_| Failure::Internal)?),
            connection_id: connection_id.to_owned(),
            purpose,
            principal_id: principal.id.clone(),
            conn: Arc::from(conn),
            operations: AtomicU64::new(0),
        });
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session.id.clone(), Arc::clone(&session));
        self.set_status(connection_id, ConnectionStatus::Connected);
        let version = self.server_version(&session).await;
        Ok((session, version))
    }

    fn has_sessions(&self, connection_id: &str) -> bool {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .any(|s| s.connection_id == connection_id)
    }

    /// Closes a session. Unknown ids are fine (idempotent).
    pub fn close_session(&self, id: &str, principal: &Principal) {
        let removed = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            match sessions.get(id) {
                Some(s) if s.principal_id == principal.id => sessions.remove(id),
                _ => None,
            }
        };
        if let Some(session) = removed
            && !self.has_sessions(&session.connection_id)
        {
            self.set_status(&session.connection_id, ConnectionStatus::Disconnected);
        }
    }

    /// Ends every session of a connection, announcing each.
    fn end_sessions_of(&self, connection_id: &str, reason: &str) {
        let ended: Vec<Arc<DbSession>> = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let ids: Vec<String> = sessions
                .values()
                .filter(|s| s.connection_id == connection_id)
                .map(|s| s.id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| sessions.remove(&id))
                .collect()
        };
        for session in ended {
            self.emit(AppEvent::SessionEnded {
                session_id: session.id.clone(),
                reason: reason.to_owned(),
            });
        }
    }

    /// `SHOW server_version` on the session, or `unknown`.
    async fn server_version(&self, session: &DbSession) -> String {
        scalar_text(
            &*session.conn,
            &session.next_operation(),
            "SHOW server_version",
        )
        .await
        .unwrap_or_else(|| "unknown".into())
    }
}

/// What `preview` produced: the preview and the grant pieces it stands for.
pub struct Prepared {
    pub preview: GrantPreview,
    pub host: Host,
    pub tls: TlsPolicy,
    pub stored_tls: StoredTls,
    pub addresses: AddressPolicy,
}

/// SHA-256 over the canonical JSON of the preview with an empty `previewDigest`.
pub fn preview_digest(preview: &GrantPreview) -> String {
    let mut p = preview.clone();
    p.preview_digest = String::new();
    let value = serde_json::to_value(&p).expect("preview serializes");
    format!("sha256:{}", ambidex::input_digest(&value))
}

fn invalid(field: &str, message: &str) -> ConnectionError {
    ConnectionError::InvalidTarget {
        field: field.into(),
        message: message.into(),
    }
}

/// The TLS policy of a draft, with its stored and displayed forms.
fn tls_from_draft(
    draft: &TlsDraft,
    host: &Host,
) -> Result<(TlsPolicy, StoredTls, TlsPreview), ConnectionError> {
    let name = |given: &Option<String>| -> String {
        given
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_ascii_lowercase)
            .unwrap_or_else(|| host.to_string())
    };
    let enabled = |server_name: String, trust: ServerTrust| {
        TlsPolicy::Enabled(TlsSettings {
            mode: TlsMode::InProtocolUpgrade,
            server_name,
            trust,
        })
    };
    Ok(match draft {
        TlsDraft::Plaintext => (
            TlsPolicy::Disabled,
            StoredTls {
                kind: TlsKind::Plaintext,
                server_name: None,
                pinned_cas: vec![],
                pinned_certs: vec![],
            },
            TlsPreview {
                kind: TlsKind::Plaintext,
                server_name: None,
                pinned: vec![],
            },
        ),
        TlsDraft::DeploymentCa { server_name } => {
            let server_name = name(server_name);
            (
                enabled(server_name.clone(), ServerTrust::DeploymentCas),
                StoredTls {
                    kind: TlsKind::DeploymentCa,
                    server_name: Some(server_name.clone()),
                    pinned_cas: vec![],
                    pinned_certs: vec![],
                },
                TlsPreview {
                    kind: TlsKind::DeploymentCa,
                    server_name: Some(server_name),
                    pinned: vec![],
                },
            )
        }
        TlsDraft::PinnedCa {
            ca_pem,
            server_name,
        } => {
            let certs = parse_pem_certificates(ca_pem)
                .ok_or_else(|| invalid("tls.caPem", "no CERTIFICATE block in the PEM text"))?;
            let server_name = name(server_name);
            let pinned: Vec<String> = certs
                .iter()
                .map(|der| format!("sha256:{}", Digest(Sha256::digest(der).into())))
                .collect();
            (
                enabled(server_name.clone(), ServerTrust::PinnedCas(certs.clone())),
                StoredTls {
                    kind: TlsKind::PinnedCa,
                    server_name: Some(server_name.clone()),
                    pinned_cas: certs.iter().map(|c| hex(c)).collect(),
                    pinned_certs: vec![],
                },
                TlsPreview {
                    kind: TlsKind::PinnedCa,
                    server_name: Some(server_name),
                    pinned,
                },
            )
        }
        TlsDraft::PinnedCert {
            fingerprint,
            server_name,
        } => {
            let digest = parse_fingerprint(fingerprint).ok_or_else(|| {
                invalid(
                    "tls.fingerprint",
                    "a SHA-256 fingerprint is 64 hex characters, optionally sha256: and colons",
                )
            })?;
            let server_name = name(server_name);
            let text = format!("sha256:{digest}");
            (
                enabled(
                    server_name.clone(),
                    ServerTrust::PinnedCertificates(vec![digest]),
                ),
                StoredTls {
                    kind: TlsKind::PinnedCert,
                    server_name: Some(server_name.clone()),
                    pinned_cas: vec![],
                    pinned_certs: vec![text.clone()],
                },
                TlsPreview {
                    kind: TlsKind::PinnedCert,
                    server_name: Some(server_name),
                    pinned: vec![text],
                },
            )
        }
    })
}

/// The Plugin Host policy of a stored TLS record.
fn tls_policy_from_stored(stored: &StoredTls) -> Result<TlsPolicy, String> {
    let server_name = stored
        .server_name
        .clone()
        .ok_or_else(|| "missing server name".to_owned());
    let enabled = |trust: ServerTrust| -> Result<TlsPolicy, String> {
        Ok(TlsPolicy::Enabled(TlsSettings {
            mode: TlsMode::InProtocolUpgrade,
            server_name: server_name.clone()?,
            trust,
        }))
    };
    match stored.kind {
        TlsKind::Plaintext => Ok(TlsPolicy::Disabled),
        TlsKind::DeploymentCa => enabled(ServerTrust::DeploymentCas),
        TlsKind::PinnedCa => {
            let certs: Option<Vec<Vec<u8>>> = stored.pinned_cas.iter().map(|h| unhex(h)).collect();
            enabled(ServerTrust::PinnedCas(certs.ok_or("invalid pinned CA")?))
        }
        TlsKind::PinnedCert => {
            let digests: Option<Vec<Digest>> = stored
                .pinned_certs
                .iter()
                .map(|f| parse_fingerprint(f))
                .collect();
            enabled(ServerTrust::PinnedCertificates(
                digests.ok_or("invalid pinned certificate")?,
            ))
        }
    }
}

/// `sha256:` prefix optional, colons optional, case-insensitive.
pub fn parse_fingerprint(text: &str) -> Option<Digest> {
    let text = text.trim();
    let text = text
        .strip_prefix("sha256:")
        .or_else(|| text.strip_prefix("SHA256:"))
        .unwrap_or(text);
    let hex: String = text
        .chars()
        .filter(|c| *c != ':' && !c.is_whitespace())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    hex.parse().ok()
}

/// The DER of every `CERTIFICATE` block in `pem`; `None` when there is none or one is invalid.
pub fn parse_pem_certificates(pem: &str) -> Option<Vec<Vec<u8>>> {
    use base64::Engine as _;
    let mut certs = Vec::new();
    let mut body: Option<String> = None;
    for line in pem.lines() {
        let line = line.trim();
        if line == "-----BEGIN CERTIFICATE-----" {
            body = Some(String::new());
        } else if line == "-----END CERTIFICATE-----" {
            let text = body.take()?;
            let der = base64::engine::general_purpose::STANDARD
                .decode(text.as_bytes())
                .ok()?;
            if der.is_empty() {
                return None;
            }
            certs.push(der);
        } else if let Some(b) = &mut body {
            b.push_str(line);
        }
    }
    (!certs.is_empty() && body.is_none()).then_some(certs)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

/// Maps a connect failure to the session error the UI explains (DBee spec §8).
fn open_error(e: DbError, record: &ConnectionRecord, had_password: bool) -> Failure<SessionError> {
    match e {
        DbError::AuthenticationFailed if !had_password => SessionError::SecretMissing.into(),
        DbError::AuthenticationFailed => SessionError::AuthenticationFailed {
            user: record.user.clone(),
        }
        .into(),
        DbError::TlsFailed => SessionError::TlsFailed {
            policy: record.grant.tls.kind,
        }
        .into(),
        DbError::PermissionDenied => SessionError::PermissionDenied {
            reason: DeniedReason::Refused,
        }
        .into(),
        DbError::ConnectionLost | DbError::Cancelled => SessionError::ConnectionLost.into(),
        DbError::Timeout => SessionError::Timeout {
            host: record.grant.host.clone(),
            port: record.grant.port,
        }
        .into(),
        DbError::InvalidQuery(q) | DbError::DatabaseError(q) => SessionError::Database {
            message: q.message,
            sqlstate: q.sqlstate,
        }
        .into(),
        DbError::Unsupported(message) => SessionError::Unsupported { message }.into(),
        DbError::Internal => Failure::Internal,
    }
}

/// Maps a driver error of a schema call.
pub fn schema_error(e: DbError) -> Failure<SessionError> {
    match e {
        DbError::PermissionDenied => SessionError::PermissionDenied {
            reason: DeniedReason::Refused,
        }
        .into(),
        DbError::AuthenticationFailed => SessionError::ConnectionLost.into(),
        DbError::TlsFailed => SessionError::ConnectionLost.into(),
        DbError::ConnectionLost | DbError::Cancelled | DbError::Timeout => {
            SessionError::ConnectionLost.into()
        }
        DbError::InvalidQuery(q) | DbError::DatabaseError(q) => SessionError::Database {
            message: q.message,
            sqlstate: q.sqlstate,
        }
        .into(),
        DbError::Unsupported(message) => SessionError::Unsupported { message }.into(),
        DbError::Internal => Failure::Internal,
    }
}

/// Runs a statement that returns one text cell and reads it. `None` on any failure.
pub async fn scalar_text(conn: &dyn Connection, op: &OperationId, sql: &str) -> Option<String> {
    let mut stream = conn
        .execute(op, sql, ExecuteOptions::default())
        .await
        .ok()?;
    let mut decoder = IpcDecoder::new();
    let mut value = None;
    loop {
        match stream.next().await {
            Ok(Some(NextItem::Chunk(chunk))) => {
                for batch in decoder.push(&chunk).ok()? {
                    if value.is_none() && batch.num_rows() > 0 && batch.num_columns() > 0 {
                        value = cell_text(batch.column(0), 0).ok().flatten();
                    }
                }
            }
            Ok(Some(NextItem::Finished(_))) | Ok(None) => return value,
            Err(_) => return None,
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_parse_in_every_common_spelling() {
        let hex = "ab".repeat(32);
        let digest: Digest = hex.parse().unwrap();
        assert_eq!(parse_fingerprint(&hex), Some(digest));
        assert_eq!(parse_fingerprint(&format!("sha256:{hex}")), Some(digest));
        assert_eq!(parse_fingerprint(&hex.to_uppercase()), Some(digest));
        let colons: Vec<String> = (0..32).map(|_| "AB".to_owned()).collect();
        assert_eq!(
            parse_fingerprint(&format!("SHA256:{}", colons.join(":"))),
            Some(digest)
        );
        assert_eq!(parse_fingerprint("abcd"), None);
    }

    #[test]
    fn pem_certificates_parse() {
        let cert = rcgen::generate_simple_self_signed(vec!["db.test".into()]).unwrap();
        let pem = cert.cert.pem();
        let two = format!("{pem}\n{pem}");
        let certs = parse_pem_certificates(&two).unwrap();
        assert_eq!(certs.len(), 2);
        assert_eq!(certs[0], cert.cert.der().to_vec());
        assert_eq!(parse_pem_certificates("nothing here"), None);
        assert_eq!(
            parse_pem_certificates("-----BEGIN CERTIFICATE-----\nAAAA\n"),
            None,
            "unterminated"
        );
    }

    #[test]
    fn preview_digest_covers_the_preview_but_not_itself() {
        let driver = crate::driver::postgres_driver();
        let mut preview = GrantPreview {
            driver: driver.info,
            template: TRANSPORT_TEMPLATE.into(),
            host: "localhost".into(),
            port: 5432,
            resolved_addresses: vec!["127.0.0.1".into()],
            proposed_addresses: vec!["127.0.0.1/32".into()],
            tls: TlsPreview {
                kind: TlsKind::Plaintext,
                server_name: None,
                pinned: vec![],
            },
            allow_cancel_connection: true,
            expires_at: None,
            secret_binding: false,
            approver: "human:local:me".into(),
            preview_digest: String::new(),
        };
        let a = preview_digest(&preview);
        preview.preview_digest = a.clone();
        assert_eq!(preview_digest(&preview), a);
        preview.port = 5433;
        assert_ne!(preview_digest(&preview), a);
    }
}
