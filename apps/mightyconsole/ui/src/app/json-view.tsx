import { useCallback } from "react";
import { JsonViewer, type JsonViewerMode, type JsonViewerProps } from "@/components/ui/json-viewer";
import { useStoreIfAny } from "@/app/store";

// Every JSON value in Mightyconsole is shown by this one component (TSK-112): Byterygon UI's
// JsonViewer (toolbar with Copy, Expand all, Collapse all, Find, and a Tree | Text switch) with
// the choice of view remembered in the workspace settings, per `modeKey`, so a view that was left
// in Text opens in Text again after a reload. `defaultMode` is the view before any choice (a
// request or an event as stored reads best as text). Code that is not data (a command, a snippet)
// stays CodeBlock; a test (test/json-views.test.ts) fails on a CodeBlock with language json that
// shows data.

export interface JsonViewProps extends Omit<JsonViewerProps, "mode" | "onModeChange"> {
  /** Names the view in the settings: one key per place that shows JSON ("temporal.activity.input"). */
  modeKey: string;
}

export function JsonView({ modeKey, defaultMode = "tree", ...props }: JsonViewProps) {
  const app = useStoreIfAny();
  const chosen = app?.state.settings.jsonModes[modeKey];
  const dispatch = app?.dispatch;
  const jsonModes = app?.state.settings.jsonModes;
  const onModeChange = useCallback(
    (mode: JsonViewerMode) => dispatch?.({ type: "settings", settings: { jsonModes: { ...jsonModes, [modeKey]: mode } } }),
    [dispatch, jsonModes, modeKey],
  );
  if (!app) return <JsonViewer defaultMode={defaultMode} {...props} />;
  return <JsonViewer mode={chosen ?? defaultMode} onModeChange={onModeChange} {...props} />;
}
