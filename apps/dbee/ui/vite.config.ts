// Vite builds the one bundle both shells load (DBee spec §2): the Tauri desktop app embeds dist/
// as its frontendDist, the web server serves it with --ui. Vitest runs the tests in jsdom.
// `@/` is the alias the registry items use, so component sources are shipped unchanged.
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));
const ambidex = fileURLToPath(new URL("../../../packages/ambidex/src", import.meta.url));

export default defineConfig({
  // Relative asset URLs: the desktop webview serves from tauri://localhost, the web server from /.
  base: "./",
  plugins: [tailwindcss()],
  resolve: {
    alias: [
      { find: "@", replacement: src },
      // The runtime is bundled from its sources (the same code its dist is built from), so the app
      // needs no build order and the Worker entry resolves through Vite.
      { find: "@byterygon/ambidex/arrow-worker", replacement: `${ambidex}/arrow-worker.ts` },
      { find: "@byterygon/ambidex/arrow-decoder", replacement: `${ambidex}/arrow-decoder.ts` },
      { find: "@byterygon/ambidex/arrow", replacement: `${ambidex}/arrow.ts` },
      { find: /^@byterygon\/ambidex$/, replacement: `${ambidex}/index.ts` },
    ],
  },
  // Vite's dev server is for development only: the shipped app never loads a dev URL.
  server: { host: "127.0.0.1" },
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Monaco's own chunks (SqlEditor, loaded on demand) are larger than Vite's 500 kB default.
    chunkSizeWarningLimit: 1024,
    rolldownOptions: {
      // Base UI marks its modules "use client" for React Server Components; a client bundle drops it.
      onwarn(warning, warn) {
        if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
      },
    },
  },
  test: {
    root: ".",
    // jsdom cannot run Monaco; the tests use packages/ui's fake of the API SqlEditor touches.
    alias: [{ find: /^monaco-editor\/.*$/, replacement: fileURLToPath(new URL("../../../packages/ui/test/fakes/monaco.ts", import.meta.url)) }],
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    testTimeout: 30_000,
  },
});
