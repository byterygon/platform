//! Command line of `mightyconsole-server`, parsed by hand (no dependency), merged with the
//! configuration file ([`crate::config`]): flags, then the environment, then the file, then the
//! defaults.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use crate::config::{self, AuthSettings, CONFIG_ENV, DEFAULT_FILE, FileConfig};
use crate::tls::TlsSource;
use crate::{RouterMode, ServeConfig};

/// The default listener (spec §2.3, Open question 16).
pub const DEFAULT_LISTEN: &str = "127.0.0.1:7443";

pub const USAGE: &str = "\
mightyconsole-server: Mightyconsole web server

USAGE
  mightyconsole-server [serve] [OPTIONS]
  mightyconsole-server config check [--online] [OPTIONS]
  mightyconsole-server --version | --help

OPTIONS
  --config FILE            the configuration file (TOML; default $MIGHTYCONSOLE_CONFIG, then
                           DATA/config.toml when it exists). Flags win over it.
  --listen ADDR:PORT       TLS listener (default 127.0.0.1:7443). Without [auth.oidc] in the
                           configuration there is no login yet: any address other than
                           loopback lets every machine that reaches the port use every
                           connection you open.
  --host HOST[:PORT]       another accepted Host header value; repeatable. localhost:PORT
                           and 127.0.0.1:PORT are always accepted.
  --public-origin ORIGIN   lowercase https://host[:port] the browser shows; the page is
                           redirected there (default https://localhost:PORT). The OIDC
                           redirect URI is ORIGIN/BASE/auth/callback.
  --tls-cert FILE          PEM certificate chain, leaf first (with --tls-key)
  --tls-key FILE           PEM private key. Without both, a self-signed certificate for
                           localhost, 127.0.0.1 and ::1 is made in DATA/tls on first start
                           and reused.
  --ui DIR                 the built UI (index.html, assets/); a placeholder page without it
  --data DIR               the data directory (default: $MIGHTYCONSOLE_DATA, then the file's
                           server.data, then the OS data directory/mightyconsole)
  --codec-listen ADDR:PORT a plain-HTTP listener for the Temporal codec endpoint only
                           (/codec/PROFILE/decode, /encode), for the temporal CLI; loopback
                           addresses only. Off by default; the TLS listener serves it too.
  --router browser|hash    how the UI keeps its place in the URL (default browser: real
                           paths, every path without an extension is the page); hash puts
                           the place after #, for a proxy or host that sends one page only
  --base-path /PREFIX      serve everything under PREFIX (the page, its assets, /rpc/ws,
                           the codec endpoint, /auth/*); / redirects there. A proxy forwards
                           the prefix unchanged.

SIGN-IN
  Configured in the file's [auth] and [auth.oidc] sections (OIDC with PKCE; the IdP's CA
  from ca_file only; the client secret from client_secret_file or
  $MIGHTYCONSOLE_OIDC_CLIENT_SECRET). `config check` validates the configuration without
  starting; with --online it also fetches the IdP's discovery document and keys.

The server keeps no connection settings: profiles live in the browser.
";

/// What the command line asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(
    clippy::large_enum_variant,
    reason = "parsed once at startup; boxing would only obscure the matches"
)]
pub enum Command {
    Serve(ServeConfig),
    /// `config check [--online]`: validate and exit.
    ConfigCheck {
        config: ServeConfig,
        online: bool,
    },
    Help,
    Version,
}

/// What the environment contributes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Env {
    /// `$MIGHTYCONSOLE_DATA`: wins over the file's `server.data`.
    pub data_env: Option<PathBuf>,
    /// `<OS data dir>/mightyconsole`: the last resort.
    pub data_default: Option<PathBuf>,
    /// `$MIGHTYCONSOLE_CONFIG`.
    pub config: Option<PathBuf>,
}

impl Env {
    /// The process's environment.
    pub fn from_process() -> Env {
        let var = |name: &str| {
            std::env::var_os(name)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        };
        Env {
            data_env: var("MIGHTYCONSOLE_DATA"),
            data_default: dirs::data_dir().map(|d| d.join("mightyconsole")),
            config: var(CONFIG_ENV),
        }
    }

    /// Only a data directory (as `$MIGHTYCONSOLE_DATA`).
    pub fn data(dir: impl AsRef<Path>) -> Env {
        Env {
            data_env: Some(dir.as_ref().to_path_buf()),
            ..Env::default()
        }
    }
}

/// The default data directory: `$MIGHTYCONSOLE_DATA`, then `<OS data dir>/mightyconsole`.
pub fn default_data_dir() -> Option<PathBuf> {
    let env = Env::from_process();
    env.data_env.or(env.data_default)
}

/// Parses the arguments after the program name.
pub fn parse(args: impl IntoIterator<Item = String>, env: &Env) -> Result<Command, String> {
    let mut args = args.into_iter().peekable();
    match args.peek().map(String::as_str) {
        Some("--help" | "-h" | "help") => return Ok(Command::Help),
        Some("--version" | "-V" | "version") => return Ok(Command::Version),
        Some("serve") => {
            args.next();
        }
        Some("config") => {
            args.next();
            if args.next().as_deref() != Some("check") {
                return Err("config: the only subcommand is `config check [--online]`".into());
            }
            let mut online = false;
            let rest: Vec<String> = args
                .filter(|a| {
                    let flag = a == "--online";
                    online |= flag;
                    !flag
                })
                .collect();
            let config = parse_serve(rest.into_iter(), env)?;
            return Ok(Command::ConfigCheck { config, online });
        }
        _ => {}
    }
    parse_serve(args, env).map(Command::Serve)
}

/// The options as flags gave them.
#[derive(Default)]
struct Flags {
    config: Option<PathBuf>,
    listen: Option<SocketAddr>,
    hosts: Vec<String>,
    public_origin: Option<String>,
    tls_cert: Option<PathBuf>,
    tls_key: Option<PathBuf>,
    ui: Option<PathBuf>,
    data: Option<PathBuf>,
    codec_listen: Option<SocketAddr>,
    router: Option<RouterMode>,
    base_path: Option<String>,
}

fn parse_router(text: &str, what: &str) -> Result<RouterMode, String> {
    match text {
        "browser" => Ok(RouterMode::Browser),
        "hash" => Ok(RouterMode::Hash),
        other => Err(format!("{what} {other:?}: browser or hash")),
    }
}

fn parse_base_path(text: &str, what: &str) -> Result<String, String> {
    if text.is_empty() || !ambidex_axum::valid_path_prefix(text) {
        return Err(format!(
            "{what} {text:?}: /-led segments of A-Z a-z 0-9 - _ ~, no trailing slash"
        ));
    }
    Ok(text.to_owned())
}

fn parse_flags(mut args: impl Iterator<Item = String>) -> Result<Flags, String> {
    let mut flags = Flags::default();
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
            "--config" => flags.config = Some(PathBuf::from(value()?)),
            "--listen" => {
                let text = value()?;
                flags.listen = Some(
                    text.parse()
                        .map_err(|e| format!("--listen {text:?}: {e}"))?,
                );
            }
            "--host" => flags.hosts.push(value()?),
            "--public-origin" => flags.public_origin = Some(value()?),
            "--tls-cert" => flags.tls_cert = Some(PathBuf::from(value()?)),
            "--tls-key" => flags.tls_key = Some(PathBuf::from(value()?)),
            "--ui" => flags.ui = Some(PathBuf::from(value()?)),
            "--data" => flags.data = Some(PathBuf::from(value()?)),
            "--codec-listen" => {
                let text = value()?;
                let addr: SocketAddr = text
                    .parse()
                    .map_err(|e| format!("--codec-listen {text:?}: {e}"))?;
                if !addr.ip().is_loopback() {
                    return Err(format!(
                        "--codec-listen {text:?}: plain HTTP is for loopback only (127.0.0.1 or ::1)"
                    ));
                }
                flags.codec_listen = Some(addr);
            }
            "--router" => flags.router = Some(parse_router(&value()?, "--router")?),
            "--base-path" => flags.base_path = Some(parse_base_path(&value()?, "--base-path")?),
            other => return Err(format!("unknown option {other:?}")),
        }
    }
    Ok(flags)
}

fn parse_serve(args: impl Iterator<Item = String>, env: &Env) -> Result<ServeConfig, String> {
    let flags = parse_flags(args)?;

    // The file: --config, else $MIGHTYCONSOLE_CONFIG, else DATA/config.toml when it exists.
    let lookup_data = flags
        .data
        .clone()
        .or_else(|| env.data_env.clone())
        .or_else(|| env.data_default.clone());
    let file_path = match flags.config.clone().or_else(|| env.config.clone()) {
        Some(path) => Some(path),
        None => lookup_data
            .map(|d| d.join(DEFAULT_FILE))
            .filter(|p| p.is_file()),
    };
    let (file, file_path) = match file_path {
        Some(path) => (config::read(&path)?, path),
        None => (FileConfig::default(), PathBuf::from(DEFAULT_FILE)),
    };
    let server = file.server;
    let in_file = |p: Option<PathBuf>| p.map(|p| config::relative_to(&file_path, &p));

    let listen = match (flags.listen, server.listen) {
        (Some(listen), _) => listen,
        (None, Some(text)) => text
            .parse()
            .map_err(|e| format!("server.listen {text:?}: {e}"))?,
        (None, None) => DEFAULT_LISTEN.parse().expect("a socket address"),
    };
    let port = listen.port();
    let mut allowed_hosts = vec![format!("localhost:{port}"), format!("127.0.0.1:{port}")];
    let hosts = if flags.hosts.is_empty() {
        server.hosts.unwrap_or_default()
    } else {
        flags.hosts
    };
    for host in hosts {
        if !allowed_hosts.iter().any(|h| h.eq_ignore_ascii_case(&host)) {
            allowed_hosts.push(host);
        }
    }
    let public_origin = flags
        .public_origin
        .or(server.public_origin)
        .unwrap_or_else(|| format!("https://localhost:{port}"));
    let router = match (flags.router, server.router) {
        (Some(router), _) => router,
        (None, Some(text)) => parse_router(&text, "server.router")?,
        (None, None) => RouterMode::default(),
    };
    let base_path = match (flags.base_path, server.base_path) {
        (Some(base), _) => base,
        (None, Some(text)) => parse_base_path(&text, "server.base_path")?,
        (None, None) => String::new(),
    };
    let ui = flags.ui.or_else(|| in_file(server.ui));
    let data = flags
        .data
        .or_else(|| env.data_env.clone())
        .or_else(|| in_file(server.data))
        .or_else(|| env.data_default.clone());
    let (cert, key) = if flags.tls_cert.is_some() || flags.tls_key.is_some() {
        (flags.tls_cert, flags.tls_key)
    } else {
        (in_file(server.tls_cert), in_file(server.tls_key))
    };
    let tls = match (cert, key) {
        (Some(cert), Some(key)) => TlsSource::Files { cert, key },
        (None, None) => {
            let data = data.clone().ok_or(
                "no data directory for the certificate: give --data, --tls-cert and --tls-key, \
                 or set MIGHTYCONSOLE_DATA",
            )?;
            TlsSource::Generated {
                dir: data.join("tls"),
            }
        }
        _ => return Err("--tls-cert and --tls-key go together".into()),
    };
    let auth: AuthSettings = config::auth_settings(file.auth, &file_path)?;
    Ok(ServeConfig {
        listen,
        allowed_hosts,
        public_origin,
        tls,
        ui,
        codec_listen: flags.codec_listen,
        router,
        base_path,
        data,
        auth,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(text: &str) -> Vec<String> {
        text.split_whitespace().map(str::to_owned).collect()
    }

    #[test]
    fn no_flags_means_loopback_7443_and_a_generated_certificate() {
        let Command::Serve(config) = parse(args(""), &Env::data("/data")).unwrap() else {
            panic!("serve");
        };
        assert_eq!(config.listen, "127.0.0.1:7443".parse().unwrap());
        assert_eq!(config.allowed_hosts, ["localhost:7443", "127.0.0.1:7443"]);
        assert_eq!(config.public_origin, "https://localhost:7443");
        assert_eq!(
            config.tls,
            TlsSource::Generated {
                dir: "/data/tls".into()
            }
        );
        assert_eq!(config.ui, None);
        assert_eq!(config.router, RouterMode::Browser);
        assert_eq!(config.base_path, "");
        assert_eq!(config.session_cookie(), "__Host-ambidex_session");
        assert!(!config.is_exposed());
        assert_eq!(
            parse(args("serve"), &Env::data("/data")).unwrap(),
            Command::Serve(config)
        );
    }

    #[test]
    fn every_option() {
        let Command::Serve(config) = parse(
            args(
                "serve --listen 0.0.0.0:9000 --host box.lan:9000 --host=LOCALHOST:9000 \
                 --public-origin https://box.lan:9000 --tls-cert c.pem --tls-key k.pem --ui dist",
            ),
            &Env::default(),
        )
        .unwrap() else {
            panic!("serve");
        };
        assert_eq!(config.listen, "0.0.0.0:9000".parse().unwrap());
        assert_eq!(
            config.allowed_hosts,
            ["localhost:9000", "127.0.0.1:9000", "box.lan:9000"]
        );
        assert_eq!(config.public_origin, "https://box.lan:9000");
        assert_eq!(
            config.tls,
            TlsSource::Files {
                cert: "c.pem".into(),
                key: "k.pem".into()
            }
        );
        assert_eq!(config.ui, Some("dist".into()));
        assert!(config.is_exposed());
        let Command::Serve(config) = parse(args("--data /x"), &Env::default()).unwrap() else {
            panic!("serve");
        };
        assert_eq!(config.codec_listen, None);
        let Command::Serve(config) = parse(
            args("--data /x --codec-listen 127.0.0.1:7444"),
            &Env::default(),
        )
        .unwrap() else {
            panic!("serve");
        };
        assert_eq!(config.codec_listen, Some("127.0.0.1:7444".parse().unwrap()));
        let Command::Serve(modes) = parse(
            args("--data /x --router hash --base-path /tools/mc"),
            &Env::default(),
        )
        .unwrap() else {
            panic!("serve");
        };
        assert_eq!(modes.router, RouterMode::Hash);
        assert_eq!(modes.base_path, "/tools/mc");
        assert_eq!(modes.session_cookie(), "__Host-ambidex_session_tools_mc");
        assert_eq!(
            config.tls,
            TlsSource::Generated {
                dir: "/x/tls".into()
            }
        );
    }

    #[test]
    fn mistakes_are_reported() {
        for (bad, message) in [
            ("--listen nowhere", "--listen"),
            ("--tls-cert c.pem", "go together"),
            ("--ui", "missing value"),
            ("--nope", "unknown option"),
            ("--codec-listen 0.0.0.0:7444", "loopback only"),
            ("--codec-listen nowhere", "--codec-listen"),
            ("--router memory", "browser or hash"),
            ("--base-path mc", "--base-path"),
            ("--base-path /mc/", "--base-path"),
            ("--base-path /", "--base-path"),
            ("--base-path /a/../b", "--base-path"),
        ] {
            let err = parse(args(bad), &Env::data("/d")).unwrap_err();
            assert!(err.contains(message), "{bad}: {err}");
        }
        assert!(
            parse(args(""), &Env::default())
                .unwrap_err()
                .contains("data directory")
        );
        assert_eq!(
            parse(args("--help"), &Env::default()).unwrap(),
            Command::Help
        );
        assert_eq!(
            parse(args("--version"), &Env::default()).unwrap(),
            Command::Version
        );
    }

    fn write(dir: &std::path::Path, name: &str, text: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, text).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        path
    }

    #[test]
    fn the_file_fills_in_what_flags_and_the_environment_leave() {
        let dir = tempfile::tempdir().unwrap();
        let file = write(
            dir.path(),
            "config.toml",
            r#"
            [server]
            listen = "0.0.0.0:9443"
            hosts = ["mc.lan:9443"]
            public_origin = "https://mc.lan:9443"
            base_path = "/mc"
            router = "hash"
            ui = "dist"
            data = "/from-file"
            [auth.oidc]
            issuer = "https://idp.lan/dex"
            client_id = "mc"
            ca_file = "ca.pem"
            "#,
        );
        let env = Env {
            config: Some(file.clone()),
            ..Env::default()
        };
        let Command::Serve(config) = parse(args(""), &env).unwrap() else {
            panic!("serve");
        };
        assert_eq!(config.listen, "0.0.0.0:9443".parse().unwrap());
        assert_eq!(
            config.allowed_hosts,
            ["localhost:9443", "127.0.0.1:9443", "mc.lan:9443"]
        );
        assert_eq!(config.public_origin, "https://mc.lan:9443");
        assert_eq!(config.base_path, "/mc");
        assert_eq!(config.router, RouterMode::Hash);
        assert_eq!(config.ui, Some(dir.path().join("dist")));
        assert_eq!(
            config.tls,
            TlsSource::Generated {
                dir: "/from-file/tls".into()
            }
        );
        let oidc = config.auth.oidc.as_ref().unwrap();
        assert_eq!(oidc.ca_file, dir.path().join("ca.pem"));
        assert_eq!(config.data, Some(PathBuf::from("/from-file")));
        // Flags win over the file, the environment's data directory too.
        let env = Env {
            config: Some(file.clone()),
            data_env: Some("/from-env".into()),
            data_default: None,
        };
        let Command::Serve(config) = parse(
            args("--listen 127.0.0.1:7000 --public-origin https://localhost:7000"),
            &env,
        )
        .unwrap() else {
            panic!("serve");
        };
        assert_eq!(config.listen, "127.0.0.1:7000".parse().unwrap());
        assert_eq!(config.public_origin, "https://localhost:7000");
        assert_eq!(
            config.tls,
            TlsSource::Generated {
                dir: "/from-env/tls".into()
            }
        );
        // --config names a file; DATA/config.toml is used when it exists.
        let Command::Serve(config) = parse(
            args(&format!("--config {}", file.display())),
            &Env::default(),
        )
        .unwrap() else {
            panic!("serve");
        };
        assert!(config.auth.oidc.is_some());
        let data = tempfile::tempdir().unwrap();
        write(data.path(), "config.toml", "[auth]\ntenant = \"acme\"\n");
        let Command::Serve(config) = parse(args(""), &Env::data(data.path())).unwrap() else {
            panic!("serve");
        };
        assert_eq!(config.auth.tenant, "acme");
        assert!(
            parse(args("--config /nope.toml"), &Env::default())
                .unwrap_err()
                .contains("nope.toml")
        );
        write(dir.path(), "bad.toml", "[server]\nlisten = 1\n");
        let bad = format!("--config {}", dir.path().join("bad.toml").display());
        assert!(parse(args(&bad), &Env::default()).is_err());
    }

    #[test]
    fn config_check_takes_the_serve_options() {
        let parsed = parse(args("config check --online --data /d"), &Env::default()).unwrap();
        let Command::ConfigCheck { config, online } = parsed else {
            panic!("config check");
        };
        assert!(online);
        assert_eq!(
            config.tls,
            TlsSource::Generated {
                dir: "/d/tls".into()
            }
        );
        assert!(
            parse(args("config"), &Env::default())
                .unwrap_err()
                .contains("config check")
        );
    }
}
