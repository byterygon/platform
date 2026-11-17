## The base (TSK-79)

- One server, `mightyconsole-server`, with the web UI built in, on `https://localhost:7443` (127.0.0.1
  only by default) over TLS with a self-signed certificate made on first start, or your own.
- The Fluent 2 shell shared with DBee: a tool rail, connections per tool, tabs restored after a
  reload, a command bar, a status bar, the command palette, Settings and About.
- Connection profiles in the browser (IndexedDB), with export and import as a file.
- No login in this version: keep it on your own machine (see README).
