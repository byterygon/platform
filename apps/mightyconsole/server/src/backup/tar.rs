//! The few parts of POSIX ustar (IEEE 1003.1-1988) a backup needs: regular files with short
//! relative names, written and read back. The reader accepts only regular files whose names the
//! caller allows, so a hostile archive cannot write outside the directory it is unpacked into
//! (no `..`, no absolute path, no link, no device).

use std::io::{self, Read, Write};

const BLOCK: usize = 512;

fn octal(field: &mut [u8], value: u64) {
    // `len - 1` octal digits, then NUL.
    let digits = field.len() - 1;
    let text = format!("{value:0digits$o}");
    field[..digits].copy_from_slice(&text.as_bytes()[text.len() - digits..]);
    field[digits] = 0;
}

fn header(name: &str, size: u64, mtime: u64, mode: u32) -> io::Result<[u8; BLOCK]> {
    if name.len() > 100 || name.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("tar: name {name:?} does not fit"),
        ));
    }
    let mut h = [0u8; BLOCK];
    h[..name.len()].copy_from_slice(name.as_bytes());
    octal(&mut h[100..108], u64::from(mode));
    octal(&mut h[108..116], 0);
    octal(&mut h[116..124], 0);
    octal(&mut h[124..136], size);
    octal(&mut h[136..148], mtime);
    h[148..156].fill(b' ');
    h[156] = b'0';
    h[257..263].copy_from_slice(b"ustar\0");
    h[263..265].copy_from_slice(b"00");
    let sum: u64 = h.iter().map(|&b| u64::from(b)).sum();
    let text = format!("{sum:06o}\0 ");
    h[148..156].copy_from_slice(text.as_bytes());
    Ok(h)
}

/// Writes entries to `out`.
pub struct Writer<W: Write> {
    out: W,
}

impl<W: Write> Writer<W> {
    pub fn new(out: W) -> Writer<W> {
        Writer { out }
    }

    /// One regular file of `size` bytes read from `data` (exactly `size` are read).
    pub fn file(
        &mut self,
        name: &str,
        size: u64,
        mtime: u64,
        mut data: impl Read,
    ) -> io::Result<()> {
        self.out.write_all(&header(name, size, mtime, 0o600)?)?;
        let copied = io::copy(&mut (&mut data).take(size), &mut self.out)?;
        if copied != size {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                format!("tar: {name} ended after {copied} of {size} bytes"),
            ));
        }
        let pad = (BLOCK - (size as usize % BLOCK)) % BLOCK;
        self.out.write_all(&vec![0u8; pad])?;
        Ok(())
    }

    /// The two zero blocks that end an archive; returns the writer.
    pub fn finish(mut self) -> io::Result<W> {
        self.out.write_all(&[0u8; 2 * BLOCK])?;
        Ok(self.out)
    }
}

fn parse_octal(field: &[u8]) -> Option<u64> {
    let text = std::str::from_utf8(field).ok()?;
    let text = text.trim_matches(|c: char| c == '\0' || c == ' ');
    if text.is_empty() {
        return Some(0);
    }
    u64::from_str_radix(text, 8).ok()
}

fn bad(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

/// Reads every entry of `input`, calling `entry(name, size, reader)` for each regular file.
/// `allowed(name)` must accept every name, and `limit` bounds each file's size; anything else
/// (a link, a directory, a device, a long-name extension, a bad checksum) is refused.
pub fn read_all(
    mut input: impl Read,
    allowed: impl Fn(&str) -> bool,
    limit: u64,
    mut entry: impl FnMut(&str, u64, &mut dyn Read) -> io::Result<()>,
) -> io::Result<()> {
    let mut block = [0u8; BLOCK];
    loop {
        input.read_exact(&mut block)?;
        if block.iter().all(|&b| b == 0) {
            return Ok(());
        }
        let stored = parse_octal(&block[148..156]).ok_or_else(|| bad("tar: bad checksum field"))?;
        let mut copy = block;
        copy[148..156].fill(b' ');
        let sum: u64 = copy.iter().map(|&b| u64::from(b)).sum();
        if sum != stored {
            return Err(bad("tar: a header's checksum does not match"));
        }
        let end = block[..100].iter().position(|&b| b == 0).unwrap_or(100);
        let name =
            std::str::from_utf8(&block[..end]).map_err(|_| bad("tar: a name is not UTF-8"))?;
        if block[345] != 0 {
            return Err(bad(format!("tar: {name}: a prefixed name is not expected")));
        }
        let kind = block[156];
        if kind != b'0' && kind != 0 {
            return Err(bad(format!(
                "tar: {name}: only regular files are expected (type {:?})",
                kind as char
            )));
        }
        if !allowed(name) {
            return Err(bad(format!("tar: {name:?} is not a file a backup holds")));
        }
        let size = parse_octal(&block[124..136]).ok_or_else(|| bad("tar: bad size field"))?;
        if size > limit {
            return Err(bad(format!("tar: {name} is larger than {limit} bytes")));
        }
        let mut body = (&mut input).take(size);
        entry(name, size, &mut body)?;
        // Whatever the callback left unread, then the padding.
        io::copy(&mut body, &mut io::sink())?;
        let pad = (BLOCK - (size as usize % BLOCK)) % BLOCK;
        io::copy(&mut (&mut input).take(pad as u64), &mut io::sink())?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = Writer::new(Vec::new());
        for (name, data) in files {
            w.file(name, data.len() as u64, 1_700_000_000, *data)
                .unwrap();
        }
        w.finish().unwrap()
    }

    #[test]
    fn files_round_trip() {
        let big = vec![7u8; 1500];
        let bytes = archive(&[
            ("store.redb", b"abc"),
            ("audit/a.jsonl", &big),
            ("empty", b""),
        ]);
        assert_eq!(bytes.len() % BLOCK, 0);
        let mut seen = Vec::new();
        read_all(
            &bytes[..],
            |_| true,
            1 << 20,
            |name, size, r| {
                let mut data = Vec::new();
                r.read_to_end(&mut data)?;
                assert_eq!(data.len() as u64, size);
                seen.push((name.to_owned(), data));
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(seen[0], ("store.redb".to_owned(), b"abc".to_vec()));
        assert_eq!(seen[1].1, big);
        assert_eq!(seen[2].1, b"");
    }

    #[test]
    fn the_system_tar_reads_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.tar");
        std::fs::write(&path, archive(&[("store.redb", b"hello")])).unwrap();
        let Ok(out) = std::process::Command::new("tar")
            .arg("-tvf")
            .arg(&path)
            .output()
        else {
            return; // no tar on this machine
        };
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(String::from_utf8_lossy(&out.stdout).contains("store.redb"));
    }

    #[test]
    fn names_not_allowed_links_and_bad_checksums_are_refused() {
        let bytes = archive(&[("../etc/passwd", b"x")]);
        let e = read_all(&bytes[..], |n| n == "store.redb", 10, |_, _, _| Ok(())).unwrap_err();
        assert!(e.to_string().contains("not a file a backup holds"), "{e}");

        let mut link = archive(&[("store.redb", b"x")]);
        link[156] = b'2';
        // Fix the checksum so only the type is wrong.
        link[148..156].fill(b' ');
        let sum: u64 = link[..BLOCK].iter().map(|&b| u64::from(b)).sum();
        link[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
        let e = read_all(&link[..], |_| true, 10, |_, _, _| Ok(())).unwrap_err();
        assert!(e.to_string().contains("only regular files"), "{e}");

        let mut tampered = archive(&[("store.redb", b"x")]);
        tampered[0] = b'S';
        let e = read_all(&tampered[..], |_| true, 10, |_, _, _| Ok(())).unwrap_err();
        assert!(e.to_string().contains("checksum"), "{e}");

        let bytes = archive(&[("store.redb", b"0123456789A")]);
        let e = read_all(&bytes[..], |_| true, 10, |_, _, _| Ok(())).unwrap_err();
        assert!(e.to_string().contains("larger than 10"), "{e}");
    }
}
