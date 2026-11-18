# The Linux CI image (TSK-89): what the Rust and DBee desktop budget jobs of ci.yml used to
# install with apt on every run (WebKitGTK, PostgreSQL, Xvfb), plus the pinned Rust toolchain and
# a pinned Chrome for the browser checks. Built and pushed by .github/workflows/ci-image.yml when
# this folder changes; ci.yml uses it by digest.
#
# The jobs run in it as the `runner` user (uid 1001, the hosted runner's uid, so the workspace
# and tool cache mounted from the host stay writable) with passwordless sudo, so the network
# namespace steps (`sudo unshare --net` then `setpriv --reuid="$SUDO_UID"`) work as on the host,
# and PostgreSQL (which refuses root) starts as that user. See .github/ci-image/README.md.

# ubuntu:24.04, the multi-arch index digest (2026-11-18).
FROM ubuntu@sha256:73b999393d07f2bf65a40373778a44dc9a6d54ad7718d29247d8ff9413c4d6a8

ARG DEBIAN_FRONTEND=noninteractive

# Links the ghcr.io package to the repository (its access follows the repository's).
LABEL org.opencontainers.image.source=https://github.com/byterygon/platform \
      org.opencontainers.image.description="Byterygon platform CI image (Linux x64)" \
      org.opencontainers.image.licenses="MIT OR Apache-2.0"

# Build tools and what the actions need (git, zstd for actions/cache), the libraries Tauri links
# on Linux (WebKitGTK 4.1, GTK 3), PostgreSQL's server binaries (initdb/postgres for the driver,
# dbee-server and mightyconsole-server tests and the budget's database), Xvfb, sudo and iproute2
# for the network namespace steps, and the shared libraries Chrome needs.
RUN apt-get -o Acquire::Retries=3 update \
 && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
      ca-certificates curl git zstd xz-utils unzip tar gzip bzip2 jq openssl \
      build-essential pkg-config file \
      sudo iproute2 procps \
      libwebkit2gtk-4.1-dev \
      postgresql \
      xvfb xauth dbus-x11 \
      fonts-liberation fonts-dejavu-core libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 \
      libcups2t64 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libasound2t64 libpango-1.0-0 libcairo2 libxshmfence1 libvulkan1 \
 && rm -rf /var/lib/apt/lists/*

# The hosted runner's user: uid/gid 1001, passwordless sudo (the jobs call `sudo unshare`). sudo
# keeps RUSTUP_HOME and CARGO_HOME, so cargo inside the namespace finds the toolchain and the
# registry the earlier steps filled (on the host they sit under HOME, which the steps pass).
RUN groupadd --gid 1001 runner \
 && useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash runner \
 && printf 'runner ALL=(ALL) NOPASSWD:ALL\nDefaults env_keep += "RUSTUP_HOME CARGO_HOME"\n' > /etc/sudoers.d/runner \
 && chmod 0440 /etc/sudoers.d/runner \
 && visudo -c
# Docker sets no USER or LOGNAME for `--user 1001`; the desktop app names its local principal
# from them (ambidex-tauri LocalIdentity::from_env) and refuses to start without one.
ENV USER=runner \
    LOGNAME=runner

# Chrome for Testing, pinned by version and SHA-256 (computed on download; Google publishes no
# checksum). The browser checks find it on PATH as google-chrome; they pass --no-sandbox on Linux.
ARG CHROME_VERSION=158.0.8127.36
ARG CHROME_SHA256=dba9cc838e1ce269c33ea68170881127bd15d078fc3ca5891c90802819a4d7c7
RUN curl -sSfL --retry 3 -o /tmp/chrome.zip \
      "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-linux64.zip" \
 && echo "${CHROME_SHA256}  /tmp/chrome.zip" | sha256sum -c - \
 && unzip -q /tmp/chrome.zip -d /opt \
 && rm /tmp/chrome.zip \
 && ln -s /opt/chrome-linux64/chrome /usr/local/bin/google-chrome \
 && google-chrome --version

# Rust: rustup and the toolchain of rust-toolchain.toml (keep RUST_TOOLCHAIN in step with it; a
# job whose toolchain is missing still installs it, only slower). CARGO_HOME and RUSTUP_HOME are
# owned by runner so cargo's registry and rust-cache restore into them.
ARG RUSTUP_VERSION=1.29.3
ARG RUSTUP_SHA256=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55
ARG RUST_TOOLCHAIN=1.99.1
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN mkdir -p "$RUSTUP_HOME" "$CARGO_HOME" && chown runner:runner "$RUSTUP_HOME" "$CARGO_HOME"
USER runner
RUN curl -sSfL --retry 3 -o /tmp/rustup-init \
      "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" \
 && echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum -c - \
 && chmod +x /tmp/rustup-init \
 && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_TOOLCHAIN}" -c rustfmt -c clippy \
 && rm /tmp/rustup-init \
 && rustc --version && cargo --version
USER root
