// Entry point. The state is read (URL hash, then browser storage, then the default theme) before
// the first render, so the first paint already has the right theme.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./studio.css";
import { App } from "./app.tsx";
import { loadState } from "./state/persist.ts";

// No top-level await: the build is a classic script (file:// cannot load ES modules).
void loadState(location.hash).then((initial) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App initial={initial} />
    </StrictMode>,
  );
});
