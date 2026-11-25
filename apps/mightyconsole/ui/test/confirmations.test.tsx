// The destroy confirmation, functional (DOC-25 §3.3.6, TSK-138): a Destructive call refused with
// ApprovalRequired asks the person to type the phrase, confirms on the server and is sent again
// once; Cancel ends it with the refusal; other procedures are the client's own.
import { RpcError } from "@byterygon/ambidex";
import { afterEach, describe, expect, test } from "vitest";
import type { MightyClient } from "@/app/client";
import { approvalIdOf, ConfirmationGate, ConfirmationHost, withConfirmations } from "@/app/confirmations";
import type { Confirmation } from "@/gen/api";
import { axeViolations, byRole, byText, cleanup, click, render, type, waitFor } from "./support/render";

afterEach(cleanup);

const CHALLENGE: Confirmation = {
  action: "nats.kv.delete",
  tool: "nats",
  profileName: null,
  context: null,
  namespace: null,
  resourceKind: "key",
  resourceName: "orders.1",
  phrase: "orders.1",
  expiresAt: 0,
  reauth: false,
};

function refused(): RpcError {
  return new RpcError("ApprovalRequired", "approval required", { details: { approval_id: "apr_1" } });
}

/** A client whose `nats.kv.delete` needs one confirmation, and that records every call. */
function stub(calls: string[]) {
  let confirmed = false;
  const get = async () => ({ ok: true });
  const client = {
    $close: () => undefined,
    nats: {
      kv: {
        get,
        delete: async (input: { key: string }) => {
          calls.push(`delete ${input.key}`);
          if (!confirmed) throw refused();
          confirmed = false;
          return {};
        },
      },
    },
    app: {
      confirmations: {
        get: async () => CHALLENGE,
        confirm: async ({ typed }: { typed: string }) => {
          calls.push(`confirm ${typed}`);
          if (typed !== CHALLENGE.phrase) throw new RpcError("InvalidArgument", "that is not the name to type");
          confirmed = true;
          return {};
        },
      },
    },
  };
  return { client: client as unknown as MightyClient, get };
}

describe("withConfirmations", () => {
  test("only Destructive procedures are wrapped; the rest keep their identity", () => {
    const { client, get } = stub([]);
    const wrapped = withConfirmations(client, new ConfirmationGate()) as unknown as { nats: { kv: { get: unknown; delete: unknown } } };
    expect(wrapped.nats.kv.get).toBe(get);
    expect(wrapped.nats.kv.delete).not.toBe((client as unknown as { nats: { kv: { delete: unknown } } }).nats.kv.delete);
  });

  test("a refused call is sent again once the gate says confirmed; otherwise it ends refused", async () => {
    const calls: string[] = [];
    const { client } = stub(calls);
    const gate = new ConfirmationGate();
    const wrapped = withConfirmations(client, gate);
    // No dialog mounted: the refusal stands.
    await expect(wrapped.nats.kv.delete({ connId: "c", bucket: "b", key: "orders.1" })).rejects.toMatchObject({ code: "ApprovalRequired" });
    const detach = gate.attach(async (id) => {
      calls.push(`asked ${id}`);
      await client.app.confirmations.confirm({ approvalId: id, typed: "orders.1" });
      return true;
    });
    await wrapped.nats.kv.delete({ connId: "c", bucket: "b", key: "orders.1" });
    detach();
    expect(calls).toEqual(["delete orders.1", "delete orders.1", "asked apr_1", "confirm orders.1", "delete orders.1"]);
  });

  test("approvalIdOf reads only ApprovalRequired refusals", () => {
    expect(approvalIdOf(refused())).toBe("apr_1");
    expect(approvalIdOf(new RpcError("PermissionDenied", "no"))).toBeNull();
    expect(approvalIdOf(new Error("x"))).toBeNull();
  });
});

describe("ConfirmationHost", () => {
  test("the person types the phrase, the server confirms, the call goes through", async () => {
    const calls: string[] = [];
    const { client } = stub(calls);
    const gate = new ConfirmationGate();
    const wrapped = withConfirmations(client, gate);
    render(<ConfirmationHost gate={gate} client={client} />);
    const done = wrapped.nats.kv.delete({ connId: "c", bucket: "b", key: "orders.1" });
    await waitFor(() => byText(/Type/) !== null, "the challenge");
    expect(document.querySelector("[data-confirmation-phrase]")?.getAttribute("data-confirmation-phrase")).toBe("orders.1");
    const button = byRole("button", "Delete") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(await axeViolations()).toEqual([]);
    await type(byRole("textbox", "Confirmation") as HTMLInputElement, "orders.1");
    await click(byRole("button", "Delete"));
    await done;
    expect(calls).toEqual(["delete orders.1", "confirm orders.1", "delete orders.1"]);
  });

  test("Cancel ends the call with its refusal", async () => {
    const calls: string[] = [];
    const { client } = stub(calls);
    const gate = new ConfirmationGate();
    const wrapped = withConfirmations(client, gate);
    render(<ConfirmationHost gate={gate} client={client} />);
    const done = wrapped.nats.kv.delete({ connId: "c", bucket: "b", key: "orders.1" }).then(
      () => null,
      (e: unknown) => e,
    );
    await waitFor(() => byRole("button", "Cancel") !== null, "the dialog");
    await click(byRole("button", "Cancel"));
    expect(await done).toMatchObject({ code: "ApprovalRequired" });
    expect(calls).toEqual(["delete orders.1"]);
  });
});
