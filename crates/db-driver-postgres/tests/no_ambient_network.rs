//! Native drivers are not sandboxed; they must reach the network only through the host broker
//! (ADR "Plugin trust and driver execution model"). This holds the driver to that by checking
//! its sources and dependencies for socket, TLS and DNS access of its own.

use std::path::Path;

const FORBIDDEN: &[&str] = &[
    "std::net",
    "tokio::net",
    "TcpStream",
    "UdpSocket",
    "UnixStream",
    "ToSocketAddrs",
    "lookup_host",
    "rustls",
    "native_tls",
    "openssl",
    "std::process",
    "std::fs",
    "std::env",
];

#[test]
fn sources_have_no_socket_tls_dns_file_or_process_access() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut checked = 0;
    for entry in std::fs::read_dir(&src).unwrap() {
        let path = entry.unwrap().path();
        let text = std::fs::read_to_string(&path).unwrap();
        for word in FORBIDDEN {
            assert!(
                !text.contains(word),
                "{} uses {word}; go through the broker instead",
                path.display()
            );
        }
        checked += 1;
    }
    assert!(checked >= 7);
}

#[test]
fn dependencies_bring_no_network_stack() {
    let manifest =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")).unwrap();
    let deps = manifest
        .split("[dependencies]")
        .nth(1)
        .unwrap()
        .split("\n[")
        .next()
        .unwrap();
    for word in [
        "rustls",
        "native-tls",
        "openssl",
        "tokio-postgres",
        "sqlx",
        "socket2",
        "\"net\"",
    ] {
        assert!(!deps.contains(word), "dependency on {word}");
    }
    assert!(deps.contains("default-features = false, features = [\"rt\", \"sync\", \"time\"]"));
}
