// Type tests for the generated fixture `api.ts` (Ambidex spec §2): it compiles under the strict
// workspace settings, and `Client<typeof procedures>` gives each procedure the input, output and
// error types of its Rust declaration. Checked by `pnpm typecheck`; nothing here runs.

import type {
  Client,
  ErrorOf,
  InputOf,
  StreamCall,
  Subscription,
} from "../src/index.js";
import {
  API,
  PROTOCOL,
  SCHEMA_HASH,
  procedures,
  type ApprovalRequiredDetails,
  type FailInput,
  type FixtureError,
  type JsonValue,
  type Procedures,
} from "./conformance/api.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assert<T extends true>(): T | void {}

declare const client: Client<typeof procedures>;
declare const opts: { signal: AbortSignal };

// Identity and metadata come from the registry.
const api: "conformance" | string = API;
const protocol: number = PROTOCOL;
const hash: string = SCHEMA_HASH;
const failKind: "query" = procedures.fixture.fail.kind;
const protectedKind: "mutation" = procedures.fixture.protected.kind;
void [api, protocol, hash, failKind, protectedKind];

// Queries and mutations: typed input, typed result.
const failed: Promise<null> = client.fixture.fail({ code: "NotFound", retryable: false }, opts);
const big: Promise<string> = client.fixture.big(10, { timeoutMs: 1000 });
const echoed: Promise<JsonValue> = client.fixture.echo({ any: ["json", 1, null] });
void [failed, big, echoed];
assert<Equal<InputOf<Procedures["fixture.fail"]>, FailInput>>();

// `retryable` is `#[serde(default)]`: the server fills it in, so a client may leave it out.
void client.fixture.fail({ code: "NotFound" });
// @ts-expect-error: not a Code
void client.fixture.fail({ code: "Nope", retryable: false });
// @ts-expect-error: a required field is missing
void client.fixture.fail({ retryable: true });
// @ts-expect-error: the Rust input is a usize
void client.fixture.big("10");
// @ts-expect-error: no such procedure
void client.fixture.missing;

// Subscriptions and streams.
assert<Equal<ReturnType<typeof client.fixture.counter>, Subscription<number>>>();
assert<Equal<ReturnType<typeof client.fixture.rows>, StreamCall<number, Uint8Array>>>();

// Errors narrow on `code`; `details` is the typed domain error. ApprovalRequired details are the
// router's approval id or, when the handler raised that code itself, the domain error.
declare const err: ErrorOf<Procedures["fixture.fail"]>;
if (err.code === "ApprovalRequired") {
  assert<Equal<typeof err.details, ApprovalRequiredDetails | FixtureError | undefined>>();
  // @ts-expect-error: may be the domain error, which has no approval id
  void err.details?.approval_id;
  if (err.details && "approval_id" in err.details) {
    const id: string = err.details.approval_id;
    void id;
  }
} else {
  const details: FixtureError | undefined = err.details;
  if (details?.kind === "Requested") {
    const code: "NotFound" | string = details.code;
    void code;
  }
}
declare const plain: ErrorOf<Procedures["fixture.wait"]>;
if (plain.code !== "ApprovalRequired") {
  // A procedure without typed details never has any.
  assert<Equal<typeof plain.details, undefined>>();
} else {
  assert<Equal<typeof plain.details, ApprovalRequiredDetails | undefined>>();
}
