// Entry: one client over the auto-selected transport, the workspace's tabs and settings, the store,
// the app. Nothing here branches on the shell except through isTauri() in the shortcuts table and
// app.info.mode in About.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./app/App";
import { ServicesContext, createServices } from "./app/client";
import { applyAppearance } from "./app/presets";
import { StoreProvider } from "./app/store";
import { loadWorkspace } from "./app/workspace";

const services = createServices();

// The tabs and settings come from the workspace (app.getWorkspace) before the first render, so the
// shell opens with them and the chosen appearance.
async function boot(): Promise<void> {
  const { persisted, saver } = await loadWorkspace(services.client);
  applyAppearance(persisted.settings);
  // Pending changes are written when the page goes away: the call is sent before the transport
  // closes (flush starts it synchronously when no other write is in flight).
  window.addEventListener("pagehide", () => void saver.flush());
  window.addEventListener("beforeunload", () => void saver.flush().finally(() => services.close?.()));

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ServicesContext.Provider value={services}>
        <StoreProvider persisted={persisted} saver={saver}>
          <App />
        </StoreProvider>
      </ServicesContext.Provider>
    </StrictMode>,
  );
}

void boot();
