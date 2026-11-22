# Generated files and their drift tests

Moved from the repository's CLAUDE.md (TSK-126), unchanged. CLAUDE.md points here.

Codegen (spec §2, TSK-7): `#[rpc::router]` attaches ts-rs and schemars types to every procedure;
`ambidex::codegen` turns a `Router` into `api.ts` and `api.manifest.json` (with the schema hash the
server puts in `ServerConfig`) and fails if ts-rs and schemars disagree. Procedure input/output
types therefore derive `TS` and `JsonSchema`. Inputs are checked as serde reads them, outputs as
it writes them: `#[serde(default)]` fields need `#[ts(optional = nullable)]` (clients may omit
them), `skip_serializing_if` fields `#[ts(optional)]` (the server may leave them out). The fixture
API's generated files live in `packages/ambidex/test/conformance/` and are committed; CI fails
when they are stale.

Design tokens (TSK-40, TSK-41): `packages/design-tokens/generated/<theme>/` is generated from
`themes/<theme>.theme.json` and committed (all eight files for `default`, the three CSS files for the other
presets); its drift test fails when any is stale. Regenerate with
`pnpm --filter @byterygon/design-tokens build && pnpm --filter @byterygon/design-tokens tokens build --theme <name>`
(`default` when omitted). `scripts/check-licenses.mjs` also checks the vendored fonts' licences and checksums.

Byterygon UI (TSK-42): `packages/ui/registry/` is generated from the components and the token
presets and committed; its drift test fails when stale (`pnpm --filter @byterygon/ui registry`
rewrites it, so rerun it after changing tokens too). `pnpm ui:new <name>` scaffolds a component;
`pnpm --filter @byterygon/ui verify:install` installs the registry with the real shadcn CLI into a
blank Vite app, offline (CI runs it in the network namespace).

DBee UI (TSK-38): `apps/dbee/ui` is a nested pnpm workspace package (`pnpm-workspace.yaml` lists it).
Its Byterygon UI items are copies of registry items (`src/components/ui`, `src/lib`), rewritten by
`pnpm --filter @byterygon/dbee sync:ui` and checked by its tests; rerun it after changing
`packages/ui`. The Rust CI job builds the UI first so `dbee-desktop` embeds it; a Rust-only build
without `apps/dbee/ui/dist` falls back to the placeholder page (build.rs warns).
