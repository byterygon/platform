# DBee 0.1.0

The first usable version of DBee, Byterygon's keyboard-first PostgreSQL client for engineers on
air-gapped and self-hosted networks. This release is the **desktop app only**. The installers are
**not signed** yet; read [INSTALL.md](INSTALL.md) before you open one.

## What you can do

- **Connect.** Personal connections to PostgreSQL. Creating a connection is the approval of its
  grant: you see the exact host, port, resolved addresses, TLS policy and expiry before anything
  connects. Passwords live in the operating system's keychain (or are asked per session when there
  is none). No "accept any certificate", no fallback to plaintext.
- **Browse.** Schemas, tables, views and columns, loaded lazily.
- **Run SQL.** A Monaco editor per tab (offline), one database session per tab, autocommit.
  `Ctrl+Enter` runs the selection or the statement under the cursor, `Shift+Escape` cancels and the
  cancel reaches the database. Destructive statements are confirmed first. Errors show the
  position and SQLSTATE.
- **Read results.** A virtualized grid over Arrow buffers: rows appear as they arrive, a million
  rows scroll, `NULL` differs from the empty string, 64-bit integers keep their precision. Select,
  copy as TSV, CSV or JSON, open a cell value.
- **Export.** CSV, TSV or JSON Lines to a file chosen in the native dialog.
- **Keep your place.** Query tabs, pane sizes and settings come back after a restart.
- **Themes.** Six presets, light or dark following the OS, compact density by default.
- **Audit.** A local hash-chained audit log of every call.

## Offline by design

Nothing is fetched at install time or at run time: no updater, no telemetry, no network listener,
a strict content security policy, and the web view only talks to the app's own core. The Windows
installer carries the WebView2 runtime; the Linux packages use the system WebKitGTK; macOS uses
WKWebView.

## Known limits

- Installers are unsigned (Windows SmartScreen, macOS Gatekeeper). See INSTALL.md.
- The Windows 11 Mica window material is **off by default** until it has been checked on Windows 11;
  turn it on in Settings, then restart.
- PostgreSQL only. Out of scope for 0.1: team mode, web login, agents, other databases, scripts,
  transaction mode, query history, autocomplete from the live schema, editing data in the grid.
- The self-hosted web server is built and tested but is not packaged in this release.

## Files

| Platform | File |
| --- | --- |
| Windows (x64) | `DBee_0.1.0_x64-setup.exe` (NSIS, per-user, includes WebView2) |
| macOS (Apple silicon) | `DBee_0.1.0_aarch64.dmg` |
| macOS (Intel) | `DBee_0.1.0_x64.dmg` |
| Linux (x64) | `DBee_0.1.0_amd64.AppImage`, `DBee_0.1.0_amd64.deb` |

`SHA256SUMS` lists the checksum of each file. The licence (AGPL-3.0-only) and
`THIRD-PARTY-NOTICES.txt` (Rust and npm dependencies, vendored fonts and icons) are installed with
the app and attached to this release.
