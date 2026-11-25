//! A container's Files, read only (TSK-81 batch 4c, mockup frame docker-files, DOC-21 Open
//! question 45 q): everything goes through `GET /containers/{id}/archive?path=…`, the tar Docker
//! makes of a path. No shell in the image is needed, and stopped containers work too.
//!
//! - `docker.containers.files.list`: a folder's direct entries, read from the tar's headers as
//!   they stream (the contents are skipped, never kept). A listing stops at
//!   [`MAX_ENTRIES`] entries or [`MAX_READ`] bytes read, and says so.
//! - `docker.containers.files.read`: a file's text for the preview, up to [`MAX_PREVIEW`].
//! - `docker.containers.files.download`: the path's tar as it comes, in `bytes` chunks.
//!
//! The tar reader understands ustar names with their prefix, GNU long names and links (`L`,
//! `K`), PAX headers (`x`: `path`, `linkpath`, `size`, `mtime`) and base-256 sizes.

use std::collections::HashMap;
use std::sync::Arc;

use ambidex::{BinarySink, Ctx, rpc};
use base64::Engine as _;
use http_body_util::BodyExt;
use hyper::Method;
use hyper::body::Incoming;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::containers::container_ref;
use super::engine::{CALL_TIMEOUT, http_error, read_body};
use super::stream::{CHUNK_BYTES, ended, read_error};
use super::{DockerClient, TOOL};
use crate::core::{Hub, ToolError, ToolErrorKind, ToolResult};

/// A listing keeps at most this many entries.
pub const MAX_ENTRIES: usize = 2000;

/// A listing reads at most this much of the folder's tar (its files' contents included).
pub const MAX_READ: u64 = 64 * 1024 * 1024;

/// A preview reads at most this much of a file.
pub const MAX_PREVIEW: u64 = 1024 * 1024;

const BLOCK: usize = 512;

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FilesPathInput {
    pub conn_id: String,
    /// The container's name or id.
    pub id: String,
    /// An absolute path in the container.
    pub path: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FilesDownloadInput {
    pub conn_id: String,
    pub id: String,
    pub path: String,
    pub stream_id: String,
}

/// What an entry is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    File,
    Dir,
    Symlink,
    /// A hard link to another entry of the tar.
    Link,
    /// A device, a FIFO, a socket.
    Other,
}

/// One entry of a folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub kind: FileKind,
    /// Bytes; 0 for a folder.
    pub size: u64,
    /// The permission bits (`0o755`).
    pub mode: u32,
    /// Unix milliseconds.
    pub mtime_ms: u64,
    /// Where a symlink or a hard link points.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub link_target: Option<String>,
}

/// Why a listing stopped early.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Truncated {
    /// [`MAX_ENTRIES`] entries were listed.
    Entries,
    /// [`MAX_READ`] bytes were read (the folder holds large files).
    Bytes,
}

/// `docker.containers.files.list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FilesListOutput {
    /// The path as asked.
    pub path: String,
    /// What the path is (Docker's stat of it); a file or a symlink has no entries.
    pub kind: FileKind,
    /// A symlink's target, when `path` is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub link_target: Option<String>,
    /// Folders first, then by name.
    pub entries: Vec<FileEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub truncated: Option<Truncated>,
}

/// `docker.containers.files.read`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileReadOutput {
    pub path: String,
    pub size: u64,
    /// The text, when the file is UTF-8 without NUL bytes and at most [`MAX_PREVIEW`].
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    /// Not text (invalid UTF-8 or a NUL byte).
    pub binary: bool,
    /// Larger than [`MAX_PREVIEW`]: not read.
    pub too_large: bool,
}

/// `docker.containers.files.download`'s summary.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FilesDownloadSummary {
    /// The tar's bytes sent.
    pub bytes: u64,
}

/// An absolute container path, as Docker's `path` query takes it.
pub fn container_path<'a>(field: &str, path: &'a str) -> Result<&'a str, ToolError> {
    if !path.starts_with('/') {
        return Err(ToolError::invalid(
            TOOL,
            field,
            "the path must be absolute, like /etc",
        ));
    }
    if path.contains('\0') || path.len() > 4096 {
        return Err(ToolError::invalid(
            TOOL,
            field,
            "not a path Docker can read",
        ));
    }
    Ok(path)
}

/// `/containers/{id}/archive?path=…`.
pub fn archive_path(id: &str, path: &str) -> String {
    let encoded: String = url::form_urlencoded::byte_serialize(path.as_bytes()).collect();
    format!("/containers/{id}/archive?path={encoded}")
}

/// One header of the tar, with the long names and PAX values already applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TarEntry {
    pub path: String,
    pub kind: FileKind,
    pub size: u64,
    pub mode: u32,
    pub mtime: u64,
    pub link: Option<String>,
}

/// An octal field, or a base-256 one (its first byte's high bit set).
fn number(field: &[u8]) -> u64 {
    if field.first().is_some_and(|b| b & 0x80 != 0) {
        return field[1..].iter().fold(u64::from(field[0] & 0x7f), |n, b| {
            n.saturating_mul(256).saturating_add(u64::from(*b))
        });
    }
    let text: String = field
        .iter()
        .take_while(|b| **b != 0)
        .map(|b| *b as char)
        .collect();
    u64::from_str_radix(text.trim(), 8).unwrap_or(0)
}

fn text(field: &[u8]) -> String {
    let end = field.iter().position(|b| *b == 0).unwrap_or(field.len());
    String::from_utf8_lossy(&field[..end]).into_owned()
}

/// `len key=value\n` records.
fn pax(data: &[u8]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut rest = data;
    while let Some(space) = rest.iter().position(|b| *b == b' ') {
        let Ok(len) = std::str::from_utf8(&rest[..space])
            .unwrap_or("")
            .parse::<usize>()
        else {
            break;
        };
        if len <= space || len > rest.len() {
            break;
        }
        let record = &rest[space + 1..len];
        let record = record.strip_suffix(b"\n").unwrap_or(record);
        if let Some(eq) = record.iter().position(|b| *b == b'=') {
            out.insert(
                String::from_utf8_lossy(&record[..eq]).into_owned(),
                String::from_utf8_lossy(&record[eq + 1..]).into_owned(),
            );
        }
        rest = &rest[len..];
    }
    out
}

/// What the reader is in the middle of.
enum State {
    Header,
    /// An entry's data (and its padding): `keep` bytes of it are wanted (a long name, a PAX
    /// header, a previewed file).
    Data {
        left: u64,
        pad: u64,
        meta: Option<u8>,
    },
    End,
}

/// What [`TarReader::push`] found.
#[derive(Debug, PartialEq, Eq)]
pub enum TarEvent {
    Entry(TarEntry),
    /// Some of the current entry's contents (only when asked for with `contents`).
    Data(Vec<u8>),
    End,
}

/// A tar read as it streams: headers come out as [`TarEvent::Entry`], contents are skipped
/// unless `contents` is set.
pub struct TarReader {
    buffer: Vec<u8>,
    state: State,
    contents: bool,
    meta: Vec<u8>,
    long_name: Option<String>,
    long_link: Option<String>,
    pax: HashMap<String, String>,
    zero_blocks: u8,
}

impl TarReader {
    pub fn new(contents: bool) -> TarReader {
        TarReader {
            buffer: Vec::new(),
            state: State::Header,
            contents,
            meta: Vec::new(),
            long_name: None,
            long_link: None,
            pax: HashMap::new(),
            zero_blocks: 0,
        }
    }

    /// Reads `data`; `event` gets what it completes.
    pub fn push(&mut self, data: &[u8], event: &mut impl FnMut(TarEvent)) {
        self.buffer.extend_from_slice(data);
        let mut at = 0;
        loop {
            match &mut self.state {
                State::End => {
                    self.buffer.clear();
                    return;
                }
                State::Header => {
                    if self.buffer.len() - at < BLOCK {
                        break;
                    }
                    let block: [u8; BLOCK] =
                        self.buffer[at..at + BLOCK].try_into().expect("a block");
                    at += BLOCK;
                    self.header(&block, event);
                }
                State::Data { left, pad, meta } => {
                    let available = (self.buffer.len() - at) as u64;
                    if available == 0 {
                        break;
                    }
                    if *left > 0 {
                        let n = (*left).min(available) as usize;
                        let piece = &self.buffer[at..at + n];
                        if meta.is_some() {
                            self.meta.extend_from_slice(piece);
                        } else if self.contents {
                            event(TarEvent::Data(piece.to_vec()));
                        }
                        at += n;
                        *left -= n as u64;
                        continue;
                    }
                    let n = (*pad).min(available);
                    at += n as usize;
                    *pad -= n;
                    if *pad == 0 {
                        let meta = *meta;
                        self.state = State::Header;
                        if let Some(kind) = meta {
                            self.finish_meta(kind);
                        }
                    }
                }
            }
        }
        self.buffer.drain(..at);
    }

    fn finish_meta(&mut self, kind: u8) {
        let data = std::mem::take(&mut self.meta);
        match kind {
            b'L' => self.long_name = Some(text(&data)),
            b'K' => self.long_link = Some(text(&data)),
            b'x' => self.pax = pax(&data),
            _ => {}
        }
    }

    fn header(&mut self, block: &[u8; BLOCK], event: &mut impl FnMut(TarEvent)) {
        if block.iter().all(|b| *b == 0) {
            self.zero_blocks += 1;
            if self.zero_blocks == 2 {
                self.state = State::End;
                event(TarEvent::End);
            }
            return;
        }
        self.zero_blocks = 0;
        let typeflag = block[156];
        let mut size = number(&block[124..136]);
        let pad = (BLOCK as u64 - size % BLOCK as u64) % BLOCK as u64;
        // Headers that describe the next entry.
        if matches!(typeflag, b'L' | b'K' | b'x' | b'g') {
            self.state = State::Data {
                left: size,
                pad,
                meta: Some(typeflag),
            };
            return;
        }
        let ustar = &block[257..262] == b"ustar";
        let mut path = text(&block[0..100]);
        if ustar {
            let prefix = text(&block[345..500]);
            if !prefix.is_empty() {
                path = format!("{prefix}/{path}");
            }
        }
        let mut link = Some(text(&block[157..257])).filter(|l| !l.is_empty());
        let mut mtime = number(&block[136..148]);
        if let Some(long) = self.long_name.take() {
            path = long;
        }
        if let Some(long) = self.long_link.take() {
            link = Some(long);
        }
        let pax = std::mem::take(&mut self.pax);
        if let Some(p) = pax.get("path") {
            path.clone_from(p);
        }
        if let Some(l) = pax.get("linkpath") {
            link = Some(l.clone());
        }
        if let Some(s) = pax.get("size").and_then(|s| s.parse().ok()) {
            size = s;
        }
        if let Some(m) = pax
            .get("mtime")
            .and_then(|m| m.split('.').next()?.parse().ok())
        {
            mtime = m;
        }
        let pad = (BLOCK as u64 - size % BLOCK as u64) % BLOCK as u64;
        let kind = match typeflag {
            b'0' | 0 | b'7' => FileKind::File,
            b'5' => FileKind::Dir,
            b'2' => FileKind::Symlink,
            b'1' => FileKind::Link,
            _ => FileKind::Other,
        };
        let kind = if kind == FileKind::File && path.ends_with('/') {
            FileKind::Dir
        } else {
            kind
        };
        let mode = u32::try_from(number(&block[100..108]) & 0o7777).unwrap_or(0);
        event(TarEvent::Entry(TarEntry {
            path,
            kind,
            size,
            mode,
            mtime,
            link: if matches!(kind, FileKind::Symlink | FileKind::Link) {
                link
            } else {
                None
            },
        }));
        self.state = State::Data {
            left: size,
            pad,
            meta: None,
        };
    }
}

/// Docker's stat of the archived path, from the `X-Docker-Container-Path-Stat` header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathStat {
    pub name: String,
    pub kind: FileKind,
    pub size: u64,
    pub link_target: Option<String>,
}

/// Go's `os.FileMode` type bits.
const MODE_DIR: u64 = 1 << 31;
const MODE_SYMLINK: u64 = 1 << 27;

pub fn path_stat(header: &str) -> Option<PathStat> {
    let json = base64::engine::general_purpose::STANDARD
        .decode(header.trim())
        .ok()?;
    let value: Value = serde_json::from_slice(&json).ok()?;
    let mode = value.get("mode").and_then(Value::as_u64).unwrap_or(0);
    Some(PathStat {
        name: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        kind: if mode & MODE_DIR != 0 {
            FileKind::Dir
        } else if mode & MODE_SYMLINK != 0 {
            FileKind::Symlink
        } else {
            FileKind::File
        },
        size: value.get("size").and_then(Value::as_u64).unwrap_or(0),
        link_target: value
            .get("linkTarget")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .map(str::to_owned),
    })
}

/// An entry's path relative to the archived folder, or `None` for the folder itself.
/// Docker names the entries after the folder's base name (`media/`, `media/logo.png`); the
/// root's have no prefix.
pub fn relative<'a>(root: &str, path: &'a str) -> Option<&'a str> {
    let path = path.trim_start_matches("./").trim_start_matches('/');
    let path = path.trim_end_matches('/');
    let rest = if root.is_empty() {
        path
    } else {
        path.strip_prefix(root)?.strip_prefix('/')?
    };
    (!rest.is_empty()).then_some(rest)
}

/// The listing of a folder from its tar's events.
pub struct Listing {
    root: String,
    pub entries: Vec<FileEntry>,
    pub truncated: Option<Truncated>,
}

impl Listing {
    /// `name` is Docker's stat name of the folder (`/` for the root).
    pub fn new(name: &str) -> Listing {
        let root = name.trim_matches('/');
        Listing {
            root: if root == "." {
                String::new()
            } else {
                root.to_owned()
            },
            entries: Vec::new(),
            truncated: None,
        }
    }

    /// Takes an entry; `false` once the listing is full.
    pub fn take(&mut self, entry: TarEntry) -> bool {
        let Some(rest) = relative(&self.root, &entry.path) else {
            return true;
        };
        if rest.contains('/') {
            return true;
        }
        if self.entries.len() >= MAX_ENTRIES {
            self.truncated = Some(Truncated::Entries);
            return false;
        }
        self.entries.push(FileEntry {
            name: rest.to_owned(),
            kind: entry.kind,
            size: if entry.kind == FileKind::Dir {
                0
            } else {
                entry.size
            },
            mode: entry.mode,
            mtime_ms: entry.mtime.saturating_mul(1000),
            link_target: entry.link,
        });
        true
    }

    /// Folders first, then by name.
    pub fn sorted(mut self) -> (Vec<FileEntry>, Option<Truncated>) {
        self.entries.sort_by(|a, b| {
            (b.kind == FileKind::Dir)
                .cmp(&(a.kind == FileKind::Dir))
                .then_with(|| a.name.cmp(&b.name))
        });
        (self.entries, self.truncated)
    }
}

fn client(hub: &Hub, ctx: &Ctx, conn_id: &str) -> Result<Arc<DockerClient>, ToolError> {
    Ok(hub
        .get::<DockerClient>(&ctx.session().id, TOOL, conn_id)?
        .value)
}

/// `GET` the archive of `path`: Docker's stat of it and the tar's body.
async fn archive(
    client: &DockerClient,
    id: &str,
    path: &str,
) -> Result<(PathStat, Incoming), ToolError> {
    let url = archive_path(id, path);
    let response = tokio::time::timeout(CALL_TIMEOUT, client.engine.send(Method::GET, &url, None))
        .await
        .map_err(|_| {
            ToolError::new(
                ToolErrorKind::Connect,
                TOOL,
                format!("Docker did not answer {url} within 30 s"),
            )
        })??;
    let status = response.status();
    if !status.is_success() {
        let body = read_body(response, 64 * 1024).await?;
        return Err(http_error(status, &body, "path"));
    }
    let stat = response
        .headers()
        .get("x-docker-container-path-stat")
        .and_then(|h| h.to_str().ok())
        .and_then(path_stat)
        .unwrap_or(PathStat {
            name: path.rsplit('/').next().unwrap_or("").to_owned(),
            kind: FileKind::Dir,
            size: 0,
            link_target: None,
        });
    Ok((stat, response.into_body()))
}

/// A folder's direct entries.
pub async fn list(
    client: &DockerClient,
    id: &str,
    path: &str,
) -> Result<FilesListOutput, ToolError> {
    let (stat, mut body) = archive(client, id, path).await?;
    if stat.kind != FileKind::Dir {
        return Ok(FilesListOutput {
            path: path.to_owned(),
            kind: stat.kind,
            link_target: stat.link_target,
            entries: Vec::new(),
            truncated: None,
        });
    }
    let mut reader = TarReader::new(false);
    let mut listing = Listing::new(if path == "/" { "/" } else { &stat.name });
    let mut read = 0u64;
    let mut full = false;
    while !full {
        let Some(frame) = body.frame().await else {
            break;
        };
        let Ok(data) = frame.map_err(read_error)?.into_data() else {
            continue;
        };
        read += data.len() as u64;
        let mut end = false;
        reader.push(&data, &mut |event| match event {
            TarEvent::Entry(entry) if !full => full = !listing.take(entry),
            TarEvent::End => end = true,
            _ => {}
        });
        if end {
            break;
        }
        if !full && read >= MAX_READ {
            listing.truncated = Some(Truncated::Bytes);
            break;
        }
    }
    // Dropping the body closes the channel: Docker stops making the rest of the tar.
    drop(body);
    let (entries, truncated) = listing.sorted();
    Ok(FilesListOutput {
        path: path.to_owned(),
        kind: FileKind::Dir,
        link_target: None,
        entries,
        truncated,
    })
}

/// A file's text for the preview.
pub async fn read(
    client: &DockerClient,
    id: &str,
    path: &str,
) -> Result<FileReadOutput, ToolError> {
    let (stat, mut body) = archive(client, id, path).await?;
    if stat.kind == FileKind::Dir {
        return Err(ToolError::invalid(
            TOOL,
            "path",
            format!("{path} is a folder"),
        ));
    }
    let too_large = stat.size > MAX_PREVIEW;
    let mut output = FileReadOutput {
        path: path.to_owned(),
        size: stat.size,
        text: None,
        binary: false,
        too_large,
    };
    if too_large || stat.kind == FileKind::Symlink {
        return Ok(output);
    }
    let mut reader = TarReader::new(true);
    let mut data = Vec::new();
    let mut entries = 0;
    let mut done = false;
    while !done {
        let Some(frame) = body.frame().await else {
            break;
        };
        let Ok(chunk) = frame.map_err(read_error)?.into_data() else {
            continue;
        };
        reader.push(&chunk, &mut |event| match event {
            TarEvent::Entry(_) => {
                entries += 1;
                done = entries > 1;
            }
            TarEvent::Data(piece) if entries == 1 && (data.len() as u64) < MAX_PREVIEW => {
                data.extend_from_slice(&piece)
            }
            TarEvent::End => done = true,
            TarEvent::Data(_) => {}
        });
    }
    drop(body);
    data.truncate(MAX_PREVIEW as usize);
    match String::from_utf8(data) {
        Ok(text) if !text.contains('\0') => output.text = Some(text),
        _ => output.binary = true,
    }
    Ok(output)
}

/// `docker.containers.files.download`: the tar of the path, in chunks of at most
/// [`CHUNK_BYTES`], one credit each.
pub async fn download(
    hub: &Arc<Hub>,
    ctx: &Ctx,
    input: FilesDownloadInput,
    sink: &BinarySink,
) -> ToolResult<FilesDownloadSummary> {
    let session = ctx.session().id.clone();
    let id = container_ref("id", &input.id)?.to_owned();
    let path = container_path("path", &input.path)?.to_owned();
    let claim = hub.claim_stream(&session, TOOL, &input.stream_id)?;
    let (handle, _busy) = hub.busy::<DockerClient>(&session, TOOL, &input.conn_id)?;
    let (_, mut body) = archive(&handle.value, &id, &path).await?;
    let progress = hub.progress(&session, claim.stream_id());
    let mut sent = 0u64;
    let mut chunk: Vec<u8> = Vec::with_capacity(CHUNK_BYTES);
    loop {
        let frame = tokio::select! {
            biased;
            () = handle.token.cancelled() => return Err(ended()),
            () = ctx.cancelled() => return Err(ended()),
            frame = body.frame() => frame,
        };
        let done = match frame {
            None => true,
            Some(Err(e)) => return Err(read_error(e).into()),
            Some(Ok(frame)) => {
                if let Ok(data) = frame.into_data() {
                    chunk.extend_from_slice(&data);
                }
                false
            }
        };
        while chunk.len() >= CHUNK_BYTES || (done && !chunk.is_empty()) {
            let rest = if chunk.len() > CHUNK_BYTES {
                chunk.split_off(CHUNK_BYTES)
            } else {
                Vec::new()
            };
            let out = std::mem::replace(&mut chunk, rest);
            tokio::select! {
                biased;
                () = handle.token.cancelled() => return Err(ended()),
                () = ctx.cancelled() => return Err(ended()),
                ready = sink.ready() => ready?,
            }
            let n = out.len() as u64;
            progress.matched(1, n);
            sink.send(out).await?;
            sent += n;
        }
        if done {
            return Ok(FilesDownloadSummary { bytes: sent });
        }
    }
}

pub struct DockerFilesApi(pub Arc<Hub>);

#[rpc::router(namespace = "docker.containers.files")]
impl DockerFilesApi {
    /// A folder's direct entries (folders first), from the tar Docker makes of it: at most
    /// 2,000 entries or 64 MiB read, then `truncated` says which. A file or a symlink gives its
    /// kind and no entries. Works on stopped containers.
    #[rpc::query(perm = "docker.read", risk = Risk::Read, timeout_default = "2m")]
    async fn list(&self, ctx: Ctx, input: FilesPathInput) -> ToolResult<FilesListOutput> {
        let client = client(&self.0, &ctx, &input.conn_id)?;
        let id = container_ref("id", &input.id)?;
        let path = container_path("path", &input.path)?;
        Ok(list(&client, id, path).await?)
    }

    /// A file's text for the preview, when it is UTF-8 and at most 1 MiB.
    #[rpc::query(perm = "docker.files.read", risk = Risk::Read, audit = "always")]
    async fn read(&self, ctx: Ctx, input: FilesPathInput) -> ToolResult<FileReadOutput> {
        let client = client(&self.0, &ctx, &input.conn_id)?;
        let id = container_ref("id", &input.id)?;
        let path = container_path("path", &input.path)?;
        Ok(read(&client, id, path).await?)
    }

    /// The path's tar (a file or a whole folder) as `bytes` chunks of at most 256 KiB.
    #[rpc::stream(perm = "docker.files.read", risk = Risk::Read, timeout_max = "12h", audit = "always")]
    async fn download(
        &self,
        ctx: Ctx,
        input: FilesDownloadInput,
        sink: BinarySink,
    ) -> ToolResult<FilesDownloadSummary> {
        download(&self.0, &ctx, input, &sink).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A ustar header block for `path`.
    fn header(path: &str, kind: u8, size: u64, mode: u32, link: &str) -> Vec<u8> {
        let mut h = vec![0u8; BLOCK];
        let (prefix, name) = if path.len() > 100 {
            let cut = path[..path.len() - 100].len() + path[path.len() - 100..].find('/').unwrap();
            (&path[..cut], &path[cut + 1..])
        } else {
            ("", path)
        };
        h[..name.len()].copy_from_slice(name.as_bytes());
        h[100..107].copy_from_slice(format!("{mode:07o}").as_bytes());
        h[124..135].copy_from_slice(format!("{size:011o}").as_bytes());
        h[136..147].copy_from_slice(format!("{:011o}", 1_795_161_600u64).as_bytes());
        h[156] = kind;
        h[157..157 + link.len()].copy_from_slice(link.as_bytes());
        h[257..263].copy_from_slice(b"ustar\0");
        h[345..345 + prefix.len()].copy_from_slice(prefix.as_bytes());
        h
    }

    fn entry(path: &str, kind: u8, data: &[u8], link: &str) -> Vec<u8> {
        let mut out = header(path, kind, data.len() as u64, 0o644, link);
        out.extend_from_slice(data);
        out.resize(out.len().div_ceil(BLOCK) * BLOCK, 0);
        out
    }

    fn pax_entry(records: &[(&str, &str)], next: Vec<u8>) -> Vec<u8> {
        let mut body = Vec::new();
        for (k, v) in records {
            let base = format!(" {k}={v}\n");
            let mut len = base.len() + 1;
            if format!("{len}{base}").len() != len {
                len += 1;
            }
            body.extend_from_slice(format!("{len}{base}").as_bytes());
        }
        let mut out = entry("PaxHeaders/x", b'x', &body, "");
        out.extend(next);
        out
    }

    fn folder() -> Vec<u8> {
        let long = format!("media/{}/deep.txt", "d".repeat(120));
        let mut tar = Vec::new();
        tar.extend(entry("media/", b'5', b"", ""));
        tar.extend(entry("media/robots.txt", b'0', b"User-agent: *\n", ""));
        tar.extend(entry("media/invoices/", b'5', b"", ""));
        tar.extend(entry("media/invoices/2026.pdf", b'0', &[7u8; 1500], ""));
        tar.extend(entry("media/exports", b'2', b"", "/data/exports"));
        tar.extend(entry(&long, b'0', b"x", ""));
        let mut gnu = entry(
            "././@LongLink",
            b'L',
            format!("media/{}\0", "n".repeat(110)).as_bytes(),
            "",
        );
        gnu.extend(entry("media/nnn", b'0', b"abc", ""));
        tar.extend(gnu);
        tar.extend(pax_entry(
            &[("path", "media/ünïcode name.txt"), ("size", "5")],
            entry("media/short", b'0', b"hello", ""),
        ));
        tar.extend(vec![0u8; BLOCK * 2]);
        tar
    }

    fn read_all(tar: &[u8], step: usize, contents: bool) -> Vec<TarEvent> {
        let mut reader = TarReader::new(contents);
        let mut events = Vec::new();
        for piece in tar.chunks(step) {
            reader.push(piece, &mut |e| events.push(e));
        }
        events
    }

    #[test]
    fn headers_come_out_whatever_the_reads() {
        for step in [1, 7, 512, 513, 4096, 1 << 20] {
            let events = read_all(&folder(), step, false);
            let paths: Vec<String> = events
                .iter()
                .filter_map(|e| match e {
                    TarEvent::Entry(entry) => Some(entry.path.clone()),
                    _ => None,
                })
                .collect();
            assert_eq!(paths.len(), 8, "step {step}: {paths:?}");
            assert_eq!(paths[5], format!("media/{}/deep.txt", "d".repeat(120)));
            assert_eq!(paths[6], format!("media/{}", "n".repeat(110)));
            assert_eq!(paths[7], "media/ünïcode name.txt");
            assert_eq!(events.last(), Some(&TarEvent::End));
        }
    }

    #[test]
    fn a_listing_keeps_the_direct_entries_folders_first() {
        let mut listing = Listing::new("media");
        for event in read_all(&folder(), 1000, false) {
            if let TarEvent::Entry(e) = event {
                listing.take(e);
            }
        }
        let (entries, truncated) = listing.sorted();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names[0], "invoices");
        assert!(names.contains(&"robots.txt"));
        assert!(names.contains(&"ünïcode name.txt"));
        assert!(!names.iter().any(|n| n.contains('/')), "{names:?}");
        // The deep file and the invoice are a level down.
        assert_eq!(entries.len(), 5, "{names:?}");
        let link = entries.iter().find(|e| e.name == "exports").unwrap();
        assert_eq!(link.kind, FileKind::Symlink);
        assert_eq!(link.link_target.as_deref(), Some("/data/exports"));
        let robots = entries.iter().find(|e| e.name == "robots.txt").unwrap();
        assert_eq!(
            (robots.size, robots.mode, robots.mtime_ms),
            (14, 0o644, 1_795_161_600_000)
        );
        assert_eq!(truncated, None);
    }

    #[test]
    fn the_roots_entries_have_no_prefix_and_a_full_listing_stops() {
        assert_eq!(relative("", "bin/"), Some("bin"));
        assert_eq!(relative("", "./etc/hosts"), Some("etc/hosts"));
        assert_eq!(relative("media", "media/"), None);
        assert_eq!(relative("media", "mediax/a"), None);
        let mut listing = Listing::new("/");
        let mut taken = 0;
        for i in 0..=MAX_ENTRIES {
            let ok = listing.take(TarEntry {
                path: format!("f{i}"),
                kind: FileKind::File,
                size: 1,
                mode: 0o644,
                mtime: 0,
                link: None,
            });
            if ok {
                taken += 1;
            }
        }
        assert_eq!(taken, MAX_ENTRIES);
        assert_eq!(listing.sorted().1, Some(Truncated::Entries));
    }

    #[test]
    fn contents_come_when_asked_and_sizes_read_base_256() {
        let tar = entry("robots.txt", b'0', b"User-agent: *\n", "");
        let data: Vec<u8> = read_all(&tar, 3, true)
            .into_iter()
            .filter_map(|e| match e {
                TarEvent::Data(d) => Some(d),
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(data, b"User-agent: *\n");
        let mut field = [0u8; 12];
        field[0] = 0x80;
        field[11] = 2;
        field[10] = 1;
        assert_eq!(number(&field), 258);
        assert_eq!(number(b"0000644\0"), 0o644);
    }

    #[test]
    fn paths_and_the_stat_header() {
        assert!(container_path("path", "etc").is_err());
        assert!(container_path("path", "/a\0b").is_err());
        assert_eq!(
            archive_path("web", "/app/my media"),
            "/containers/web/archive?path=%2Fapp%2Fmy+media"
        );
        let stat = base64::engine::general_purpose::STANDARD.encode(
            r#"{"name":"media","size":4096,"mode":2147484141,"mtime":"2026-11-18T09:40:00Z","linkTarget":""}"#,
        );
        assert_eq!(
            path_stat(&stat),
            Some(PathStat {
                name: "media".into(),
                kind: FileKind::Dir,
                size: 4096,
                link_target: None
            })
        );
        let link = base64::engine::general_purpose::STANDARD.encode(
            r#"{"name":"exports","size":13,"mode":134218239,"linkTarget":"/data/exports"}"#,
        );
        assert_eq!(path_stat(&link).unwrap().kind, FileKind::Symlink);
    }
}
