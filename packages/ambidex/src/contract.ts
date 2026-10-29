// Type-level contract between a generated `api.ts` (rpc-gen, Ambidex spec §2) and this runtime.
// Types only: the runtime that implements `createClient` arrives with its own task (TSK-8).
//
// A generated `api.ts` exports `procedures`, a table nested by procedure name segment whose
// leaves are `ProcedureDef`s. `Client<typeof procedures>` maps every leaf to its call signature
// (spec §5), so `client.query.execute(input, opts)` is typed from the Rust declaration.

/** The kinds of call, spec §5. */
export type ProcedureKind = "query" | "mutation" | "subscription" | "stream";

/** What every leaf of a generated table has. `__types` exists only at the type level. */
export interface ProcedureLike {
  readonly name: string;
  readonly kind: ProcedureKind;
  readonly __types?: {
    readonly input: unknown;
    readonly output: unknown;
    readonly error: unknown;
  };
}

/** Per-call options. */
export interface CallOptions {
  /** Aborting sends Cancel; the call rejects with `Cancelled`. */
  readonly signal?: AbortSignal;
  /** Client deadline; the server caps it at the procedure's `timeoutMaxMs`. */
  readonly timeoutMs?: number;
}

/** A subscription: server-push events until `unsubscribe()`, cancel or disconnect. */
export interface Subscription<E> extends AsyncIterable<E> {
  unsubscribe(): void;
}

/** A stream: ordered binary chunks with backpressure, then one typed final result. */
export interface StreamCall<T, Chunk> {
  chunks(): AsyncIterable<Chunk>;
  readonly result: Promise<T>;
}

type Types<P> = P extends { readonly __types?: infer T } ? NonNullable<T> : never;

/** The input type of a procedure. */
export type InputOf<P> = Types<P> extends { readonly input: infer I } ? I : never;

/** The result type (one event for a subscription, the final result for a stream). */
export type OutputOf<P> = Types<P> extends { readonly output: infer O } ? O : never;

/** The error a call of the procedure fails with (`RpcError<Details>` from `api.ts`). */
export type ErrorOf<P> = Types<P> extends { readonly error: infer E } ? E : never;

/** A procedure whose input is `null` (Rust `()`) can be called without one. */
type Args<I> = [I] extends [null]
  ? [input?: null, opts?: CallOptions]
  : [input: I, opts?: CallOptions];

/** The call signature of one procedure. */
export type ProcedureCall<P, Chunk = Uint8Array> = P extends {
  readonly kind: "query" | "mutation";
}
  ? (...args: Args<InputOf<P>>) => Promise<OutputOf<P>>
  : P extends { readonly kind: "subscription" }
    ? (...args: Args<InputOf<P>>) => Subscription<OutputOf<P>>
    : P extends { readonly kind: "stream" }
      ? (...args: Args<InputOf<P>>) => StreamCall<OutputOf<P>, Chunk>
      : never;

/** A client for a generated procedure table: namespaces are objects, procedures are calls. */
export type Client<T, Chunk = Uint8Array> = {
  readonly [K in keyof T]: T[K] extends ProcedureLike
    ? ProcedureCall<T[K], Chunk>
    : Client<T[K], Chunk>;
};
