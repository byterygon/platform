// What the desktop shell tells the UI about the window (TSK-54). The shell sets
// `window.__DBEE_SHELL__ = { material: "mica" }` and fires `dbee:shell` only after it applied the
// material to the window (Windows 11, DWM accepted it); a browser, the server's UI, macOS, Linux
// and Windows 10 never get it, so the UI never guesses from the user agent.
//
// The UI lets the material show (data-material="mica" on <html>, which makes the canvas
// transparent) only when the shell applied it, the setting is on and the preset is the default
// (Aurora; the other presets keep their own backdrop, Open question in DOC-17).
import type { Preset } from "./presets";

export type ShellMaterial = "mica";

export const SHELL_EVENT = "dbee:shell";

interface ShellHost {
  __DBEE_SHELL__?: unknown;
}

/** The material the shell applied to the window, `null` when none (or not the desktop shell). */
export function shellMaterial(host: ShellHost = globalThis as ShellHost): ShellMaterial | null {
  const info = host.__DBEE_SHELL__;
  if (typeof info === "object" && info !== null && (info as { material?: unknown }).material === "mica") return "mica";
  return null;
}

/** Whether the canvas is transparent so the window material shows through. */
export function materialVisible(applied: ShellMaterial | null, enabled: boolean, preset: Preset): ShellMaterial | null {
  return applied !== null && enabled && preset === "default" ? applied : null;
}

/** Sets or clears `data-material` on the document root. */
export function applyMaterial(material: ShellMaterial | null, doc: Document = document): void {
  if (material === null) delete doc.documentElement.dataset["material"];
  else doc.documentElement.dataset["material"] = material;
}

/** Calls `listener` with the current material and again when the shell reports one. */
export function watchShell(listener: (material: ShellMaterial | null) => void, target: Pick<EventTarget, "addEventListener" | "removeEventListener"> = window): () => void {
  listener(shellMaterial());
  const handler = () => listener(shellMaterial());
  target.addEventListener(SHELL_EVENT, handler);
  return () => target.removeEventListener(SHELL_EVENT, handler);
}
