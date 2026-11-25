// About's diagnostics hold the time, the code, the correlation id and the server's message only
// (TSK-141): never the error's details, which carry what a target answered.
import { RpcError } from "@byterygon/ambidex";
import { describe, expect, it } from "vitest";
import { describeError, diagnosticLine } from "@/app/messages";

describe("diagnostics", () => {
  it("keep the message and the correlation id, never the details", () => {
    const error = new RpcError("Unauthenticated", "the target rejected the credentials", {
      correlation_id: "c-123",
      details: { kind: "Auth", message: "rejected", remote: { code: "401", name: "details-only-SEED" }, system: "nats", retryable: false },
    });
    const line = diagnosticLine(describeError(error), new Date("2026-11-25T00:00:00Z"));
    expect(line).toBe("2026-11-25T00:00:00.000Z Unauthenticated c-123 the target rejected the credentials");
    expect(line).not.toContain("SEED");
  });

  it("leave out an error the server log cannot match", () => {
    expect(diagnosticLine(describeError(new Error("local")), new Date())).toBeNull();
  });
});
