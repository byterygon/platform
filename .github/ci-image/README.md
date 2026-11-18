# CI image (`ghcr.io/byterygon/ci-linux`)

The Linux x64 image that ci.yml's **Rust** and **DBee desktop budget** jobs run in (TSK-89).
Before it, both jobs ran `apt-get install libwebkit2gtk-4.1-dev postgresql xvfb` on every run:
45 s at the median, but 24 of 59 measured installs took 5 minutes or more (up to 20).

What it holds (`Dockerfile`):

- Ubuntu 24.04, pinned by digest; build tools, git, zstd (actions/cache);
- WebKitGTK 4.1 and GTK 3 development files (Tauri on Linux), PostgreSQL's server binaries,
  Xvfb and xauth;
- Chrome for Testing, pinned by version and SHA-256, on PATH as `google-chrome` (the
  `check:browser` steps; they pass `--no-sandbox` on Linux);
- rustup (pinned, SHA-256) and the toolchain of `rust-toolchain.toml` with rustfmt and clippy,
  in `/usr/local/rustup` and `/usr/local/cargo` (`RUSTUP_HOME`, `CARGO_HOME`);
- a `runner` user, uid/gid 1001 like the hosted runner's, with passwordless sudo that keeps
  `RUSTUP_HOME` and `CARGO_HOME`.

## How ci.yml runs it

```yaml
container:
  image: ghcr.io/byterygon/ci-linux@sha256:...   # always by digest
  options: --user 1001 --cap-add SYS_ADMIN --cap-add NET_ADMIN --shm-size 2g
```

- `--user 1001`: the steps run as the runner's uid, so the workspace and tool cache mounted from
  the host stay writable and PostgreSQL (which refuses root) starts. `sudo` gives root where the
  steps already used it.
- `--cap-add SYS_ADMIN`: `unshare --net` (a new network namespace) inside the container.
- `--cap-add NET_ADMIN`: `ip link set lo up` inside that namespace.
- `--shm-size 2g`: Chrome and WebKitGTK share memory through `/dev/shm` (Docker's default is 64 MB).

Nothing else is granted (no `--privileged`). The network namespace steps are written exactly as
on the host: `sudo unshare --net`, then `setpriv --reuid="$SUDO_UID"` back to the runner user.

The image also sets `USER` and `LOGNAME` to `runner`: Docker sets neither for `--user 1001`, and
the desktop app names its local principal from them.

**WebKitGTK's sandbox is off in a container.** WebKitGTK (2.52) sees it runs inside Docker and
starts its web and network processes without bubblewrap (checked: no `bwrap` process while
dbee-desktop runs in the image). Directly on the hosted runner WebKit can use it (whether it did
was not checked). So the cold start (Rust job) and the budget (DBee desktop budget job) measure
the app without WebKit's sandbox; what they check (the app starts, loads the UI, runs the acceptance steps) is
unchanged.

## Changing it

1. Edit the `Dockerfile` (keep `RUST_TOOLCHAIN` in step with `rust-toolchain.toml`; a job whose
   toolchain is missing installs it, only slower). Bump a pin by downloading the file and
   computing its SHA-256 (`sha256sum`); for the base image, `docker pull ubuntu:24.04` and
   `docker inspect --format '{{index .RepoDigests 0}}' ubuntu:24.04`.
2. Try it locally:
   ```sh
   docker build -t ci-linux:local .github/ci-image
   docker run --rm --user 1001 --cap-add SYS_ADMIN --cap-add NET_ADMIN --shm-size 2g \
     -v "$PWD/.github/ci-image/verify.sh:/verify.sh:ro" ci-linux:local sh /verify.sh
   ```
3. The pull request runs `.github/workflows/ci-image.yml`: it builds the image and runs
   `verify.sh` in it. After the merge, the workflow's publish job on main builds, verifies and
   pushes `ghcr.io/byterygon/ci-linux:<commit>`; its summary prints the digest.
4. A second pull request pins that digest in ci.yml (both jobs), so CI runs on the new image.
