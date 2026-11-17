// TSK-87, packaging (Mightyconsole spec section 18): the release binary with the UI built in, the
// container image, and what ships with them. The Mightyconsole release workflow does the same on
// every platform; this checklist repeats it on the machine it runs on.
import { type Checklist, command, manual, vitest } from "../checklist.mts";

const RELEASE = "apps/mightyconsole/release/release.mts";
const BINARY = "target/release/mightyconsole-server";
const MUSL = "target/x86_64-unknown-linux-musl/release/mightyconsole-server";

export default {
  id: "packaging",
  task: "TSK-87",
  title: "Packaging",
  builtWhen: "apps/mightyconsole/release/release.mts",
  lab: [],
  items: [
    {
      id: "artifacts",
      text: "A single binary with the UI embedded for Linux, macOS and Windows and a container image (publishing to 127.0.0.1 in its example), both working offline; checksums; the AGPL text; third-party notices for Rust and npm dependencies; a README (start, open, trust the certificate, where profiles live, never expose it on a shared network).",
      checks: [
        vitest("test/release.test.ts"),
        command("release notes and version", ["node", RELEASE, "check"]),
        command("the UI build", ["pnpm", "--filter", "@byterygon/mightyconsole", "build"]),
        command("release binary with the UI built in", ["cargo", "build", "-p", "mightyconsole-server", "--release", "--locked", "--features", "embed-ui"]),
        command("the binary starts and serves its built-in UI", ["node", RELEASE, "smoke", "--binary", BINARY]),
        command("the release binary in Chrome: session, CSP, a live stream, nothing outside the server", ["node", "scripts/browser-check.ts"], {
          cwd: "apps/mightyconsole/ui",
          env: { MIGHTYCONSOLE_SERVER: `{repo}/${BINARY}`, MIGHTYCONSOLE_EMBEDDED_UI: "1", BYTERYGON_REQUIRE_BROWSER: "1" },
        }),
        command("third-party notices (Rust, npm, fonts, icons)", ["node", "scripts/third-party-notices.mjs", "--app", "mightyconsole", "--out", "{evidence}/THIRD-PARTY-NOTICES.txt"]),
        command("an archive with the licence, README, notices and notes, and its checksum", [
          "sh",
          "-c",
          `set -e
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) name=linux-x64 ;; Linux-aarch64) name=linux-arm64 ;;
  Darwin-arm64) name=macos-arm64 ;; Darwin-x86_64) name=macos-x64 ;;
  *) echo "no archive name for $(uname -s)-$(uname -m)"; exit 1 ;;
esac
node ${RELEASE} package --name "$name" --binary ${BINARY} --notices "$1/THIRD-PARTY-NOTICES.txt" --out "$1/release"
tar -tzf "$1"/release/*-"$name".tar.gz
node ${RELEASE} checksums "$1/release"`,
          "sh",
          "{evidence}",
        ], { requires: ["tar"] }),
        command("the static image: loads from its file, starts with no network, serves on 127.0.0.1", [
          "sh",
          "-c",
          `set -e
MIGHTYCONSOLE_VERSION=$(node ${RELEASE} version) CC_x86_64_unknown_linux_musl=musl-gcc cargo build -p mightyconsole-server --release --locked --features embed-ui --target x86_64-unknown-linux-musl
node ${RELEASE} image --arch amd64 --binary ${MUSL} --notices "$1/THIRD-PARTY-NOTICES.txt" --out "$1/release"
sh apps/mightyconsole/release/image-check.sh "$1/release/mightyconsole-$(node ${RELEASE} version)-image-linux-amd64.tar.gz" "$(node ${RELEASE} version)"`,
          "sh",
          "{evidence}",
        ], { requires: ["docker", "musl-gcc"] }),
        manual("the Mightyconsole release workflow run: five binaries and two images built and checked with no network (link the run)"),
      ],
    },
    {
      id: "evidence",
      text: "Every item above is checked on the test lab with evidence in the PR; nothing is published or tagged without Uy Son; CI green.",
      checks: [manual("the PR links this summary and the workflow run; no tag, no published release; CI green")],
    },
  ],
} satisfies Checklist;
