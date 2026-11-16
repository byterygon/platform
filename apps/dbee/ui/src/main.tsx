// Entry: one client over the auto-selected transport, the store, the app. Nothing here branches on
// the shell except through isTauri() in the shortcuts table and app.info.mode in About.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./app/App";
import { ServicesContext, createServices } from "./app/client";
import { applyAppearance } from "./app/presets";
import { load } from "./app/persistence";
import { StoreProvider } from "./app/store";

const persisted = load();
// Before the first paint, so the splash and the shell share the chosen appearance.
applyAppearance(persisted.settings);
const services = createServices();
window.addEventListener("beforeunload", () => services.close?.());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ServicesContext.Provider value={services}>
      <StoreProvider persisted={persisted}>
        <App />
      </StoreProvider>
    </ServicesContext.Provider>
  </StrictMode>,
);
