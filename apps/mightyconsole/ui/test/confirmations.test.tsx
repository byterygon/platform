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
function stub(calls: string[], options: { challenges?: Confirmation[]; confirmError?: () => RpcError | null; me?: boolean } = {}) {
  let confirmed = false;
  const challenges = [...(options.challenges ?? [CHALLENGE])];
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
      ...(options.me ? { me: async () => ({ displayName: "Uy Son", username: "uy.son", user: "human:account:1", email: null }) } : {}),
      confirmations: {
        get: async () => (challenges.length > 1 ? challenges.shift()! : challenges[0]!),
        confirm: async ({ typed }: { typed: string }) => {
          calls.push(`confirm ${typed}`);
          const refusal = options.confirmError?.() ?? null;
          if (refusal) throw refusal;
          if (typed !== challenges[challenges.length - 1]!.phrase) throw new RpcError("InvalidArgument", "that is not the name to type");
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
    const button = byRole("button", "Delete key") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(await axeViolations()).toEqual([]);
    await type(byRole("textbox", "Confirmation") as HTMLInputElement, "orders.1");
    await click(byRole("button", "Delete key"));
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

describe("the destroy dialog of the mockup", () => {
  const NATS: Confirmation = { ...CHALLENGE, action: "nats.js.streams.delete", resourceKind: "stream", resourceName: "ORDERS", phrase: "ORDERS", profileName: "nats-prod", namespace: null, expiresAt: Date.now() + 120_000 };

  test("it names the action, the target, the profile and the account, and starts in the name field", async () => {
    const { client } = stub([], { challenges: [NATS], me: true });
    const gate = new ConfirmationGate();
    render(<ConfirmationHost gate={gate} client={client} />);
    void gate.ask("apr_1");
    await waitFor(() => byText(/Delete stream ORDERS on nats-prod/) !== null, "the title");
    await waitFor(() => byText(/Uy Son/) !== null, "the account");
    const dialog = document.querySelector("[role=alertdialog]")!;
    expect(dialog.textContent).toContain("nats-prod");
    expect(document.activeElement).toBe(byRole("textbox", "Confirmation"));
    expect(byRole("button", "Delete stream")).not.toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  test("a lapsed challenge says so and Ask again sends the call again, keeping what was typed", async () => {
    const calls: string[] = [];
    let lapsedOnce = true;
    const { client } = stub(calls, {
      challenges: [NATS, { ...NATS, expiresAt: Date.now() + 120_000 }],
      confirmError: () => {
        if (!lapsedOnce) return null;
        lapsedOnce = false;
        return new RpcError("FailedPrecondition", "this confirmation expired; start the action again");
      },
    });
    const gate = new ConfirmationGate();
    const wrapped = withConfirmations(client, gate);
    render(<ConfirmationHost gate={gate} client={client} />);
    const done = wrapped.nats.kv.delete({ connId: "c", bucket: "b", key: "orders.1" });
    await waitFor(() => byRole("textbox", "Confirmation") !== null, "the dialog");
    await type(byRole("textbox", "Confirmation") as HTMLInputElement, "ORDERS");
    await click(byRole("button", "Delete stream"));
    await waitFor(() => byText(/expired after 2 minutes/) !== null, "the expiry");
    expect(byRole("alert", "")).not.toBeNull();
    await click(byRole("button", "Ask again"));
    await waitFor(() => (byRole("textbox", "Confirmation") as HTMLInputElement | null)?.value === "ORDERS", "the kept text");
    await click(byRole("button", "Delete stream"));
    await done;
    expect(calls.filter((c) => c.startsWith("confirm"))).toEqual(["confirm ORDERS", "confirm ORDERS"]);
    expect(calls.filter((c) => c.startsWith("delete")).length).toBe(3);
  });

  test("a challenge whose time has passed is expired at once, and its field is off", async () => {
    const { client } = stub([], { challenges: [{ ...NATS, expiresAt: Date.now() - 1000 }] });
    const gate = new ConfirmationGate();
    render(<ConfirmationHost gate={gate} client={client} />);
    void gate.ask("apr_1");
    await waitFor(() => byText(/expired after 2 minutes/) !== null, "the expiry");
    expect((byRole("textbox", "Confirmation") as HTMLInputElement).disabled).toBe(true);
    expect(byRole("button", "Ask again")).not.toBeNull();
  });

  test("too many wrong answers: the server pauses the session and the dialog says nothing was deleted", async () => {
    const { client } = stub([], { challenges: [NATS], confirmError: () => new RpcError("ResourceExhausted", "too many wrong answers; wait a minute") });
    const gate = new ConfirmationGate();
    render(<ConfirmationHost gate={gate} client={client} />);
    void gate.ask("apr_1");
    await waitFor(() => byRole("textbox", "Confirmation") !== null, "the dialog");
    await type(byRole("textbox", "Confirmation") as HTMLInputElement, "ORDERS");
    await click(byRole("button", "Delete stream"));
    await waitFor(() => byText(/Confirmations are paused for a minute/) !== null, "the pause");
  });

  test("when the server asks for a fresh sign-in the dialog offers it instead of the name field", async () => {
    let went = 0;
    const { client } = stub([], { challenges: [{ ...NATS, reauth: true }] });
    const gate = new ConfirmationGate();
    render(<ConfirmationHost gate={gate} client={client} onSignInAgain={() => void (went += 1)} />);
    void gate.ask("apr_1");
    await waitFor(() => byText(/Confirm it's you/) !== null, "the reauth dialog");
    expect(byRole("textbox", "Confirmation")).toBeNull();
    await click(byRole("button", "Sign in again"));
    expect(went).toBe(1);
  });
});
