// Routing (DOC-21 §3.7, TSK-101): TanStack Router with code-based routes on one of three
// histories. The browser history is the default; the server's `--router hash` and `--base-path`
// reach the page as two `<meta>` (§2.3); memory is for tests and embedding. The shell owns `/`,
// `/<tool>` and `/<tool>/<profile name>`; under the profile each tool adds its subtree from its
// ToolModule. Routes carry `staticData.crumb` (the breadcrumb label of TSK-105) and the places
// `staticData.place` (the tab place the URL names). The tab model stays the source of truth: the
// shell's route sync (`useRouteSync` in App.tsx) keeps the URL on the active tab's place.
import {
  type AnyRoute,
  type AnyRouter,
  type ParsedLocation,
  type RouterHistory,
  createBrowserHistory,
  createHashHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { ProfileRecord } from "@/profiles/record";
import type { PlaceHref, TabPlace, ToolModule } from "@/tools/types";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** The breadcrumb label of this level (TSK-105 draws it from `useMatches`). */
    crumb?: (params: Record<string, string>) => string;
    /**
     * A route that is a place: the tab kind and params its URL names, or `null` when the params do
     * not make one. Its tool's tab kind gives the URL back with `href`.
     */
    place?: (params: Record<string, string>, search: Record<string, unknown>) => Omit<TabPlace, "title"> | null;
  }
}

/** What a browser entry's history state says about its tab (DOC-21 §3.7). */
export interface EntryState {
  /** The tab the entry shows, and its step in the tab's history. */
  mcTab?: string;
  mcStep?: number;
  __TSR_index?: number;
}

export type RouterMode = "browser" | "hash" | "memory";

export interface RouterConfig {
  mode: RouterMode;
  /** `""` or a path such as `/mc` (no trailing slash). */
  basePath: string;
}

/** The `<meta>` names the server writes (`static_ui::ROUTER_META`, `BASE_META`). */
export const ROUTER_META = "mightyconsole-router";
export const BASE_META = "mightyconsole-base";

/** A base path as the server accepts it: `/`-led segments of unreserved characters. */
export const BASE_PATH = /^(\/[A-Za-z0-9_~-]+)+$/;

/** The page's mode and base path; browser at `/` when the server wrote none (Vite's dev server). */
export function readRouterConfig(doc: Document = document): RouterConfig {
  const meta = (name: string) => doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? "";
  const mode = meta(ROUTER_META);
  const base = meta(BASE_META);
  return { mode: mode === "hash" || mode === "memory" ? mode : "browser", basePath: BASE_PATH.test(base) ? base : "" };
}

export function createAppHistory(config: RouterConfig, initialEntries: string[] = ["/"]): RouterHistory {
  switch (config.mode) {
    case "hash":
      return createHashHistory();
    case "memory":
      return createMemoryHistory({ initialEntries });
    case "browser":
      return createBrowserHistory();
  }
}

/** The Ambidex WebSocket under the base path (§2.3). */
export function webSocketUrl(config: RouterConfig, host: string = location.host): string {
  return `wss://${host}${config.basePath}/rpc/ws`;
}

/** Percent-encodes one path segment (also `/`, `?`, `#` and `%`). */
export const segment = (value: string): string => encodeURIComponent(value);

/** A tool's place URL from its segments: `path("orders", "workflows")`. */
export function path(...segments: string[]): string {
  return segments.map(segment).join("/");
}

/** A string param, or `""`. */
export const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** A short search value, or nothing (DOC-21 §3.7: long filters stay in the tab). */
export const SEARCH_MAX = 200;
export function shortSearch(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" && value.length <= SEARCH_MAX ? value : undefined;
}

/** `validateSearch` for routes that read string values only: anything else is dropped. */
export function stringSearch<K extends string>(...keys: K[]): (search: Record<string, unknown>) => Partial<Record<K, string>> {
  return (search) => {
    const out: Partial<Record<K, string>> = {};
    for (const key of keys) {
      const value = search[key];
      if (typeof value === "string" && value !== "") out[key] = value;
      else if (typeof value === "number") out[key] = String(value);
    }
    return out;
  };
}

/**
 * A place route whose last segment is its view word, e.g. echo's `ping` or a list under a parent
 * route. `place` gives the tab place from the path params and the validated search.
 */
export function placeRoute(
  parent: AnyRoute,
  path: string,
  crumb: string | ((params: Record<string, string>) => string),
  place: (params: Record<string, string>, search: Record<string, unknown>) => Omit<TabPlace, "title"> | null,
  options: { validateSearch?: (search: Record<string, unknown>) => Record<string, unknown>; children?: (self: AnyRoute) => readonly AnyRoute[] } = {},
): AnyRoute {
  const route = createRoute({
    getParentRoute: () => parent,
    path,
    ...(options.validateSearch ? { validateSearch: options.validateSearch } : {}),
    staticData: { crumb: typeof crumb === "string" ? () => crumb : crumb, place },
  }) as unknown as AnyRoute;
  const children = options.children?.(route) ?? [];
  return children.length > 0 ? (route.addChildren(children as AnyRoute[]) as AnyRoute) : route;
}

/** A level of the path that is not a place itself (a namespace, a workflow): only a crumb. */
export function levelRoute(parent: AnyRoute, path: string, crumb: (params: Record<string, string>) => string, children: (self: AnyRoute) => readonly AnyRoute[]): AnyRoute {
  const route = createRoute({ getParentRoute: () => parent, path, staticData: { crumb } }) as unknown as AnyRoute;
  return route.addChildren(children(route) as AnyRoute[]) as AnyRoute;
}

/**
 * The route tree: `/` (start), `/<tool>`, `/<tool>/$profile` and each tool's subtree. `Root` is
 * the whole shell: leaf routes render nothing, the tab model draws the screens.
 */
export function buildRouteTree(tools: readonly ToolModule[], Root: () => ReactNode): AnyRoute {
  const root = createRootRoute({ component: Root, staticData: { crumb: () => "Mightyconsole" } });
  const start = createRoute({ getParentRoute: () => root, path: "/" });
  const toolRoutes = tools.map((tool) => {
    const toolRoute = createRoute({ getParentRoute: () => root, path: tool.id, staticData: { crumb: () => tool.label } });
    const profileRoute = createRoute({ getParentRoute: () => toolRoute, path: "$profile", staticData: { crumb: (params) => params["profile"] ?? "" } });
    const children = tool.routes?.(profileRoute as unknown as AnyRoute) ?? [];
    return toolRoute.addChildren([children.length > 0 ? profileRoute.addChildren(children as AnyRoute[]) : profileRoute]);
  });
  return root.addChildren([start, ...toolRoutes]) as unknown as AnyRoute;
}

/**
 * Search params as plain strings (TanStack's default reads JSON, so `?run=123` would become a
 * number and a quoted query would lose its quotes).
 */
export function parseSearch(search: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(search)) out[key] = value;
  return out;
}

export function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === "string" && value !== "") params.set(key, value);
    else if (typeof value === "number" || typeof value === "boolean") params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function createAppRouter(tools: readonly ToolModule[], Root: () => ReactNode, history: RouterHistory, config: RouterConfig): AnyRouter {
  return createRouter({
    routeTree: buildRouteTree(tools, Root),
    history,
    parseSearch,
    stringifySearch,
    // The hash holds the routes in hash mode; the page's own path is the base path.
    ...(config.mode === "browser" && config.basePath ? { basepath: config.basePath } : {}),
  }) as unknown as AnyRouter;
}

/** What a URL names (DOC-21 §3.7). */
export type UrlTarget =
  | { type: "start" }
  | { type: "tool"; tool: string; profileName?: string }
  | { type: "place"; tool: string; profileName: string; place: Omit<TabPlace, "title"> };

/** The target of a location: a place when a place route matched all of it, else its tool, else the start. */
export function targetOf(router: AnyRouter, location: Pick<ParsedLocation, "pathname" | "search">, tools: readonly ToolModule[]): UrlTarget {
  const matches = router.matchRoutes(location.pathname, location.search as Record<string, unknown>) as unknown as {
    routeId: string;
    params: Record<string, string>;
    search: Record<string, unknown>;
    staticData: { place?: (params: Record<string, string>, search: Record<string, unknown>) => Omit<TabPlace, "title"> | null };
    _notFound?: boolean;
  }[];
  const notFound = matches.some((m) => m._notFound);
  const first = location.pathname.split("/").find((s) => s !== "");
  const tool = first !== undefined ? tools.find((t) => t.id === first) : undefined;
  if (!tool) return { type: "start" };
  const leaf = matches[matches.length - 1];
  const profileName = leaf?.params["profile"];
  if (!notFound && leaf?.staticData.place && profileName) {
    const place = leaf.staticData.place(leaf.params, leaf.search);
    if (place && tool.tabKinds[place.kind]) return { type: "place", tool: tool.id, profileName, place };
  }
  return profileName ? { type: "tool", tool: tool.id, profileName } : { type: "tool", tool: tool.id };
}

/** The router-internal href (no base path) of a tab place, or `/<tool>` when its kind has no URL. */
export function placeHref(tool: ToolModule, profile: Pick<ProfileRecord, "name"> | undefined, place: Pick<TabPlace, "kind" | "params">): string {
  const href: PlaceHref | null | undefined = profile ? tool.tabKinds[place.kind]?.href?.(place.params) : null;
  if (!profile || !href) return `/${tool.id}`;
  return `/${tool.id}/${segment(profile.name)}/${href.path}${stringifySearch(href.search ?? {})}`;
}
