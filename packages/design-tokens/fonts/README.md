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
- The roles `font.sans` and `font.mono` name these families first and fall back to system fonts,
  so a project that does not load `fonts.css` still renders.

To update a font, download the release archive named in the manifest, compare its sha256 with the
publisher's, replace the files, and edit the manifest.
