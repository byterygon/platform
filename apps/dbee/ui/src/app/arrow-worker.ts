// The Arrow decoder Worker entry, bundled by Vite (`new Worker(new URL("./arrow-worker.ts", import.meta.url))`).
// It calls serveArrowDecoder itself rather than importing "@byterygon/ambidex/arrow-worker" for its
// side effect: the alias in vite.config.ts points that import at the package's sources, which its
// package.json does not list under "sideEffects", so the bundler dropped it and shipped an empty
// Worker (no query ever got its schema; found by the TSK-61 desktop acceptance pass).
// scripts/check-dist.ts fails the build if the Worker comes out without the decoder again.
import { type ArrowDecoderScope, serveArrowDecoder } from "@byterygon/ambidex/arrow-decoder";

serveArrowDecoder(globalThis as unknown as ArrowDecoderScope);
