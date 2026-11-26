//! A stand-in sshd (a russh server): a generated host key, public-key and password logins,
//! `direct-tcpip` forwarding to the names of its own table (so a jump host behind it is reached
//! only through it), a user whose forwarding is refused (`AllowTcpForwarding no`), commands
//! (`nc <host> <port>` connects to a name of its table and pipes it to the channel; `refuse` is
//! refused; `fail` writes to stderr and exits 3), and a log of what it saw.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use russh::keys::ssh_key::LineEnding;
use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::keys::{PrivateKey, PublicKey};
use russh::server::{self, Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId, ChannelOpenFailure};

use super::{Hosts, Log};

pub const USER: &str = "lab";
pub const NO_FORWARD_USER: &str = "nofwd";
pub const PASSWORD: &str = "correct horse";

pub fn key() -> PrivateKey {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).unwrap();
    PrivateKey::from(Ed25519Keypair::from_seed(&seed))
}

/// The client's key, shared by every fake host of a test.
pub struct ClientKey {
    pub private: PrivateKey,
    pub text: String,
}

impl ClientKey {
    pub fn new() -> ClientKey {
        let private = key();
        let text = private.to_openssh(LineEnding::LF).unwrap().to_string();
        ClientKey { private, text }
    }
}

#[derive(Clone)]
struct Host {
    client_key: PublicKey,
    hosts: Hosts,
    log: Log,
    user: Arc<Mutex<String>>,
    auth_attempts: Arc<AtomicUsize>,
    sessions: Arc<Mutex<HashMap<ChannelId, Channel<Msg>>>>,
}

/// A running fake sshd.
pub struct Sshd {
    pub addr: SocketAddr,
    pub host_key: PublicKey,
    pub log: Log,
    pub auth_attempts: Arc<AtomicUsize>,
}

pub async fn start(client: &ClientKey, hosts: Hosts) -> Sshd {
    let host_key = key();
    let log: Log = Arc::default();
    let auth_attempts = Arc::new(AtomicUsize::new(0));
    let config = server::Config {
        keys: vec![host_key.clone()],
        auth_rejection_time: std::time::Duration::ZERO,
        auth_rejection_time_initial: Some(std::time::Duration::ZERO),
        ..server::Config::default()
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut host = Host {
        client_key: client.private.public_key().clone(),
        hosts,
        log: log.clone(),
        user: Arc::default(),
        auth_attempts: Arc::clone(&auth_attempts),
        sessions: Arc::default(),
    };
    tokio::spawn(async move {
        let _ = host.run_on_socket(Arc::new(config), &listener).await;
    });
    Sshd {
        addr,
        host_key: host_key.public_key().clone(),
        log,
        auth_attempts,
    }
}

impl server::Server for Host {
    type Handler = Host;
    fn new_client(&mut self, _: Option<SocketAddr>) -> Host {
        let mut host = self.clone();
        host.user = Arc::default();
        host.sessions = Arc::default();
        host
    }
}

impl Host {
    fn push(&self, line: String) {
        self.log.lock().unwrap().push(line);
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        // One handler per connection: its end is the session's end.
        if !self.user.lock().unwrap().is_empty() {
            self.log.lock().unwrap().push("session closed".into());
        }
    }
}

impl server::Handler for Host {
    type Error = russh::Error;

    async fn auth_none(&mut self, _user: &str) -> Result<Auth, Self::Error> {
        self.auth_attempts.fetch_add(1, Ordering::SeqCst);
        Ok(Auth::reject())
    }

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        self.auth_attempts.fetch_add(1, Ordering::SeqCst);
        if user == USER && password == PASSWORD {
            *self.user.lock().unwrap() = user.to_owned();
            self.push(format!("login:{user}:password"));
            return Ok(Auth::Accept);
        }
        Ok(Auth::reject())
    }

    async fn auth_publickey_offered(
        &mut self,
        _user: &str,
        _offer: server::PublicKeyOffer<'_>,
    ) -> Result<Auth, Self::Error> {
        self.auth_attempts.fetch_add(1, Ordering::SeqCst);
        Ok(Auth::Accept)
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        key: server::VerifiedPublicKey<'_>,
    ) -> Result<Auth, Self::Error> {
        self.auth_attempts.fetch_add(1, Ordering::SeqCst);
        if (user == USER || user == NO_FORWARD_USER)
            && key.public_key.key_data() == self.client_key.key_data()
        {
            *self.user.lock().unwrap() = user.to_owned();
            self.push(format!("login:{user}:publickey"));
            return Ok(Auth::Accept);
        }
        Ok(Auth::reject())
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.sessions.lock().unwrap().insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        id: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let command = String::from_utf8_lossy(data).into_owned();
        self.push(format!("exec:{command}"));
        let words: Vec<&str> = command.split_whitespace().collect();
        match words.as_slice() {
            ["refuse", ..] => {
                session.channel_failure(id)?;
            }
            ["fail", ..] => {
                session.channel_success(id)?;
                session.extended_data(id, 1, b"nc: no such host\n".to_vec())?;
                session.exit_status_request(id, 3)?;
                session.eof(id)?;
                session.close(id)?;
            }
            ["nc", host, port] => {
                let target = self
                    .hosts
                    .get(*host)
                    .copied()
                    .or_else(|| Some(SocketAddr::new(host.parse().ok()?, port.parse().ok()?)));
                let upstream = match target {
                    Some(target) => tokio::net::TcpStream::connect(target).await.ok(),
                    None => None,
                };
                let channel = self.sessions.lock().unwrap().remove(&id);
                match (upstream, channel) {
                    (Some(mut upstream), Some(channel)) => {
                        session.channel_success(id)?;
                        tokio::spawn(async move {
                            let mut stream = channel.into_stream();
                            let _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream).await;
                        });
                    }
                    _ => {
                        session.channel_success(id)?;
                        session.extended_data(id, 1, b"nc: cannot connect\n".to_vec())?;
                        session.exit_status_request(id, 1)?;
                        session.eof(id)?;
                        session.close(id)?;
                    }
                }
            }
            _ => {
                session.channel_failure(id)?;
            }
        }
        Ok(())
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.push(format!("direct-tcpip:{host_to_connect}:{port_to_connect}"));
        if *self.user.lock().unwrap() == NO_FORWARD_USER {
            reply
                .reject(ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }
        let target = self.hosts.get(host_to_connect).copied().or_else(|| {
            let ip = host_to_connect.parse().ok()?;
            Some(SocketAddr::new(ip, u16::try_from(port_to_connect).ok()?))
        });
        let upstream = match target {
            Some(target) => tokio::net::TcpStream::connect(target).await.ok(),
            None => None,
        };
        let Some(mut upstream) = upstream else {
            reply.reject(ChannelOpenFailure::ConnectFailed).await;
            return Ok(());
        };
        reply.accept().await;
        tokio::spawn(async move {
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream).await;
        });
        Ok(())
    }
}
