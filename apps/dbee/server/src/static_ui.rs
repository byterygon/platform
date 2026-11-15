//! The static UI bundle (`apps/dbee/ui`'s `dist/`) behind the Host check, with the web shell's
//! security headers (DBee spec §11).
//!
//! Paths are resolved only inside the configured directory: each segment is percent-decoded and
//! must be a plain file name (no `.`, `..`, separators, control characters), and the resolved
//! file must still canonicalize under the directory. A path without an extension that names no
//! file falls back to `index.html` (the UI's client-side routes); a missing file with an
//! extension is 404.
//!
//! Content-Security-Policy: everything from `'self'`, the WebSocket to the public origin, the
//! Arrow Worker through `worker-src 'self'` (spec §11), inline `style` attributes for the
//! components' positioning, no frames, no plugins, no forms.

use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

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

struct Shared {
    ui: Option<StaticUi>,
    csp: HeaderValue,
}

/// The HTTP routes next to `/rpc/ws`: every path serves the UI (or 404 without one).
pub fn routes(ui: Option<StaticUi>, public_origin: &str) -> Router {
    let shared = Arc::new(Shared {
        ui,
        csp: HeaderValue::from_str(&content_security_policy(public_origin))
            .expect("a validated origin is a header value"),
    });
    Router::new().fallback(serve).with_state(shared)
}

/// The policy for the page: `connect-src` names the public origin's WebSocket explicitly for
/// browsers that do not treat `'self'` as covering `wss:`.
pub fn content_security_policy(public_origin: &str) -> String {
    let host = public_origin
        .strip_prefix("https://")
        .unwrap_or(public_origin);
    format!(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
         img-src 'self' data:; font-src 'self'; connect-src 'self' wss://{host}; \
         worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; \
         object-src 'none'"
    )
}

async fn serve(State(shared): State<Arc<Shared>>, method: Method, uri: Uri) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let Some(ui) = &shared.ui else {
        return plain(
            StatusCode::NOT_FOUND,
            "DBee server: no UI directory is configured (--ui)\n",
        );
    };
    let Some(segments) = segments(uri.path()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some((path, cache)) = resolve(ui.root(), &segments).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(bytes) = tokio::fs::read(&path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let content_type = content_type(&path);
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(bytes.clone())
    };
    let mut response = Response::new(body);
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&bytes.len().to_string()).expect("a number"),
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
    response
}

fn plain(status: StatusCode, text: &'static str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        text,
    )
        .into_response()
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
        // A decoded segment must still be a single normal path component.
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

/// The file to serve and its cache policy: the named file when it exists, otherwise
/// `index.html` for paths without an extension. The resolved path must canonicalize under
/// `root` (symlinks pointing outside are refused).
async fn resolve(root: &Path, segments: &[String]) -> Option<(PathBuf, &'static str)> {
    let (candidate, is_index) = if segments.is_empty() {
        (root.join("index.html"), true)
    } else {
        let mut path = root.to_path_buf();
        path.extend(segments.iter());
        (path, false)
    };
    let exists = tokio::fs::metadata(&candidate)
        .await
        .map(|m| m.is_file())
        .unwrap_or(false);
    let (path, cache) = if exists {
        let cache = if is_index {
            "no-cache"
        } else if segments.first().is_some_and(|s| s == "assets") {
            // Vite writes content-hashed file names under assets/.
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        (candidate, cache)
    } else {
        let has_extension = segments
            .last()
            .is_some_and(|s| s.rsplit_once('.').is_some_and(|(stem, _)| !stem.is_empty()));
        if is_index || has_extension {
            return None;
        }
        (root.join("index.html"), "no-cache")
    };
    let canonical = tokio::fs::canonicalize(&path).await.ok()?;
    canonical.starts_with(root).then_some((canonical, cache))
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
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
        assert_eq!(segments("/a//b/").unwrap(), vec!["a", "b"]);
        assert_eq!(segments("/a%20b").unwrap(), vec!["a b"]);
        for bad in [
            "/../x",
            "/./x",
            "/%2e%2e/x",
            "/assets/..%2f..%2fx",
            "/a%5cb",
            "/a%00b",
            "/%zz",
            "/%2",
            "/a%c3%28",
        ] {
            assert!(segments(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn the_policy_names_the_websocket_and_the_worker() {
        let csp = content_security_policy("https://dbee.example.com:8443");
        assert!(csp.contains("connect-src 'self' wss://dbee.example.com:8443;"));
        assert!(csp.contains("worker-src 'self';"));
        assert!(csp.contains("frame-ancestors 'none'"));
        assert!(!csp.contains("http:"));
    }
}
