# Mightyconsole acceptance

One command runs a build task's acceptance checklist (Mightyconsole spec section 18) against the
test lab and saves the evidence for its PR (TSK-87). Every tool task runs it before it closes, as
its "Release after this tool" section says.

```sh
pnpm --filter @byterygon/mightyconsole acceptance --list                 # checklists, items, wiring
pnpm --filter @byterygon/mightyconsole acceptance docker --lab-up         # one tool, starting its lab profile
pnpm --filter @byterygon/mightyconsole acceptance foundation packaging
pnpm --filter @byterygon/mightyconsole acceptance all --strict            # everything; skipped items fail too
```

Options: `--only ID,ID` (items), `--lab-up` (start the checklist's lab profiles when `lab check`
fails), `--server PATH` (another `mightyconsole-server`; a release binary serves its built-in UI),
`--strict`, `--out DIR`.

## Verdicts

| Verdict | Meaning | Fails the run |
| --- | --- | --- |
| PASS | every check passed | no |
| FAIL | a check failed, or a cargo or Vitest filter matched no test | yes |
| MANUAL | the automatic checks passed; a person checks the rest (a CI run, a flow by hand) and links it | no |
| NOT WIRED | the item has no check yet | yes, once the task's code is in |
| SKIPPED | the task's code is not in yet (the checklist's `builtWhen` path is missing), or the lab, a browser or a required program is missing; the reason is printed | only with `--strict` |

A tool that is not built yet is skipped as a whole, saying so: `docker` waits for
`apps/mightyconsole/server/src/tools/docker`.

## Evidence

Each run writes `evidence/<time>-<checklists>/` (git-ignored):

- `summary.md`: one table per checklist (item, verdict, every check with its result and files),
  ready to paste into the PR; `summary.json` the same as data;
- `logs/`: the output of every check, the lab's `check`, the builds;
- `screenshots/`: what the browser checks saw (headless Chrome, Chromium or Edge; `BYTERYGON_BROWSER`
  names one);
- `environment.txt`: commit, OS, Node, Rust and Docker versions.

Attach `summary.md` and the screenshots to the task's last PR. CI runs `foundation` in the
Mightyconsole lab workflow and uploads its evidence as an artifact.

## Wiring a tool's checklist

`checklists/<tool>.mts` holds the spec's items with `checks: []`. The tool task fills them with the
helpers of `checklist.mts`:

```ts
import { browser, cargo, command, manual, vitest } from "../checklist.mts";

{
  id: "containers",
  text: "Containers list grouped by Compose project …",
  lab: true,                                         // needs the checklist's lab profiles up
  checks: [
    cargo("docker::lab::containers_are_grouped_by_project", { features: ["lab-tests"] }),
    vitest("test/docker.test.tsx", "containers"),
    browser("the containers of the lab host", async ({ page, origin, until, run, shot, lab }) => {
      await page.navigate(`${origin}/`);
      // add a profile from lab (credentials.json), connect, open the list …
      await until(`__mc.has("shop")`, "the Compose project");
      await shot("containers grouped by project");
    }),
    manual("exec in the TTY container by hand: resize, exit code"),
  ],
}
```

- `cargo(filter)` runs `cargo test -p mightyconsole-server -- <filter>`; `vitest(file, name?)` one
  UI test file or the tests whose name contains `name`. Each must match at least one test;
  `test/acceptance.test.ts` checks that every name still exists.
- `browser(label, fn)` gets a fresh page on a running server (the UI built in, or `ui/dist`), the
  `__mc` helpers of `ui/scripts/cdp.ts`, `shot(name)` for screenshots and `lab` (the lab's
  `credentials.json`).
- `command(label, argv, { cwd, env, requires })` runs any program; `{evidence}`, `{repo}`,
  `{server}` and `{ui}` are replaced; `requires` names programs whose absence skips it.
- `server(label, args, [regex])` starts the server and matches its startup lines.
- `manual(label)` is for what only a person can see.
