# Mightyconsole

One offline web console for NATS, Kafka with Schema Registry, Kubernetes, Temporal, Docker over
SSH and LangGraph. `RELEASE-NOTES.md` says which tools this build has. Licence: AGPL-3.0-only
(`LICENSE`); the parts it contains are listed in `THIRD-PARTY-NOTICES.txt`. Source:
https://github.com/byterygon/platform (`apps/mightyconsole`).

> **Keep it on your own machine.** This version has **no login**. Anyone who can reach its port
> can use every connection you open through it. Leave it on `127.0.0.1` (the default) and never
> expose it on a shared network, a VPN or the internet.

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

```sh
docker load -i mightyconsole-<version>-image-linux-amd64.tar.gz      # or -arm64
docker run -d --name mightyconsole -p 127.0.0.1:7443:7443 \
  -v mightyconsole-data:/data byterygon/mightyconsole:<version>
```

Always publish the port on `127.0.0.1` as above. Inside the container the server listens on all
of the container's addresses, so it prints its exposure warning; the `-p 127.0.0.1:…` mapping is
what keeps it on your machine. Keep host port 7443: the page must be opened at the origin the
server expects (`https://localhost:7443`). Other options go after the image name, starting with
`serve --listen 0.0.0.0:7443`, for example
`… byterygon/mightyconsole:<version> serve --listen 0.0.0.0:7443 --tls-cert /data/cert.pem --tls-key /data/key.pem`.
The image is not on any registry: it is the file in this release.

## Open it

Open **https://localhost:7443/**. On its first start the server makes a self-signed certificate for
`localhost`, `127.0.0.1` and `::1`, keeps it in its data directory and prints its SHA-256
fingerprint. The browser warns once: compare the fingerprint it shows with the printed one, then
accept or trust the certificate. To avoid the warning, give your own certificate, for example from
`mkcert localhost 127.0.0.1 ::1`:

```sh
./mightyconsole-server --tls-cert localhost+2.pem --tls-key localhost+2-key.pem
```

## Where things live

- **Connection profiles, including their passwords and keys, live in your browser** (IndexedDB of
  `https://localhost:7443`), not on the server. Each browser, browser profile and origin has its
  own: another port or host name starts empty, and clearing the site's data deletes them. Back
  them up with **Settings > Export all profiles** and restore them with **Import profiles**
  (secrets are left out of an export unless you tick the box).
- **The server keeps only its certificate**, in its data directory: `$MIGHTYCONSOLE_DATA` if set,
  else `~/.local/share/mightyconsole` (Linux), `~/Library/Application Support/mightyconsole`
  (macOS), `%APPDATA%\mightyconsole` (Windows), or the `/data` volume in the container.
  `--data DIR` chooses another one.
- Live connections are held in the server's memory for the browser tab that opened them and are
  released when the tab closes, on Disconnect, or after 10 minutes without use.

## Stop it

Press Ctrl+C (or `docker stop mightyconsole`). Nothing needs to be cleaned up.
