// A tab's section as its place's view word (DOC-21 §3.7): the section shown is `params.view`, so
// the URL ends with it (`…/history`) and Back, Forward or a link can show it. Changing the section
// replaces the tab's current step (TSK-105's links may push one instead). Without the shell's
// `navigate` (a screen in a test) the section is local state only.
import { useEffect, useState } from "react";
import type { LinkEvent, TabPlace, TabProps } from "@/tools/types";

export function viewOf<V extends string>(params: Record<string, unknown>, views: readonly V[], fallback: V): V {
  const view = params["view"];
  return typeof view === "string" && (views as readonly string[]).includes(view) ? (view as V) : fallback;
}

export function useTabView<V extends string>(props: { tab: TabProps["tab"]; navigate?: TabProps["navigate"] | undefined }, views: readonly V[], fallback: V): [V, (view: V) => void] {
  const { tab, navigate } = props;
  const fromTab = viewOf(tab.params, views, fallback);
  const [view, setView] = useState<V>(fromTab);
  // The tab moved (Back, Forward, a URL): show its section.
  useEffect(() => setView(fromTab), [fromTab]);
  const change = (next: V) => {
    setView(next);
    if (next !== fromTab) navigate?.({ kind: tab.kind, params: { ...tab.params, view: next }, title: tab.title }, { replace: true });
  };
  return [view, change];
}

/**
 * How a screen follows a link (DOC-21 §3.7): the shell's `go` (this tab, or another with Mod or
 * the middle button), else a tab of its own (a screen in a test without the shell).
 */
export function linkTo(props: Pick<TabProps, "go" | "openTab">): (place: TabPlace, event?: LinkEvent) => void {
  return (place, event) => (props.go ? props.go(place, event) : props.openTab(place));
}
