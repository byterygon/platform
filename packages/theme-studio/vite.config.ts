// The Theme Studio builds to dist/: index.html, one classic script and one stylesheet, with every
// font and image inlined. That set runs from any static server and also straight from a folder
// (file://), where browsers refuse ES modules, module workers, fonts and fetches of other files.
// So: no ES module output (one IIFE, dynamic imports inlined), no module preload, assets as data:
// URLs, and Monaco's editor worker inlined as a blob worker. Nothing is fetched from anywhere.
//
// `@/` is the alias the Byterygon UI sources use; it points at packages/ui/src, so the Studio
// renders the real components (and their examples) unchanged.
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { type Plugin, defineConfig } from "vitest/config";

const ui = fileURLToPath(new URL("../ui/src", import.meta.url));

/** index.html with a classic, deferred script and no `crossorigin` (file:// has no CORS origin). */
function classicScript(): Plugin {
  return {
    name: "byterygon-classic-script",
    apply: "build",
    enforce: "post",
    transformIndexHtml(html) {
      return html
        .replace(/<script type="module" crossorigin (src="[^"]+")><\/script>/g, "<script defer $1></script>")
        .replace(/<link rel="stylesheet" crossorigin (href="[^"]+")>/g, '<link rel="stylesheet" $1>');
    },
  };
}

/** Monaco's `?worker` (a separate file) becomes `?worker&inline` (a blob), which file:// allows. */
function inlineWorkers(): Plugin {
  return {
    name: "byterygon-inline-workers",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!source.endsWith("?worker")) return null;
      const resolved = await this.resolve(source.slice(0, -"?worker".length), importer, { skipSelf: true });
      return resolved ? `${resolved.id}?worker&inline` : null;
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), inlineWorkers(), classicScript()],
  resolve: { alias: { "@": ui }, dedupe: ["react", "react-dom"] },
  worker: { format: "iife" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    cssCodeSplit: false,
    modulePreload: false,
    assetsInlineLimit: () => true,
    // One file holds the engine, Style Dictionary, Monaco and the app.
    chunkSizeWarningLimit: 16_384,
    rolldownOptions: {
      output: { format: "iife", entryFileNames: "studio.js", assetFileNames: "studio[extname]" },
      onwarn(warning, warn) {
        // Base UI marks its modules "use client" for React Server Components; a client bundle drops it.
        if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
      },
    },
  },
  test: {
    alias: [{ find: /^monaco-editor\/.*$/, replacement: fileURLToPath(new URL("../ui/test/fakes/monaco.ts", import.meta.url)) }],
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    testTimeout: 30_000,
  },
});
