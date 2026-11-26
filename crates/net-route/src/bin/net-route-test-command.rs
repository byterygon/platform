//! A program for net-route's command-hop tests (DOC-23 5, "a small test binary that echoes or
//! exits"), so they need nothing installed. Not used outside the tests.
//!
//!   echo                 "HELLO command" on stdout, then echoes stdin until it closes
//!   exit <code> <text>   writes <text> to stderr and exits with <code>
//!   connect <host> <port> a TCP connection to host:port, piped to stdio (a small `nc`)
//!   env                  the names of its environment, sorted, one line, then echoes stdin
//!   hang                 ignores stdin and runs until it is stopped; writes its PID first

use std::io::{Read, Write};
use std::net::TcpStream;

fn echo() {
    let mut buf = [0u8; 4096];
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    loop {
        match stdin.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                if stdout
                    .write_all(&buf[..n])
                    .and_then(|()| stdout.flush())
                    .is_err()
                {
                    return;
                }
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("echo") => {
            println!("HELLO command");
            echo();
        }
        Some("exit") => {
            let code = args.get(1).and_then(|c| c.parse().ok()).unwrap_or(1);
            eprintln!("{}", args.get(2).map_or("", String::as_str));
            std::process::exit(code);
        }
        Some("connect") => {
            let address = format!("{}:{}", args[1], args[2]);
            let tcp = match TcpStream::connect(&address) {
                Ok(tcp) => tcp,
                Err(e) => {
                    eprintln!("cannot reach {address}: {e}");
                    std::process::exit(2);
                }
            };
            let mut upstream = tcp.try_clone().expect("clone");
            let pump = std::thread::spawn(move || {
                let _ = std::io::copy(&mut upstream, &mut std::io::stdout().lock());
            });
            let mut down = tcp;
            let _ = std::io::copy(&mut std::io::stdin().lock(), &mut down);
            let _ = down.shutdown(std::net::Shutdown::Write);
            let _ = pump.join();
        }
        Some("env") => {
            let mut names: Vec<String> = std::env::vars_os()
                .map(|(k, _)| k.to_string_lossy().into_owned())
                .collect();
            names.sort();
            println!("{}", names.join(" "));
            echo();
        }
        Some("hang") => {
            println!("{}", std::process::id());
            loop {
                std::thread::sleep(std::time::Duration::from_secs(3600));
            }
        }
        _ => {
            eprintln!("usage: net-route-test-command echo|exit|connect|env|hang");
            std::process::exit(64);
        }
    }
}
