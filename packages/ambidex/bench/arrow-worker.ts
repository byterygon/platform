// The Arrow decoder in a Node worker thread: what `src/arrow-worker.ts` does in a Web Worker,
// with `parentPort` in place of the Worker's global scope. Messages are structured-cloned and
// buffers transferred, as between a page and its Worker.

import { parentPort } from "node:worker_threads";

import { serveArrowDecoder } from "../src/arrow-decoder.js";

if (parentPort === null) throw new Error("run as a worker thread");
const port = parentPort;

serveArrowDecoder({
  postMessage: (message, transfer) => port.postMessage(message, transfer as ArrayBuffer[]),
  addEventListener: (_type, listener) => void port.on("message", (data) => listener({ data })),
});
