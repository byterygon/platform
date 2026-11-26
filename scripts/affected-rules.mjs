// The hand-kept part of scripts/affected.mjs (TSK-89): what the two dependency graphs do not
// show. The graphs themselves come from the workspace (package.json files for pnpm, Cargo.lock
// and the members' Cargo.toml for Cargo); this file only adds the edges between them and the
// files that belong to no package or crate. Keep it short, and when in doubt run everything.
//
// Patterns are repository-relative globs: `*` within one path segment, `**` across segments.

/** Changing one of these runs everything: CI itself, the toolchains, workspace-wide config. */
export const RUN_ALL = [
  ".github/**",
  "rust-toolchain.toml",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  ".gitattributes",
  ".npmrc",
  ".cargo/**",
  "scripts/affected.mjs",
  "scripts/affected-rules.mjs",
  "scripts/affected/**",
];

/**
 * Changing one of these affects every Rust crate (workspace dependencies, lints, profiles), but no
 * JS package (Cargo.lock is diffed precisely instead).
 */
export const ALL_RUST = ["Cargo.toml"];

/**
 * The JS-Rust edges and other files read across package boundaries. `files` (globs) or a `crate`
 * or `package` on the left; what it affects on the right.
 */
export const EDGES = [
  // dbee-desktop embeds the built UI (apps/dbee/ui/dist, build.rs); the Linux jobs build it first.
  { package: "@byterygon/dbee", affects: { crates: ["dbee-desktop"] } },
  // mightyconsole-server embeds its built UI (build.rs, static_ui.rs) and the Rust job runs the UI
  // against the real server in Chrome.
  { package: "@byterygon/mightyconsole", affects: { crates: ["mightyconsole-server"] } },
  // rpc-gen outputs, committed in the UI packages and drift-checked by the Rust tests.
  { files: ["apps/dbee/ui/src/gen/**"], affects: { crates: ["dbee-core"] } },
  { files: ["apps/mightyconsole/ui/src/gen/**"], affects: { crates: ["mightyconsole-server"] } },
  { files: ["packages/ambidex/test/conformance/**"], affects: { crates: ["ambidex-conformance"] } },
  { files: ["packages/ambidex/bench/generated/**"], affects: { crates: ["ambidex-bench"] } },
  // The TypeScript runtime's integration tests run against the Rust conformance server.
  { crate: "ambidex-conformance", affects: { packages: ["@byterygon/ambidex"] } },
  // The Mightyconsole UI package's tests read the lab, the acceptance harness and the release notes.
  { files: ["apps/mightyconsole/lab/**", "apps/mightyconsole/acceptance/**", "apps/mightyconsole/release/**"], affects: { packages: ["@byterygon/mightyconsole"] } },
  // The DBee desktop budget drives the release build through apps/dbee/acceptance.
  { files: ["apps/dbee/acceptance/**"], affects: { targets: ["dbee-budget"] } },
];

/**
 * Mightyconsole lab (TSK-89, batch 3): the files that belong to one tool's lab profile. `<tool>`
 * stands for each tool of apps/mightyconsole/lab/lab.mts's TOOLS. Any other change that affects
 * Mightyconsole (the shell, the server core, packages/ui, the lockfiles, ...) brings up every
 * tool, as do pushes and the weekly run.
 */
export const LAB_TOOL_FILES = [
  "apps/mightyconsole/ui/src/tools/<tool>/**",
  "apps/mightyconsole/server/src/tools/<tool>/**",
  "apps/mightyconsole/lab/<tool>/**",
  "apps/mightyconsole/acceptance/checklists/<tool>.mts",
  // TSK-124: a tool's further checklists (temporal-more, temporal-detail) and server tests.
  "apps/mightyconsole/acceptance/checklists/<tool>-*.mts",
  "apps/mightyconsole/server/tests/<tool>.rs",
  "apps/mightyconsole/server/tests/<tool>_*.rs",
  "apps/mightyconsole/ui/test/<tool>.test.ts",
  "apps/mightyconsole/ui/test/<tool>.test.tsx",
  "apps/mightyconsole/ui/test/<tool>-*.test.ts",
  "apps/mightyconsole/ui/test/<tool>-*.test.tsx",
];
/**
 * TSK-124: files that change along with any tool's procedures or checklists and say nothing of
 * their own about which tools a change needs: the generated API (written by rpc-gen from the
 * server's routes), its drift test and the test that every checklist name still exists. They do
 * not bring up every tool when they come with a tool's own files; alone, they still do.
 */
export const LAB_NEUTRAL_FILES = [
  "apps/mightyconsole/ui/src/gen/**",
  "apps/mightyconsole/server/tests/codegen.rs",
  "apps/mightyconsole/ui/test/acceptance.test.ts",
];
/** Lab folders named after something other than their tool. */
export const LAB_TOOL_EXTRA = [
  { files: ["apps/mightyconsole/lab/docker-host/**"], tool: "docker" },
  { files: ["apps/mightyconsole/lab/schemas/**"], tool: "kafka" },
  // TSK-115: the crate whose lab tests run against the routes profile.
  { files: ["crates/net-route/**"], tool: "routes" },
];

/**
 * Files that need none of the conditional jobs (the License policy and Secret scan jobs always
 * run). Markdown is documentation unless an edge above lists it.
 */
export const NO_TARGETS = [
  "**/*.md",
  "LICENSE-*",
  "apps/*/LICENSE",
  ".gitignore",
  "**/.gitignore",
  ".mcp.json",
  ".claude/**",
  "deny.toml",
  "scripts/check-licenses.mjs",
  "scripts/third-party-notices.mjs",
  "scripts/ci-measure.mjs",
  // Runs in the Affected job on every pull request.
  "scripts/affected.test.mjs",
  // TSK-128: runs on a developer's machine; its tests run in the Affected job.
  "scripts/pre-pr.mjs",
  "scripts/pre-pr.test.mjs",
  // TSK-129: read by the lab workflows (a change to them runs the lab on main); tested in Affected.
  "scripts/lab-labels.mjs",
  "scripts/lab-labels.test.mjs",
];
