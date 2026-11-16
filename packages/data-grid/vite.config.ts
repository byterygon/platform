// Vitest runs the tests in jsdom. The Ambidex runtime is resolved from its sources (as DBee's
// bundle does), so the grid needs no build order; only `arrow.ts` is imported by the grid itself,
// the decoder only by the tests that turn real Arrow IPC bytes into batches.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const ambidex = fileURLToPath(new URL("../ambidex/src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@byterygon/ambidex/arrow-decoder", replacement: `${ambidex}/arrow-decoder.ts` },
      { find: "@byterygon/ambidex/arrow", replacement: `${ambidex}/arrow.ts` },
    ],
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    testTimeout: 30_000,
  },
});
