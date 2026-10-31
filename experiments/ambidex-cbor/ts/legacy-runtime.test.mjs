import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { buildSync } from "esbuild";
const base = new URL("../rust/target/legacy-runtime/", import.meta.url);
mkdirSync(base, { recursive: true });
const revision = "174b74aeb88aac05916b612e38d074f14042caf4";
let available = true;
try {
  for (const file of ["connection.ts", "errors.ts", "frame.ts"])
    writeFileSync(
      new URL(file, base),
      execFileSync(
        "git",
        ["show", `${revision}:packages/ambidex/src/${file}`],
        {
          stdio: ["ignore", "pipe", "ignore"],
        },
      ),
    );
} catch {
  available = false;
}
if (available) {
  writeFileSync(
    new URL("entry.ts", base),
    'export {Connection} from "./connection.js";export {jsonFrame,encodeFrame,Kind,FrameDecoder} from "./frame.js";',
  );
  buildSync({
    entryPoints: [new URL("entry.ts", base).pathname],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: new URL("entry.mjs", base).pathname,
  });
  const { Connection, jsonFrame, encodeFrame, Kind, FrameDecoder } =
    await import(new URL("entry.mjs", base));
  test(
    "actual pinned TS runtime ignores HelloAck capability extension",
    {},
    async () => {
      let hello;
      const transport = {
        async open(handlers) {
          return {
            send(bytes) {
              const d = new FrameDecoder(1048576);
              d.push(bytes);
              const f = d.next();
              if (f?.kind === Kind.Hello) {
                hello = JSON.parse(new TextDecoder().decode(f.payload));
                queueMicrotask(() =>
                  handlers.data(
                    encodeFrame(
                      jsonFrame(Kind.HelloAck, 0, {
                        session: "legacy-session",
                        server_version: "test",
                        limits: {
                          max_frame_bytes: 1048576,
                          max_concurrent_calls: 4,
                        },
                        capabilities: { version: 1, codec: "cbor-v1" },
                      }),
                    ),
                  ),
                );
              }
            },
            close() {},
          };
        },
      };
      const conn = await Connection.open(transport, {
        hello: {
          api: "spike",
          schemaHash: "hash-v1",
          protocol: 1,
          clientVersion: "test",
        },
        helloTimeoutMs: 1000,
      });
      assert.equal(conn.ack.session, "legacy-session");
      assert.equal(hello.schema_hash, "hash-v1");
      assert.equal(hello.capabilities, undefined);
      assert.equal(conn.ack.capabilities, undefined);
      conn.close();
    },
  );
} else {
  test("actual pinned TS runtime ignores HelloAck capability extension", {
    skip: "pinned git commit unavailable",
  });
}
