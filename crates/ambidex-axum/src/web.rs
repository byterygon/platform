//! HTTP helpers shared by the sign-in routes and the products' page handlers: reading and
//! setting `__Host-` cookies, the `next` path a sign-in returns to, and small HTML pages.

use axum::http::{HeaderMap, HeaderValue, header};

/// The value of a header that must appear exactly once, as text.
pub fn single_header(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?;
    if values.next().is_some() {
        return None;
    }
    value.to_str().ok()
}

/// The value of cookie `name`, if it appears exactly once across all `Cookie` headers and is not
/// empty. Two cookies of one name (e.g. one planted by a sibling subdomain without the prefix)
/// are ambiguous, so the answer is `None` (fail closed).
pub fn cookie<'h>(headers: &'h HeaderMap, name: &str) -> Option<&'h str> {
    let mut found = None;
    for header in headers.get_all(header::COOKIE) {
        let header = header.to_str().ok()?;
        for pair in header.split(';') {
            let Some((key, value)) = pair.trim().split_once('=') else {
                continue;
            };
            if key == name {
                if found.is_some() {
                    return None;
                }
                found = Some(value);
            }
        }
    }
    found.filter(|value| !value.is_empty())
}

/// `SameSite` of a cookie.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SameSite {
    Strict,
    Lax,
}

/// A `Set-Cookie` value for a `__Host-` cookie: `Secure`, `HttpOnly`, `Path=/`, no `Domain`.
/// `max_age` `None` ends with the browser. The name and value must be cookie-safe tokens (they
/// are ours: fixed names and hex values).
pub fn set_cookie(
    name: &str,
    value: &str,
    same_site: SameSite,
    max_age: Option<u64>,
) -> HeaderValue {
    let same_site = match same_site {
        SameSite::Strict => "Strict",
        SameSite::Lax => "Lax",
    };
    let max_age = max_age
        .map(|s| format!("; Max-Age={s}"))
        .unwrap_or_default();
    HeaderValue::from_str(&format!(
        "{name}={value}; Path=/; Secure; HttpOnly; SameSite={same_site}{max_age}"
    ))
    .expect("cookie names and values are tokens")
}

/// A `Set-Cookie` that removes cookie `name`.
pub fn clear_cookie(name: &str, same_site: SameSite) -> HeaderValue {
    set_cookie(name, "", same_site, Some(0))
}

/// Longest `next` a sign-in keeps (DOC-25 §3.2.2).
pub const MAX_NEXT: usize = 2048;

/// The path a sign-in returns to: `next` when it is a path under `base_path` (`""` or a
/// `/`-led prefix) that starts with a single `/`, has no scheme, no `//` and no backslash, is
/// at most [`MAX_NEXT`] bytes and holds only URL characters (no quotes, spaces or controls);
/// otherwise the base path itself (`/` when it is empty).
pub fn safe_next(next: Option<&str>, base_path: &str) -> String {
    let home = if base_path.is_empty() {
        "/".to_owned()
    } else {
        base_path.to_owned()
    };
    let Some(next) = next else {
        return home;
    };
    let allowed = |b: u8| {
        b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'.'
                    | b'_'
                    | b'~'
                    | b'%'
                    | b'!'
                    | b'$'
                    | b'&'
                    | b'('
                    | b')'
                    | b'*'
                    | b'+'
                    | b','
                    | b';'
                    | b'='
                    | b':'
                    | b'@'
                    | b'/'
                    | b'?'
                    | b'#'
            )
    };
    let under_base = base_path.is_empty()
        || next == base_path
        || next
            .strip_prefix(base_path)
            .is_some_and(|rest| rest.starts_with(['/', '?', '#']));
    let ok = next.len() <= MAX_NEXT
        && next.starts_with('/')
        && !next.starts_with("//")
        && !next.contains("//")
        && next.bytes().all(allowed)
        && under_base;
    if ok { next.to_owned() } else { home }
}

/// Escapes text for an HTML attribute or element.
pub fn html_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// The page that ends a sign-in (DOC-25 §3.2.2 step 5): no script, a `<meta http-equiv=refresh>`
/// to `next` and a link. A same-origin navigation from it sends the new `SameSite=Strict`
/// cookie, which a 302 at the end of a cross-site redirect chain would not.
pub fn continue_page(next: &str) -> String {
    let next = html_escape(next);
    format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta http-equiv=\"refresh\" content=\"0;url={next}\">\n<title>Signed in</title>\n\
         </head>\n<body>\n<p>Signed in. <a href=\"{next}\">Continue</a>.</p>\n</body>\n</html>\n"
    )
}

/// Headers every sign-in answer carries: no caching, no referrer (the callback's URL holds the
/// authorization code), and a policy that allows nothing but the page itself.
pub fn auth_headers(headers: &mut HeaderMap) {
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; \
             frame-ancestors 'none'",
        ),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_must_be_a_local_path_under_the_base() {
        for (next, base, want) in [
            (None, "", "/"),
            (Some("/"), "", "/"),
            (Some("/tools/nats?x=1#/a"), "", "/tools/nats?x=1#/a"),
            (Some("//evil.example"), "", "/"),
            (Some("/\\evil.example"), "", "/"),
            (Some("https://evil.example"), "", "/"),
            (Some("evil"), "", "/"),
            (Some("/a//b"), "", "/"),
            (Some("/a\"onload"), "", "/"),
            (Some("/a b"), "", "/"),
            (Some("/a\nb"), "", "/"),
            (Some("/mc/x"), "/mc", "/mc/x"),
            (Some("/mc"), "/mc", "/mc"),
            (Some("/mc?x"), "/mc", "/mc?x"),
            (Some("/mcx"), "/mc", "/mc"),
            (Some("/other"), "/mc", "/mc"),
            (None, "/mc", "/mc"),
        ] {
            assert_eq!(safe_next(next, base), want, "{next:?} under {base:?}");
        }
        let long = format!("/{}", "a".repeat(MAX_NEXT));
        assert_eq!(safe_next(Some(&long), ""), "/");
    }

    #[test]
    fn cookies() {
        let mut h = HeaderMap::new();
        h.append(
            header::COOKIE,
            HeaderValue::from_static("a=1; __Host-x=abc"),
        );
        assert_eq!(cookie(&h, "__Host-x"), Some("abc"));
        h.append(header::COOKIE, HeaderValue::from_static("__Host-x=def"));
        assert_eq!(cookie(&h, "__Host-x"), None);
        assert_eq!(
            set_cookie("__Host-x", "ab", SameSite::Lax, Some(600)),
            "__Host-x=ab; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600"
        );
        assert_eq!(
            clear_cookie("__Host-x", SameSite::Strict),
            "__Host-x=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0"
        );
    }

    #[test]
    fn the_continue_page_escapes_and_has_no_script() {
        let page = continue_page("/a?b=1&c=2");
        assert!(page.contains("content=\"0;url=/a?b=1&amp;c=2\""));
        assert!(!page.contains("<script"));
    }
}
