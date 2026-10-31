import { encodeTyped, decodeTyped } from "./semantic.mjs";
import { digest, handshake, mutationDecodeFailure } from "./router.mjs";
// Stateful experimental peers. Sessions are trusted harness inputs, not credentials.
export class Peer {
  constructor(client, server, session) {
    if (!session?.principal) throw new Error("Unauthenticated");
    const negotiated = handshake(client, server);
    this.agreement = negotiated.agreed;
    this.hello = negotiated.hello;
    this.ack = negotiated.ack;
    this.session = Object.freeze({ ...session });
    this.executions = 0;
  }
  renegotiate() {
    throw new Error("codec fixed per connection");
  }
  receive(bytes, schema) {
    if (this.agreement.codec === "json-v1") return decodeLegacy(bytes, schema);
    return decodeTyped(
      bytes,
      schema,
      this.agreement.codec === "cbor-v1" ? "cbor" : "json",
    );
  }
  encode(value, schema) {
    if (this.agreement.codec === "json-v1") return encodeLegacy(value, schema);
    return encodeTyped(
      value,
      schema,
      this.agreement.codec === "cbor-v1" ? "cbor" : "json",
    );
  }
}
export function relay(left, right, bytes, schema) {
  if (
    left.session.principal !== right.session.principal ||
    left.session.context !== right.session.context ||
    left.session.target !== right.session.target
  )
    throw new Error("relay binding mismatch");
  const value = left.receive(bytes, schema),
    before = digest(value, schema),
    out = right.encode(value, schema),
    after = digest(right.receive(out, schema), schema);
  if (before !== after) throw new Error("digest changed");
  return { bytes: out, inputDigest: before };
}
export const forwardArrow = (frame) => ({
  kind: frame.kind,
  callId: frame.callId,
  flags: frame.flags,
  payload: frame.payload.slice(),
});
export function mutate(peer, value, schema, { corruptReply = false } = {}) {
  const request = peer.encode(value, schema);
  const typed = peer.receive(request, schema);
  peer.executions++;
  let reply = peer.encode(typed, schema);
  if (corruptReply) reply = Uint8Array.of(255);
  try {
    return { value: peer.receive(reply, schema) };
  } catch {
    return { error: mutationDecodeFailure() };
  }
}

// Explicit old-peer adapter; no unsafe integer is ever converted to Number.
import { jsonBytes, parseJSON } from "./codec.mjs";
function legacyWire(value, schema, toLegacy) {
  if (schema.type === "ref") return legacyWire(value, schema.target, toLegacy);
  const type = typeof schema === "string" ? schema : schema.type;
  if (type === "i64" || type === "u64") {
    if (toLegacy) {
      const n = BigInt(value);
      if (n < -9007199254740991n || n > 9007199254740991n)
        throw new Error("legacy integer unsafe");
      return Number(n);
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value))
      throw new Error("invalid legacy integer");
    return String(value);
  }
  if (value === null) return value;
  if (type === "nullable") return legacyWire(value, schema.inner, toLegacy);
  if (type === "array")
    return value.map((v) => legacyWire(v, schema.items, toLegacy));
  if (type === "object") {
    const out = Object.create(null);
    for (const [k, v] of Object.entries(value)) {
      if (!Object.hasOwn(schema.fields, k))
        throw new Error("legacy extra field");
      out[k] = legacyWire(v, schema.fields[k], toLegacy);
    }
    return out;
  }
  if (type === "map")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        legacyWire(v, schema.values, toLegacy),
      ]),
    );
  if (type === "enum" || type === "tuple" || schema.flatten?.length)
    throw new Error("legacy adapter unsupported shape");
  return value;
}
function encodeLegacy(value, schema) {
  const wire = parseJSON(encodeTyped(value, schema, "json"));
  return jsonBytes(legacyWire(wire, schema, true));
}
function decodeLegacy(bytes, schema) {
  const wire = legacyWire(parseJSON(bytes), schema, false);
  return decodeTyped(jsonBytes(wire), schema, "json");
}
