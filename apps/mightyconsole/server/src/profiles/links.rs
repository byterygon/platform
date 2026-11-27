//! Links of the network map (DOC-23 (aa), (bl), TSK-145): the links a person draws between this
//! server, SSH hosts and proxies are saved by themselves, whether a route uses them or not.
//!
//! A route still names its links by id and is the ordered view of one path (`routes.*`). A link
//! into the target exists only inside routes: the target is whatever profile uses the route, so
//! the map draws it from the profiles and never saves a link to it on its own.
//!
//! The rules the map shows, enforced here so no client can break them:
//!
//! - the method follows the source (from this server `tcp` or `command`, from an SSH host `ssh`
//!   or `sshCommand`, from a proxy `connect`); nothing is reached *from* the target and nothing
//!   connects *into* this server;
//! - one link per pair of nodes, and no loop;
//! - both nodes exist and belong to the link's owner (DOC-23 (ae));
//! - a command (local or on a host) is not confirmed until a person has read it, and changing
//!   what it runs clears the confirmation (`links.update`); a local one needs
//!   `profiles.hostAccess` to save or confirm;
//! - a link a route uses cannot be deleted (the refusal lists the routes).

use std::collections::BTreeSet;

use security_types::Principal;

use super::routes::{
    EnvInput, Graph, LINK_TOOL, LinkConfirmation, LinkFields, Listed, Method, Node, ROUTE_TOOL,
    User, command_link, in_use_error, ssh_command_line,
};
use super::table::{self, LINKS, Ownership, StoredProfile, WriteError};
use super::{Access, ProfileError, ProfileService, invalid, now_text};
use crate::core::AppEvent;
use crate::secrets::{Owner as SecretOwner, Secret};

/// What a link does besides joining two nodes.
#[derive(Debug, Clone)]
pub struct LinkSpec {
    pub method: Method,
    /// `command`: the program, its arguments, variables and working directory.
    pub program: Option<String>,
    pub args: Vec<String>,
    pub env: Vec<EnvInput>,
    pub cwd: Option<String>,
    /// `sshCommand`: the line run on the host.
    pub command: Option<String>,
}

/// The secret variables to write and the stored ones to remove.
type SecretPlan = (Vec<(String, Secret)>, Vec<String>);

/// Whether `method` is one a link out of `from` may use.
pub fn method_fits(from: &Node, method: Method) -> bool {
    match from {
        Node::Server => matches!(method, Method::Tcp | Method::Command),
        Node::Proxy { .. } => method == Method::Connect,
        Node::SshHost { .. } => matches!(method, Method::Ssh | Method::SshCommand),
        Node::Target => false,
    }
}

fn node_name(node: &Node, graph: &Graph) -> String {
    match node {
        Node::Server => "this server".into(),
        Node::Proxy { id } => graph
            .proxies
            .get(id)
            .map_or_else(|| "a proxy".into(), |r| r.name.clone()),
        Node::SshHost { id } => graph
            .hosts
            .get(id)
            .map_or_else(|| "an SSH host".into(), |r| r.name.clone()),
        Node::Target => "the target".into(),
    }
}

/// The link `spec` makes between `from` and `to`, and the values of its secret variables.
fn link_of_spec(
    from: &Node,
    to: &Node,
    spec: &LinkSpec,
) -> Result<(LinkFields, Vec<(String, String)>), ProfileError> {
    if !method_fits(from, spec.method) {
        return Err(invalid(
            "method",
            match from {
                Node::Server => "from this server a link is a TCP connection or a local command",
                Node::Proxy { .. } => "from a proxy a link is its CONNECT request",
                Node::SshHost { .. } => {
                    "from an SSH host a link is an SSH channel or an SSH command"
                }
                Node::Target => "nothing is reached through a target",
            },
        ));
    }
    let (mut link, secrets) = match spec.method {
        Method::Command => command_link(
            0,
            spec.program.as_deref().unwrap_or(""),
            &spec.args,
            &spec.env,
            spec.cwd.as_ref(),
        )?,
        Method::SshCommand => {
            let line = ssh_command_line(0, spec.command.as_deref().unwrap_or(""))?;
            (
                LinkFields {
                    command: Some(line),
                    ..LinkFields::new(from.clone(), to.clone(), Method::SshCommand)
                },
                Vec::new(),
            )
        }
        method => (
            LinkFields::new(from.clone(), to.clone(), method),
            Vec::new(),
        ),
    };
    link.from = from.clone();
    link.to = to.clone();
    Ok((link, secrets))
}

/// Whether `to` reaches `from` over the links of `owner` (so a link from `from` to `to` would
/// close a loop). Links into a target end a path.
fn reaches(graph: &Graph, owner: &Ownership, start: &Node, goal: &Node) -> bool {
    let mut seen: BTreeSet<Node> = BTreeSet::new();
    let mut stack = vec![start.clone()];
    while let Some(at) = stack.pop() {
        if at == *goal {
            return true;
        }
        if !seen.insert(at.clone()) {
            continue;
        }
        for row in graph.links.values().filter(|r| r.owner == *owner) {
            if let Ok(link) = LinkFields::of(row)
                && link.from == at
                && link.to != Node::Target
            {
                stack.push(link.to);
            }
        }
    }
    false
}

impl Graph {
    /// The ids of the links that start or end at `node` (a node's deletion takes them along
    /// once no route uses it).
    pub(crate) fn links_at(&self, node: &Node) -> Vec<String> {
        self.links
            .iter()
            .filter(|(_, row)| LinkFields::of(row).is_ok_and(|l| l.from == *node || l.to == *node))
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// The routes that name a link.
    pub fn link_routes(&self, link_id: &str) -> Vec<&StoredProfile> {
        self.routes
            .iter()
            .filter(|route| {
                super::routes::RouteFields::of(route)
                    .is_ok_and(|f| f.links.iter().any(|l| l == link_id))
            })
            .collect()
    }

    /// Deletes, in `write`, the links at `node` with their secrets (the node is being deleted
    /// and no route uses it).
    pub(crate) fn delete_links_at(
        &self,
        write: &redb::WriteTransaction,
        node: &Node,
    ) -> Result<(), WriteError> {
        for id in self.links_at(node) {
            table::delete_in(write, LINKS, &SecretOwner::link(&id))?;
        }
        Ok(())
    }
}

impl ProfileService {
    /// What `p` may do with a link: as its owner says; a shared one is seen (never its secrets)
    /// by whoever may use a route that names it.
    pub fn link_access(&self, p: &Principal, link: &StoredProfile, graph: &Graph) -> Access {
        self.owned_access(p, &link.owner, || {
            graph
                .link_routes(&link.id)
                .iter()
                .any(|route| self.route_access(p, route, graph).may_use())
        })
    }

    /// The routes that name a link, and whether `p` sees each.
    pub fn link_users(&self, p: &Principal, link_id: &str, graph: &Graph) -> Vec<User> {
        graph
            .link_routes(link_id)
            .into_iter()
            .map(|route| User {
                id: route.id.clone(),
                tool: ROUTE_TOOL.into(),
                name: route.name.clone(),
                visible: self.route_access(p, route, graph) > Access::None,
            })
            .collect()
    }

    pub fn get_link(
        &self,
        p: &Principal,
        id: &str,
    ) -> Result<(StoredProfile, Access, Graph), ProfileError> {
        let link = self.store.row(LINKS, id)?.ok_or(ProfileError::NotFound)?;
        let graph = self.graph()?;
        match self.link_access(p, &link, &graph) {
            Access::None => Err(ProfileError::NotFound),
            access => Ok((link, access, graph)),
        }
    }

    /// Every link `p` sees, with that access and the routes that name it.
    pub fn list_links(&self, p: &Principal) -> Result<(Vec<Listed>, Graph), ProfileError> {
        let graph = self.graph()?;
        let links = graph
            .links
            .values()
            .filter_map(|link| match self.link_access(p, link, &graph) {
                Access::None => None,
                access => Some((link.clone(), access, self.link_users(p, &link.id, &graph))),
            })
            .collect();
        Ok((links, graph))
    }

    fn link_changed(&self, link: &StoredProfile) {
        let event = AppEvent::LinkChanged {
            id: link.id.clone(),
        };
        let graph = self.graph().ok();
        self.hub.publish_where(&event, |p| match &graph {
            Some(g) => self.link_access(p, link, g) > Access::None,
            None => false,
        });
        if let Some(g) = &graph {
            for route in g.link_routes(&link.id) {
                self.route_changed(route);
            }
        }
    }

    /// Checks a node a link starts or ends at: this server, or a proxy or SSH host that exists
    /// and has the link's owner.
    fn check_link_node(
        &self,
        owner: &Ownership,
        node: &Node,
        graph: &Graph,
        field: &str,
    ) -> Result<(), ProfileError> {
        let (row, what) = match node {
            Node::Proxy { id } => (graph.proxies.get(id), "proxy"),
            Node::SshHost { id } => (graph.hosts.get(id), "SSH host"),
            Node::Server => return Ok(()),
            Node::Target => {
                return Err(invalid(
                    field,
                    "a link into the target is made by saving a route",
                ));
            }
        };
        let row = row.ok_or_else(|| invalid(field, format!("no such {what}")))?;
        if row.owner != *owner {
            return Err(invalid(
                field,
                match owner {
                    Ownership::Personal { .. } => {
                        format!("a personal link joins its owner's own {what}s")
                    }
                    Ownership::Shared => format!("a shared link joins shared {what}s"),
                },
            ));
        }
        Ok(())
    }

    /// The secret variables a link keeps in the vault: each gets the value `given` or the one
    /// already stored, and the stored ones the link no longer has are removed.
    fn link_secrets(
        &self,
        id: Option<&str>,
        link: &LinkFields,
        given: Vec<(String, String)>,
    ) -> Result<SecretPlan, ProfileError> {
        let stored: BTreeSet<String> = match id {
            Some(id) => self
                .link_secret_status(id)?
                .into_iter()
                .map(|s| s.field)
                .collect(),
            None => BTreeSet::new(),
        };
        let mut set: Vec<(String, Secret)> = given
            .into_iter()
            .map(|(k, v)| (k, Secret::new(v.into_bytes())))
            .collect();
        let wanted: BTreeSet<String> = link
            .env
            .iter()
            .filter(|v| v.secret)
            .map(|v| format!("env.{}", v.name))
            .collect();
        for field in &wanted {
            if !set.iter().any(|(k, _)| k == field) && !stored.contains(field) {
                return Err(invalid(
                    "env",
                    format!(
                        "enter the value of the secret variable {}",
                        field.trim_start_matches("env.")
                    ),
                ));
            }
        }
        set.sort_by(|a, b| a.0.cmp(&b.0));
        let remove = stored.difference(&wanted).cloned().collect();
        Ok((set, remove))
    }

    /// `links.create`: a link from `from` to `to`, saved by itself. A command starts not
    /// confirmed.
    pub fn create_link(
        &self,
        p: &Principal,
        owner: Ownership,
        from: Node,
        to: Node,
        spec: &LinkSpec,
        now_ms: u64,
    ) -> Result<StoredProfile, ProfileError> {
        self.may_create(p, &owner)?;
        let graph = self.graph()?;
        self.check_link_node(&owner, &from, &graph, "from")?;
        self.check_link_node(&owner, &to, &graph, "to")?;
        if to == Node::Server {
            return Err(invalid("to", "nothing connects into this server"));
        }
        if from == to {
            return Err(invalid("to", "a node does not reach itself"));
        }
        let (link, given) = link_of_spec(&from, &to, spec)?;
        if link.method == Method::Command {
            self.may_reach_host(p)?;
        }
        let pair = |row: &StoredProfile| {
            row.owner == owner && LinkFields::of(row).is_ok_and(|l| l.from == from && l.to == to)
        };
        if graph.links.values().any(pair) {
            return Err(ProfileError::Conflict(format!(
                "{} already reaches {}",
                node_name(&from, &graph),
                node_name(&to, &graph)
            )));
        }
        if reaches(&graph, &owner, &to, &from) {
            return Err(invalid("to", "that would make a loop"));
        }
        let (secrets, _) = self.link_secrets(None, &link, given)?;
        let row = self.new_row(
            &p.id,
            LINK_TOOL,
            owner,
            String::new(),
            serde_json::to_value(&link).unwrap_or_default(),
            now_ms,
        );
        let stored = self.store.put_row(LINKS, row, None, |write, stored| {
            self.write_secrets(
                write,
                &SecretOwner::link(&stored.id),
                &secrets,
                &[],
                &p.id,
                now_ms,
            )?;
            Ok(())
        })?;
        self.link_changed(&stored);
        Ok(stored)
    }

    /// `links.update`: another method or other settings for the same two nodes, at `etag`.
    /// What the link runs changing clears its confirmation, and so confirms again every route
    /// over it.
    pub fn update_link(
        &self,
        p: &Principal,
        id: &str,
        etag: u64,
        spec: &LinkSpec,
        now_ms: u64,
    ) -> Result<StoredProfile, ProfileError> {
        let (current, access, graph) = self.get_link(p, id)?;
        if !access.may_edit() {
            return Err(ProfileError::Forbidden("you may not edit this link".into()));
        }
        let before = LinkFields::of(&current)?;
        let (mut after, given) = link_of_spec(&before.from, &before.to, spec)?;
        if before.method == Method::Command || after.method == Method::Command {
            self.may_reach_host(p)?;
        }
        if after.same_as(&before) {
            after.confirmed = before.confirmed.clone();
        }
        let twin = graph.links.values().any(|row| {
            row.id != id
                && row.owner == current.owner
                && LinkFields::of(row).is_ok_and(|l| l.same_as(&after))
        });
        if twin {
            return Err(ProfileError::Conflict(
                "another link already does exactly this".into(),
            ));
        }
        let (secrets, remove) = self.link_secrets(Some(id), &after, given)?;
        let mut next = current.clone();
        next.fields = serde_json::to_value(&after).unwrap_or_default();
        next.updated_at = now_text(now_ms);
        next.updated_by = p.id.clone();
        let remove: Vec<&str> = remove.iter().map(String::as_str).collect();
        let stored = self
            .store
            .put_row(LINKS, next, Some(etag), |write, stored| {
                self.write_secrets(
                    write,
                    &SecretOwner::link(&stored.id),
                    &secrets,
                    &remove,
                    &p.id,
                    now_ms,
                )?;
                Ok(())
            })?;
        self.link_changed(&stored);
        Ok(stored)
    }

    /// `links.delete`: refused while a route names the link (the message lists them).
    pub fn delete_link(&self, p: &Principal, id: &str) -> Result<(), ProfileError> {
        let (current, access, _) = self.get_link(p, id)?;
        if !access.may_edit() {
            return Err(ProfileError::Forbidden(
                "you may not delete this link".into(),
            ));
        }
        let mut in_use = None;
        self.store
            .delete_row(LINKS, SecretOwner::link(id), |write| {
                let graph = Graph::in_write(write)?;
                let users = self.link_users(p, id, &graph);
                if !users.is_empty() {
                    in_use = Some(users);
                    return Err(WriteError::Stale);
                }
                Ok(())
            })
            .map_err(|e| match in_use.take() {
                Some(users) => in_use_error("this link", "link", &users),
                None => e.into(),
            })?;
        self.link_changed(&current);
        Ok(())
    }

    /// `links.confirm`: a person read the command of the link as the panel showed it and lets
    /// it run. A local command needs `profiles.hostAccess`.
    pub fn confirm_link(
        &self,
        p: &Principal,
        id: &str,
        now_ms: u64,
    ) -> Result<StoredProfile, ProfileError> {
        let (current, access, _) = self.get_link(p, id)?;
        if !access.may_edit() {
            return Err(ProfileError::Forbidden(
                "you may not confirm this link".into(),
            ));
        }
        let mut fields = LinkFields::of(&current)?;
        if !fields.needs_confirmation() {
            return Err(invalid("id", "this link runs no command to confirm"));
        }
        if fields.method == Method::Command {
            self.may_reach_host(p)?;
        }
        if fields.confirmed.is_some() {
            return Ok(current);
        }
        let at = now_text(now_ms);
        fields.confirmed = Some(LinkConfirmation {
            by: p.id.clone(),
            at: at.clone(),
        });
        let mut next = current.clone();
        next.fields = serde_json::to_value(&fields).unwrap_or_default();
        next.updated_at = at;
        next.updated_by = p.id.clone();
        let stored = self
            .store
            .put_row(LINKS, next, Some(current.etag), |_, _| Ok(()))?;
        self.link_changed(&stored);
        Ok(stored)
    }
}
