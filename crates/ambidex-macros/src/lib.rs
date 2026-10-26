//! Procedural macros for Ambidex procedure declarations (Ambidex spec §2).
//!
//! Use them through `ambidex::rpc`; the generated code refers to the `ambidex` crate. See the
//! `ambidex::rpc` documentation for the attribute arguments.

use std::collections::HashSet;

use proc_macro::TokenStream;
use proc_macro2::{Span, TokenStream as TokenStream2};
use quote::quote;
use syn::punctuated::Punctuated;
use syn::spanned::Spanned;
use syn::{
    Attribute, FnArg, Ident, ImplItem, ImplItemFn, ItemImpl, LitStr, Path, ReturnType, Token, Type,
};

/// Registers the procedures of an `impl` block and implements `ambidex::Api` for its type.
#[proc_macro_attribute]
pub fn router(args: TokenStream, item: TokenStream) -> TokenStream {
    match expand_router(args.into(), item.into()) {
        Ok(tokens) => tokens.into(),
        Err(err) => err.to_compile_error().into(),
    }
}

macro_rules! outside_router {
    ($($name:ident),*) => {$(
        #[doc = concat!("Declares a ", stringify!($name), " procedure. Only valid on a method inside")]
        #[doc = "an `impl` block annotated with `#[rpc::router]`."]
        #[proc_macro_attribute]
        pub fn $name(_args: TokenStream, item: TokenStream) -> TokenStream {
            let item = TokenStream2::from(item);
            let err = syn::Error::new(
                Span::call_site(),
                concat!("#[rpc::", stringify!($name), "] must be used on a method inside an impl \
                         block annotated with #[rpc::router]"),
            )
            .to_compile_error();
            quote!(#err #item).into()
        }
    )*};
}

outside_router!(query, mutation, subscription, stream);

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Query,
    Mutation,
    Subscription,
    Stream,
}

impl Kind {
    fn from_ident(ident: &Ident) -> Option<Kind> {
        match ident.to_string().as_str() {
            "query" => Some(Kind::Query),
            "mutation" => Some(Kind::Mutation),
            "subscription" => Some(Kind::Subscription),
            "stream" => Some(Kind::Stream),
            _ => None,
        }
    }

    fn variant(self) -> Ident {
        let name = match self {
            Kind::Query => "Query",
            Kind::Mutation => "Mutation",
            Kind::Subscription => "Subscription",
            Kind::Stream => "Stream",
        };
        Ident::new(name, Span::call_site())
    }

    fn has_handler(self) -> bool {
        matches!(self, Kind::Query | Kind::Mutation)
    }
}

/// Parsed procedure attribute.
struct Procedure {
    kind: Kind,
    method: Ident,
    name: String,
    perm: LitStr,
    risk: Ident,
    agent: Ident,
    timeout_default_ms: Option<u64>,
    timeout_max_ms: Option<u64>,
    log_input: bool,
    redact: Vec<LitStr>,
    deprecated: bool,
    input_ty: Option<Type>,
}

fn expand_router(args: TokenStream2, item: TokenStream2) -> syn::Result<TokenStream2> {
    let mut namespace: Option<LitStr> = None;
    let parser = syn::meta::parser(|meta| {
        if meta.path.is_ident("namespace") {
            namespace = Some(meta.value()?.parse()?);
            Ok(())
        } else {
            Err(meta.error("unknown #[rpc::router] argument; expected `namespace = \"...\"`"))
        }
    });
    syn::parse::Parser::parse2(parser, args)?;
    let namespace = namespace.ok_or_else(|| {
        syn::Error::new(
            Span::call_site(),
            "#[rpc::router] requires `namespace = \"...\"`",
        )
    })?;
    if !is_name_segment(&namespace.value(), true) {
        return Err(syn::Error::new(
            namespace.span(),
            "namespace must be non-empty segments separated by `.`, without whitespace",
        ));
    }

    let mut item: ItemImpl = syn::parse2(item)?;
    if let Some((path, _)) = &item.trait_ {
        return Err(syn::Error::new(
            path.span(),
            "#[rpc::router] goes on an inherent impl block",
        ));
    }
    if !item.generics.params.is_empty() {
        return Err(syn::Error::new(
            item.generics.span(),
            "#[rpc::router] does not support generic impl blocks",
        ));
    }

    let mut procedures = Vec::new();
    let mut names = HashSet::new();
    for impl_item in &mut item.items {
        let ImplItem::Fn(method) = impl_item else {
            continue;
        };
        let Some(procedure) = take_procedure(method, &namespace.value())? else {
            continue;
        };
        if !names.insert(procedure.name.clone()) {
            return Err(syn::Error::new(
                method.sig.ident.span(),
                format!("duplicate procedure name `{}`", procedure.name),
            ));
        }
        procedures.push(procedure);
    }

    let self_ty = &item.self_ty;
    let metas = procedures.iter().map(meta_expr);
    let entries = procedures.iter().map(entry_expr);
    Ok(quote! {
        #item

        impl ::ambidex::Api for #self_ty {
            fn metas() -> ::std::vec::Vec<::ambidex::ProcedureMeta> {
                ::std::vec![#(#metas),*]
            }

            fn procedures(
                self: ::std::sync::Arc<Self>,
            ) -> ::std::vec::Vec<::ambidex::Procedure> {
                let api = self;
                let mut metas = <Self as ::ambidex::Api>::metas().into_iter();
                let mut next = move || metas.next().expect("one meta per procedure");
                ::std::vec![#(#entries),*]
            }
        }
    })
}

/// Removes the procedure attribute from `method` and parses it. `Ok(None)` for plain methods.
fn take_procedure(method: &mut ImplItemFn, namespace: &str) -> syn::Result<Option<Procedure>> {
    let mut found: Option<(Kind, Attribute)> = None;
    let mut kept = Vec::with_capacity(method.attrs.len());
    for attr in method.attrs.drain(..) {
        match procedure_kind(attr.path()) {
            Some(kind) => {
                if found.is_some() {
                    return Err(syn::Error::new(
                        attr.span(),
                        "a method can carry only one procedure attribute",
                    ));
                }
                found = Some((kind, attr));
            }
            None => kept.push(attr),
        }
    }
    method.attrs = kept;
    let Some((kind, attr)) = found else {
        return Ok(None);
    };

    let mut perm: Option<LitStr> = None;
    let mut risk: Option<Ident> = None;
    let mut agent: Option<Ident> = None;
    let mut timeout_default_ms = None;
    let mut timeout_max_ms = None;
    let mut log_input = false;
    let mut redact = Vec::new();
    let mut deprecated = false;
    let mut name: Option<LitStr> = None;

    let parse = |meta: syn::meta::ParseNestedMeta| {
        if meta.path.is_ident("perm") {
            let lit: LitStr = meta.value()?.parse()?;
            let value = lit.value();
            if value.is_empty() || value.chars().any(char::is_whitespace) {
                return Err(syn::Error::new(
                    lit.span(),
                    "`perm` must be non-empty and contain no whitespace",
                ));
            }
            perm = Some(lit);
        } else if meta.path.is_ident("risk") {
            let path: Path = meta.value()?.parse()?;
            risk = Some(enum_variant(
                &path,
                &["Read", "Write", "Destructive"],
                "Risk",
            )?);
        } else if meta.path.is_ident("agent") {
            let path: Path = meta.value()?.parse()?;
            agent = Some(enum_variant(&path, &["Exposed", "Hidden"], "Agent")?);
        } else if meta.path.is_ident("timeout_default") {
            timeout_default_ms = Some(parse_duration(&meta.value()?.parse()?)?);
        } else if meta.path.is_ident("timeout_max") {
            timeout_max_ms = Some(parse_duration(&meta.value()?.parse()?)?);
        } else if meta.path.is_ident("log_input") {
            log_input = true;
        } else if meta.path.is_ident("deprecated") {
            deprecated = true;
        } else if meta.path.is_ident("redact") {
            let content;
            let value = meta.value()?;
            syn::bracketed!(content in value);
            let paths = Punctuated::<LitStr, Token![,]>::parse_terminated(&content)?;
            for path in &paths {
                if !is_name_segment(&path.value(), true) {
                    return Err(syn::Error::new(
                        path.span(),
                        "redact paths are field names separated by `.`",
                    ));
                }
            }
            redact.extend(paths);
        } else if meta.path.is_ident("name") {
            let lit: LitStr = meta.value()?.parse()?;
            if !is_name_segment(&lit.value(), false) {
                return Err(syn::Error::new(
                    lit.span(),
                    "`name` must be one non-empty segment without `.` or whitespace",
                ));
            }
            name = Some(lit);
        } else {
            return Err(meta.error(
                "unknown procedure argument; expected perm, risk, agent, timeout_default, \
                 timeout_max, log_input, redact, name or deprecated",
            ));
        }
        Ok(())
    };
    match &attr.meta {
        syn::Meta::Path(_) => {}
        _ => attr.parse_nested_meta(parse)?,
    }

    let perm = perm.ok_or_else(|| {
        syn::Error::new(
            attr.span(),
            "missing `perm = \"...\"`: every procedure must declare the permission it requires",
        )
    })?;
    let risk = risk.ok_or_else(|| {
        syn::Error::new(
            attr.span(),
            "missing `risk = Risk::Read | Risk::Write | Risk::Destructive`",
        )
    })?;
    if let (Some(default), Some(max)) = (timeout_default_ms, timeout_max_ms)
        && default > max
    {
        return Err(syn::Error::new(
            attr.span(),
            "`timeout_default` must not exceed `timeout_max`",
        ));
    }

    let input_ty = check_signature(method, kind)?;
    let method_name = name.map_or_else(|| method.sig.ident.to_string(), |lit| lit.value());
    Ok(Some(Procedure {
        kind,
        method: method.sig.ident.clone(),
        name: format!("{namespace}.{method_name}"),
        perm,
        risk,
        agent: agent.unwrap_or_else(|| Ident::new("Hidden", Span::call_site())),
        timeout_default_ms,
        timeout_max_ms,
        log_input,
        redact,
        deprecated,
        input_ty,
    }))
}

/// `rpc::query` or bare `query` (when imported) and the other kinds.
fn procedure_kind(path: &Path) -> Option<Kind> {
    let segments: Vec<_> = path.segments.iter().collect();
    let last = segments.last()?;
    let prefix_ok = match segments.len() {
        1 => true,
        2 => segments[0].ident == "rpc",
        3 => segments[0].ident == "ambidex" && segments[1].ident == "rpc",
        _ => false,
    };
    if prefix_ok {
        Kind::from_ident(&last.ident)
    } else {
        None
    }
}

/// Checks the method shape and returns the input type for kinds with a handler.
fn check_signature(method: &ImplItemFn, kind: Kind) -> syn::Result<Option<Type>> {
    let sig = &method.sig;
    if sig.asyncness.is_none() {
        return Err(syn::Error::new(
            sig.fn_token.span(),
            "procedures must be `async fn`",
        ));
    }
    if !sig.generics.params.is_empty() {
        return Err(syn::Error::new(
            sig.generics.span(),
            "procedures cannot be generic",
        ));
    }
    match sig.inputs.first() {
        Some(FnArg::Receiver(syn::Receiver {
            kind: syn::ReceiverKind::Reference(_, _, None),
            ..
        })) => {}
        _ => {
            return Err(syn::Error::new(
                sig.ident.span(),
                "procedures take `&self` as their first parameter",
            ));
        }
    }
    if !kind.has_handler() {
        return Ok(None);
    }
    let typed: Vec<_> = sig.inputs.iter().skip(1).collect();
    let [FnArg::Typed(_ctx), FnArg::Typed(input)] = typed.as_slice() else {
        return Err(syn::Error::new(
            sig.inputs.span(),
            "queries and mutations have the shape `async fn name(&self, ctx: Ctx, input: I)`",
        ));
    };
    if matches!(sig.output, ReturnType::Default) {
        return Err(syn::Error::new(
            sig.ident.span(),
            "queries and mutations return `Result<O, E>`",
        ));
    }
    Ok(Some((*input.ty).clone()))
}

fn enum_variant(path: &Path, variants: &[&str], ty: &str) -> syn::Result<Ident> {
    let last = path.segments.last().map(|s| &s.ident);
    match last {
        Some(ident) if variants.iter().any(|v| ident == v) => Ok(ident.clone()),
        _ => Err(syn::Error::new(
            path.span(),
            format!(
                "expected one of {}",
                variants
                    .iter()
                    .map(|v| format!("{ty}::{v}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )),
    }
}

/// `"500ms"`, `"30s"`, `"5m"`, `"1h"` to milliseconds. Zero is rejected.
fn parse_duration(lit: &LitStr) -> syn::Result<u64> {
    let value = lit.value();
    let (digits, unit) = value.split_at(
        value
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(value.len()),
    );
    let factor = match unit {
        "ms" => 1,
        "s" => 1_000,
        "m" => 60_000,
        "h" => 3_600_000,
        _ => 0,
    };
    let ms = digits
        .parse::<u64>()
        .ok()
        .and_then(|n| n.checked_mul(factor))
        .filter(|ms| *ms > 0);
    ms.ok_or_else(|| {
        syn::Error::new(
            lit.span(),
            "expected a positive duration such as \"500ms\", \"30s\", \"5m\" or \"1h\"",
        )
    })
}

/// Non-empty segments of `[A-Za-z0-9_-]`, separated by `.` when `dotted`.
fn is_name_segment(s: &str, dotted: bool) -> bool {
    let ok = |seg: &str| {
        !seg.is_empty()
            && seg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    };
    if dotted { s.split('.').all(ok) } else { ok(s) }
}

fn meta_expr(p: &Procedure) -> TokenStream2 {
    let Procedure {
        name,
        perm,
        risk,
        agent,
        log_input,
        deprecated,
        ..
    } = p;
    let kind = p.kind.variant();
    let timeout_default = p
        .timeout_default_ms
        .map(|ms| quote!(meta.timeout_default = ::std::time::Duration::from_millis(#ms);));
    // When only `timeout_default` is set above the default maximum, the maximum follows it.
    let timeout_max = match (p.timeout_max_ms, p.timeout_default_ms) {
        (Some(ms), _) => Some(quote!(meta.timeout_max = ::std::time::Duration::from_millis(#ms);)),
        (None, Some(_)) => {
            Some(quote!(meta.timeout_max = meta.timeout_max.max(meta.timeout_default);))
        }
        (None, None) => None,
    };
    let redact = &p.redact;
    quote! {{
        let mut meta = ::ambidex::ProcedureMeta::new(
            #name,
            ::ambidex::ProcedureKind::#kind,
            #perm,
            ::ambidex::Risk::#risk,
        );
        meta.agent = ::ambidex::Agent::#agent;
        #timeout_default
        #timeout_max
        meta.log_input = #log_input;
        meta.redact = ::std::vec![#(::std::string::String::from(#redact)),*];
        meta.deprecated = #deprecated;
        meta
    }}
}

fn entry_expr(p: &Procedure) -> TokenStream2 {
    let method = &p.method;
    match &p.input_ty {
        Some(input_ty) => {
            quote! {
                ::ambidex::Procedure::new(
                    next(),
                    ::ambidex::router::__private::handler(&api, |api, ctx, input| {
                        ::std::boxed::Box::pin(async move {
                            let input: #input_ty =
                                ::ambidex::router::__private::decode_input(input)?;
                            ::ambidex::router::__private::encode_output(
                                api.#method(ctx, input).await,
                            )
                        })
                    }),
                )
            }
        }
        None => quote! {{
            // Declared only until the engine supports this call kind; keep the method "used".
            let _ = Self::#method;
            ::ambidex::Procedure::declared(next())
        }},
    }
}
