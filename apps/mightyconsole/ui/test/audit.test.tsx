// The audit log (DOC-25 §3.5, TSK-135 §6, TSK-140 batch 3c): newest first with the sensitive reads
// marked, the filters going to the server, an entry's digests and hashes, "Load more" paging, the
// chain check and its verdicts, and the export of the filtered view as CSV through the pages.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AccountMenu } from "@/app/account-menu";
import { AuditDialog } from "@/app/audit/AuditDialog";
import { NO_FILTERS, auditTools, csvField, filterOf, isFiltered, shortHash, statusText, toCsv, verdict } from "@/app/audit/audit";
import { Toast } from "@/components/ui/toast";
import type { AuditRow } from "@/gen/api";
import { fakeAudit, createFakeServices } from "./support/fake-services";
import { axeViolations, byRole, cleanup, click, render, settle, type as typeText, waitFor } from "./support/render";

afterEach(cleanup);
beforeEach(() => vi.useRealTimers());

const ROW: AuditRow = { seq: 1, timeMs: 0, user: "u", session: "s", userKind: "human", action: "a.b", perm: "a.read", target: null, risk: "Read", sensitive: false, outcome: "allowed", errorCode: null, phase: "done", durationMs: null, correlationId: "c" };

describe("the logic", () => {
  test("the filters become the server's filter: period from now, tool as a prefix, empty text as nothing", () => {
    const now = 1_000_000_000_000;
    expect(filterOf(NO_FILTERS, now)).toEqual({ fromMs: now - 7 * 86_400_000, toMs: null, principal: null, action: null, risk: null, outcome: null, sensitiveOnly: null, includeStarted: null });
    expect(filterOf({ who: " bao ", tool: "nats", risk: "Destructive", outcome: "refused", period: "all", sensitiveOnly: true }, now)).toEqual({ fromMs: null, toMs: null, principal: "bao", action: "nats.", risk: "Destructive", outcome: "refused", sensitiveOnly: true, includeStarted: null });
    expect(isFiltered(NO_FILTERS)).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, period: "day" })).toBe(true);
    expect(isFiltered({ ...NO_FILTERS, who: "x" })).toBe(true);
  });

  test("the tools are the first words of the procedures, plus the sign-in events", () => {
    expect(auditTools(["nats", "nats.kv.get", "admin", "echo"])).toEqual(["admin", "auth", "echo", "nats"]);
    expect(auditTools()).toEqual(expect.arrayContaining(["audit", "docker", "nats", "auth"]));
    expect(auditTools()).not.toContain("nats.js");
  });

  test("CSV quotes what needs it and defuses a leading formula character", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField('a,"b"')).toBe('"a,""b"""');
    expect(csvField("=HYPERLINK()")).toBe("'=HYPERLINK()");
    expect(csvField(-3)).toBe("-3");
    const csv = toCsv([{ ...ROW, target: "profile/P1", sensitive: true }]);
    expect(csv.split("\r\n")[0]).toBe("seq,time,user,session,action,permission,target,risk,sensitive,outcome,error,duration_ms,correlation");
    expect(csv.split("\r\n")[1]).toBe("1,1970-01-01T00:00:00.000Z,u,s,a.b,a.read,profile/P1,Read,yes,allowed,,,c");
  });

  test("the verdicts: intact, an unchecked checkpoint, calls with no completion, and a break", () => {
    const ok = { ok: true, records: 1200, segments: 2, headSeq: 1200, unfinished: [], checkpoint: "intact", broken: null, checkedMs: 0 };
    expect(verdict(ok)).toMatchObject({ tone: "success", title: "The chain is intact" });
    expect(verdict(ok).detail).toBe("1,200 records in 2 files. The checkpoint matches.");
    expect(verdict({ ...ok, checkpoint: "not checked" }).tone).toBe("warning");
    expect(verdict({ ...ok, unfinished: ["c1"] })).toMatchObject({ tone: "warning", title: "The chain is intact, but some calls have no completion" });
    const broken = verdict({ ...ok, ok: false, broken: { file: "audit-1.jsonl", line: 4, seq: 9, kind: "edited", message: "hash differs" } });
    expect(broken).toMatchObject({ tone: "danger", title: "The chain breaks at record 9" });
    expect(broken.detail).toContain("edited in audit-1.jsonl, line 4");
  });

  test("a status line and a short hash", () => {
    expect(statusText({ segments: 1, bytes: 2048, maxBytes: 1024 * 1024 * 512, oldestTimeMs: null, records: 1, refusing: null, checkpointMs: null, checkpointSeq: null })).toBe("1 records · 1 file · 2.0 KiB of 512.0 MiB");
    expect(shortHash("abcdef0123456789")).toBe("abcdef012345…");
    expect(shortHash("abc")).toBe("abc");
  });
});

type Fake = ReturnType<typeof createFakeServices>;

async function open(fake: Fake, save: (name: string, text: string) => void = () => undefined) {
  const view = render(
    <Toast>
      <AuditDialog open onOpenChange={() => undefined} client={fake.services.client} save={save} />
    </Toast>,
  );
  await waitFor(() => document.querySelectorAll("[data-seq]").length > 0, "the entries");
  await settle(3);
  return view;
}

const calls = (fake: Fake, procedure: string) => fake.server.calls.filter((c) => c.procedure === procedure);
const seqs = () => [...document.querySelectorAll("[data-seq]")].map((r) => Number((r as HTMLElement).dataset["seq"]));
const log = () => document.querySelector<HTMLElement>('[data-testid="audit-log"]')!;

describe("the list", () => {
  test("newest first, a refusal and a failure marked, a sensitive read with its eye, and the page is accessible", async () => {
    const fake = createFakeServices();
    await open(fake);
    expect(seqs()).toEqual([7, 6, 5, 4, 3, 2, 1]);
    const table = document.querySelector('table[aria-label="Audit entries"]')!;
    expect(table.querySelector('[data-seq="7"]')?.textContent).toContain("Refused");
    expect(table.querySelector('[data-seq="5"]')?.textContent).toContain("Failed · Unavailable");
    expect(table.querySelector('[data-seq="4"]')?.textContent).toContain("Destroy");
    expect(table.querySelector('[data-seq="6"] [aria-label="Sensitive read"], [data-seq="6"] [role="img"]')).not.toBeNull();
    expect(table.querySelector('[data-seq="2"] [role="img"]')).toBeNull();
    expect(document.querySelector('[data-testid="audit-count"]')?.textContent).toBe("7 entries shown: the oldest is reached");
    expect(calls(fake, "audit.list")[0]!.input).toMatchObject({ cursor: null, limit: 100, filter: { principal: null, action: null } });
    // The filters show their labels before their lists have opened (the lab walk saw raw values).
    expect(["Tool", "Risk", "Outcome", "Period"].map((f) => byRole("combobox", f)!.textContent)).toEqual(["Tool: any", "Risk: any", "Outcome: any", "Last 7 days"]);
    expect(await axeViolations()).toEqual([]);
  });

  test("the status line reads the log, and a log that refuses writes says so", async () => {
    const fake = createFakeServices();
    fake.server.audit.status = { ...fake.server.audit.status, refusing: "the audit disk is full" };
    await open(fake);
    expect(document.querySelector('[data-testid="audit-status"]')?.textContent).toContain("7 records · 2 files · 3.2 MiB of 512.0 MiB");
    expect(log().textContent).toContain("The log refuses writes");
    expect(log().textContent).toContain("the audit disk is full");
  });

  test("an empty answer says so and a failed one can be retried", async () => {
    const fake = createFakeServices();
    fake.server.audit.rows = [];
    await open(fake).catch(() => undefined);
    await waitFor(() => (log().textContent ?? "").includes("No entry matches"), "the empty text");
  });
});

describe("the filters", () => {
  test("who waits for a pause, then goes to the server with the others; Clear filters starts again", async () => {
    const fake = createFakeServices();
    await open(fake);
    await typeText(document.querySelector<HTMLInputElement>('input[aria-label="Who"]')!, "bao");
    await waitFor(() => calls(fake, "audit.list").some((c) => (c.input as { filter: { principal: string | null } }).filter.principal === "bao"), "the filtered call");
    await waitFor(() => seqs().join() === "7,5", "bao's entries");
    await click(byRole("button", "Clear filters"));
    await waitFor(() => seqs().length === 7, "everything again");
  });

  test("outcome and sensitive reads narrow the list", async () => {
    const fake = createFakeServices();
    await open(fake);
    await click(byRole("combobox", "Outcome"));
    await click(byRole("option", "Outcome: refused"));
    await waitFor(() => seqs().join() === "7", "the refusals");
    await click(byRole("button", "Clear filters"));
    await waitFor(() => seqs().length === 7, "everything again");
    await click(byRole("checkbox", "Sensitive reads only"));
    await waitFor(() => seqs().join() === "6", "the sensitive reads");
    expect(calls(fake, "audit.list").at(-1)!.input).toMatchObject({ filter: { sensitiveOnly: true } });
  });

  test("a tool narrows by its prefix", async () => {
    const fake = createFakeServices();
    await open(fake);
    await click(byRole("combobox", "Tool"));
    await click(byRole("option", "Tool: nats"));
    await waitFor(() => seqs().join() === "5,4,2", "nats entries");
    expect(calls(fake, "audit.list").at(-1)!.input).toMatchObject({ filter: { action: "nats." } });
  });
});

describe("paging", () => {
  test("Load more asks for the next page with the cursor and appends it; the end says it is reached", async () => {
    const fake = createFakeServices();
    const template = fake.server.audit.rows[5]!;
    fake.server.audit.rows = Array.from({ length: 130 }, (_, i) => ({ ...template, seq: 130 - i, timeMs: Date.now() - i * 1000, correlationId: `c${i}` }));
    await open(fake);
    expect(seqs().length).toBe(100);
    expect(document.querySelector('[data-testid="audit-count"]')?.textContent).toBe("100 entries shown, more below");
    await click(byRole("button", "Load more"));
    await waitFor(() => seqs().length === 130, "the second page");
    expect(calls(fake, "audit.list").at(-1)!.input).toMatchObject({ cursor: "100" });
    expect(seqs()[100]).toBe(30);
    expect(byRole("button", "Load more")).toBeNull();
    expect(document.querySelector('[data-testid="audit-count"]')?.textContent).toBe("130 entries shown: the oldest is reached");
  });
});

describe("an entry", () => {
  test("shows who, the permission, the reason and the digests and hashes, and records the read", async () => {
    const fake = createFakeServices();
    await open(fake);
    await click(byRole("button", "Entry 7, docker.containers.remove"));
    await waitFor(() => (document.querySelector('[data-testid="audit-detail"]')?.textContent ?? "").includes("Input digest"), "the detail");
    const detail = document.querySelector('[data-testid="audit-detail"]')!;
    expect(calls(fake, "audit.get")[0]!.input).toEqual({ seq: 7 });
    expect(detail.textContent).toContain("docker.containers.remove");
    expect(detail.textContent).toContain("human:oidc:bao");
    expect(detail.textContent).toContain("docker.destroy");
    expect(detail.textContent).toContain("missing: docker.destroy");
    expect(detail.textContent).toContain("sha256:00000007");
    expect(detail.textContent).toContain("never the input");
    expect(await axeViolations()).toEqual([]);
  });

  test("an entry that is gone says so in place", async () => {
    const fake = createFakeServices();
    await open(fake);
    fake.server.audit.records.delete(7);
    await click(byRole("button", "Entry 7, docker.containers.remove"));
    await waitFor(() => (document.querySelector('[data-testid="audit-detail"]')?.textContent ?? "").includes("no audit entry 7") || (document.querySelector('[data-testid="audit-detail"]')?.textContent ?? "").toLowerCase().includes("not found"), "the failure");
  });
});

describe("the chain", () => {
  test("Verify asks the server and shows the verdict", async () => {
    const fake = createFakeServices();
    await open(fake);
    await click(byRole("button", "Verify chain"));
    await waitFor(() => document.querySelector('[data-testid="audit-verdict"]') !== null, "the verdict");
    const verdictBox = document.querySelector('[data-testid="audit-verdict"]')!;
    expect(verdictBox.textContent).toContain("The chain is intact");
    expect(verdictBox.textContent).toContain("The checkpoint matches.");
    expect(calls(fake, "audit.verify").length).toBe(1);
  });

  test("a broken chain is shown as an error with where it breaks", async () => {
    const fake = createFakeServices();
    fake.server.audit.verify = { ok: false, records: 7, segments: 2, headSeq: 7, unfinished: [], checkpoint: "intact", broken: { file: "audit-1.jsonl", line: 3, seq: 3, kind: "edited", message: "the entry was changed" }, checkedMs: Date.now() };
    await open(fake);
    await click(byRole("button", "Verify chain"));
    await waitFor(() => document.querySelector('[data-testid="audit-verdict"]') !== null, "the verdict");
    const verdictBox = document.querySelector('[data-testid="audit-verdict"]')!;
    expect(verdictBox.textContent).toContain("The chain breaks at record 3");
    expect(verdictBox.textContent).toContain("edited in audit-1.jsonl, line 3");
    expect(verdictBox.getAttribute("role")).toBe("alert");
  });
});

describe("export", () => {
  test("pages through the filtered view and hands over one CSV", async () => {
    const fake = createFakeServices();
    const template = fake.server.audit.rows[5]!;
    fake.server.audit.rows = Array.from({ length: 620 }, (_, i) => ({ ...template, seq: 620 - i, timeMs: Date.now() - i * 1000, correlationId: `c${i}` }));
    const saved: { name: string; text: string }[] = [];
    await open(fake, (name, text) => saved.push({ name, text }));
    await click(byRole("button", "Export this view as CSV"));
    await waitFor(() => saved.length === 1, "the file");
    expect(saved[0]!.name).toMatch(/^audit-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/);
    expect(saved[0]!.text.trim().split("\r\n").length).toBe(621);
    const exportCalls = calls(fake, "audit.list").filter((c) => (c.input as { limit: number }).limit === 500);
    expect(exportCalls.length).toBe(2);
    expect(exportCalls[1]!.input).toMatchObject({ cursor: "500" });
  });
});

describe("the fake", () => {
  test("keeps the seven entries the screen's tests count on", () => {
    expect(fakeAudit().rows.map((r) => r.seq)).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });
});

describe("the account menu", () => {
  const menu = async (onAudit?: () => void) => {
    const fake = createFakeServices();
    render(<AccountMenu me={fake.server.me} idpName={null} startedMs={null} onSessions={() => undefined} onSettings={() => undefined} onSignOut={() => undefined} {...(onAudit ? { onAudit } : {})} />);
    await click(document.querySelector('[data-testid="account-button"]'));
    await waitFor(() => document.querySelector('[data-testid="account-summary"]') !== null, "the menu");
  };

  test("offers the Audit log only to people who may read it, and opens it", async () => {
    const opened = vi.fn();
    await menu(opened);
    await click(byRole("menuitem", "Audit log"));
    expect(opened).toHaveBeenCalledTimes(1);
  });

  test("a person without audit.read gets no item", async () => {
    await menu();
    expect(byRole("menuitem", "Audit log")).toBeNull();
    expect(byRole("menuitem", "Sessions")).not.toBeNull();
  });
});
