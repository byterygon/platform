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
  mightyconsole-server audit verify [--data DIR | FILE...]
  mightyconsole-server reset-admin [--print] [--data DIR] [--config FILE]
  mightyconsole-server keys generate --out FILE
  mightyconsole-server secrets status [--data DIR] [--config FILE]
  mightyconsole-server restore --data DIR [--check-secrets] [--config FILE] FILE.tar
  mightyconsole-server --version | --help

OPTIONS
  --config FILE            the configuration file (TOML; default $MIGHTYCONSOLE_CONFIG, then
                           DATA/config.toml when it exists). Flags win over it.
  --listen ADDR:PORT       TLS listener (default 127.0.0.1:7443). Everyone signs in; beyond
                           loopback, give --tls-cert and --tls-key (a self-signed certificate
                           starts with a warning).
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
  Everyone signs in. Built-in accounts (user name, password, optional TOTP) are on unless
  [auth] accounts = false; [auth] signup = open (default) lets people make their own
  account, off leaves it to an administrator; require_totp = none, admins or all.
  OIDC is configured in [auth.oidc] (PKCE; the IdP's CA from ca_file only; the client secret
  from client_secret_file or $MIGHTYCONSOLE_OIDC_CLIENT_SECRET). `config check` validates the configuration without
  starting; with --online it also fetches the IdP's discovery document and keys.

AUDIT
  The audit log is DATA/audit/audit-<n>.jsonl: hash-chained JSON Lines, one fsync per entry,
  verified when the server starts (a broken log refuses the start, naming the file and line).
  `audit verify` checks a data directory's log, or the files given (a copy of segments), and
  says where the chain breaks; exit 0 when intact, 1 when broken, 2 on a usage or read error.
  --audit-new-chain        after a broken log: move it to DATA/audit/broken-<utc>/ and start a
                           new chain whose first entry (audit.new_chain) names it.
  The file's [audit] section: reads, stderr, segment_bytes, retention_days,
  min_retention_days, max_bytes.

THE DEFAULT ADMINISTRATOR
  A first start makes the account `admin` with a generated password in DATA/admin-password
  (mode 0600; the log names the file, never the password). In a container:
  `docker cp <container>:/data/admin-password -`. The first sign-in must change it; the file
  is then deleted.
  `reset-admin` (run where the data directory is; in a container `docker exec <container>
  /mightyconsole-server reset-admin --print`) writes a new password to DATA/admin-password,
  requires a change at the next sign-in, enables and unlocks the account, removes its TOTP
  and ends its sessions. With the server stopped it opens the store itself; with the server
  running it asks it through DATA/reset-admin.request and waits up to 30 s. --print also
  prints the new password on this command's output.

SECRETS
  Secrets are encrypted in DATA/store.redb (AES-256-GCM, a data key per secret, wrapped by a
  key-encryption key) and never returned. The keys are listed in [[secrets.keys]], the active
  one first: source = \"file\" (file = PATH: 32 bytes in base64, mode 0400 or 0600, owned by the
  server's user), \"passphrase\" (passphrase_file = PATH, else $MIGHTYCONSOLE_SECRET_PASSPHRASE,
  else a prompt on the terminal; 16 characters or more; Argon2id) or \"command\" (command =
  [program, args...]: run without a shell, a clean environment and 30 s; its output is the key
  in base64). Without any, a first start generates DATA/keys/kek-<id>.key: it protects copies
  of the store, not a compromise of the machine, so move it to a separate mount.
  A key that does not load, or a stored secret whose key is not configured, stops the start.
  Losing every copy of a key loses the secrets under it.
  `keys generate --out FILE` writes a new key file (mode 0600) and prints its id.
  `secrets status` (server stopped) counts the stored secrets by key.

BACKUP AND RESTORE
  Offline: stop the server, copy the data directory without keys/, keep the keys (or the
  passphrase) apart. Online: admin.backup.snapshot writes DATA/backups/backup-<utc>.tar (the
  store, the audit log and its checkpoint; never the keys).
  `restore --data DIR FILE.tar` unpacks a backup into a new (empty) DIR and checks the store
  and the audit chain; --check-secrets also decrypts every stored secret with the configured
  keys and names the ones that fail. Then provide the keys and start the server on DIR.

OUTBOUND
  What a connection profile may make the server reach ([outbound] in the configuration file):
  allow = [...] (when set, only these) and deny = [...] (never these; wins), each an address,
  a network (10.0.0.0/8), a host name or *.domain. Link-local and cloud metadata addresses
  (169.254.169.254, ...) are never reached unless an allow network names them; private and
  loopback addresses are reached unless the rules say otherwise.

Connection profiles and their secrets (write-only, encrypted) live in the store.
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
    /// `audit verify [--data DIR | FILE...]`: check the log and exit.
    AuditVerify(AuditTarget),
    /// `reset-admin [--print] [OPTIONS]`: reset the default administrator (DOC-25 §3.2.7).
    ResetAdmin {
        config: ServeConfig,
        print: bool,
    },
    /// `keys generate --out FILE`: a new key file (DOC-25 §3.6.4).
    KeysGenerate {
        out: PathBuf,
    },
    /// `secrets status`: the stored secrets by key (DOC-25 §3.4.5).
    SecretsStatus {
        config: ServeConfig,
    },
    /// `restore --data DIR [--check-secrets] FILE.tar` (DOC-25 §3.4.6).
    Restore {
        config: ServeConfig,
        archive: PathBuf,
        check_secrets: bool,
    },
    Help,
    Version,
}

/// What `audit verify` checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuditTarget {
    /// The log of a data directory.
    Dir(PathBuf),
    /// These files, in the order of their names.
    Files(Vec<PathBuf>),
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

/// The configuration a command that reads `data` uses: the file named by `$MIGHTYCONSOLE_CONFIG`,
/// else `DATA/config.toml` when it exists, else the defaults.
pub fn serve_config_for(data: &Path, env: &Env) -> Result<ServeConfig, String> {
    parse_serve(
        ["--data".to_owned(), data.display().to_string()].into_iter(),
        env,
    )
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
        Some("audit") => {
            args.next();
            if args.next().as_deref() != Some("verify") {
                return Err(
                    "audit: the only subcommand is `audit verify [--data DIR | FILE...]`".into(),
                );
            }
            let mut data = None;
            let mut files = Vec::new();
            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--data" => {
                        data = Some(PathBuf::from(
                            args.next()
                                .ok_or("audit verify: --data needs a directory")?,
                        ));
                    }
                    flag if flag.starts_with("--") => {
                        return Err(format!("audit verify: unknown option {flag:?}"));
                    }
                    file => files.push(PathBuf::from(file)),
                }
            }
            return match (data, files.is_empty()) {
                (Some(_), false) => Err("audit verify: give --data or files, not both".into()),
                (Some(dir), true) => Ok(Command::AuditVerify(AuditTarget::Dir(dir))),
                (None, false) => {
                    files.sort();
                    Ok(Command::AuditVerify(AuditTarget::Files(files)))
                }
                (None, true) => env
                    .data_env
                    .clone()
                    .or_else(|| env.data_default.clone())
                    .map(|dir| Command::AuditVerify(AuditTarget::Dir(dir)))
                    .ok_or_else(|| {
                        "audit verify: no data directory: give --data, files, or set MIGHTYCONSOLE_DATA".into()
                    }),
            };
        }
        Some("reset-admin") => {
            args.next();
            let mut print = false;
            let rest: Vec<String> = args
                .filter(|a| {
                    let flag = a == "--print";
                    print |= flag;
                    !flag
                })
                .collect();
            let config = parse_serve(rest.into_iter(), env)?;
            if config.data.is_none() {
                return Err(
                    "reset-admin: no data directory: give --data or set MIGHTYCONSOLE_DATA".into(),
                );
            }
            return Ok(Command::ResetAdmin { config, print });
        }
        Some("keys") => {
            args.next();
            if args.next().as_deref() != Some("generate") {
                return Err("keys: the only subcommand is `keys generate --out FILE`".into());
            }
            let mut out = None;
            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--out" => {
                        out = Some(PathBuf::from(
                            args.next().ok_or("keys generate: --out needs a file")?,
                        ));
                    }
                    other => return Err(format!("keys generate: unknown option {other:?}")),
                }
            }
            let out = out.ok_or("keys generate: give --out FILE")?;
            return Ok(Command::KeysGenerate { out });
        }
        Some("restore") => {
            args.next();
            let mut check_secrets = false;
            let mut archive = None;
            let mut rest = Vec::new();
            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--check-secrets" => check_secrets = true,
                    flag if flag.starts_with("--") => {
                        rest.push(arg.clone());
                        if !flag.contains('=') {
                            rest.extend(args.next());
                        }
                    }
                    _ if archive.is_none() => archive = Some(PathBuf::from(arg)),
                    other => return Err(format!("restore: unexpected {other:?}")),
                }
            }
            let archive = archive.ok_or("restore: name the backup file (FILE.tar)")?;
            if !rest
                .iter()
                .any(|a| a == "--data" || a.starts_with("--data="))
            {
                return Err("restore: give --data DIR, the new data directory".into());
            }
            let config = parse_serve(rest.into_iter(), env)?;
            return Ok(Command::Restore {
                config,
                archive,
                check_secrets,
            });
        }
        Some("secrets") => {
            args.next();
            if args.next().as_deref() != Some("status") {
                return Err("secrets: the only subcommand is `secrets status`".into());
            }
            let config = parse_serve(args, env)?;
            if config.data.is_none() {
                return Err(
                    "secrets status: no data directory: give --data or set MIGHTYCONSOLE_DATA"
                        .into(),
                );
            }
            return Ok(Command::SecretsStatus { config });
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
    audit_new_chain: bool,
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
            "--audit-new-chain" => flags.audit_new_chain = true,
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
    let secrets = config::secrets_settings(file.secrets, &file_path)?;
    let policy = config::PolicySettings {
        allow_personal_profiles: file.policy.allow_personal_profiles.unwrap_or(true),
    };
    let outbound =
        crate::core::outbound::Policy::from_lists(&file.outbound.allow, &file.outbound.deny)?;
    let mut audit = config::audit_settings(file.audit)?;
    audit.new_chain = flags.audit_new_chain;
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
        audit,
        secrets,
        policy,
        outbound,
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
    fn restore_parses_and_needs_a_new_data_directory() {
        let Command::Restore {
            config,
            archive,
            check_secrets,
        } = parse(
            args("restore --data /new --check-secrets /b/backup-x.tar"),
            &Env::data("/old"),
        )
        .unwrap()
        else {
            panic!("restore");
        };
        assert_eq!(config.data, Some("/new".into()));
        assert_eq!(archive, PathBuf::from("/b/backup-x.tar"));
        assert!(check_secrets);
        // $MIGHTYCONSOLE_DATA is not enough: the directory is named.
        assert!(
            parse(args("restore /b/x.tar"), &Env::data("/old"))
                .unwrap_err()
                .contains("--data")
        );
        assert!(
            parse(args("restore --data /new"), &Env::default())
                .unwrap_err()
                .contains("FILE.tar")
        );
    }

    #[test]
    fn keys_generate_and_secrets_status_parse() {
        assert_eq!(
            parse(args("keys generate --out /k/new.key"), &Env::default()).unwrap(),
            Command::KeysGenerate {
                out: "/k/new.key".into()
            }
        );
        for bad in [
            "keys",
            "keys generate",
            "keys generate --out",
            "keys make --out x",
        ] {
            assert!(parse(args(bad), &Env::default()).is_err(), "{bad}");
        }
        let Command::SecretsStatus { config } =
            parse(args("secrets status --data /d"), &Env::default()).unwrap()
        else {
            panic!("secrets status");
        };
        assert_eq!(config.data, Some("/d".into()));
        assert!(
            parse(args("secrets status"), &Env::default())
                .unwrap_err()
                .contains("no data directory")
        );
        assert!(parse(args("secrets list"), &Env::default()).is_err());
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
    #[test]
    fn audit_verify_takes_a_data_directory_or_files() {
        let dir = |p: &str| Command::AuditVerify(AuditTarget::Dir(p.into()));
        assert_eq!(
            parse(args("audit verify --data /d"), &Env::default()).unwrap(),
            dir("/d")
        );
        // The environment's data directory when nothing is given.
        assert_eq!(
            parse(args("audit verify"), &Env::data("/env")).unwrap(),
            dir("/env")
        );
        // Files are checked in the order of their names.
        assert_eq!(
            parse(args("audit verify /x/b.jsonl /x/a.jsonl"), &Env::default()).unwrap(),
            Command::AuditVerify(AuditTarget::Files(vec![
                "/x/a.jsonl".into(),
                "/x/b.jsonl".into()
            ]))
        );
        for bad in [
            "audit",
            "audit check",
            "audit verify --data /d /x/a.jsonl",
            "audit verify --data",
            "audit verify --online",
            "audit verify",
        ] {
            assert!(parse(args(bad), &Env::default()).is_err(), "{bad}");
        }
    }

    #[test]
    fn audit_new_chain_is_a_flag_of_serve() {
        let Command::Serve(config) =
            parse(args("--audit-new-chain --data /d"), &Env::default()).unwrap()
        else {
            panic!("serve");
        };
        assert!(config.audit.new_chain);
        let Command::Serve(config) = parse(args("--data /d"), &Env::default()).unwrap() else {
            panic!("serve");
        };
        assert!(!config.audit.new_chain);
    }
}
