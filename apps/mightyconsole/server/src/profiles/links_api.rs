//! `links.*`: the links of the network map (DOC-23 (aa), (bl), TSK-145). A link says how one
//! node (this server, an SSH host, a proxy) opens a stream to the next; routes are paths of
//! them (`routes.*`). A secret variable arrives in a call (redacted) and is never answered.

use std::sync::Arc;

use ambidex::{Ctx, rpc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::api::{OwnerWire, SshHostUser};
use super::links::LinkSpec;
use super::routes::{EnvInput, LinkConfirmation, LinkFields, Method, Node, User};
use super::routes_api::{
    EnvView, IdInput, blocking, etag_of, now, owner_wire, service, users_view,
};
use super::table::StoredProfile;
use super::{Access, ProfileError, ProfileService};
use crate::core::{Empty, ToolResult};

/// A link as the caller may see it.
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LinkView {
    pub id: String,
    pub from: Node,
    /// The target for the last link of a route (the profile's own address); the map draws it
    /// from the profiles that name the route.
    pub to: Node,
    pub method: Method,
    /// `command`: the program, its arguments, variables and working directory (not for a
    /// caller who sees the link's metadata only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub program: Option<String>,
    pub args: Vec<String>,
    pub env: Vec<EnvView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cwd: Option<String>,
    /// `sshCommand`: the line run on the host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub command: Option<String>,
    /// A command (local or on the host) a person must confirm before it runs.
    pub needs_confirmation: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub confirmed: Option<LinkConfirmation>,
    pub owner: OwnerWire,
    pub etag: String,
    pub created_at: String,
    pub updated_at: String,
    pub created_by: String,
    pub updated_by: String,
    /// `owner`, `edit`, `use` or `metadata`.
    pub access: String,
    /// The routes that name it and the caller sees.
    pub used_by: Vec<SshHostUser>,
    pub used_by_hidden: u32,
}

fn link_view(
    s: &ProfileService,
    link: StoredProfile,
    access: Access,
    users: Vec<User>,
) -> Result<LinkView, ProfileError> {
    let fields = LinkFields::of(&link)?;
    let full = access != Access::Metadata;
    let set = if full && fields.env.iter().any(|v| v.secret) {
        s.link_secret_status(&link.id)?
    } else {
        Vec::new()
    };
    let env = if full {
        fields
            .env
            .iter()
            .map(|v| EnvView {
                name: v.name.clone(),
                secret: v.secret,
                value: if v.secret { None } else { v.value.clone() },
                set: !v.secret || set.iter().any(|st| st.field == format!("env.{}", v.name)),
            })
            .collect()
    } else {
        Vec::new()
    };
    let (used_by, used_by_hidden) = users_view(users);
    Ok(LinkView {
        from: fields.from.clone(),
        to: fields.to.clone(),
        method: fields.method,
        program: full.then(|| fields.program.clone()).flatten(),
        args: if full {
            fields.args.clone()
        } else {
            Vec::new()
        },
        env,
        cwd: full.then(|| fields.cwd.clone()).flatten(),
        command: full.then(|| fields.command.clone()).flatten(),
        needs_confirmation: fields.needs_confirmation(),
        confirmed: fields.confirmed.clone(),
        owner: owner_wire(&link.owner),
        etag: link.etag.to_string(),
        access: access.as_str().to_owned(),
        used_by,
        used_by_hidden,
        id: link.id,
        created_at: link.created_at,
        updated_at: link.updated_at,
        created_by: link.created_by,
        updated_by: link.updated_by,
    })
}

fn link_view_of(
    s: &ProfileService,
    p: &security_types::Principal,
    id: &str,
) -> Result<LinkView, ProfileError> {
    let (link, access, graph) = s.get_link(p, id)?;
    let users = s.link_users(p, id, &graph);
    link_view(s, link, access, users)
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LinksOutput {
    pub links: Vec<LinkView>,
}

/// What a link does, as `links.create` and `links.update` take it.
#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkSpecInput {
    pub method: Method,
    /// `command`: the program (no shell), its arguments one by one, its variables and its
    /// working directory. Secret variables' values are redacted.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub program: Option<String>,
    pub args: Vec<String>,
    pub env: Vec<EnvInput>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub cwd: Option<String>,
    /// `sshCommand`: the line run on the host (`{host}` and `{port}` are the next address).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub command: Option<String>,
}

impl std::fmt::Debug for LinkSpecInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LinkSpecInput")
            .field("method", &self.method)
            .field("program", &self.program)
            .field("args", &self.args)
            .field("env", &self.env)
            .field("cwd", &self.cwd)
            .field("command", &self.command)
            .finish()
    }
}

impl LinkSpecInput {
    fn spec(self) -> LinkSpec {
        LinkSpec {
            method: self.method,
            program: self.program,
            args: self.args,
            env: self.env,
            cwd: self.cwd,
            command: self.command,
        }
    }
}

#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkCreateInput {
    pub owner: OwnerWire,
    pub from: Node,
    pub to: Node,
    pub spec: LinkSpecInput,
}

impl std::fmt::Debug for LinkCreateInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LinkCreateInput")
            .field("from", &self.from)
            .field("to", &self.to)
            .field("spec", &self.spec)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkUpdateInput {
    pub id: String,
    pub etag: String,
    pub spec: LinkSpecInput,
}

impl std::fmt::Debug for LinkUpdateInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LinkUpdateInput")
            .field("id", &self.id)
            .field("spec", &self.spec)
            .finish_non_exhaustive()
    }
}

/// `links.*`: the links of the network map.
pub struct LinksApi(pub Option<Arc<ProfileService>>);

#[rpc::router(namespace = "links")]
impl LinksApi {
    /// The links the caller sees, with the routes that name each.
    #[rpc::query(perm = "profiles.personal", risk = Risk::Read)]
    async fn list(&self, ctx: Ctx, _input: Empty) -> ToolResult<LinksOutput> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let (links, _) = s.list_links(&p)?;
            let links = links
                .into_iter()
                .map(|(link, access, users)| link_view(&s, link, access, users))
                .collect::<Result<_, _>>()?;
            Ok(LinksOutput { links })
        })
        .await?)
    }

    #[rpc::query(perm = "profiles.personal", risk = Risk::Read)]
    async fn get(&self, ctx: Ctx, input: IdInput) -> ToolResult<LinkView> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || link_view_of(&s, &p, &input.id)).await?)
    }

    /// A link between two nodes of the caller's owner. One per pair of nodes, no loop, the
    /// method one the source allows. A command starts not confirmed; a local command needs
    /// `profiles.hostAccess`.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write, redact = ["spec.env.value"])]
    async fn create(&self, ctx: Ctx, input: LinkCreateInput) -> ToolResult<LinkView> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let link = s.create_link(
                &p,
                input.owner.ownership(&p.id),
                input.from,
                input.to,
                &input.spec.spec(),
                now(),
            )?;
            link_view_of(&s, &p, &link.id)
        })
        .await?)
    }

    /// Another method or other settings for the same two nodes, at `etag`. A command whose
    /// program, argument, variable name or line changed is not confirmed any more.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write, redact = ["spec.env.value"])]
    async fn update(&self, ctx: Ctx, input: LinkUpdateInput) -> ToolResult<LinkView> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        let etag = etag_of(&input.etag)?;
        Ok(blocking(move || {
            let link = s.update_link(&p, &input.id, etag, &input.spec.spec(), now())?;
            link_view_of(&s, &p, &link.id)
        })
        .await?)
    }

    /// Deletes the link; refused while a route names it (the message lists the routes).
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write)]
    async fn delete(&self, ctx: Ctx, input: IdInput) -> ToolResult<Empty> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        blocking(move || s.delete_link(&p, &input.id)).await?;
        Ok(Empty {})
    }

    /// A person read the command of the link in full and lets it run (DOC-23 11.3).
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write)]
    async fn confirm(&self, ctx: Ctx, input: IdInput) -> ToolResult<LinkView> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let link = s.confirm_link(&p, &input.id, now())?;
            link_view_of(&s, &p, &link.id)
        })
        .await?)
    }
}
