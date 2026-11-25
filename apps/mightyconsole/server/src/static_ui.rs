//! The UI next to `/rpc/ws`, behind the Host check (Mightyconsole spec §2.3).
//!
//! **The page.** `GET /` (and every path without an extension that names no file, the UI's
//! client-side routes) answers the UI's `index.html` with the browser's session: a `Set-Cookie`
//! for a new session, and the anti-CSRF token in `<meta name="mightyconsole-csrf">`, which the UI
//! echoes in Hello ([`crate::sessions`]). The page is `no-store`. A page requested through an
//! allowed Host other than the public origin's (`127.0.0.1:7443` when the origin is
//! `https://localhost:7443`) is redirected there first, because the upgrade only accepts the
//! public origin. Without a UI directory the page is a short placeholder with the same session,
//! so the server is usable by tests and before the UI is built.
//!
//! **Deep paths** (DOC-21 §2.3, §3.7). The UI's URLs are `/<tool>/<profile>/<place>/<view>`, the
//! last segment always a view word. A path whose segments are not plain file names (a workflow id
//! with `:` or an encoded `/`) is still the page when its last segment has no extension: no file
//! is read for it. The page's entry asset URLs (`./assets/…`, Vite's relative base) are written
//! as `/assets/…`, so a page loaded at a deep path finds them; the bundle's own imports stay
//! relative to the module that makes them.
//!
//! **Files.** Paths are resolved only inside the UI directory, as DBee's server does: each
//! segment percent-decoded and a plain file name, the file still canonicalizing under the
//! directory. `assets/` (content-hashed by Vite) is cached for a year.
//!
//! **Embedded UI.** A release binary (feature `embed-ui`, TSK-87) carries the built UI in
//! [`EMBEDDED`] and serves it when no `--ui` directory is given; the same segment checks apply,
//! and a path is looked up by name in the sorted list, so nothing outside it can be named.
//!
//! **Signed in or out** (DOC-25 §3.2.5). The page loads either way: a live session cookie gets
//! that session's anti-CSRF token and counts as activity; without one the page carries
//! `<meta name="mightyconsole-auth" content="signed-out">`, the pre-session token of the
//! built-in accounts in `<meta name="mightyconsole-pre">` (and its `__Host-` cookie), whether
//! sign-up is open in `<meta name="mightyconsole-signup">`, the IdP's display name in
//! `<meta name="mightyconsole-idp">` when OIDC is configured, and no session token. `GET <base>/healthz` answers `ok`.
//!
//! **Headers.** The Content-Security-Policy of spec §2.3 (with `base-uri` and `form-action`
//! closed as well), `nosniff`, no referrer, HSTS, same-origin opener.

use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

use crate::RouterMode;
use crate::sessions::ServerSessions;

/// The `<meta>` name the UI reads the anti-CSRF token from.
pub const CSRF_META: &str = "mightyconsole-csrf";

/// Served as the page when no UI directory is configured.
const PLACEHOLDER: &str = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
<title>Mightyconsole</title>\n</head>\n<body>\n<p>mightyconsole-server is running. The UI is not \
built: run <code>pnpm --filter @byterygon/mightyconsole build</code> and start the server with \
<code>--ui apps/mightyconsole/ui/dist</code>.</p>\n</body>\n</html>\n";

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/embedded_ui.rs"));
}

/// The UI compiled into this binary (`(path, bytes)` sorted by path); empty unless built with
/// the `embed-ui` feature.
pub static EMBEDDED: &[(&str, &[u8])] = embedded::FILES;

/// Where the page and its files come from.
#[derive(Debug, Clone)]
pub enum UiSource {
    /// A directory given with `--ui`.
    Dir(StaticUi),
    /// Files compiled into the binary (sorted by path, with an `index.html`).
    Embedded(&'static [(&'static str, &'static [u8])]),
}

impl UiSource {
    /// The UI compiled into this binary, if it has one.
    pub fn embedded() -> Option<UiSource> {
        EMBEDDED
            .binary_search_by(|(name, _)| (*name).cmp("index.html"))
            .is_ok()
            .then_some(UiSource::Embedded(EMBEDDED))
    }
}

/// A UI directory that exists.
#[derive(Debug, Clone)]
pub struct StaticUi {
    root: PathBuf,
}

impl StaticUi {
    /// Canonicalizes `path` and checks that it is a directory.
    pub fn open(path: &Path) -> io::Result<StaticUi> {
        let root = std::fs::canonicalize(path)?;
        if !root.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::NotADirectory,
                "not a directory",
            ));
        }
        Ok(StaticUi { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

/// Whether the page is signed in (`signed-in`, `signed-out`; absent without sign-in).
pub const AUTH_META: &str = "mightyconsole-auth";
/// The IdP's display name for the sign-in link.
pub const IDP_META: &str = "mightyconsole-idp";
/// The signed-out page's pre-session token (DOC-25 §3.2.6), echoed in `X-Mightyconsole-Csrf`
/// by every `POST /auth/*`.
pub const PRE_META: &str = "mightyconsole-pre";
/// Whether the sign-in page offers sign-up: `open` or `off`.
pub const SIGNUP_META: &str = "mightyconsole-signup";

/// The `<meta>` names the UI reads its history and base path from (DOC-21 §3.7).
pub const ROUTER_META: &str = "mightyconsole-router";
pub const BASE_META: &str = "mightyconsole-base";

/// How the page is served (DOC-21 §2.3).
#[derive(Debug, Clone)]
pub struct PageConfig {
    pub cookie_name: String,
    pub public_origin: String,
    pub router: RouterMode,
    /// `""` or a validated prefix such as `/tools/mc`.
    pub base_path: String,
}

struct Shared {
    ui: Option<UiSource>,
    sessions: ServerSessions,
    page: PageConfig,
    /// `host[:port]` of the public origin.
    origin_host: String,
    csp: HeaderValue,
}

/// The HTTP routes next to `/rpc/ws`.
pub fn routes(ui: Option<UiSource>, sessions: ServerSessions, page: PageConfig) -> Router {
    let shared = Arc::new(Shared {
        ui,
        sessions,
        origin_host: page
            .public_origin
            .strip_prefix("https://")
            .unwrap_or(&page.public_origin)
            .to_owned(),
        csp: HeaderValue::from_str(&content_security_policy(&page.public_origin))
            .expect("a validated origin is a header value"),
        page,
    });
    Router::new().fallback(serve).with_state(shared)
}

/// The path under the base path (`/` for the base itself), or `None` outside it.
fn under_base<'p>(base: &str, path: &'p str) -> Option<&'p str> {
    if base.is_empty() {
        return Some(path);
    }
    match path.strip_prefix(base) {
        Some("") => Some("/"),
        Some(rest) if rest.starts_with('/') => Some(rest),
        _ => None,
    }
}

/// What every answer of the server carries when its handler set nothing else (TSK-141): error
/// answers, redirects, `healthz`, the codec endpoint's JSON and the sign-in routes are never
/// sniffed into a document, never framed and never send a referrer. The page sets its own,
/// fuller policy ([`content_security_policy`]).
pub async fn baseline_headers(mut response: axum::response::Response) -> axum::response::Response {
    let headers = response.headers_mut();
    headers
        .entry(header::X_CONTENT_TYPE_OPTIONS)
        .or_insert(HeaderValue::from_static("nosniff"));
    headers
        .entry(header::REFERRER_POLICY)
        .or_insert(HeaderValue::from_static("no-referrer"));
    headers
        .entry(header::CONTENT_SECURITY_POLICY)
        .or_insert(HeaderValue::from_static(
            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        ));
    headers
        .entry(header::X_FRAME_OPTIONS)
        .or_insert(HeaderValue::from_static("DENY"));
    response
}

/// The policy of spec §2.3. `connect-src` names the WebSocket explicitly for browsers that do
/// not count `wss:` as `'self'`; `blob:` workers and images are for Monaco and downloads.
pub fn content_security_policy(public_origin: &str) -> String {
    let host = public_origin
        .strip_prefix("https://")
        .unwrap_or(public_origin);
    format!(
        "default-src 'self'; script-src 'self'; worker-src 'self' blob:; \
         style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
         connect-src 'self' wss://{host}; font-src 'self'; object-src 'none'; \
         frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    )
}

async fn serve(
    State(shared): State<Arc<Shared>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    // Under a base path nothing else is served; `/` leads to it.
    let base = shared.page.base_path.as_str();
    let Some(path) = under_base(base, uri.path()) else {
        return if uri.path() == "/" {
            redirect(&format!("{base}/"))
        } else {
            StatusCode::NOT_FOUND.into_response()
        };
    };
    if path == "/healthz" {
        return respond(
            &shared,
            &method,
            "text/plain; charset=utf-8",
            "no-store",
            Bytes::from_static(b"ok"),
            None,
        );
    }
    // A path that cannot name a file is the page when it looks like a route (no extension).
    let hash = shared.page.router == RouterMode::Hash;
    let segments = match segments(path) {
        Some(segments) => segments,
        None if !hash && is_route(path) => Vec::new(),
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    // In hash mode the routes are in the hash: only the base path itself is the page.
    if hash && !segments.is_empty() && !has_extension(&segments) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let target = match &shared.ui {
        Some(UiSource::Dir(ui)) => resolve(ui.root(), &segments).await,
        Some(UiSource::Embedded(files)) => resolve_embedded(files, &segments),
        None if segments.is_empty() || !has_extension(&segments) => Some(Target::Page(None)),
        None => None,
    };
    match target {
        None => StatusCode::NOT_FOUND.into_response(),
        Some(Target::Page(content)) => page(&shared, &method, &uri, &headers, content).await,
        Some(Target::File(Content::Path(path), cache)) => {
            let Ok(bytes) = tokio::fs::read(&path).await else {
                return StatusCode::NOT_FOUND.into_response();
            };
            let kind = content_type(&path.to_string_lossy());
            respond(&shared, &method, kind, cache, bytes.into(), None)
        }
        Some(Target::File(Content::Static(name, bytes), cache)) => respond(
            &shared,
            &method,
            content_type(name),
            cache,
            Bytes::from_static(bytes),
            None,
        ),
    }
}

/// The UI's page with the browser's session, or a redirect to the public origin.
async fn page(
    shared: &Shared,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    content: Option<Content>,
) -> Response {
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok());
    if host.is_some_and(|h| !h.eq_ignore_ascii_case(&shared.origin_host)) {
        let path = uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
        return redirect(&format!("{}{path}", shared.page.public_origin));
    }
    let html = match content {
        Some(Content::Path(path)) => match tokio::fs::read_to_string(&path).await {
            Ok(html) => html,
            Err(_) => return StatusCode::NOT_FOUND.into_response(),
        },
        Some(Content::Static(_, bytes)) => match std::str::from_utf8(bytes) {
            Ok(html) => html.to_owned(),
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        None => PLACEHOLDER.to_owned(),
    };
    let page = &shared.page;
    let cookie = request_cookie(headers, &page.cookie_name);
    // DOC-21 §2.3: the history and the base path for the UI; both are fixed words or a
    // validated path, so they need no escaping.
    let html = absolute_assets(&html, &page.base_path);
    let html = inject_meta(&html, ROUTER_META, page.router.as_str());
    let html = inject_meta(&html, BASE_META, &page.base_path);
    let sessions = &shared.sessions;
    let (html, set_cookie) = match cookie.and_then(|c| sessions.sessions.page(c)) {
        Some(session) => {
            let html = inject_meta(&html, AUTH_META, "signed-in");
            (inject_csrf(&html, &session.csrf_token), None)
        }
        None => {
            // Signed out (DOC-25 §3.2.5, §3.2.6): the pre-session token every POST /auth/*
            // carries, whether sign-up is open, and the IdP when there is one.
            let mut html = inject_meta(&html, AUTH_META, "signed-out");
            let mut set_cookie = None;
            if let Some(accounts) = &sessions.accounts {
                let pre = accounts.pre_session(headers);
                html = inject_meta(&html, PRE_META, &pre.token);
                let signup = match accounts.signup() {
                    ambidex_axum::accounts::Signup::Open => "open",
                    ambidex_axum::accounts::Signup::Off => "off",
                };
                html = inject_meta(&html, SIGNUP_META, signup);
                set_cookie = pre.set_cookie;
            }
            if let Some(login) = &sessions.oidc {
                let idp = ambidex_axum::web::html_escape(login.display_name());
                html = inject_meta(&html, IDP_META, &idp);
            }
            (html, set_cookie)
        }
    };
    respond(
        shared,
        method,
        "text/html; charset=utf-8",
        "no-store",
        html.into(),
        set_cookie,
    )
}

fn respond(
    shared: &Shared,
    method: &Method,
    content_type: &'static str,
    cache: &'static str,
    bytes: Bytes,
    set_cookie: Option<HeaderValue>,
) -> Response {
    let length = bytes.len();
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(bytes)
    };
    let mut response = Response::new(body);
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&length.to_string()).expect("a number"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    headers.insert(header::CONTENT_SECURITY_POLICY, shared.csp.clone());
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::STRICT_TRANSPORT_SECURITY,
        HeaderValue::from_static("max-age=63072000"),
    );
    headers.insert(
        header::HeaderName::from_static("cross-origin-opener-policy"),
        HeaderValue::from_static("same-origin"),
    );
    if let Some(cookie) = set_cookie {
        headers.insert(header::SET_COOKIE, cookie);
    }
    response
}

/// The `<meta>` with the token, before `</head>` (or at the start without one). The token is
/// hex, so it needs no escaping.
pub fn inject_csrf(html: &str, token: &str) -> String {
    debug_assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
    inject_meta(html, CSRF_META, token)
}

/// A `<meta name content>` before `</head>` (or at the start without one). `content` must not
/// need escaping (no `"`, `<`, `&`).
fn inject_meta(html: &str, name: &str, content: &str) -> String {
    debug_assert!(!content.contains(['"', '<', '>', '&']));
    let meta = format!("<meta name=\"{name}\" content=\"{content}\">");
    match html.find("</head>") {
        Some(at) => format!("{}{meta}\n{}", &html[..at], &html[at..]),
        None => format!("{meta}\n{html}"),
    }
}

/// The page's entry asset URLs from Vite's relative `./assets/` to `<base>/assets/`, so they
/// resolve from any path the page is served at.
pub fn absolute_assets(html: &str, base_path: &str) -> String {
    html.replace("=\"./assets/", &format!("=\"{base_path}/assets/"))
}

/// A permanent redirect to `location`.
fn redirect(location: &str) -> Response {
    match HeaderValue::from_str(location) {
        Ok(location) => (
            StatusCode::PERMANENT_REDIRECT,
            [(header::LOCATION, location)],
        )
            .into_response(),
        Err(_) => StatusCode::BAD_REQUEST.into_response(),
    }
}

/// Whether a raw request path is a client-side route: its last segment has no extension.
fn is_route(path: &str) -> bool {
    let last = path.rsplit('/').find(|s| !s.is_empty()).unwrap_or("");
    !last.contains('.')
}

/// The value of cookie `name` in the request, if it appears exactly once.
fn request_cookie<'h>(headers: &'h HeaderMap, name: &str) -> Option<&'h str> {
    let mut found = None;
    for header in headers.get_all(header::COOKIE) {
        let header = header.to_str().ok()?;
        for pair in header.split(';') {
            if let Some((key, value)) = pair.trim().split_once('=')
                && key == name
            {
                if found.is_some() {
                    return None;
                }
                found = Some(value);
            }
        }
    }
    found.filter(|v| !v.is_empty())
}

/// A file of the UI: on disk, or compiled in (with its name, for the content type).
#[derive(Debug, PartialEq, Eq)]
enum Content {
    Path(PathBuf),
    Static(&'static str, &'static [u8]),
}

#[derive(Debug, PartialEq, Eq)]
enum Target {
    /// The page: the UI's `index.html`, or the placeholder (`None`).
    Page(Option<Content>),
    /// A file and its `Cache-Control`.
    File(Content, &'static str),
}

/// The decoded path segments, or `None` when any segment could reach outside the directory or
/// is not a plain file name. Empty segments (`//`, the trailing slash) are skipped.
fn segments(path: &str) -> Option<Vec<String>> {
    let mut out = Vec::new();
    for raw in path.split('/') {
        if raw.is_empty() {
            continue;
        }
        let segment = percent_decode(raw)?;
        if segment == "." || segment == ".." {
            return None;
        }
        if segment
            .chars()
            .any(|c| c == '/' || c == '\\' || c == '\0' || c == ':' || c.is_control())
        {
            return None;
        }
        let mut components = Path::new(&segment).components();
        match (components.next(), components.next()) {
            (Some(Component::Normal(_)), None) => {}
            _ => return None,
        }
        out.push(segment);
    }
    Some(out)
}

fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let text = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(text, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn has_extension(segments: &[String]) -> bool {
    segments
        .last()
        .is_some_and(|s| s.rsplit_once('.').is_some_and(|(stem, _)| !stem.is_empty()))
}

/// The page for `/`, `index.html` and extension-less paths that name no file; otherwise the
/// named file. The resolved path must canonicalize under `root`.
async fn resolve(root: &Path, segments: &[String]) -> Option<Target> {
    let index = || async {
        let canonical = tokio::fs::canonicalize(root.join("index.html"))
            .await
            .ok()?;
        canonical
            .starts_with(root)
            .then_some(Target::Page(Some(Content::Path(canonical))))
    };
    if segments.is_empty() || (segments.len() == 1 && segments[0] == "index.html") {
        return index().await;
    }
    let mut candidate = root.to_path_buf();
    candidate.extend(segments.iter());
    let exists = tokio::fs::metadata(&candidate)
        .await
        .map(|m| m.is_file())
        .unwrap_or(false);
    if !exists {
        return if has_extension(segments) {
            None
        } else {
            index().await
        };
    }
    let canonical = tokio::fs::canonicalize(&candidate).await.ok()?;
    if !canonical.starts_with(root) {
        return None;
    }
    Some(Target::File(
        Content::Path(canonical),
        cache_control(segments),
    ))
}

/// The same answers as [`resolve`] from the files compiled into the binary.
fn resolve_embedded(
    files: &'static [(&'static str, &'static [u8])],
    segments: &[String],
) -> Option<Target> {
    let find = |name: &str| {
        files
            .binary_search_by(|(n, _)| (*n).cmp(name))
            .ok()
            .map(|i| files[i])
    };
    let index = || find("index.html").map(|(n, b)| Target::Page(Some(Content::Static(n, b))));
    if segments.is_empty() || (segments.len() == 1 && segments[0] == "index.html") {
        return index();
    }
    match find(&segments.join("/")) {
        Some((name, bytes)) => Some(Target::File(
            Content::Static(name, bytes),
            cache_control(segments),
        )),
        None if has_extension(segments) => None,
        None => index(),
    }
}

/// `assets/` is content-hashed by Vite: cached for a year; the rest is revalidated.
fn cache_control(segments: &[String]) -> &'static str {
    if segments.first().is_some_and(|s| s == "assets") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

fn content_type(name: &str) -> &'static str {
    match name.rsplit_once('.').map(|(_, ext)| ext) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("webmanifest") => "application/manifest+json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("webp") => "image/webp",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_reject_anything_that_is_not_a_plain_file_name() {
        assert_eq!(segments("/").unwrap(), Vec::<String>::new());
        assert_eq!(
            segments("/assets/app-1.js").unwrap(),
            vec!["assets".to_owned(), "app-1.js".to_owned()]
        );
        for bad in [
            "/../x",
            "/./x",
            "/%2e%2e/x",
            "/assets/..%2f..%2fx",
            "/a%5cb",
            "/a%00b",
            "/%zz",
        ] {
            assert!(segments(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn the_policy_is_the_spec_s() {
        let csp = content_security_policy("https://localhost:7443");
        assert!(csp.contains("connect-src 'self' wss://localhost:7443;"));
        assert!(csp.contains("worker-src 'self' blob:;"));
        assert!(csp.contains("img-src 'self' data: blob:;"));
        assert!(csp.contains("script-src 'self';"));
        assert!(csp.contains("frame-ancestors 'none'"));
        assert!(csp.contains("object-src 'none'"));
        assert!(!csp.contains("http:"));
    }

    #[test]
    fn embedded_files_resolve_like_the_directory() {
        static FILES: &[(&str, &[u8])] = &[
            ("assets/app-1.js", b"js"),
            ("favicon.svg", b"<svg/>"),
            ("index.html", b"<html></html>"),
        ];
        let seg = |p: &str| segments(p).unwrap();
        let page = Some(Target::Page(Some(Content::Static(
            "index.html",
            b"<html></html>",
        ))));
        assert_eq!(resolve_embedded(FILES, &seg("/")), page);
        assert_eq!(resolve_embedded(FILES, &seg("/index.html")), page);
        // A client-side route (no extension) is the page; a missing file is not.
        assert_eq!(resolve_embedded(FILES, &seg("/nats/streams")), page);
        assert_eq!(resolve_embedded(FILES, &seg("/assets/missing.js")), None);
        assert_eq!(
            resolve_embedded(FILES, &seg("/assets/app-1.js")),
            Some(Target::File(
                Content::Static("assets/app-1.js", b"js"),
                "public, max-age=31536000, immutable"
            ))
        );
        assert_eq!(
            resolve_embedded(FILES, &seg("/favicon.svg")),
            Some(Target::File(
                Content::Static("favicon.svg", b"<svg/>"),
                "no-cache"
            ))
        );
        // Encoded separators never reach the lookup: `segments` refuses them first.
        assert!(segments("/assets%2fapp-1.js").is_none());
        assert_eq!(
            content_type("assets/app-1.js"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type("LICENSE"), "application/octet-stream");
    }

    #[test]
    fn the_embedded_list_is_sorted_and_has_a_page_when_present() {
        assert!(EMBEDDED.windows(2).all(|w| w[0].0 < w[1].0));
        if cfg!(feature = "embed-ui") {
            assert!(
                UiSource::embedded().is_some(),
                "embed-ui without index.html"
            );
        } else {
            assert!(EMBEDDED.is_empty());
            assert!(UiSource::embedded().is_none());
        }
    }

    #[test]
    fn the_token_goes_before_the_end_of_head() {
        let html = "<html><head><title>x</title></head><body></body></html>";
        let out = inject_csrf(html, "ab12");
        assert!(out.contains("<meta name=\"mightyconsole-csrf\" content=\"ab12\">\n</head>"));
        assert!(inject_csrf("<p>x</p>", "ab").starts_with("<meta name"));
    }
}
