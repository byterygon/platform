// Temporary loopback WebSocket and in-memory Tauri-style byte-pipe benchmark.
// This does not instantiate Tauri or reuse production protocol negotiation.
import { WebSocketServer } from "ws";
import { performance } from "node:perf_hooks";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { workloads, codecs } from "./bench-core.mjs";
import { encodeTyped, decodeTyped } from "./semantic.mjs";
import { jsonBytes, parseJSON } from "./codec.mjs";
const results = [];
for (const transport of ["websocket-loopback", "tauri-byte-pipe-mock"])
  for (const w of workloads)
    for (const codec of codecs) {
      let server, socket, peer;
      const serverWork = (bytes) => {
        if (codec === "json-v1")
          return jsonBytes(JSON.parse(new TextDecoder().decode(bytes)));
        const value = decodeTyped(bytes, w.schema, codec);
        return encodeTyped(value, w.schema, codec);
      };
      const request = () =>
        codec === "json-v1"
          ? jsonBytes(w.legacy)
          : encodeTyped(w.value, w.schema, codec);
      const response = (bytes) =>
        codec === "json-v1"
          ? JSON.parse(new TextDecoder().decode(bytes))
          : decodeTyped(bytes, w.schema, codec);
      try {
        if (transport === "websocket-loopback") {
          server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
          await once(server, "listening");
          server.on("connection", (s) =>
            s.on("message", (bytes) =>
              s.send(serverWork(new Uint8Array(bytes))),
            ),
          );
          socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
          socket.binaryType = "arraybuffer";
          await new Promise((resolve, reject) => {
            socket.onopen = resolve;
            socket.onerror = reject;
          });
        }
        const call = async () => {
          const bytes = request();
          if (socket) {
            const reply = new Promise((resolve, reject) => {
              socket.onmessage = (e) => resolve(new Uint8Array(e.data));
              socket.onerror = reject;
            });
            socket.send(bytes);
            return response(await reply);
          }
          return new Promise((resolve, reject) =>
            setImmediate(() => {
              try {
                resolve(response(serverWork(bytes.slice())));
              } catch (e) {
                reject(e);
              }
            }),
          );
        };
        for (let i = 0; i < (w.supplemental ? 2 : 20); i++) await call();
        for (let trial = 0; trial < 5; trial++) {
          const samplesMs = [];
          for (let i = 0; i < (w.supplemental ? 10 : 100); i++) {
            const start = performance.now();
            await call();
            samplesMs.push(performance.now() - start);
          }
          results.push({
            transport,
            name: w.name,
            codec,
            stage: "round-trip",
            trial,
            bytes: request().length,
            samplesMs,
            legacyContextOnly: codec === "json-v1",
          });
        }
      } finally {
        if (socket) {
          socket.close();
          await new Promise((resolve) => {
            if (socket.readyState === 3) resolve();
            else socket.onclose = resolve;
          });
        }
        if (server) await new Promise((resolve) => server.close(resolve));
      }
    }
writeFileSync(
  new URL("../results/transport-bench.json", import.meta.url),
  JSON.stringify(
    {
      caveat:
        "Experimental peers, fixed codec per connection. No TLS or real Tauri/WKWebView. Local loopback is not hard network isolation. JSON-v1 is contextual only.",
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log("Transport trials:", results.length);
