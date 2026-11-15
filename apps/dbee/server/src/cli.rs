//! Command line of `dbee-server`, parsed by hand (no dependency): `serve`, `audit verify`.

use std::net::SocketAddr;
use std::path::PathBuf;

use crate::ServeConfig;

pub const USAGE: &str = "\
dbee-server: DBee self-hosted web server

USAGE
  dbee-server serve --tls-cert FILE --tls-key FILE --allowed-host HOST[:PORT]...
                    --public-origin https://HOST[:PORT] [OPTIONS]
  dbee-server audit verify FILE
  dbee-server --version | --help

SERVE OPTIONS
  --tls-cert FILE          PEM certificate chain, leaf first (required)
  --tls-key FILE           PEM private key, PKCS#8, SEC1 or PKCS#1 (required)
  --allowed-host HOST      Host header values accepted; repeatable; include the port when
                           it is not 443 (required, at least one)
  --public-origin ORIGIN   lowercase https://host[:port] the browser sees; the WebSocket
                           upgrade's Origin must equal it (required)
  --bind ADDR:PORT         TLS listener (default 127.0.0.1:8443)
  --workspace DIR          connections, settings, tabs and audit/log.jsonl
                           (default: $DBEE_WORKSPACE, then the OS data directory)
  --ui DIR                 the built UI (index.html, assets/); without it every non-RPC
                           path answers 404
  --deployment-ca FILE     PEM CA certificates for database grants with the \"required,
                           deployment CAs\" TLS policy; repeatable; nothing is loaded
                           implicitly

AUDIT VERIFY
  Checks the hash chain of an audit log (audit/log.jsonl) and lists calls whose outcome
  was never recorded. Exit 0 when the chain verifies, 1 otherwise.

There is no login before Ambidex M3 (OIDC): the server refuses every /rpc/ws upgrade.
Plain HTTP is not served; put the server behind nothing, or behind a TLS-terminating proxy
once M3 adds that mode.
";

/// What the command line asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Serve(ServeConfig),
    AuditVerify(PathBuf),
    Help,
    Version,
}

/// Parses the arguments after the program name. `default_workspace` is used when `--workspace`
/// is absent.
pub fn parse(
    args: impl IntoIterator<Item = String>,
    default_workspace: Option<PathBuf>,
) -> Result<Command, String> {
    let mut args = args.into_iter().peekable();
    let Some(first) = args.next() else {
        return Err("missing command (serve, audit verify, --help)".into());
    };
    match first.as_str() {
        "--help" | "-h" | "help" => Ok(Command::Help),
        "--version" | "-V" | "version" => Ok(Command::Version),
        "audit" => match (args.next().as_deref(), args.next(), args.next()) {
            (Some("verify"), Some(file), None) => Ok(Command::AuditVerify(file.into())),
            (Some("verify"), None, _) => Err("audit verify: missing FILE".into()),
            (Some("verify"), Some(_), Some(extra)) => {
                Err(format!("audit verify: unexpected argument {extra:?}"))
            }
            (Some(other), _, _) => Err(format!("audit: unknown subcommand {other:?}")),
            (None, _, _) => Err("audit: missing subcommand (verify)".into()),
        },
        "serve" => parse_serve(args, default_workspace).map(Command::Serve),
        other => Err(format!("unknown command {other:?}")),
    }
}

fn parse_serve(
    mut args: impl Iterator<Item = String>,
    default_workspace: Option<PathBuf>,
) -> Result<ServeConfig, String> {
    let mut bind: Option<SocketAddr> = None;
    let mut tls_cert = None;
    let mut tls_key = None;
    let mut allowed_hosts = Vec::new();
    let mut public_origin = None;
    let mut workspace = None;
    let mut ui = None;
    let mut deployment_cas = Vec::new();

    while let Some(arg) = args.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => {
                (flag.to_owned(), Some(value.to_owned()))
            }
            _ => (arg.clone(), None),
        };
        let mut value = || -> Result<String, String> {
            match inline.clone().or_else(|| args.next()) {
                Some(v) if !v.is_empty() => Ok(v),
                _ => Err(format!("{flag}: missing value")),
            }
        };
        match flag.as_str() {
            "--bind" => {
                let text = value()?;
                bind = Some(text.parse().map_err(|e| format!("--bind {text:?}: {e}"))?);
            }
            "--tls-cert" => tls_cert = Some(PathBuf::from(value()?)),
            "--tls-key" => tls_key = Some(PathBuf::from(value()?)),
            "--allowed-host" => allowed_hosts.push(value()?),
            "--public-origin" => public_origin = Some(value()?),
            "--workspace" => workspace = Some(PathBuf::from(value()?)),
            "--ui" => ui = Some(PathBuf::from(value()?)),
            "--deployment-ca" => deployment_cas.push(PathBuf::from(value()?)),
            other => return Err(format!("serve: unknown option {other:?}")),
        }
    }

    let workspace = workspace
        .or(default_workspace)
        .ok_or("serve: --workspace is required (no OS data directory and DBEE_WORKSPACE unset)")?;
    Ok(ServeConfig {
        bind: bind.unwrap_or_else(|| SocketAddr::from(([127, 0, 0, 1], 8443))),
        tls_cert: tls_cert.ok_or("serve: --tls-cert is required")?,
        tls_key: tls_key.ok_or("serve: --tls-key is required")?,
        allowed_hosts: if allowed_hosts.is_empty() {
            return Err("serve: at least one --allowed-host is required".into());
        } else {
            allowed_hosts
        },
        public_origin: public_origin.ok_or("serve: --public-origin is required")?,
        workspace,
        ui,
        deployment_cas,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(text: &str) -> Vec<String> {
        text.split_whitespace().map(str::to_owned).collect()
    }

    #[test]
    fn serve_needs_tls_hosts_and_origin() {
        let full = parse(
            args(
                "serve --tls-cert c.pem --tls-key=k.pem --allowed-host dbee.test \
                 --allowed-host dbee.test:8443 --public-origin https://dbee.test --ui dist \
                 --deployment-ca ca1.pem --deployment-ca ca2.pem --bind 0.0.0.0:443",
            ),
            Some("/data".into()),
        )
        .unwrap();
        assert_eq!(
            full,
            Command::Serve(ServeConfig {
                bind: "0.0.0.0:443".parse().unwrap(),
                tls_cert: "c.pem".into(),
                tls_key: "k.pem".into(),
                allowed_hosts: vec!["dbee.test".into(), "dbee.test:8443".into()],
                public_origin: "https://dbee.test".into(),
                workspace: "/data".into(),
                ui: Some("dist".into()),
                deployment_cas: vec!["ca1.pem".into(), "ca2.pem".into()],
            })
        );
        let minimal = "serve --tls-cert c --tls-key k --allowed-host h --public-origin https://h";
        match parse(args(minimal), Some("/data".into())).unwrap() {
            Command::Serve(config) => {
                assert_eq!(config.bind, "127.0.0.1:8443".parse().unwrap());
                assert_eq!(config.ui, None);
                assert!(config.deployment_cas.is_empty());
            }
            other => panic!("{other:?}"),
        }
        for (missing, message) in [
            (
                "serve --tls-key k --allowed-host h --public-origin https://h",
                "--tls-cert",
            ),
            (
                "serve --tls-cert c --allowed-host h --public-origin https://h",
                "--tls-key",
            ),
            (
                "serve --tls-cert c --tls-key k --public-origin https://h",
                "--allowed-host",
            ),
            (
                "serve --tls-cert c --tls-key k --allowed-host h",
                "--public-origin",
            ),
            (
                "serve --tls-cert c --tls-key k --allowed-host h --public-origin",
                "missing value",
            ),
            (
                "serve --tls-cert c --tls-key k --allowed-host h --public-origin https://h --bind x",
                "--bind",
            ),
            ("serve --nope", "unknown option"),
        ] {
            let err = parse(args(missing), Some("/data".into())).unwrap_err();
            assert!(err.contains(message), "{missing}: {err}");
        }
        assert!(
            parse(args(minimal), None)
                .unwrap_err()
                .contains("--workspace")
        );
    }

    #[test]
    fn audit_verify_help_and_version() {
        assert_eq!(
            parse(args("audit verify a/log.jsonl"), None).unwrap(),
            Command::AuditVerify("a/log.jsonl".into())
        );
        assert_eq!(parse(args("--help"), None).unwrap(), Command::Help);
        assert_eq!(parse(args("--version"), None).unwrap(), Command::Version);
        assert!(parse(args("audit verify"), None).is_err());
        assert!(parse(args("audit verify a b"), None).is_err());
        assert!(parse(args("audit"), None).is_err());
        assert!(parse(args("audit prune x"), None).is_err());
        assert!(parse(args("run"), None).is_err());
        assert!(parse(Vec::<String>::new(), None).is_err());
    }
}
