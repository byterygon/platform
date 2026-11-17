// The app on the tests' fake core in a real browser (TSK-64): preview.html loads this in the Vite dev
// server, for looking at the screens and for the screenshot set. Query parameters:
//   scene   empty (no connections) | main (one connection, a tab with a statement, run once)
//   scheme  light | dark (default light)
//   density comfortable | compact (default comfortable)
// Development only: nothing here is part of the shipped bundle.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { App } from "@/app/App";
import { ServicesContext } from "@/app/client";
import { DEFAULT_PERSISTED, type Persisted } from "@/app/persistence";
import { StoreProvider } from "@/app/store";
import { WorkspaceSaver } from "@/app/workspace";
import type { ConnectionSummary } from "@/gen/api";
import { createFakeServices } from "./fake-client";

const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "main";
const scheme = params.get("scheme") === "dark" ? "dark" : "light";
const density = params.get("density") === "compact" ? "compact" : "comfortable";

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
  grant: { id: "g-1", state: "active", expiresAt: null, createdAt: 0 },
};

const fake = createFakeServices({ connections: scene === "empty" ? [] : [connection], rows: 200 });
const persisted: Persisted = {
  ...DEFAULT_PERSISTED,
  settings: { ...DEFAULT_PERSISTED.settings, colorScheme: scheme, density },
  ...(scene === "empty"
    ? {}
    : {
        tabs: [
          { id: "t1", connectionId: "conn-1", sql: "-- Orders placed in the last 30 days\nselect id, name, active\n  from public.orders\n order by id desc;", maxRows: 1000 },
          { id: "t2", connectionId: "conn-1", sql: "", maxRows: null },
        ],
        activeTab: "t1",
      }),
};
const saver = new WorkspaceSaver(fake.client, { revision: "rev-0", delayMs: 50 });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ServicesContext.Provider value={fake}>
      <StoreProvider persisted={persisted} saver={saver}>
        <App shell="desktop" />
      </StoreProvider>
    </ServicesContext.Provider>
  </StrictMode>,
);

// The main scene runs its statement once, so the results layer has rows (run=0 leaves it idle).
if (scene === "main" && params.get("run") !== "0") {
  setTimeout(() => {
    const runButton = [...document.querySelectorAll<HTMLButtonElement>("[role=toolbar][aria-label=Query] button")].find((b) => b.textContent?.trim().startsWith("Run"));
    runButton?.click();
  }, 1200);
}
