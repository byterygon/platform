//! `proxies.*` and `routes.*` (DOC-23 §8.1, §9, (aa) to (ac); DOC-25 §3.4: same owners,
//! permissions and write-only secrets as profiles). A proxy's password and a command hop's
//! secret variables arrive in a call (redacted) and are never answered; a view lists whether
//! they are set.

use std::sync::Arc;

use ambidex::{Ctx, rpc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::api::{OwnerWire, SecretRow, SshHostUser};
use super::routes::{
    Graph, HopInput, LinkConfirmation, LinkFields, Method, Node, ProxyFields, ProxyKind,
    RouteFields, RouteKind, User,
};
use super::table::{Ownership, StoredProfile};
use super::{Access, ProfileError, ProfileService};
use crate::core::route::RouteTestLine;
use crate::core::{Empty, ToolError, ToolErrorKind, ToolResult};

pub(super) const SYSTEM: &str = "routes";

pub(super) fn tool_error(e: ProfileError) -> ToolError {
    match e {
        ProfileError::Invalid { field, message } => ToolError::invalid(SYSTEM, &field, message),
        ProfileError::NotFound => {
            ToolError::not_found(SYSTEM, "route", "no such route, proxy or link")
        }
        ProfileError::Forbidden(m) => ToolError::new(ToolErrorKind::Forbidden, SYSTEM, m),
        ProfileError::Conflict(m) => ToolError::new(ToolErrorKind::Conflict, SYSTEM, m),
        ProfileError::Store(m) => ToolError::new(ToolErrorKind::Remote, SYSTEM, m),
    }
}

pub(super) fn service(s: &Option<Arc<ProfileService>>) -> Result<Arc<ProfileService>, ToolError> {
    s.clone()
        .ok_or_else(|| ToolError::new(ToolErrorKind::Remote, SYSTEM, "no profile store"))
}

pub(super) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ProfileError> + Send + 'static,
) -> Result<T, ToolError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| ToolError::new(ToolErrorKind::Remote, SYSTEM, e.to_string()))?
        .map_err(tool_error)
}

pub(super) fn etag_of(text: &str) -> Result<u64, ToolError> {
    text.parse()
        .map_err(|_| ToolError::invalid(SYSTEM, "etag", "the etag a read answered"))
}

pub(super) fn now() -> u64 {
    security_types::unix_now_ms()
}

pub(super) fn owner_wire(owner: &Ownership) -> OwnerWire {
    match owner {
        Ownership::Personal { user } => OwnerWire::Personal {
            user: Some(user.clone()),
        },
        Ownership::Shared => OwnerWire::Shared,
    }
}

pub(super) fn users_view(users: Vec<User>) -> (Vec<SshHostUser>, u32) {
    let hidden = users.iter().filter(|u| !u.visible).count();
    (
        users
            .into_iter()
            .filter(|u| u.visible)
            .map(|u| SshHostUser {
                id: u.id,
                tool: u.tool,
                name: u.name,
            })
            .collect(),
        u32::try_from(hidden).unwrap_or(u32::MAX),
    )
}

// ---- proxies ---------------------------------------------------------------------------------

/// A saved proxy as the caller may see it: never its password.
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProxyView {
    pub id: String,
    pub name: String,
    pub fields: ProxyFields,
    /// `http://…`, `https://…` or `socks5://…`.
    pub url: String,
    pub owner: OwnerWire,
    pub etag: String,
    pub created_at: String,
    pub updated_at: String,
    pub created_by: String,
    pub updated_by: String,
    /// `owner`, `edit`, `use` or `metadata`.
    pub access: String,
    /// The secrets set (none listed for `metadata` and `use`).
    pub secrets: Vec<SecretRow>,
    /// The routes that pass it and the caller sees.
    pub used_by: Vec<SshHostUser>,
    pub used_by_hidden: u32,
}

fn proxy_view(
    s: &ProfileService,
    proxy: StoredProfile,
    access: Access,
    users: Vec<User>,
) -> Result<ProxyView, ProfileError> {
    let fields = ProxyFields::of(&proxy)?;
    let secrets = if access.may_edit() {
        s.proxy_secret_status(&proxy.id)?
            .into_iter()
            .map(SecretRow::from)
            .collect()
    } else {
        Vec::new()
    };
    let (used_by, used_by_hidden) = users_view(users);
    Ok(ProxyView {
        url: fields.url(),
        fields,
        owner: owner_wire(&proxy.owner),
        etag: proxy.etag.to_string(),
        access: access.as_str().to_owned(),
        secrets,
        used_by,
        used_by_hidden,
        id: proxy.id,
        name: proxy.name,
        created_at: proxy.created_at,
        updated_at: proxy.updated_at,
        created_by: proxy.created_by,
        updated_by: proxy.updated_by,
    })
}

fn proxy_view_of(
    s: &ProfileService,
    p: &security_types::Principal,
    id: &str,
) -> Result<ProxyView, ProfileError> {
    let (proxy, access, graph) = s.get_proxy(p, id)?;
    let users = s.node_users(p, &Node::Proxy { id: id.to_owned() }, &graph);
    proxy_view(s, proxy, access, users)
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProxiesOutput {
    pub proxies: Vec<ProxyView>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdInput {
    pub id: String,
}

#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxyCreateInput {
    pub name: String,
    pub owner: OwnerWire,
    pub fields: ProxyFields,
    /// The login's password (redacted; never answered).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub password: Option<String>,
}

impl std::fmt::Debug for ProxyCreateInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProxyCreateInput")
            .field("name", &self.name)
            .field("fields", &self.fields)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxyUpdateInput {
    pub id: String,
    pub etag: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub name: Option<String>,
    /// A change of any field removes the stored password unless `password` sets it again.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub fields: Option<ProxyFields>,
    /// Redacted; `null` keeps the stored one.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub password: Option<String>,
}

impl std::fmt::Debug for ProxyUpdateInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProxyUpdateInput")
            .field("id", &self.id)
            .field("fields", &self.fields)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProxyUpdateOutput {
    pub proxy: ProxyView,
    /// Secrets removed because the proxy's address or login changed.
    pub removed_secrets: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NamedIdInput {
    pub id: String,
    /// The name, typed as the confirmation (delete) or the new one (duplicate).
    pub name: String,
}

#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxyImportInput {
    /// The proxy's id in the export file.
    pub source_id: String,
    pub owner: OwnerWire,
    pub name: String,
    pub fields: ProxyFields,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub password: Option<String>,
}

impl std::fmt::Debug for ProxyImportInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProxyImportInput")
            .field("source_id", &self.source_id)
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProxyImportOutput {
    pub proxy: ProxyView,
    /// `false` when an earlier import of the same record made it.
    pub created: bool,
}

/// `proxies.*`: saved HTTP CONNECT and SOCKS5 proxies that routes go through (DOC-23 (ac)).
/// `None` only in the codegen router.
pub struct ProxiesApi(pub Option<Arc<ProfileService>>);

#[rpc::router(namespace = "proxies")]
impl ProxiesApi {
    /// The proxies the caller sees, with the routes that pass each.
    #[rpc::query(perm = "profiles.personal", risk = Risk::Read)]
    async fn list(&self, ctx: Ctx, _input: Empty) -> ToolResult<ProxiesOutput> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let proxies = s
                .list_proxies(&p)?
                .into_iter()
                .map(|(proxy, access, users)| proxy_view(&s, proxy, access, users))
                .collect::<Result<_, _>>()?;
            Ok(ProxiesOutput { proxies })
        })
        .await?)
    }

    #[rpc::query(perm = "profiles.personal", risk = Risk::Read)]
    async fn get(&self, ctx: Ctx, input: IdInput) -> ToolResult<ProxyView> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || proxy_view_of(&s, &p, &input.id)).await?)
    }

    /// A new personal (the caller's) or shared (`profiles.manage`) proxy.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write, redact = ["password"])]
    async fn create(&self, ctx: Ctx, input: ProxyCreateInput) -> ToolResult<ProxyView> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let proxy = s.create_proxy(
                &p,
                input.owner.ownership(&p.id),
                &input.name,
                input.fields,
                input.password,
                None,
                now(),
            )?;
            proxy_view_of(&s, &p, &proxy.id)
        })
        .await?)
    }

    /// Changes the parts given, at `etag`; a change of the address or the login removes the
    /// stored password unless the call sets it.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write, redact = ["password"])]
    async fn update(&self, ctx: Ctx, input: ProxyUpdateInput) -> ToolResult<ProxyUpdateOutput> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        let etag = etag_of(&input.etag)?;
        Ok(blocking(move || {
            let (proxy, removed) = s.update_proxy(
                &p,
                &input.id,
                etag,
                input.name.as_deref(),
                input.fields,
                input.password,
                now(),
            )?;
            Ok(ProxyUpdateOutput {
                proxy: proxy_view_of(&s, &p, &proxy.id)?,
                removed_secrets: removed,
            })
        })
        .await?)
    }

    /// Deletes the proxy and its password (confirmed by its name); refused while a route passes
    /// it.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Destructive)]
    async fn delete(&self, ctx: Ctx, input: NamedIdInput) -> ToolResult<Empty> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        blocking(move || s.delete_proxy(&p, &input.id, &input.name)).await?;
        Ok(Empty {})
    }

    /// Imports a proxy from an export file once per `sourceId`.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write, redact = ["password"])]
    async fn import(&self, ctx: Ctx, input: ProxyImportInput) -> ToolResult<ProxyImportOutput> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let (proxy, created) = s.import_proxy(
                &p,
                &input.source_id,
                input.owner.ownership(&p.id),
                &input.name,
                input.fields,
                input.password,
                now(),
            )?;
            Ok(ProxyImportOutput {
                proxy: proxy_view_of(&s, &p, &proxy.id)?,
                created,
            })
        })
        .await?)
    }
}

// ---- routes ----------------------------------------------------------------------------------

/// A variable of a command hop: a secret's value is never answered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EnvView {
    pub name: String,
    pub secret: bool,
    /// A plain variable's value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub value: Option<String>,
    /// A secret's: whether a value is stored.
    pub set: bool,
}

/// One hop of a route as the editor and the path figure show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HopView {
    /// `httpConnect`, `socks5`, `ssh`, `sshCommand` or `command`.
    pub kind: String,
    /// `host:port`, or a local command's program name.
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub proxy_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ssh_host_id: Option<String>,
    /// The proxy's or SSH host's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub node_name: Option<String>,
    /// `sshCommand`: the line run on the host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub command: Option<String>,
    /// `command`: the program, its arguments, its variables and working directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub program: Option<String>,
    pub args: Vec<String>,
    pub env: Vec<EnvView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cwd: Option<String>,
    /// The link this hop's behaviour is saved in (what `routes.confirm` names).
    pub link_id: String,
    /// A command (local or on the host) a person must confirm before it runs.
    pub needs_confirmation: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub confirmed: Option<LinkConfirmation>,
}

/// A route as the caller may see it.
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RouteView {
    pub id: String,
    pub name: String,
    pub kind: RouteKind,
    /// In order: the first is the one this server contacts.
    pub hops: Vec<HopView>,
    /// Every command of the route is confirmed: it may be tested, chosen and used.
    pub confirmed: bool,
    pub owner: OwnerWire,
    pub etag: String,
    pub created_at: String,
    pub updated_at: String,
    pub created_by: String,
    pub updated_by: String,
    /// `owner`, `edit`, `use` or `metadata`.
    pub access: String,
    /// The profiles that name it and the caller sees.
    pub used_by: Vec<SshHostUser>,
    pub used_by_hidden: u32,
}

fn hop_views(
    s: &ProfileService,
    links: &[(String, LinkFields)],
    graph: &Graph,
    full: bool,
) -> Result<Vec<HopView>, ProfileError> {
    let mut out = Vec::new();
    for (link_id, link) in links {
        let base = |kind: &str, label: String| HopView {
            kind: kind.to_owned(),
            label,
            proxy_id: None,
            ssh_host_id: None,
            node_name: None,
            command: None,
            program: None,
            args: Vec::new(),
            env: Vec::new(),
            cwd: None,
            link_id: link_id.clone(),
            needs_confirmation: link.needs_confirmation(),
            confirmed: link.confirmed.clone(),
        };
        let view = match (&link.from, link.method) {
            (_, Method::Tcp) => continue,
            (_, Method::Command) => {
                let program = link.program.clone().unwrap_or_default();
                let label = program
                    .rsplit(['/', '\\'])
                    .next()
                    .unwrap_or(&program)
                    .to_owned();
                let mut view = base("command", label);
                if full {
                    let set = s.link_secret_status(link_id)?;
                    view.program = Some(program);
                    view.args = link.args.clone();
                    view.env = link
                        .env
                        .iter()
                        .map(|v| EnvView {
                            name: v.name.clone(),
                            secret: v.secret,
                            value: if v.secret { None } else { v.value.clone() },
                            set: !v.secret
                                || set.iter().any(|st| st.field == format!("env.{}", v.name)),
                        })
                        .collect();
                    view.cwd = link.cwd.clone();
                }
                view
            }
            (Node::Proxy { id }, _) => {
                let row = graph.proxies.get(id);
                let fields = row.and_then(|r| ProxyFields::of(r).ok());
                let kind = match fields.as_ref().map(|f| f.kind) {
                    Some(ProxyKind::Socks5) => "socks5",
                    _ => "httpConnect",
                };
                let label = fields
                    .as_ref()
                    .map(|f| net_route::format_address(&f.host, f.port))
                    .unwrap_or_default();
                let mut view = base(kind, label);
                view.proxy_id = Some(id.clone());
                view.node_name = row.map(|r| r.name.clone());
                view
            }
            (Node::SshHost { id }, method) => {
                let row = graph.hosts.get(id);
                let label = row
                    .map(|r| {
                        net_route::format_address(
                            r.fields["host"].as_str().unwrap_or_default(),
                            r.fields["port"]
                                .as_u64()
                                .and_then(|p| u16::try_from(p).ok())
                                .unwrap_or(22),
                        )
                    })
                    .unwrap_or_default();
                let kind = if method == Method::SshCommand {
                    "sshCommand"
                } else {
                    "ssh"
                };
                let mut view = base(kind, label);
                view.ssh_host_id = Some(id.clone());
                view.node_name = row.map(|r| r.name.clone());
                if full {
                    view.command = link.command.clone();
                }
                view
            }
            (Node::Server | Node::Target, _) => continue,
        };
        out.push(view);
    }
    Ok(out)
}

fn route_view(
    s: &ProfileService,
    route: StoredProfile,
    access: Access,
    users: Vec<User>,
    graph: &Graph,
) -> Result<RouteView, ProfileError> {
    let fields = RouteFields::of(&route)?;
    let links = graph.route_links(&route).unwrap_or_default();
    let hops = hop_views(s, &links, graph, access != Access::Metadata)?;
    let (used_by, used_by_hidden) = users_view(users);
    Ok(RouteView {
        kind: fields.kind,
        hops,
        confirmed: graph.route_confirmed(&route),
        owner: owner_wire(&route.owner),
        etag: route.etag.to_string(),
        access: access.as_str().to_owned(),
        used_by,
        used_by_hidden,
        id: route.id,
        name: route.name,
        created_at: route.created_at,
        updated_at: route.updated_at,
        created_by: route.created_by,
        updated_by: route.updated_by,
    })
}

fn route_view_of(
    s: &ProfileService,
    p: &security_types::Principal,
    id: &str,
) -> Result<RouteView, ProfileError> {
    let (route, access, graph) = s.get_route(p, id)?;
    let users = s.route_users(p, id, &graph);
    route_view(s, route, access, users, &graph)
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutesOutput {
    pub routes: Vec<RouteView>,
}

#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteCreateInput {
    pub name: String,
    pub owner: OwnerWire,
    /// `path` (the default) or `system`.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub kind: Option<RouteKind>,
    /// 1 to 8 hops for a path; none for the System route. Secret variables' values redacted.
    pub hops: Vec<HopInput>,
}

impl std::fmt::Debug for RouteCreateInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RouteCreateInput")
            .field("name", &self.name)
            .field("kind", &self.kind)
            .field("hops", &self.hops)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteUpdateInput {
    pub id: String,
    pub etag: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub name: Option<String>,
    /// The whole path again; a command whose program, arguments, variable names or line
    /// changed is not confirmed. `null` keeps the hops.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub hops: Option<Vec<HopInput>>,
}

impl std::fmt::Debug for RouteUpdateInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RouteUpdateInput")
            .field("id", &self.id)
            .field("hops", &self.hops)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteConfirmInput {
    pub id: String,
    /// The links the confirmation showed (`HopView.linkId`).
    pub links: Vec<String>,
}

#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteImportInput {
    pub source_id: String,
    pub owner: OwnerWire,
    pub name: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub kind: Option<RouteKind>,
    pub hops: Vec<HopInput>,
}

impl std::fmt::Debug for RouteImportInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RouteImportInput")
            .field("source_id", &self.source_id)
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RouteImportOutput {
    pub route: RouteView,
    pub created: bool,
}

/// Where a Test goes.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestTarget {
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteTestInput {
    /// A saved route (confirmed), or …
    #[serde(default)]
    #[ts(optional = nullable)]
    pub route_id: Option<String>,
    /// … the editor's draft (secret variables redacted; empty ones take the stored values of
    /// the same command).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub hops: Option<Vec<HopInput>>,
    pub target: TestTarget,
}

impl std::fmt::Debug for RouteTestInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RouteTestInput")
            .field("route_id", &self.route_id)
            .field("hops", &self.hops)
            .field("target", &self.target)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RouteTestOutput {
    /// One line per hop up to the first failure, then the target when every hop passed.
    pub lines: Vec<RouteTestLine>,
    /// The route's hops (lines after a failure are "Not tried").
    pub hops: u32,
    /// The whole time, ms.
    pub ms: u32,
}

/// `routes.*`: named paths from this server to a profile's target (DOC-23 §8.1, §9).
/// `None` only in the codegen router.
pub struct RoutesApi(
    pub Option<Arc<ProfileService>>,
    pub Option<Arc<crate::core::Hub>>,
);

#[rpc::router(namespace = "routes")]
impl RoutesApi {
    /// The routes the caller sees, with the profiles that name each.
    #[rpc::query(perm = "profiles.personal", risk = Risk::Read)]
    async fn list(&self, ctx: Ctx, _input: Empty) -> ToolResult<RoutesOutput> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let (routes, graph) = s.list_routes(&p)?;
            let routes = routes
                .into_iter()
                .map(|(route, access, users)| route_view(&s, route, access, users, &graph))
                .collect::<Result<_, _>>()?;
            Ok(RoutesOutput { routes })
        })
        .await?)
    }

    #[rpc::query(perm = "profiles.personal", risk = Risk::Read)]
    async fn get(&self, ctx: Ctx, input: IdInput) -> ToolResult<RouteView> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || route_view_of(&s, &p, &input.id)).await?)
    }

    /// A new route. A local command hop or the System route needs `profiles.hostAccess`; a
    /// command starts not confirmed.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write, redact = ["hops.env.value"])]
    async fn create(&self, ctx: Ctx, input: RouteCreateInput) -> ToolResult<RouteView> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let route = s.create_route(
                &p,
                input.owner.ownership(&p.id),
                &input.name,
                input.kind.unwrap_or(RouteKind::Path),
                &input.hops,
                None,
                now(),
            )?;
            route_view_of(&s, &p, &route.id)
        })
        .await?)
    }

    /// Changes the name or the hops, at `etag`.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write, redact = ["hops.env.value"])]
    async fn update(&self, ctx: Ctx, input: RouteUpdateInput) -> ToolResult<RouteView> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        let etag = etag_of(&input.etag)?;
        Ok(blocking(move || {
            let route = s.update_route(
                &p,
                &input.id,
                etag,
                input.name.as_deref(),
                input.hops.as_deref(),
                now(),
            )?;
            route_view_of(&s, &p, &route.id)
        })
        .await?)
    }

    /// A copy named `name` over the same hops (their secrets and confirmations with them).
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write)]
    async fn duplicate(&self, ctx: Ctx, input: NamedIdInput) -> ToolResult<RouteView> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let route = s.duplicate_route(&p, &input.id, &input.name, now())?;
            route_view_of(&s, &p, &route.id)
        })
        .await?)
    }

    /// Deletes the route (confirmed by its name). The profiles that name it show "Route
    /// missing" and never connect Direct on their own.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Destructive)]
    async fn delete(&self, ctx: Ctx, input: NamedIdInput) -> ToolResult<Empty> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        blocking(move || s.delete_route(&p, &input.id, &input.name)).await?;
        Ok(Empty {})
    }

    /// A person read the commands of `links` in full and lets the route run them (DOC-23 11.3).
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write)]
    async fn confirm(&self, ctx: Ctx, input: RouteConfirmInput) -> ToolResult<RouteView> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let route = s.confirm_route(&p, &input.id, &input.links, now())?;
            route_view_of(&s, &p, &route.id)
        })
        .await?)
    }

    /// Imports a route from an export file once per `sourceId`; its commands arrive not
    /// confirmed unless the owner confirmed the very same command before.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write, redact = ["hops.env.value"])]
    async fn import(&self, ctx: Ctx, input: RouteImportInput) -> ToolResult<RouteImportOutput> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let (route, created) = s.import_route(
                &p,
                &input.source_id,
                input.owner.ownership(&p.id),
                &input.name,
                input.kind.unwrap_or(RouteKind::Path),
                &input.hops,
                now(),
            )?;
            Ok(RouteImportOutput {
                route: route_view_of(&s, &p, &route.id)?,
                created,
            })
        })
        .await?)
    }

    /// Test (DOC-23 §9, (q)): each hop in order, then TCP to the target, up to the first
    /// failure, with each step's time and each SSH hop's host key. Nothing of the tool's own
    /// protocol is spoken.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Read, redact = ["hops.env.value"], audit = "always", timeout_default = "60s", timeout_max = "60s")]
    async fn test(&self, ctx: Ctx, input: RouteTestInput) -> ToolResult<RouteTestOutput> {
        let s = service(&self.0)?;
        let hub = self
            .1
            .clone()
            .ok_or_else(|| ToolError::new(ToolErrorKind::Remote, SYSTEM, "no hub"))?;
        let p = ctx.principal().clone();
        let resolution = blocking(move || match (input.route_id, input.hops) {
            (Some(id), None) => s.resolve_for_test(&p, &id),
            (None, Some(hops)) => s.resolve_draft(&p, &hops),
            _ => Err(ProfileError::Invalid {
                field: "routeId".into(),
                message: "give a saved route's id or the draft's hops".into(),
            }),
        })
        .await?;
        let routed = resolution.routed(SYSTEM, hub.session_pool().clone())?;
        let started = std::time::Instant::now();
        let lines = routed.test(&input.target.host, input.target.port).await;
        Ok(RouteTestOutput {
            lines,
            hops: u32::try_from(routed.hop_count()).unwrap_or(u32::MAX),
            ms: u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX),
        })
    }
}
