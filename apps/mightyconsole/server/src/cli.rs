//! Command line of `mightyconsole-server`, parsed by hand (no dependency).

use std::net::SocketAddr;
use std::path::PathBuf;

use crate::ServeConfig;
use crate::tls::TlsSource;

/// The default listener (spec §2.3, Open question 16).
pub const DEFAULT_LISTEN: &str = "127.0.0.1:7443";

pub const USAGE: &str = "\
mightyconsole-server: Mightyconsole web server

USAGE
  mightyconsole-server [serve] [OPTIONS]
  mightyconsole-server --version | --help

OPTIONS
  --listen ADDR:PORT       TLS listener (default 127.0.0.1:7443). Any address other than
                           loopback lets every machine that reaches the port use every
                           connection you open: there is no login in v0.1.
  --host HOST[:PORT]       another accepted Host header value; repeatable. localhost:PORT
                           and 127.0.0.1:PORT are always accepted.
  --public-origin ORIGIN   lowercase https://host[:port] the browser shows; the page is
                           redirected there (default https://localhost:PORT)
  --tls-cert FILE          PEM certificate chain, leaf first (with --tls-key)
  --tls-key FILE           PEM private key. Without both, a self-signed certificate for
                           localhost, 127.0.0.1 and ::1 is made in DATA/tls on first start
                           and reused.
  --ui DIR                 the built UI (index.html, assets/); a placeholder page without it
  --data DIR               where the certificate is kept (default: $MIGHTYCONSOLE_DATA, then
                           the OS data directory/mightyconsole)
  --codec-listen ADDR:PORT a plain-HTTP listener for the Temporal codec endpoint only
                           (/codec/PROFILE/decode, /encode), for the temporal CLI; loopback
                           addresses only. Off by default; the TLS listener serves it too.

The server keeps no connection settings: profiles live in the browser.
";

/// What the command line asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Serve(ServeConfig),
    Help,
    Version,
}

/// The default data directory: `$MIGHTYCONSOLE_DATA`, then `<OS data dir>/mightyconsole`.
pub fn default_data_dir() -> Option<PathBuf> {
    std::env::var_os("MIGHTYCONSOLE_DATA")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::data_dir().map(|d| d.join("mightyconsole")))
}

/// Parses the arguments after the program name.
pub fn parse(
    args: impl IntoIterator<Item = String>,
    default_data: Option<PathBuf>,
) -> Result<Command, String> {
    let mut args = args.into_iter().peekable();
    match args.peek().map(String::as_str) {
        Some("--help" | "-h" | "help") => return Ok(Command::Help),
        Some("--version" | "-V" | "version") => return Ok(Command::Version),
        Some("serve") => {
            args.next();
        }
        _ => {}
    }
    parse_serve(args, default_data).map(Command::Serve)
}

fn parse_serve(
    mut args: impl Iterator<Item = String>,
    default_data: Option<PathBuf>,
) -> Result<ServeConfig, String> {
    let mut listen: Option<SocketAddr> = None;
    let mut hosts = Vec::new();
    let mut public_origin = None;
    let mut tls_cert = None;
    let mut tls_key = None;
    let mut ui = None;
    let mut data = None;
    let mut codec_listen: Option<SocketAddr> = None;

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
            "--listen" => {
                let text = value()?;
                listen = Some(
                    text.parse()
                        .map_err(|e| format!("--listen {text:?}: {e}"))?,
                );
            }
            "--host" => hosts.push(value()?),
            "--public-origin" => public_origin = Some(value()?),
            "--tls-cert" => tls_cert = Some(PathBuf::from(value()?)),
            "--tls-key" => tls_key = Some(PathBuf::from(value()?)),
            "--ui" => ui = Some(PathBuf::from(value()?)),
            "--data" => data = Some(PathBuf::from(value()?)),
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
                codec_listen = Some(addr);
            }
            other => return Err(format!("unknown option {other:?}")),
        }
    }

    let listen = listen.unwrap_or_else(|| DEFAULT_LISTEN.parse().expect("a socket address"));
    let port = listen.port();
    let mut allowed_hosts = vec![format!("localhost:{port}"), format!("127.0.0.1:{port}")];
    for host in hosts {
        if !allowed_hosts.iter().any(|h| h.eq_ignore_ascii_case(&host)) {
            allowed_hosts.push(host);
        }
    }
    let public_origin = public_origin.unwrap_or_else(|| format!("https://localhost:{port}"));
    let tls = match (tls_cert, tls_key) {
        (Some(cert), Some(key)) => TlsSource::Files { cert, key },
        (None, None) => {
            let data = data.or(default_data).ok_or(
                "no data directory for the certificate: give --data, --tls-cert and --tls-key, \
                 or set MIGHTYCONSOLE_DATA",
            )?;
            TlsSource::Generated {
                dir: data.join("tls"),
            }
        }
        _ => return Err("--tls-cert and --tls-key go together".into()),
    };
    Ok(ServeConfig {
        listen,
        allowed_hosts,
        public_origin,
        tls,
        ui,
        codec_listen,
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
        let Command::Serve(config) = parse(args(""), Some("/data".into())).unwrap() else {
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
        assert!(!config.is_exposed());
        assert_eq!(
            parse(args("serve"), Some("/data".into())).unwrap(),
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
            None,
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
        let Command::Serve(config) = parse(args("--data /x"), None).unwrap() else {
            panic!("serve");
        };
        assert_eq!(config.codec_listen, None);
        let Command::Serve(config) =
            parse(args("--data /x --codec-listen 127.0.0.1:7444"), None).unwrap()
        else {
            panic!("serve");
        };
        assert_eq!(config.codec_listen, Some("127.0.0.1:7444".parse().unwrap()));
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
        ] {
            let err = parse(args(bad), Some("/d".into())).unwrap_err();
            assert!(err.contains(message), "{bad}: {err}");
        }
        assert!(
            parse(args(""), None)
                .unwrap_err()
                .contains("data directory")
        );
        assert_eq!(parse(args("--help"), None).unwrap(), Command::Help);
        assert_eq!(parse(args("--version"), None).unwrap(), Command::Version);
    }
}
