# Mightyconsole

One offline web console for NATS, Kafka with Schema Registry, Kubernetes, Temporal, Docker over
SSH and LangGraph. `RELEASE-NOTES.md` says which tools this build has. Licence: AGPL-3.0-only
(`LICENSE`); the parts it contains are listed in `THIRD-PARTY-NOTICES.txt`. Source:
https://github.com/byterygon/platform (`apps/mightyconsole`).

> **Everyone signs in.** The server has built-in accounts (anyone who reaches the sign-in page can
> make one unless `[auth] signup = "off"`) and, when configured, sign-in through your identity
> provider (OIDC). Roles are not in this version yet: **every signed-in person may do
> everything**. Keep it on `127.0.0.1` (the default) unless you trust everyone who can reach the
> port, and give it a real certificate (`--tls-cert`, `--tls-key`) before you expose it.

## Verify the download

```sh
sha256sum -c SHA256SUMS --ignore-missing          # macOS: shasum -a 256 -c SHA256SUMS
```

```powershell
(Get-FileHash .\mightyconsole-<version>-windows-x64.zip -Algorithm SHA256).Hash   # compare with SHA256SUMS
```

## Start it

The server is one file with the web UI built in. It needs nothing else and never downloads
anything: no update check, no telemetry, no fonts or scripts from a CDN. It only connects to the
systems your connection profiles name.

```sh
./mightyconsole-server                 # Linux, macOS
mightyconsole-server.exe               # Windows
./mightyconsole-server --help          # every option
```

The builds are not code-signed. macOS refuses an unsigned program downloaded from elsewhere: run
`xattr -d com.apple.quarantine mightyconsole-server` once (or allow it in System Settings >
Privacy & Security). Windows SmartScreen may warn: choose **More info**, then **Run anyway**.

### Or as a container

From GitHub Packages (linux/amd64 and linux/arm64 in one image):

```sh
docker pull ghcr.io/byterygon/mightyconsole:<version>      # e.g. 0.1.0-alpha.1; `alpha` floats, `latest` is 0.1.0 and later
docker run -d --name mightyconsole -p 127.0.0.1:7443:7443 \
  -v mightyconsole-data:/data ghcr.io/byterygon/mightyconsole:<version>
```

On a machine with no network, load the file from this release instead (or move the image with
`docker save ghcr.io/byterygon/mightyconsole:<version> | gzip > mightyconsole-image.tar.gz` on a
connected machine and `docker load -i mightyconsole-image.tar.gz` on the other one):

```sh
docker load -i mightyconsole-<version>-image-linux-amd64.tar.gz      # or -arm64
docker run -d --name mightyconsole -p 127.0.0.1:7443:7443 \
  -v mightyconsole-data:/data byterygon/mightyconsole:<version>
```

The published image carries a build provenance attestation:
`gh attestation verify oci://ghcr.io/byterygon/mightyconsole:<version> --repo byterygon/platform`.

Publish the port on `127.0.0.1` as above. Inside the container the server listens on all of the
container's addresses, so it warns that its certificate is self-signed; the `-p 127.0.0.1:…`
mapping is what keeps it on your machine. Keep host port 7443: the page must be opened at the
origin the server expects (`https://localhost:7443`). Other options go after the image name,
starting with `serve --listen 0.0.0.0:7443`, for example
`… byterygon/mightyconsole:<version> serve --listen 0.0.0.0:7443 --tls-cert /data/cert.pem --tls-key /data/key.pem`.
The image in the file and the one on ghcr.io are the same bytes.

## Open it

Open **https://localhost:7443/**. On its first start the server makes a self-signed certificate for
`localhost`, `127.0.0.1` and `::1`, keeps it in its data directory and prints its SHA-256
fingerprint. The browser warns once: compare the fingerprint it shows with the printed one, then
accept or trust the certificate. To avoid the warning, give your own certificate, for example from
`mkcert localhost 127.0.0.1 ::1`:

```sh
./mightyconsole-server --tls-cert localhost+2.pem --tls-key localhost+2-key.pem
```

## Sign in

- **The default administrator.** The first start makes the account `admin` with a generated
  password, written to `admin-password` in the data directory (readable by you only). The server
  prints where the file is, never the password. In a container the file is in the `/data` volume
  (the image has no shell, so no `cat`):

  ```sh
  docker cp mightyconsole:/data/admin-password -
  ```

  Sign in as `admin` with it. You must choose a new password first; the file is then deleted.
- **Your own account.** The sign-in page offers **Create an account** (`[auth] signup = "open"`,
  the default). Passwords have at least 12 characters and cannot be one of the most common ones.
  Five wrong passwords lock an account for 15 minutes.
- **Two-step sign-in (TOTP)** is optional per account; `[auth] require_totp = "admins"` or `"all"`
  asks for it at the next sign-in. Keep the recovery codes it shows you.
- **Lost the administrator's password?** On the server's machine (access to the data directory is
  the proof):

  ```sh
  ./mightyconsole-server reset-admin --print                       # or --data DIR
  docker exec mightyconsole /mightyconsole-server reset-admin --print
  ```

  It writes a new password to `admin-password` (`--print` also shows it), unlocks and enables the
  account, removes its TOTP and ends its sessions; the next sign-in must change the password. It
  works with the server running or stopped.
- Sign-in through your identity provider and the other settings: `mightyconsole-server --help`
  (`[auth]` and `[auth.oidc]` in `DATA/config.toml`).

## Where things live

- **Connection profiles, including their passwords and keys, live in your browser** (IndexedDB of
  `https://localhost:7443`), not on the server. Each browser, browser profile and origin has its
  own: another port or host name starts empty, and clearing the site's data deletes them. Back
  them up with **Settings > Export all profiles** and restore them with **Import profiles**
  (secrets are left out of an export unless you tick the box).
- **The server keeps its certificate, the accounts (`store.redb`) and the audit log** in its data
  directory: `$MIGHTYCONSOLE_DATA` if set, else `~/.local/share/mightyconsole` (Linux),
  `~/Library/Application Support/mightyconsole` (macOS), `%APPDATA%\mightyconsole` (Windows), or
  the `/data` volume in the container. `--data DIR` chooses another one. One server uses a data
  directory at a time.
- **The secret key.** Secrets the server stores are encrypted with a key that the first start
  generates in `keys/kek-<id>.key` in the data directory (the server prints where). **Losing
  every copy of the key loses those secrets.** A key beside the data protects copies of
  `store.redb` (backups) but not a compromise of the machine: move it to a separate mount (a
  container or Kubernetes secret, a tmpfs, removable media) and name it in `DATA/config.toml`:

  ```toml
  [[secrets.keys]]
  file = "/run/secrets/mightyconsole-kek"   # mode 0600, owned by the server's user
  ```

  `mightyconsole-server keys generate --out FILE` makes a new key file. A passphrase or a command
  (Vault, a KMS, an HSM) can provide the key instead: `mightyconsole-server --help`, SECRETS.
  The server does not start when a key does not load or a stored secret's key is missing.
  **To rotate the key**, add the new key as the first `[[secrets.keys]]`, keep the old one after
  it, and send the server `SIGHUP` (`kill -HUP <pid>`, `docker kill -s HUP mightyconsole`; on
  Windows, restart it): it switches to the new key without stopping and moves every stored
  secret to it in the background (`mightyconsole-server secrets status` with the server stopped,
  or `admin.secrets.status`, shows the progress). When no secret is left under the old key,
  remove it from the configuration.
- **Backups.** Offline: stop the server and copy the data directory without `keys/`; keep the
  keys (or the passphrase) somewhere else. Online: an administrator's `admin.backup.snapshot`
  writes `backups/backup-<utc>.tar` in the data directory (the store, the audit log and its
  checkpoint; never the keys); move it off the machine. To restore:
  `mightyconsole-server restore --data NEW_DIR [--check-secrets] backup-<utc>.tar`, then provide
  the keys and start the server on `NEW_DIR`. Without the keys the restored server does not start.
- Live connections are held in the server's memory for the browser tab that opened them and are
  released when the tab closes, on Disconnect, or after 10 minutes without use.

## Stop it

Press Ctrl+C (or `docker stop mightyconsole`). Nothing needs to be cleaned up.
