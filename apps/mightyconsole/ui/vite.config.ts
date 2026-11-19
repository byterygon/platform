// Vite builds the UI mightyconsole-server serves with --ui (Mightyconsole spec §2.1). Vitest runs
// the tests in jsdom. `@/` is the alias the registry items use, so component sources are shipped
// unchanged.
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));
const ambidex = fileURLToPath(new URL("../../../packages/ambidex/src", import.meta.url));

export default defineConfig({
  // Relative asset URLs: the server serves the bundle from /.
  base: "./",
  plugins: [tailwindcss()],
  resolve: {
    alias: [
      { find: "@", replacement: src },
      // The runtime is bundled from its sources, so the app needs no build order.
      { find: "@byterygon/ambidex/arrow-worker", replacement: `${ambidex}/arrow-worker.ts` },
      { find: "@byterygon/ambidex/arrow-decoder", replacement: `${ambidex}/arrow-decoder.ts` },
      { find: "@byterygon/ambidex/arrow", replacement: `${ambidex}/arrow.ts` },
      { find: /^@byterygon\/ambidex$/, replacement: `${ambidex}/index.ts` },
    ],
  },
  // Vite's dev server is for development only: the server serves the built bundle.
  server: { host: "127.0.0.1" },
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // One chunk carries the seven theme presets as text (Settings swaps them in), the shell and its
    // router (TanStack Router, TSK-101).
    chunkSizeWarningLimit: 2304,
    rolldownOptions: {
      // Base UI marks its modules "use client" for React Server Components; a client bundle drops it.
      onwarn(warning, warn) {
        if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
      },
    },
  },
  test: {
    root: ".",
    // jsdom cannot run Monaco: CodeEditor's tests use Byterygon UI's stand-in.
    alias: [{ find: /^monaco-editor\/.*$/, replacement: fileURLToPath(new URL("../../../packages/ui/test/fakes/monaco.ts", import.meta.url)) }],
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    testTimeout: 30_000,
  },
});
