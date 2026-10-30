import { WebSocketServer } from "ws";
import { workloads as serverWorkloads } from "./workloads.mjs";
import {
  encodeTyped as serverEncode,
  decodeTyped as serverDecode,
} from "./semantic.mjs";
import { jsonBytes } from "./codec.mjs";
import { chromium, webkit } from "playwright";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
const root = new URL("./", import.meta.url);
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/") {
      res.setHeader("Content-Type", "text/html");
      res.end("<!doctype html><title>TSK-21 local benchmark</title>");
      return;
    }
    if (!/^\/[a-z-]+\.mjs$/.test(req.url)) throw Error();
    res.setHeader("Content-Type", "text/javascript");
    res.end(await readFile(new URL(req.url.slice(1), root)));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const socketServer = new WebSocketServer({
  noServer: true,
  maxPayload: 1048576,
});
server.on("upgrade", (request, socket, head) => {
  const match = /^\/rpc\/(\d+)\/(json-v1|json|cbor)$/.exec(request.url ?? "");
  if (!match || !serverWorkloads[Number(match[1])]) {
    socket.destroy();
    return;
  }
  socketServer.handleUpgrade(request, socket, head, (ws) => {
    const w = serverWorkloads[Number(match[1])],
      codec = match[2];
    ws.on("message", (data) => {
      try {
        const reply =
          codec === "json-v1"
            ? jsonBytes(JSON.parse(data.toString()))
            : serverEncode(
                serverDecode(new Uint8Array(data), w.schema, codec),
                w.schema,
                codec,
              );
        ws.send(reply);
      } catch {
        ws.close(1008, "invalid payload");
      }
    });
  });
});
const results = [];
try {
  for (const [name, engine] of [
    ["Chromium", chromium],
    ["WebKit proxy", webkit],
  ]) {
    let browser;
    try {
      browser = await engine.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const measured = await page.evaluate(async () => {
        const { jobs, operation, encodedBytes } =
          await import("/bench-core.mjs");
        const raw = [];
        for (const { w, codec, stage, trial } of jobs()) {
          for (let i = 0; i < (w.supplemental ? 2 : 20); i++)
            operation(w, codec, stage);
          const samplesMs = [];
          const batch = w.supplemental
            ? 1
            : w.name === "metadata-500" || w.name === "edited-grid"
              ? 3
              : 20;
          let sampledPeakHeapBytes = 0;
          for (let i = 0; i < (w.supplemental ? 10 : 100); i++) {
            const start = performance.now();
            for (let b = 0; b < batch; b++) operation(w, codec, stage);
            samplesMs.push((performance.now() - start) / batch);
            sampledPeakHeapBytes = Math.max(
              sampledPeakHeapBytes,
              performance.memory?.usedJSHeapSize ?? 0,
            );
          }
          raw.push({
            name: w.name,
            codec,
            stage,
            trial,
            batch,
            bytes: encodedBytes(w, codec),
            samplesMs,
            sampledPeakHeapBytes: sampledPeakHeapBytes || null,
            legacyContextOnly: codec === "json-v1",
          });
        }
        // Real browser WebSocket loopback RPC, distinct from batched codec timings.
        const { workloads, codecs } = await import("/bench-core.mjs");
        const { encodeTyped, decodeTyped } = await import("/semantic.mjs");
        const { jsonBytes } = await import("/codec.mjs");
        for (let index = 0; index < workloads.length; index++) {
          const w = workloads[index],
            connections = new Map();
          for (const codec of codecs) {
            const socket = new WebSocket(
              `ws://${location.host}/rpc/${index}/${codec}`,
            );
            socket.binaryType = "arraybuffer";
            await new Promise((resolve, reject) => {
              socket.onopen = resolve;
              socket.onerror = reject;
            });
            connections.set(codec, socket);
          }
          const call = async (codec) => {
            const socket = connections.get(codec);
            const reply = new Promise((resolve, reject) => {
              socket.onmessage = (e) => resolve(new Uint8Array(e.data));
              socket.onerror = reject;
            });
            socket.send(
              codec === "json-v1"
                ? jsonBytes(w.legacy)
                : encodeTyped(w.value, w.schema, codec),
            );
            const bytes = await reply;
            return codec === "json-v1"
              ? JSON.parse(new TextDecoder().decode(bytes))
              : decodeTyped(bytes, w.schema, codec);
          };
          try {
            for (const codec of codecs)
              for (let i = 0; i < (w.supplemental ? 2 : 20); i++)
                await call(codec);
            for (let trial = 0; trial < 5; trial++) {
              for (const codec of trial % 2 ? [...codecs].reverse() : codecs) {
                const samplesMs = [];
                for (let i = 0; i < (w.supplemental ? 10 : 100); i++) {
                  const start = performance.now();
                  await call(codec);
                  samplesMs.push(performance.now() - start);
                }
                raw.push({
                  name: w.name,
                  codec,
                  stage: "websocket-rpc",
                  trial,
                  batch: 1,
                  bytes: encodedBytes(w, codec),
                  samplesMs,
                  legacyContextOnly: codec === "json-v1",
                });
              }
            }
          } finally {
            for (const socket of connections.values()) socket.close();
          }
        }
        return {
          userAgent: navigator.userAgent,
          raw,
          memoryLimitation: performance.memory
            ? "Nonstandard sampled heap only; no per-workload isolated GC control"
            : "Heap and GC not exposed by this browser runtime; cannot establish heap adoption gate",
        };
      });
      results.push({ engine: name, version: browser.version(), ...measured });
    } catch (e) {
      results.push({ engine: name, error: String(e) });
    } finally {
      await browser?.close();
    }
  }
} finally {
  socketServer.close();
  server.close();
}
await writeFile(
  new URL("../results/browser-bench.json", import.meta.url),
  JSON.stringify(
    {
      caveat:
        "Headless WebKit is a JavaScript-engine proxy, not Tauri WKWebView. codec and mock-RPC have no real transport. Codec/mock samples average batches; websocket-rpc samples are individual round trips to the Node echo server, without TLS or production authentication. Five trials alternate codec order.",
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  results.map((x) => ({
    engine: x.engine,
    error: x.error,
    trials: x.raw?.length,
  })),
);
