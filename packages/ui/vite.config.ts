// Vite builds the gallery (`pnpm build`, `pnpm gallery`) and Vitest runs the tests. `@/` is the
// same alias the registry items use, so component sources are shipped unchanged.
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  root: "gallery",
  base: "./",
  plugins: [tailwindcss()],
  resolve: { alias: { "@": src } },
  build: {
    outDir: "../dist/gallery",
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
    // jsdom cannot run Monaco; the component tests drive a small fake of the API it uses. The real
    // editor is tested in Chromium by scripts/browser-check.ts.
    alias: [{ find: /^monaco-editor\/.*$/, replacement: fileURLToPath(new URL("./test/fakes/monaco.ts", import.meta.url)) }],
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    testTimeout: 30_000,
  },
});
