// Entry: a signed-out page goes to the sign-in first; then the browser storage (IndexedDB, or memory with a warning), the persisted tabs, layout and
// settings, the router's mode and base path from the page (DOC-21 §3.7), one client over the
// WebSocket under that base path, the store, the shell.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./app/App";
import { ServicesContext, createServices } from "./app/client";
import { applyAppearance } from "./app/presets";
import { createAppHistory, readRouterConfig } from "./app/router";
import { renderSignInFailure, signInState } from "./app/sign-in";
import { StoreProvider, loadPersisted } from "./app/store";
import { openStorage } from "./profiles/storage";
import { TOOLS, orderedTools } from "./tools/registry";

async function boot(): Promise<void> {
  // Signed out (DOC-25 §3.2.5): to the sign-in, or why it failed; the app needs a session.
  const signIn = signInState();
  if (signIn.kind === "redirect") {
    window.location.replace(signIn.to);
    return;
  }
  if (signIn.kind === "failed") {
    renderSignInFailure(document.getElementById("root")!, signIn);
    return;
  }
  const storage = await openStorage();
  const persisted = await loadPersisted(
    storage,
    // The first tool of the navigation is the default selection (DOC-21 §3.1).
    orderedTools(TOOLS).map((t) => t.id),
  );
  applyAppearance(persisted.settings);
  const routerConfig = readRouterConfig();
  const history = createAppHistory(routerConfig);
  const services = createServices(storage, routerConfig);
  window.addEventListener("beforeunload", () => services.close?.());
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ServicesContext.Provider value={services}>
        <StoreProvider persisted={persisted} storage={storage}>
          <App history={history} routerConfig={routerConfig} />
        </StoreProvider>
      </ServicesContext.Provider>
    </StrictMode>,
  );
}

void boot();
