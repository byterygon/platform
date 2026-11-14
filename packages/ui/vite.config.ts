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
    rolldownOptions: {
      // Base UI marks its modules "use client" for React Server Components; a client bundle drops it.
      onwarn(warning, warn) {
        if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
      },
    },
  },
  test: {
    root: ".",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    testTimeout: 30_000,
  },
});
