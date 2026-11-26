// Entry: a signed-out page shows the sign-in; a session that must change its password, set up
// two-step sign-in or has no role yet sees that instead of the app; then the browser storage
// (IndexedDB, or memory with a warning), the persisted tabs, layout and settings, the router's mode
// and base path from the page (DOC-21 §3.7), one client over the WebSocket under that base path,
// the store, the shell.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./app/App";
import { Gate, gateApi, gateDecision } from "./app/account-gate";
import { ServicesContext, createServices } from "./app/client";
import { ConfirmationHost } from "./app/confirmations";
import { DEFAULT_APPEARANCE, applyAppearance } from "./app/presets";
import { createAppHistory, readRouterConfig } from "./app/router";
import { signOut } from "./app/session";
import { RETURN_CHANNEL, RETURN_PARAM, signInState } from "./app/sign-in";
import { SignInPage, SignedInTab } from "./app/sign-in-page";
import { StoreProvider, loadPersisted } from "./app/store";
import { openStorage } from "./profiles/storage";
import { TOOLS, orderedTools } from "./tools/registry";

/** The sign-in tab of a running app is done: it tells the app's tab, then closes. */
function tellOpener(): void {
  if (typeof BroadcastChannel === "function") {
    const channel = new BroadcastChannel(RETURN_CHANNEL);
    channel.postMessage("signed-in");
    channel.close();
  }
  window.close();
}

async function boot(): Promise<void> {
  const root = createRoot(document.getElementById("root")!);
  // The pages before the app follow the system scheme; the person's own settings load with the app.
  applyAppearance(DEFAULT_APPEARANCE);
  // Signed out (DOC-25 §3.2.5): the sign-in page, which waits for a click; the app needs a session.
  const signIn = signInState();
  if (signIn.kind === "page") {
    root.render(
      <StrictMode>
        <SignInPage state={signIn} />
      </StrictMode>,
    );
    return;
  }
  // The tab a running app opened to sign in again: it has done its job.
  if (new URLSearchParams(window.location.search).get(RETURN_PARAM) === "1") {
    root.render(<SignedInTab onClose={tellOpener} />);
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
  // A session that must change its password, set up TOTP or has no role does that first (DOC-25 §3.2.6).
  const api = gateApi(services.client);
  const me = await api.me().catch(() => null);
  if (me !== null && gateDecision(me) !== "ready") {
    root.render(
      <StrictMode>
        <Gate api={api} me={me} done={() => window.location.reload()} signOut={() => void signOut(routerConfig.basePath)} />
      </StrictMode>,
    );
    return;
  }
  root.render(
    <StrictMode>
      <ServicesContext.Provider value={services}>
        <StoreProvider persisted={persisted} storage={storage}>
          <App history={history} routerConfig={routerConfig} />
          {services.confirmations ? <ConfirmationHost gate={services.confirmations} client={services.client} onSignInAgain={() => void signOut(routerConfig.basePath)} /> : null}
        </StoreProvider>
      </ServicesContext.Provider>
    </StrictMode>,
  );
}

void boot();
