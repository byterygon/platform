// Type tests for the generated fixture `api.ts` (Ambidex spec §2): it compiles under the strict
// workspace settings, and `Client<typeof procedures>` gives each procedure the input, output and
// error types of its Rust declaration. Checked by `pnpm typecheck`; nothing here runs.

import {
  type AmbidexClient,
  type Client,
  createClient,
  type ErrorOf,
  type InputOf,
  isRpcError,
  type StreamCall,
  type Subscription,
  type Transport,
} from "../src/index.js";
import * as generated from "./conformance/api.js";
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

// The runtime's `createClient` over the generated module (TSK-8).
declare const transport: Transport;
const real = createClient(generated, transport);
assert<Equal<typeof real, AmbidexClient<generated.Api>>>();
const viaTable = createClient(procedures, transport, { api: API, schemaHash: SCHEMA_HASH });
assert<Equal<typeof viaTable, AmbidexClient<generated.Api>>>();
// @ts-expect-error: a bare table needs the API identity for Hello
createClient(procedures, transport);
const viaReal: Promise<string> = real.fixture.big(1, { timeoutMs: 5, signal: opts.signal });
const sub: Subscription<number> = real.fixture.counter(null);
const rows: StreamCall<number, Uint8Array> = real.fixture.rows(null);
void [viaReal, sub, rows, real.$connect(), real.$ping(), real.$close()];
// @ts-expect-error: no such procedure
void real.fixture.nope;
// @ts-expect-error: wrong input type
void real.fixture.big(true);

// `isRpcError` with a procedure narrows to that procedure's generated error union.
declare const caught: unknown;
if (isRpcError(caught, procedures.fixture.fail)) {
  if (caught.code === "ApprovalRequired") {
    assert<Equal<typeof caught.details, ApprovalRequiredDetails | FixtureError | undefined>>();
  } else {
    assert<Equal<typeof caught.details, FixtureError | undefined>>();
  }
  const correlation: string = caught.correlation_id;
  void correlation;
}
