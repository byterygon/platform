// Entry: the browser storage (IndexedDB, or memory with a warning), the persisted tabs, layout and
// settings, one client over the WebSocket, the store, the shell.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./app/App";
import { ServicesContext, createServices } from "./app/client";
import { applyAppearance } from "./app/presets";
import { StoreProvider, loadPersisted } from "./app/store";
import { openStorage } from "./profiles/storage";
import { TOOLS, orderedTools } from "./tools/registry";

async function boot(): Promise<void> {
  const storage = await openStorage();
  const persisted = await loadPersisted(
    storage,
    // The first tool of the navigation is the default selection (DOC-21 §3.1).
    orderedTools(TOOLS).map((t) => t.id),
  );
  applyAppearance(persisted.settings);
  const services = createServices(storage);
  window.addEventListener("beforeunload", () => services.close?.());
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ServicesContext.Provider value={services}>
        <StoreProvider persisted={persisted} storage={storage}>
          <App />
        </StoreProvider>
      </ServicesContext.Provider>
    </StrictMode>,
  );
}

void boot();
