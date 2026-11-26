//! SSH command hops against a stand-in sshd that forbids forwarding but runs commands, local
//! command hops with the crate's test program, and the System route (DOC-23 4.3b, 4.4, 4.6, 5).

mod support;

use std::sync::Arc;
use std::time::Duration;

use net_route::{
    CommandHop, Dialer, Hop, HttpConnectHop, Route, RouteError, RouteErrorKind, SshAuth,
    SshCommandHop, SshHop, fingerprint,
};
use support::sshd::{self, ClientKey, NO_FORWARD_USER, USER};
use support::{HttpProxy, echo_target, lines};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const PROGRAM: &str = env!("CARGO_BIN_EXE_net-route-test-command");

fn ssh(
    name: &str,
    host: &str,
    port: u16,
    user: &str,
    client: &ClientKey,
    key: &russh::keys::PublicKey,
) -> SshHop {
    SshHop {
        name: name.into(),
        host: host.into(),
        port,
        user: user.into(),
        auth: SshAuth::PrivateKey {
            key: client.text.clone().into(),
            passphrase: None,
        },
        trusted: Some(fingerprint(key)),
        keepalive: None,
    }
}

fn ssh_command(hop: SshHop, command: &str) -> Hop {
    Hop::SshCommand(SshCommandHop {
        ssh: hop,
        command: command.into(),
    })
}

fn local(args: &[&str]) -> CommandHop {
    CommandHop {
        program: PROGRAM.into(),
        args: args.iter().map(|a| (*a).to_owned()).collect(),
        env: Vec::new(),
        cwd: None,
    }
}

fn through(hops: Vec<Hop>) -> Dialer {
    Dialer::through(Route::new("test", hops)).unwrap()
}

async fn talk(stream: net_route::BoxStream) -> String {
    let mut stream = BufReader::new(stream);
    let mut banner = String::new();
    stream.read_line(&mut banner).await.unwrap();
    stream.get_mut().write_all(b"ping\n").await.unwrap();
    let mut echo = String::new();
    stream.read_line(&mut echo).await.unwrap();
    assert_eq!(echo, "ping\n");
    banner.trim_end().to_owned()
}

async fn dial_err(dialer: &Dialer, host: &str, port: u16) -> RouteError {
    match dialer.dial(host, port).await {
        Ok(_) => panic!("{host}:{port} should fail"),
        Err(e) => e,
    }
}

// --- sshCommand ---------------------------------------------------------------------------

#[tokio::test]
async fn an_ssh_command_reaches_what_forwarding_may_not() {
    let client = ClientKey::new();
    let target = echo_target("behind").await;
    let jump = sshd::start(&client, [("echo.internal".to_owned(), target)].into()).await;
    let hop = || {
        ssh(
            "bastion",
            "127.0.0.1",
            jump.addr.port(),
            NO_FORWARD_USER,
            &client,
            &jump.host_key,
        )
    };

    // Forwarding is refused for this user...
    let err = dial_err(&through(vec![Hop::Ssh(hop())]), "echo.internal", 7).await;
    assert_eq!(err.kind, RouteErrorKind::Forbidden);
    // ...and the command works.
    let dialer = through(vec![ssh_command(hop(), "nc {host} {port}")]);
    assert_eq!(
        talk(dialer.dial("echo.internal", 7).await.unwrap()).await,
        "HELLO behind"
    );
    assert!(lines(&jump.log).contains(&"exec:nc echo.internal 7".to_owned()));
}

#[tokio::test]
async fn an_ssh_command_after_an_ssh_hop_runs_on_the_second_host() {
    let client = ClientKey::new();
    let target = echo_target("deep").await;
    let inner = sshd::start(&client, [("echo.internal".to_owned(), target)].into()).await;
    let outer = sshd::start(&client, [("jump2.internal".to_owned(), inner.addr)].into()).await;
    let dialer = through(vec![
        Hop::Ssh(ssh(
            "bastion",
            "127.0.0.1",
            outer.addr.port(),
            USER,
            &client,
            &outer.host_key,
        )),
        ssh_command(
            ssh(
                "jump2",
                "jump2.internal",
                22,
                NO_FORWARD_USER,
                &client,
                &inner.host_key,
            ),
            "nc {host} {port}",
        ),
    ]);
    assert_eq!(
        talk(dialer.dial("echo.internal", 7).await.unwrap()).await,
        "HELLO deep"
    );
    let report = dialer.test("echo.internal", 7).await;
    let kinds: Vec<_> = report.iter().map(|r| r.hop.kind).collect();
    assert_eq!(kinds, ["ssh", "sshCommand", "target"]);
}

#[tokio::test]
async fn a_refused_or_failing_command_names_the_hop() {
    let client = ClientKey::new();
    let jump = sshd::start(&client, Default::default()).await;
    let hop = || {
        ssh(
            "bastion",
            "127.0.0.1",
            jump.addr.port(),
            USER,
            &client,
            &jump.host_key,
        )
    };

    let err = dial_err(&through(vec![ssh_command(hop(), "refuse {host}")]), "db", 1).await;
    assert_eq!(
        (err.kind, err.hop.as_ref().unwrap().kind),
        (RouteErrorKind::Forbidden, "sshCommand")
    );
    assert!(
        err.message.contains("refused to run the command"),
        "{}",
        err.message
    );

    let err = dial_err(
        &through(vec![ssh_command(hop(), "fail {host} {port}")]),
        "db",
        1,
    )
    .await;
    assert_eq!(
        (err.kind, err.hop.as_ref().unwrap().index),
        (RouteErrorKind::Connect, 0)
    );
    assert!(
        err.message.contains("exited with 3") && err.message.contains("no such host"),
        "{}",
        err.message
    );

    for bad in ["", "nc {host}\nrm -rf /"] {
        let err = Dialer::through(Route::new("r", vec![ssh_command(hop(), bad)])).unwrap_err();
        assert_eq!(
            (err.kind, err.field),
            (RouteErrorKind::Invalid, Some("command")),
            "{bad:?}"
        );
    }
}

// --- command ------------------------------------------------------------------------------

#[tokio::test]
async fn a_local_command_is_the_stream() {
    let target = echo_target("via command").await;
    let dialer = through(vec![Hop::Command(local(&["connect", "{host}", "{port}"]))]);
    assert_eq!(
        talk(dialer.dial("127.0.0.1", target.port()).await.unwrap()).await,
        "HELLO via command"
    );
    let report = dialer.test("127.0.0.1", target.port()).await;
    assert_eq!(report[0].hop.kind, "command");
    assert_eq!(report[0].hop.label, "net-route-test-command");
    assert_eq!(report.len(), 2);
}

#[tokio::test]
async fn a_local_command_then_a_proxy() {
    let target = echo_target("after").await;
    let (proxy, log) = HttpProxy {
        hosts: [("echo.internal".to_owned(), target)].into(),
        ..Default::default()
    }
    .start()
    .await;
    // The command reaches the proxy (the next hop); the proxy reaches the target by name.
    let dialer = through(vec![
        Hop::Command(local(&["connect", "{host}", "{port}"])),
        Hop::HttpConnect(HttpConnectHop::from_url(&format!("http://{proxy}")).unwrap()),
    ]);
    assert_eq!(
        talk(dialer.dial("echo.internal", 7).await.unwrap()).await,
        "HELLO after"
    );
    assert_eq!(lines(&log)[0], "CONNECT echo.internal:7 HTTP/1.1");
}

#[tokio::test]
async fn a_command_that_ends_at_once_reports_its_exit_code_and_stderr() {
    let dialer = through(vec![Hop::Command(local(&[
        "exit",
        "7",
        "not logged in: run tsh login $HOME ~",
    ]))]);
    let err = dial_err(&dialer, "db", 1).await;
    assert_eq!(err.kind, RouteErrorKind::Connect);
    assert_eq!(err.hop.as_ref().unwrap().kind, "command");
    assert!(err.message.contains("exit code 7"), "{}", err.message);
    // The arguments reached it as they were: no shell expanded them.
    assert!(
        err.message.contains("not logged in: run tsh login $HOME ~"),
        "{}",
        err.message
    );

    let mut missing = local(&[]);
    missing.program = "/nonexistent/net-route-no-such-program".into();
    let err = dial_err(&through(vec![Hop::Command(missing)]), "db", 1).await;
    assert!(err.message.contains("was not found"), "{}", err.message);
}

#[tokio::test]
async fn a_command_gets_a_clean_environment_and_its_own_variables() {
    let mut hop = local(&["env"]);
    hop.env = vec![("HOP_TOKEN".into(), "s3cret".into())];
    let mut stream = BufReader::new(
        through(vec![Hop::Command(hop)])
            .dial("db", 1)
            .await
            .unwrap(),
    );
    let mut names = String::new();
    stream.read_line(&mut names).await.unwrap();
    let allowed = [
        "PATH",
        "HOME",
        "USER",
        "LANG",
        "TMPDIR",
        "HOP_TOKEN",
        "SystemRoot",
        "USERPROFILE",
        "TEMP",
    ];
    let names: Vec<&str> = names.split_whitespace().collect();
    assert!(names.contains(&"HOP_TOKEN"), "{names:?}");
    // The test process has more variables (cargo gives it CARGO_*); none of them reaches it.
    for name in &names {
        assert!(
            allowed.contains(name),
            "{name} leaked into the command's environment"
        );
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn dropping_the_stream_ends_the_program() {
    let dialer = through(vec![Hop::Command(local(&["hang"]))]);
    let mut stream = BufReader::new(dialer.dial("db", 1).await.unwrap());
    let mut pid = String::new();
    stream.read_line(&mut pid).await.unwrap();
    let proc = format!("/proc/{}", pid.trim());
    assert!(std::path::Path::new(&proc).exists());
    drop(stream);
    // It ignores its closed stdin: SIGTERM after 2 s ends it (and the dialer reaps it).
    let deadline = std::time::Instant::now() + Duration::from_secs(6);
    while std::path::Path::new(&proc).exists() {
        assert!(std::time::Instant::now() < deadline, "{proc} still runs");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn a_local_command_comes_first() {
    let target = echo_target("t").await;
    let err = Dialer::through(Route::new(
        "r",
        vec![
            Hop::HttpConnect(HttpConnectHop::from_url(&format!("http://{target}")).unwrap()),
            Hop::Command(local(&["echo"])),
        ],
    ))
    .unwrap_err();
    assert_eq!(
        (err.kind, err.hop.unwrap().index),
        (RouteErrorKind::Invalid, 1)
    );
}

// --- System route -------------------------------------------------------------------------

#[tokio::test]
async fn the_system_route_reads_the_proxy_variables_at_each_dial() {
    let target = echo_target("system").await;
    let (proxy, log) = HttpProxy {
        hosts: [("echo.internal".to_owned(), target)].into(),
        ..Default::default()
    }
    .start()
    .await;
    let vars = [
        ("HTTPS_PROXY".to_owned(), format!("http://{proxy}")),
        ("NO_PROXY".to_owned(), "127.0.0.1".to_owned()),
    ];
    let dialer = Dialer::system_with(Arc::new(move |name: &str| {
        vars.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
    }));
    assert_eq!(
        talk(dialer.dial("echo.internal", 7).await.unwrap()).await,
        "HELLO system"
    );
    assert_eq!(lines(&log).len(), 2, "CONNECT and its auth line");
    // NO_PROXY: Direct.
    talk(dialer.dial("127.0.0.1", target.port()).await.unwrap()).await;
    assert_eq!(lines(&log).len(), 2);

    let none = Dialer::system_with(Arc::new(|_: &str| None));
    talk(none.dial("127.0.0.1", target.port()).await.unwrap()).await;
}
