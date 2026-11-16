# Fonts

Inter (interface) and JetBrains Mono (code), vendored so that nothing is loaded from the network.
Both are licensed under the SIL Open Font License 1.1, which allows use, bundling and
redistribution with software; the licence texts are in each family's folder and must stay with the
files. The package's own code is MIT OR Apache-2.0; these files are not.

- `fonts.css` declares the `@font-face` rules. It is hand-written and the same for every theme, so
  it is not one of the generated outputs.
- `manifest.json` lists each family, its version, licence, source and the sha256 of every file.
  `node scripts/check-licenses.mjs` fails when a licence file or a font file is missing, a checksum
  differs, or a font file is not listed.
- `font.sans` names the system's Segoe UI Variable first ("Segoe UI Variable Text", "Segoe UI
  Variable", "Segoe UI"), then Inter. Segoe UI is never shipped: Microsoft's licence does not allow
  redistributing it, so Windows 11 uses its own copy and every other system gets Inter. Selawik,
  Microsoft's open Segoe fallback, was vendored first and removed (TSK-58): it lacks most Vietnamese
  letters.
- `font.mono` names the system's Cascadia Mono first, then JetBrains Mono. Cascadia is OFL too, so
  vendoring it would be allowed; it is not vendored because JetBrains Mono already gives every
  platform a code font offline.
- Both roles end in system fonts, so a project that does not load `fonts.css` still renders.

To update a font, download the release archive named in the manifest, compare its sha256 with the
publisher's, replace the files, and edit the manifest.
