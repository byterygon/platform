// @vitest-environment node
// The acceptance harness (TSK-87) without running it: the checklists follow the spec's section 18
// (one per build task, the items in their order), every wired check names a test that exists (a
// renamed test would otherwise turn an item into "no test matched" only when someone runs it),
// and the harness reads cargo's and Vitest's counts.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { APP, countTests, loadChecklists, parseArgs, validate, vitestVerdict } from "../../acceptance/acceptance.mts";
import type { Checklist } from "../../acceptance/checklist.mts";

const lists = await loadChecklists();

/** Every .rs file under the server, concatenated. */
const rustSources = (() => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith(".rs")) out.push(readFileSync(join(dir, e.name), "utf8"));
    }
  };
  walk(join(APP, "server"));
  return out.join("\n");
})();

describe("acceptance checklists", () => {
  test("one per build task of section 18, valid", () => {
    expect(validate(lists)).toEqual([]);
    expect(lists.map((l) => [l.id, l.task, l.items.length])).toEqual([
      ["foundation", "TSK-79", 12],
      // TSK-143 added filter-worker.
      ["messaging", "TSK-80", 11],
      ["nats", "TSK-85", 8],
      ["kafka", "TSK-86", 7],
      ["k8s", "TSK-82", 7],
      // TSK-109 added long-histories.
      ["temporal", "TSK-83", 7],
      ["temporal-more", "TSK-92", 8],
      ["temporal-detail", "TSK-104", 2],
      // Section 18's five, then the additions Uy Son approved (DOC-21 Open question 45 q).
      ["docker", "TSK-81", 6],
      // TSK-108 added frame-limit, TSK-96 runs-history-edit and assistant-graph-versions.
      ["langgraph", "TSK-84", 9],
      ["packaging", "TSK-87", 2],
      // DOC-25 section 6, run with the idp profile; TSK-136 wired the login items, the other
      // security tasks add theirs (TSK-141 attaches the evidence); TSK-137 added the three audit items,
      // TSK-142 the built-in accounts and the default administrator.
      // TSK-138 added the seven Authorization and Destroy items; TSK-139 start-keys,
      // secrets-rotation, secrets-shared and secrets-target.
      ["security", "TSK-141", 23],
    ]);
  });

  test("a tool's checklist waits for its server module and starts the lab profile of that tool", () => {
    for (const id of ["nats", "kafka", "k8s", "temporal", "docker", "langgraph"]) {
      const list = lists.find((l) => l.id === id)!;
      expect(list.builtWhen).toBe(`apps/mightyconsole/server/src/tools/${id}`);
      expect(list.lab).toEqual([id]);
    }
  });

  test("every wired check names a test that exists", () => {
    for (const list of lists) {
      for (const item of list.items) {
        for (const check of item.checks) {
          const where = `${list.id}/${item.id}`;
          if (check.kind === "cargo") {
            const name = check.filter.split("::").at(-1)!;
            expect(rustSources, `${where}: no Rust test fn ${name}`).toMatch(new RegExp(`fn ${name}\\(`));
          }
          if (check.kind === "vitest") {
            const source = readFileSync(join(APP, "ui", check.file), "utf8");
            if (check.name) expect(source, `${where}: no test or describe "${check.name}" in ${check.file}`).toContain(check.name);
          }
        }
      }
    }
  });

  test("validate refuses duplicates, bad ids and lab items without a lab", () => {
    const bad: Checklist = {
      id: "x",
      task: "TSK-1",
      title: "X",
      builtWhen: "nowhere",
      lab: [],
      items: [
        { id: "a", text: "a", checks: [] },
        { id: "a", text: "b", lab: true, checks: [] },
        { id: "Bad Id", text: "", checks: [] },
      ],
    };
    expect(new Set(validate([bad, bad]))).toEqual(
      new Set([
        "x: two checklists with this id",
        "x/a: a lab item in a checklist without lab profiles",
        "x/a: duplicate item id",
        "x/Bad Id: ids are lowercase words with dashes",
        "x/Bad Id: no text",
      ]),
    );
  });
});

describe("the harness", () => {
  test("counts cargo's and Vitest's results", () => {
    const cargo = "test result: ok. 0 passed; 0 failed; 0 ignored\n...\ntest result: ok. 2 passed; 0 failed; 0 ignored\ntest result: FAILED. 1 passed; 1 failed; 0 ignored";
    expect(countTests(cargo)).toEqual({ passed: 3, failed: 1 });
    expect(countTests(" Test Files  1 passed (1)\n      Tests  5 passed | 2 skipped (7)\n")).toEqual({ passed: 5, failed: 0 });
    expect(countTests("      Tests  1 failed | 4 passed (5)\n")).toEqual({ passed: 4, failed: 1 });
    expect(countTests("No test files found")).toEqual({ passed: 0, failed: 0 });
    // As CI prints it, with colours forced on.
    expect(countTests("\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m5 passed\u001b[39m\u001b[22m\u001b[90m (5)\u001b[39m")).toEqual({ passed: 5, failed: 0 });
  });

  test("reads a vitest check's verdict from its file's report, matching -t as Vitest does (TSK-123)", () => {
    const t = (ancestorTitles: string[], title: string, status = "passed") => ({ ancestorTitles, title, status });
    const report = {
      testResults: [
        { status: "failed", assertionResults: [t(["shell"], "profiles through the shell"), t(["shell"], "keyboard, palette, dialogs", "failed"), t(["shell", "accessibility"], "axe in both themes")] },
      ],
    };
    expect(vitestVerdict(report, "profiles through the shell")).toEqual({ verdict: "pass", detail: "1 passed" });
    expect(vitestVerdict(report, "keyboard, palette, dialogs")).toEqual({ verdict: "fail", detail: "1 failed" });
    // The describe titles are part of the name, as with -t.
    expect(vitestVerdict(report, "accessibility")).toEqual({ verdict: "pass", detail: "1 passed" });
    expect(vitestVerdict(report, "no such test")).toEqual({ verdict: "fail", detail: "no test matched" });
    expect(vitestVerdict(report, undefined)).toEqual({ verdict: "fail", detail: "1 failed" });
    expect(vitestVerdict({ testResults: [{ status: "failed", message: "Failed to load url ./missing\nat x", assertionResults: [] }] }, "anything")).toEqual({
      verdict: "fail",
      detail: "the file did not run: Failed to load url ./missing",
    });
    expect(vitestVerdict(null, "x").verdict).toBe("fail");
  });

  test("reads its options", () => {
    expect(parseArgs(["docker", "--lab-up", "--strict", "--only", "a,b", "--server", "bin"])).toMatchObject({ names: ["docker"], labUp: true, strict: true, only: ["a", "b"], server: "bin" });
    expect(() => parseArgs(["--nope"])).toThrow(/unknown option --nope/);
    expect(() => parseArgs(["--only"])).toThrow(/needs a value/);
  });
});
