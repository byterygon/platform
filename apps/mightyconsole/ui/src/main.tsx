// Entry: a signed-out page shows the sign-in first, and a session that must change its password
// or set up TOTP does that; then the browser storage (IndexedDB, or memory with a warning), the persisted tabs, layout and
// settings, the router's mode and base path from the page (DOC-21 §3.7), one client over the
// WebSocket under that base path, the store, the shell.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./app/App";
import { ServicesContext, createServices } from "./app/client";
import { ConfirmationHost } from "./app/confirmations";
import { applyAppearance } from "./app/presets";
import { createAppHistory, readRouterConfig } from "./app/router";
import { accountGate, gateApi } from "./app/account-gate";
import { renderSignInFailure, renderSignInForm, signInState } from "./app/sign-in";
import { StoreProvider, loadPersisted } from "./app/store";
import { openStorage } from "./profiles/storage";
import { TOOLS, orderedTools } from "./tools/registry";

async function boot(): Promise<void> {
  // Signed out (DOC-25 §3.2.5): the sign-in form, the IdP, or why it failed; the app needs a
  // session.
  const root = document.getElementById("root")!;
  const signIn = signInState();
  if (signIn.kind === "redirect") {
    window.location.replace(signIn.to);
    return;
  }
  if (signIn.kind === "failed") {
    renderSignInFailure(root, signIn);
    return;
  }
  if (signIn.kind === "form") {
    renderSignInForm(root, signIn);
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
  // A session that must change its password or set up TOTP does that first (DOC-25 §3.2.6).
  if (!(await accountGate(root, gateApi(services.client)))) return;
  createRoot(root).render(
    <StrictMode>
      <ServicesContext.Provider value={services}>
        <StoreProvider persisted={persisted} storage={storage}>
          <App history={history} routerConfig={routerConfig} />
          {services.confirmations ? <ConfirmationHost gate={services.confirmations} client={services.client} /> : null}
        </StoreProvider>
      </ServicesContext.Provider>
    </StrictMode>,
  );
}

void boot();
