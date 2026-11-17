# @byterygon/ui-mcp

A local **stdio** MCP server for Byterygon UI (spec "Byterygon UI: design tokens, Theme Studio and
component set", section 9a.5). It lets a coding agent search and explain tokens, read component
manifests and examples, validate a theme, check class names, and list and install registry items.
No listener, no network, no hosted service: the client starts it and talks over stdin and stdout.

Every answer comes from the token engine, the registry or the lint analysis; the server computes
nothing of its own.

| Tool | What it returns |
| --- | --- |
| `search_tokens` `{ query, tier?, type?, limit?, theme? }` | the `by-tokens search --json` document |
| `explain_token` `{ token, theme? }` | the `by-tokens explain --json` document: use and avoid, values per mode, alias chain, references, contrast |
| `validate_theme` `{ theme? \| content?, contrast? }` | the `by-tokens validate --json` document; each diagnostic names token, mode, rule, measured and required value and a fix. `content` is a theme file's text (validated from a private temporary file, removed after) |
| `list_components` `{}` | every component: name, title, description, usage note, parts |
| `get_component` `{ name, includeSource? }` | the manifest (props with the Fluent names and deprecated aliases, variants, parts, slots, states, tokens, accessibility), the example file with imports at installed paths, dependencies, and the source on request |
| `list_registry_items` `{ type? }` | `registry.json`: components, helpers, themes |
| `install_registry_item` `{ project, items, dryRun?, overwrite? }` | writes the items and their registry dependencies into the project (below) |
| `check_classes` `{ classes, theme? }` | the `@byterygon/lint` findings for class names, each with the role to use |

Resources: `byterygon-ui://registry/llms.txt` and `byterygon-ui://registry/llms-full.txt`.
`theme` is a preset name (`default`, `classic`, `slate`, `paper`, `midnight`, `terminal`,
`high-contrast`) or a theme file path; relative paths are read from the server's working folder.
Results are JSON in a text content block; a tool error (`isError`) carries
`{ error: { code, message, fix? } }`.

## Install

`install_registry_item` resolves the items' `@byterygon/` registry dependencies (dependencies
first), then writes:

- `registry:ui` and `registry:lib` files at the project's `components.json` aliases (`ui`, `lib`;
  shadcn's defaults `@/components/ui` and `@/lib` when there is none), with `@/` resolved through
  the `@/*` path of `tsconfig.json` (or `tsconfig.app.json`, `jsconfig.json`; `src` otherwise),
  and the registry's `@/components/ui/` and `@/lib/` imports rewritten to those aliases;
- a `registry:theme` item as `byterygon-<theme>.css` next to the project's main CSS
  (`components.json` `tailwind.css`): its `css` blocks and its `@theme inline` names. Import it
  after Tailwind (the result's `next` says the line to add).

It writes **only inside the project folder**: a target that is absolute, leaves the folder through
`..` or an alias, or goes through a symbolic link that leads outside refuses the whole install
before anything is written (`error.code: "outside-project"`, with the refused paths). `dryRun`
lists the files (`create`, `overwrite`, `unchanged`, `skip`) and writes nothing. A file that exists
with other contents is skipped unless `overwrite`. npm packages are not installed (there is no
network): `missingDependencies` lists the ones the project's `package.json` lacks, with the
versions the registry was tested with.

## Run

```sh
pnpm --filter @byterygon/design-tokens build     # once: the token tools use the engine's dist/
node packages/mcp/bin/by-ui-mcp.js               # stdio; --registry <folder> for another registry
claude mcp add byterygon-ui -- node /path/to/platform/packages/mcp/bin/by-ui-mcp.js
```

Without an MCP client (a script, an agent with a shell), the same tools answer from the command
line: the CLI connects an MCP client to the server in process, so the requests and answers are the
ones a client gets over stdio.

```sh
node packages/mcp/bin/by-ui-mcp.js tools                                   # the tools and their input schemas
node packages/mcp/bin/by-ui-mcp.js call search_tokens '{"query":"hover background"}'
node packages/mcp/bin/by-ui-mcp.js call install_registry_item '{"project":".","items":["button","theme-default"],"dryRun":true}'
```

`call` prints the tool's JSON and exits 1 when the tool reports an error (2 on a bad command line).

`BYTERYGON_REGISTRY` also names the registry folder. The default is `@byterygon/ui`'s `registry/`.

## Commands

```sh
pnpm --filter @byterygon/ui-mcp test        # node --test: the server over stdio with the SDK client, install safety
pnpm --filter @byterygon/ui-mcp typecheck   # JSDoc types, checked by TypeScript
```

CI runs the tests again in a network namespace with only loopback. The server uses the official
`@modelcontextprotocol/sdk` (MIT, pinned) with its stdio transport only; the source is checked to
import no HTTP, socket or listener module. Plain ESM with JSDoc types, no build step.
