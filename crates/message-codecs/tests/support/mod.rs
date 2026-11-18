//! A fake Confluent Schema Registry on loopback for the tests that must not need the lab: the
//! endpoints the codecs read (`/schemas/ids/{id}`, `/subjects`, `/subjects/{s}/versions[/{v}]`,
//! registering), held in memory. Plain HTTP/1.1, one request per connection.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Clone, Default)]
pub struct FakeRegistry {
    state: Arc<Mutex<State>>,
}

#[derive(Default)]
struct State {
    /// id → (schemaType, schema, references)
    schemas: Vec<(Option<String>, String, Value)>,
    /// subject → ids by version (version = index + 1)
    subjects: HashMap<String, Vec<u32>>,
    pub requests: Vec<String>,
}

impl FakeRegistry {
    /// Starts the server; returns it and its URL.
    pub async fn start() -> (Self, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let me = Self::default();
        let server = me.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let s = server.clone();
                tokio::spawn(async move { s.serve(stream).await });
            }
        });
        (me, url)
    }

    /// Registers a schema directly; returns its id.
    pub fn add(
        &self,
        subject: &str,
        schema_type: Option<&str>,
        schema: &str,
        references: Value,
    ) -> u32 {
        let mut st = self.state.lock().unwrap();
        let id = (st.schemas.len() + 1) as u32;
        st.schemas.push((
            schema_type.map(str::to_owned),
            schema.to_owned(),
            references,
        ));
        st.subjects.entry(subject.to_owned()).or_default().push(id);
        id
    }

    pub fn requests(&self) -> Vec<String> {
        self.state.lock().unwrap().requests.clone()
    }

    async fn serve(&self, mut stream: TcpStream) {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        let header_end = loop {
            let n = stream.read(&mut chunk).await.unwrap_or(0);
            if n == 0 {
                return;
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
        };
        let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
        let len: usize = head
            .lines()
            .find_map(|l| {
                l.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .map(|v| v.trim().parse().unwrap_or(0))
            })
            .unwrap_or(0);
        while buf.len() < header_end + len {
            let n = stream.read(&mut chunk).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        let body = &buf[header_end..];
        let mut first = head.lines().next().unwrap_or_default().split(' ');
        let (method, path) = (
            first.next().unwrap_or_default().to_owned(),
            first.next().unwrap_or_default().to_owned(),
        );
        self.state
            .lock()
            .unwrap()
            .requests
            .push(format!("{method} {path}"));
        let (status, reply) = self.route(&method, &path, body);
        let text = reply.to_string();
        let resp = format!(
            "HTTP/1.1 {status} X\r\ncontent-type: application/vnd.schemaregistry.v1+json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
            text.len()
        );
        let _ = stream.write_all(resp.as_bytes()).await;
        let _ = stream.shutdown().await;
    }

    fn route(&self, method: &str, path: &str, body: &[u8]) -> (u16, Value) {
        let not_found = |code: u32, m: &str| (404, json!({ "error_code": code, "message": m }));
        let path = path.split('?').next().unwrap_or_default();
        let parts: Vec<String> = path
            .trim_start_matches('/')
            .split('/')
            .map(decode)
            .collect();
        let mut st = self.state.lock().unwrap();
        match (
            method,
            parts
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .as_slice(),
        ) {
            ("GET", ["subjects"]) => (200, json!(st.subjects.keys().collect::<Vec<_>>())),
            ("GET", ["schemas", "ids", id]) => match id
                .parse::<usize>()
                .ok()
                .and_then(|i| st.schemas.get(i.wrapping_sub(1)))
            {
                Some((t, s, r)) => {
                    let mut v = json!({ "schema": s, "references": r });
                    if let Some(t) = t {
                        v["schemaType"] = json!(t);
                    }
                    (200, v)
                }
                None => not_found(40403, "Schema not found"),
            },
            ("GET", ["subjects", subject, "versions"]) => match st.subjects.get(*subject) {
                Some(ids) => (200, json!((1..=ids.len()).collect::<Vec<_>>())),
                None => not_found(40401, "Subject not found"),
            },
            ("GET", ["subjects", subject, "versions", v]) => {
                let Some(ids) = st.subjects.get(*subject) else {
                    return not_found(40401, "Subject not found");
                };
                let version = if *v == "latest" {
                    ids.len()
                } else {
                    v.parse().unwrap_or(0)
                };
                let Some(&id) = version.checked_sub(1).and_then(|i| ids.get(i)) else {
                    return not_found(40402, "Version not found");
                };
                let (t, s, r) = &st.schemas[id as usize - 1];
                let mut v = json!({ "subject": subject, "version": version, "id": id, "schema": s, "references": r });
                if let Some(t) = t {
                    v["schemaType"] = json!(t);
                }
                (200, v)
            }
            ("POST", ["subjects", subject, "versions"]) => {
                let req: Value = serde_json::from_slice(body).unwrap_or_default();
                let schema = req["schema"].as_str().unwrap_or_default().to_owned();
                let t = req["schemaType"].as_str().map(str::to_owned);
                let existing = st
                    .schemas
                    .iter()
                    .position(|(et, es, _)| *es == schema && *et == t);
                let id = match existing {
                    Some(i) => (i + 1) as u32,
                    None => {
                        st.schemas.push((
                            t,
                            schema,
                            req.get("references").cloned().unwrap_or(json!([])),
                        ));
                        st.schemas.len() as u32
                    }
                };
                let ids = st.subjects.entry((*subject).to_owned()).or_default();
                if !ids.contains(&id) {
                    ids.push(id);
                }
                (200, json!({ "id": id }))
            }
            _ => not_found(40400, "no such endpoint in the fake registry"),
        }
    }
}

fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
