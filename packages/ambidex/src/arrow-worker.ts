// Worker entry of the Arrow decoder (`arrow.ts`). Start it as a module Worker and let the
// application's bundler resolve it (and apache-arrow) from the installed packages:
//
//   new Worker(new URL("@byterygon/ambidex/arrow-worker", import.meta.url), { type: "module" })
//
// Nothing is fetched at runtime beyond the bundled script.

import { type ArrowDecoderScope, serveArrowDecoder } from "./arrow-decoder.js";

serveArrowDecoder(globalThis as unknown as ArrowDecoderScope);
