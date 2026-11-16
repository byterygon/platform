# Fonts

Selawik (interface), JetBrains Mono (code) and Inter, vendored so that nothing is loaded from the
network. All three are licensed under the SIL Open Font License 1.1, which allows use, bundling and
redistribution with software; the licence texts are in each family's folder and must stay with the
files. The package's own code is MIT OR Apache-2.0; these files are not.

- `fonts.css` declares the `@font-face` rules. It is hand-written and the same for every theme, so
  it is not one of the generated outputs.
- `manifest.json` lists each family, its version, licence, source and the sha256 of every file.
  `node scripts/check-licenses.mjs` fails when a licence file or a font file is missing, a checksum
  differs, or a font file is not listed.
- `font.sans` names the system's Segoe UI Variable first ("Segoe UI Variable Text", "Segoe UI
  Variable", "Segoe UI"), then Selawik. Segoe UI is never shipped: Microsoft's licence does not
  allow redistributing it, so Windows 11 uses its own copy and every other system gets Selawik,
  Microsoft's open, metric-compatible fallback. Selawik's files are Microsoft's woff2 as released,
  unmodified, because "Selawik" is a Reserved Font Name under the OFL (a modified version would
  need another name).
- `font.mono` names the system's Cascadia Mono first, then JetBrains Mono. Cascadia is OFL too, so
  vendoring it would be allowed; it is not vendored because JetBrains Mono already gives every
  platform a code font offline.
- Inter is no longer in `font.sans`; it stays for themes that name it.
- Both roles end in system fonts, so a project that does not load `fonts.css` still renders.

To update a font, download the release archive named in the manifest, compare its sha256 with the
publisher's, replace the files, and edit the manifest.
