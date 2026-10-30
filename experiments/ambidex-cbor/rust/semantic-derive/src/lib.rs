//! Experimental semantic metadata derived from the same Rust/serde declarations.
use proc_macro::TokenStream;
use quote::quote;
use syn::{Data, DeriveInput, Fields, parse_macro_input};
#[derive(Default)]
struct Attr {
    rename: Option<String>,
    rename_all: Option<String>,
    tag: Option<String>,
    content: Option<String>,
    untagged: bool,
    default: bool,
    skip: bool,
    skip_de: bool,
    skip_ser: bool,
    skip_if: bool,
    flatten: bool,
    deny_unknown: bool,
}
fn attrs(a: &[syn::Attribute]) -> syn::Result<Attr> {
    let mut out = Attr::default();
    for a in a.iter().filter(|a| a.path().is_ident("serde")) {
        a.parse_nested_meta(|m|{let key=m.path.get_ident().map(ToString::to_string).unwrap_or_default();match key.as_str(){"rename"=>out.rename=Some(m.value()?.parse::<syn::LitStr>()?.value()),"rename_all"=>out.rename_all=Some(m.value()?.parse::<syn::LitStr>()?.value()),"tag"=>out.tag=Some(m.value()?.parse::<syn::LitStr>()?.value()),"content"=>out.content=Some(m.value()?.parse::<syn::LitStr>()?.value()),"untagged"=>out.untagged=true,"default"=>{out.default=true;if m.input.peek(syn::Token![=]){return Err(m.error("custom default functions require explicit semantic metadata; unsupported in this spike derive"));}},"skip"=>out.skip=true,"skip_deserializing"=>out.skip_de=true,"skip_serializing"=>out.skip_ser=true,"skip_serializing_if"=>{out.skip_if=true;let _:syn::LitStr=m.value()?.parse()?;},"flatten"=>out.flatten=true,"deny_unknown_fields"=>out.deny_unknown=true,_=>return Err(m.error("unsupported serde attribute in experimental semantic derive; do not silently omit semantics"))};Ok(())})?;
    }
    Ok(out)
}
fn renamed(name: &str, rule: Option<&str>) -> syn::Result<String> {
    let words = if name.contains('_') {
        name.split('_').map(str::to_owned).collect::<Vec<_>>()
    } else {
        let mut words = Vec::new();
        let mut word = String::new();
        for c in name.chars() {
            if c.is_uppercase() && !word.is_empty() {
                words.push(word);
                word = String::new();
            }
            word.extend(c.to_lowercase());
        }
        if !word.is_empty() {
            words.push(word);
        }
        words
    };
    Ok(match rule {
        None => name.into(),
        Some("snake_case") => words.join("_"),
        Some("kebab-case") => words.join("-"),
        Some("SCREAMING_SNAKE_CASE") => words.join("_").to_uppercase(),
        Some("lowercase") => name.to_lowercase(),
        Some("UPPERCASE") => name.to_uppercase(),
        Some("camelCase") => words
            .iter()
            .enumerate()
            .map(|(i, w)| {
                if i == 0 {
                    w.clone()
                } else {
                    let mut c = w.chars();
                    c.next().unwrap().to_uppercase().collect::<String>() + c.as_str()
                }
            })
            .collect(),
        Some("PascalCase") => words
            .iter()
            .map(|w| {
                let mut c = w.chars();
                c.next().unwrap().to_uppercase().collect::<String>() + c.as_str()
            })
            .collect(),
        Some(_) => {
            return Err(syn::Error::new(
                proc_macro2::Span::call_site(),
                "unsupported rename rule",
            ));
        }
    })
}
fn fields(f: &Fields, rule: Option<&str>) -> syn::Result<proc_macro2::TokenStream> {
    match f {
        Fields::Named(fs) => {
            let mut expr = Vec::new();
            let mut field_names = std::collections::HashSet::new();
            for field in &fs.named {
                let a = attrs(&field.attrs)?;
                if a.skip {
                    continue;
                }
                let ty = &field.ty;
                let name = a.rename.unwrap_or(renamed(
                    field
                        .ident
                        .as_ref()
                        .unwrap()
                        .to_string()
                        .trim_start_matches("r#"),
                    rule,
                )?);
                if !field_names.insert(name.clone()) {
                    return Err(syn::Error::new_spanned(
                        field,
                        "duplicate serde-visible field name",
                    ));
                }
                let (default, skip_de, skip_ser, skip_if, flatten) =
                    (a.default, a.skip_de, a.skip_ser, a.skip_if, a.flatten);
                let default_value = if default {
                    quote! {Some(crate::model::default_metadata::<#ty>()?)}
                } else {
                    quote! {None::<serde_json::Value>}
                };
                expr.push(quote!{if !((direction==Direction::Input && #skip_de)||(direction==Direction::Output && #skip_ser)){fields.push(serde_json::json!({"name":#name,"schema":<#ty as Semantic>::describe(g,direction)?,"optional":if direction==Direction::Input{#default||<#ty as Semantic>::accepts_missing()}else{#skip_if},"default":#default_value,"flatten":#flatten}));}});
            }
            Ok(
                quote! {{let mut fields=Vec::new();#(#expr)* fields.sort_by(|a,b|a["name"].as_str().cmp(&b["name"].as_str()));serde_json::json!({"type":"object","unknownFields":"ignore","fields":fields})}},
            )
        }
        Fields::Unnamed(fs) => {
            let expr: Vec<_> = fs
                .unnamed
                .iter()
                .map(|f| {
                    let ty = &f.ty;
                    quote! {<#ty as Semantic>::describe(g,direction)?}
                })
                .collect();
            if expr.len() == 1 {
                Ok(quote! {#(#expr)*})
            } else {
                Ok(quote! {serde_json::json!({"type":"tuple","items":[#(#expr),*]})})
            }
        }
        Fields::Unit => Ok(quote! {serde_json::json!({"type":"unit"})}),
    }
}
#[proc_macro_derive(Semantic, attributes(serde))]
pub fn derive(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    match expand(input) {
        Ok(t) => t.into(),
        Err(e) => e.into_compile_error().into(),
    }
}
fn expand(input: DeriveInput) -> syn::Result<proc_macro2::TokenStream> {
    let a = attrs(&input.attrs)?;
    let ident = &input.ident;
    let name = a.rename.unwrap_or(ident.to_string());
    let mut generics = input.generics.clone();
    for t in generics.type_params_mut() {
        t.bounds.push(syn::parse_quote!(Semantic));
    }
    let (imp, ty, where_) = generics.split_for_impl();
    let params: Vec<_> = input
        .generics
        .type_params()
        .map(|t| {
            let id = &t.ident;
            quote! {<#id as Semantic>::name()}
        })
        .collect();
    let body = match &input.data {
        Data::Struct(s) => {
            let f = fields(&s.fields, a.rename_all.as_deref())?;
            let policy = if a.deny_unknown { "reject" } else { "ignore" };
            quote! {{let mut node=#f;if node["type"]=="object"{node["unknownFields"]=serde_json::json!(#policy);}node}}
        }
        Data::Enum(e) => {
            let mut variants = Vec::new();
            for v in &e.variants {
                let va = attrs(&v.attrs)?;
                if va.skip {
                    continue;
                }
                let name = va
                    .rename
                    .unwrap_or(renamed(&v.ident.to_string(), a.rename_all.as_deref())?);
                let f = fields(&v.fields, None)?;
                variants.push(
                    quote! {{let schema=#f;serde_json::json!({"name":#name,"schema":schema})}},
                );
            }
            let untagged = a.untagged;
            let tag = a.tag;
            let content = a.content;
            let tag = tag
                .map(|v| quote! {Some(#v)})
                .unwrap_or(quote! {None::<&str>});
            let content = content
                .map(|v| quote! {Some(#v)})
                .unwrap_or(quote! {None::<&str>});
            quote! {{let mut variants=vec![#(#variants),*];if !#untagged{variants.sort_by(|a,b|a["name"].as_str().cmp(&b["name"].as_str()));}serde_json::json!({"type":"enum","untagged":#untagged,"tag":#tag,"content":#content,"variants":variants})}}
        }
        Data::Union(_) => return Err(syn::Error::new_spanned(ident, "unions unsupported")),
    };
    Ok(
        quote! {impl #imp Semantic for #ident #ty #where_ {fn name()->String{let params:Vec<String>=vec![#(#params),*];if params.is_empty(){#name.into()}else{format!("{}<{}>",#name,params.join(","))}}fn describe(g:&mut Graph,direction:Direction)->Result<serde_json::Value,String>{let name=<Self as Semantic>::name();if g.begin::<Self>(&name,direction)? {let node=#body;g.finish(&name,direction,node);}Ok(serde_json::json!({"ref":name}))}}},
    )
}
