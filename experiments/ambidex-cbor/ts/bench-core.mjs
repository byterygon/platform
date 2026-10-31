import { encodeTyped, decodeTyped } from "./semantic.mjs";
import { workloads } from "./workloads.mjs";
import { jsonBytes } from "./codec.mjs";
export { workloads };
export const codecs = ["json-v1", "json", "cbor"];
export function operation(w, codec, stage = "codec") {
  if (codec === "json-v1") {
    const request = JSON.stringify(w.legacy);
    const value = JSON.parse(request);
    return stage === "mock-rpc" ? JSON.parse(JSON.stringify(value)) : value;
  }
  const request = encodeTyped(w.value, w.schema, codec);
  const input = decodeTyped(request, w.schema, codec);
  if (stage === "codec") return input;
  // Trusted test session + allow authorizer + echo handler. No real transport.
  const session = { principal: "human:bench", context: "bench-session" };
  if (!session.principal) throw new Error("Unauthenticated");
  const output = input;
  return decodeTyped(encodeTyped(output, w.schema, codec), w.schema, codec);
}
export function encodedBytes(w, codec) {
  return codec === "json-v1"
    ? jsonBytes(w.legacy).length
    : encodeTyped(w.value, w.schema, codec).length;
}
export function jobs() {
  const out = [];
  for (const w of workloads)
    for (let trial = 0; trial < 5; trial++)
      for (const stage of ["codec", "mock-rpc"]) {
        const order = trial % 2 ? ["cbor", "json", "json-v1"] : codecs;
        for (const codec of order) out.push({ w, codec, stage, trial });
      }
  return out;
}
