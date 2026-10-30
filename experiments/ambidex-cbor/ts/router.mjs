import { createHash } from "node:crypto";
import { encode, decode, parseJSON } from "./codec.mjs";
import { convert } from "./semantic.mjs";
export const hash = (domain, bytes) =>
  "sha256:" +
  createHash("sha256")
    .update(domain + "\0")
    .update(bytes)
    .digest("hex");
export const digest = (value, schema) =>
  hash("ambidex.input-digest.v2", encode(convert(value, schema, true, "cbor")));
export async function dispatch({
  bytes,
  codec,
  schema,
  session,
  access,
  authorize,
  handler,
  logInput = false,
  redact = [],
  contract = "experimental",
  policy = "experimental",
}) {
  const events = [];
  const raw = codec === "cbor" ? decode(bytes) : parseJSON(bytes);
  events.push("bounded-syntax");
  if (!session?.principal) throw new Error("Unauthenticated");
  events.push("authenticated-session");
  if (!(await access(session))) {
    events.push("access-denied");
    return { error: "PermissionDenied", events };
  }
  events.push("access-gate");
  const typed = convert(raw, schema, false, codec);
  events.push("hydrate");
  const inputDigest = digest(typed, schema);
  events.push("digest-v2");
  const binding = {
    version: 2,
    contract,
    policy,
    procedure: "fixture.edit",
    principal: session.principal,
    target: session.target,
    context: session.context,
    inputDigest,
  };
  if (!(await authorize(binding))) return { error: "PermissionDenied", events };
  events.push("bound-authorization");
  const log = logInput ? convert(typed, schema, true, "json") : null;
  if (log)
    for (const path of redact) {
      const keys = path.split(".");
      let object = log;
      for (const k of keys.slice(0, -1)) {
        if (!object || !Object.hasOwn(object, k)) {
          object = null;
          break;
        }
        object = object[k];
      }
      const key = keys.at(-1);
      if (object && Object.hasOwn(object, key)) object[key] = "<redacted>";
    }
  events.push("redact-log");
  const result = await handler(typed);
  events.push("typed-dispatch");
  return { result, inputDigest, log, events };
}
export function negotiate(client, server) {
  const offered = client.codecs ?? ["json-v1"],
    available = server.codecs ?? ["json-v1"];
  if (
    !Array.isArray(offered) ||
    !Array.isArray(available) ||
    ![...offered, ...available].every((x) => typeof x === "string")
  )
    throw new Error("malformed capabilities");
  const known = new Set(["json-v1", "json-lossless-v2", "cbor-v1"]);
  const codec = offered.find((x) => known.has(x) && available.includes(x));
  if (!codec || (client.losslessRequired && codec === "json-v1"))
    throw new Error("unsupported codec");
  if (
    codec !== "json-v1" &&
    client.contract &&
    server.contract &&
    client.contract !== server.contract
  )
    throw new Error("contract mismatch");
  return Object.freeze({ codec, callZeroCodec: "json-v1", replay: false });
}
export const mutationDecodeFailure = () => ({
  code: "Unavailable",
  local: true,
  retryable: false,
  message: "outcome unknown: mutation result could not be decoded",
});

// Opaque approval IDs are backed by exact, versioned scope records in this simulator.
export class ApprovalStore {
  #records = new Map();
  issue(binding) {
    const id = "approval-" + (this.#records.size + 1);
    this.#records.set(id, structuredClone(binding));
    return id;
  }
  accepts(id, binding) {
    const stored = this.#records.get(id);
    if (!stored || binding.version !== 2 || stored.version !== 2) return false;
    return [
      "version",
      "contract",
      "policy",
      "procedure",
      "principal",
      "target",
      "context",
      "inputDigest",
    ].every(
      (k) =>
        Object.hasOwn(stored, k) &&
        Object.hasOwn(binding, k) &&
        stored[k] === binding[k],
    );
  }
}

// Candidate additive capability extension, confined to this simulator.
export function hello(config = {}) {
  return {
    protocol: 1,
    api: "spike",
    schema_hash: "legacy-v1",
    client_version: "spike",
    ...(config.codecs
      ? {
          capabilities: {
            version: 1,
            controlCodecs: config.codecs,
            contract: config.contract,
          },
        }
      : {}),
  };
}
export function handshake(client, server) {
  const first = hello(client);
  const caps = first.capabilities;
  if (caps && caps.version !== 1) throw new Error("capability version");
  const agreed = negotiate(client, server);
  const ack = {
    session: "mock-session",
    server_version: "spike",
    limits: { max_frame_bytes: 1048576, max_concurrent_calls: 4 },
    ...(server.codecs
      ? {
          capabilities: {
            version: 1,
            codec: agreed.codec,
            contract: server.contract,
          },
        }
      : {}),
  };
  return { hello: first, ack, agreed };
}
