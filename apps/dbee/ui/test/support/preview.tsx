// The app on the tests' fake core in a real browser (TSK-64): preview.html loads this in the Vite dev
// server, for looking at the screens and for the screenshot set (scripts/screenshots.ts). Query
// parameters:
//   scene   empty      no connections (first run)
//           main       one connection, a tab whose statement has run (rows in the grid)
//           streaming  the statement is still running (pg_sleep in the fake core: Cancel, live count)
//           error      the statement failed with a syntax error (SQLSTATE 42601, the editor marker)
//           toast      access to the connection expires in 13 min (the sticky toast, the countdowns)
//   open    settings | sheet | approve: opens Settings, the New connection sheet or Approve access
//   scheme  light | dark (default light)
//   density comfortable | compact (default comfortable)
//   run=0   leaves main idle
// Once the scene has settled, `document.documentElement.dataset.previewReady` is set.
// Development only: nothing here is part of the shipped bundle.
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { App } from "@/app/App";
import { ServicesContext } from "@/app/client";
import { type Approval, ApproveDialog } from "@/app/connections/ApproveDialog";
import { DEFAULT_PERSISTED, type Persisted } from "@/app/persistence";
import { StoreProvider } from "@/app/store";
import { WorkspaceSaver } from "@/app/workspace";
import type { ConnectionDraft, ConnectionSummary } from "@/gen/api";
import { createFakeServices } from "./fake-client";

const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "main";
const open = params.get("open");
const scheme = params.get("scheme") === "dark" ? "dark" : "light";
const density = params.get("density") === "compact" ? "compact" : "comfortable";
/** Extra query tabs (TSK-90's overflow menu): `tabs=12` opens twelve more. */
const extraTabs = Math.min(50, Math.max(0, Number(params.get("tabs")) || 0));
const MINUTE = 60_000;

const connection: ConnectionSummary = {
  id: "conn-1",
  name: "prod-orders",
  description: null,
  colour: null,
  driver: "com.byterygon.dbee.postgres",
  host: "db-01.orders.internal",
  port: 5432,
  database: "orders_db",
  user: "app_reader",
  tls: "deployment-ca",
  hasSecret: true,
  allowCancelConnection: true,
  status: "disconnected",
  grant: { id: "g-1", state: "active", expiresAt: scene === "toast" ? Date.now() + 13 * MINUTE : null, createdAt: 0 },
};

const SQL: Record<string, string> = {
  main: "-- Orders placed in the last 30 days\nselect id, name, active\n  from public.orders\n order by id desc;",
  toast: "-- Orders placed in the last 30 days\nselect id, name, active\n  from public.orders\n order by id desc;",
  streaming: "-- Every order, slowly\nselect id, name, active, pg_sleep(0)\n  from public.orders;",
  error: "select syntax error\n  from public.orders\n where status = 'paid';",
};

const fake = createFakeServices({ connections: scene === "empty" ? [] : [connection], rows: 200 });
const persisted: Persisted = {
  ...DEFAULT_PERSISTED,
  settings: { ...DEFAULT_PERSISTED.settings, colorScheme: scheme, density },
  ...(scene === "empty"
    ? {}
    : {
        tabs: [
          { id: "t1", connectionId: "conn-1", sql: SQL[scene] ?? SQL["main"]!, maxRows: 1000 },
          { id: "t2", connectionId: "conn-1", sql: "", maxRows: null },
          ...Array.from({ length: extraTabs }, (_, index) => ({ id: `t${index + 3}`, connectionId: "conn-1", sql: `-- Monthly report ${index + 1}\nselect ${index + 1};`, maxRows: null })),
        ],
        activeTab: "t1",
      }),
};
const saver = new WorkspaceSaver(fake.client, { revision: "rev-0", delayMs: 50 });

const draft: ConnectionDraft = {
  name: "prod-orders",
  host: "db-01.orders.internal",
  port: 5432,
  database: "orders_db",
  user: "app_reader",
  tls: { kind: "deployment-ca" },
  allowedAddresses: null,
  allowCancelConnection: true,
  expiresAt: null,
  hasSecret: true,
};

/** Approve access as the app shows it after Continue to approval, from the fake core's preview. */
function PreviewApproval() {
  const [approval, setApproval] = useState<Approval | null>(null);
  useEffect(() => {
    void fake.client.connections.prepare(draft).then((preview) => setApproval({ preview, draft, password: "secret", replaces: null }));
  }, []);
  return <ApproveDialog approval={approval} onBack={() => setApproval(null)} onApproved={() => setApproval(null)} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ServicesContext.Provider value={fake}>
      <StoreProvider persisted={persisted} saver={saver}>
        <App shell="desktop" />
        {open === "approve" ? <PreviewApproval /> : null}
      </StoreProvider>
    </ServicesContext.Provider>
  </StrictMode>,
);

const click = (selector: string, text?: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(selector)].find((b) => text === undefined || b.textContent?.trim().startsWith(text))?.click();
const after = (ms: number, step: () => void) => setTimeout(step, ms);

// Run the tab's statement once the editor is there.
if (scene !== "empty" && params.get("run") !== "0") after(1200, () => click("[role=toolbar][aria-label=Query] button", "Run"));
// The expiry warning the core sends 15 minutes before (a sticky toast).
if (scene === "toast") after(1800, () => fake.emit({ kind: "GrantExpiring", connectionId: "conn-1", expiresAt: Date.now() + 13 * MINUTE }));
if (open === "settings") after(1600, () => click("button[aria-label='Settings']"));
if (open === "sheet") after(1600, () => click("button[aria-label='Add connection']"));
if (open === "shortcuts") after(1600, () => click("button[aria-label='Keyboard shortcuts']"));
after(2600, () => (document.documentElement.dataset["previewReady"] = "true"));
