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
import type { MightyClient } from "@/app/client";
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
    /**
     * The places beside this level (TSK-105): the namespaces of a cluster, a workflow's recent
     * neighbours. Picking one replaces this level's params in the URL and keeps the rest.
     */
    siblings?: (context: SiblingContext) => Promise<SiblingList>;
  }
}

/** What a route's `siblings` gets: the segment's params and the tab's profile and handle. */
export interface SiblingContext {
  params: Record<string, string>;
  profile: ProfileRecord;
  client: MightyClient;
  /** `null` while the profile is not connected. */
  connId: string | null;
}

export interface Sibling {
  label: string;
  /** A short note beside it ("6 schedules", "Running"). */
  description?: string;
  /** The path params it replaces, e.g. `{ namespace: "payments" }`. */
  params: Record<string, string>;
  /** Search keys it sets; `undefined` drops one (a workflow's `run`). */
  search?: Record<string, string | undefined>;
}

export interface SiblingList {
  /** The menu's heading: "Namespaces of prod-cluster". */
  heading: string;
  items: Sibling[];
  /** The whole list as a place: "All namespaces…". */
  all?: { label: string; place: Omit<TabPlace, "title"> };
}

/** A segment of the navigation row's breadcrumb: one matched route below the tool (DOC-21 §3.7). */
export interface RouteCrumb {
  routeId: string;
  label: string;
  /** The route's params (the location's, down to this level). */
  params: Record<string, string>;
  /** The router href of this level when it is a place; the leaf keeps the search. */
  href: string | null;
  place: Omit<TabPlace, "title"> | null;
  /** The profile's own segment. */
  profile: boolean;
  siblings?: (context: SiblingContext) => Promise<SiblingList>;
}

interface Match {
  routeId: string;
  fullPath: string;
  pathname: string;
  params: Record<string, string>;
  search: Record<string, unknown>;
  staticData: { crumb?: (params: Record<string, string>) => string; place?: (params: Record<string, string>, search: Record<string, unknown>) => Omit<TabPlace, "title"> | null; siblings?: (context: SiblingContext) => Promise<SiblingList> };
  _notFound?: boolean;
}

function matchesOf(router: AnyRouter, href: string): { matches: Match[]; search: Record<string, unknown> } {
  const q = href.indexOf("?");
  const pathname = q < 0 ? href : href.slice(0, q);
  const search = parseSearch(q < 0 ? "" : href.slice(q));
  return { matches: router.matchRoutes(pathname, search) as unknown as Match[], search };
}

/**
 * The breadcrumb of a router href (DOC-21 §3.7): its matched routes from the profile down (the
 * root and the tool are left out), each with its label, and its href when it is a place.
 */
export function crumbsOf(router: AnyRouter, href: string): RouteCrumb[] {
  const { matches, search } = matchesOf(router, href);
  if (matches.some((m) => m._notFound)) return [];
  const below = matches.slice(2);
  return below.map((m, i) => {
    const leaf = i === below.length - 1;
    const place = m.staticData.place?.(m.params, leaf ? search : {}) ?? null;
    const crumb: RouteCrumb = {
      routeId: m.routeId,
      label: m.staticData.crumb?.(m.params) ?? "",
      params: m.params,
      href: place ? (leaf ? href : m.pathname.replace(/\/$/, "")) : null,
      place,
      profile: i === 0,
    };
    if (m.staticData.siblings) crumb.siblings = m.staticData.siblings;
    return crumb;
  });
}

/** `fullPath` with its `$params` filled in, each percent-encoded. */
function interpolate(fullPath: string, params: Record<string, string>): string {
  return fullPath
    .split("/")
    .map((s) => (s.startsWith("$") ? segment(params[s.slice(1)] ?? "") : s))
    .join("/")
    .replace(/\/$/, "");
}

/**
 * The href of `href` with some params replaced (a sibling picked): the rest of the path and the
 * search stay, so the view does; `search` sets keys, `undefined` drops one.
 */
export function withParams(router: AnyRouter, href: string, params: Record<string, string>, search: Record<string, string | undefined> = {}): string | null {
  const { matches, search: current } = matchesOf(router, href);
  const leaf = matches[matches.length - 1];
  if (!leaf || matches.some((m) => m._notFound)) return null;
  const next: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(search)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return interpolate(leaf.fullPath, { ...leaf.params, ...params }) + stringifySearch(next);
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

/** A level of the path that is not a place itself (a namespace, a workflow): a crumb, maybe siblings. */
export function levelRoute(
  parent: AnyRoute,
  path: string,
  crumb: (params: Record<string, string>) => string,
  children: (self: AnyRoute) => readonly AnyRoute[],
  siblings?: (context: SiblingContext) => Promise<SiblingList>,
): AnyRoute {
  const route = createRoute({ getParentRoute: () => parent, path, staticData: { crumb, ...(siblings ? { siblings } : {}) } }) as unknown as AnyRoute;
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

/** The target of a router href (no base path): a crumb's or a sibling's. */
export function targetOfHref(router: AnyRouter, href: string, tools: readonly ToolModule[]): UrlTarget {
  const q = href.indexOf("?");
  return targetOf(router, { pathname: q < 0 ? href : href.slice(0, q), search: parseSearch(q < 0 ? "" : href.slice(q)) as never }, tools);
}

/** The router-internal href (no base path) of a tab place, or `/<tool>` when its kind has no URL. */
export function placeHref(tool: ToolModule, profile: Pick<ProfileRecord, "name"> | undefined, place: Pick<TabPlace, "kind" | "params">): string {
  const href: PlaceHref | null | undefined = profile ? tool.tabKinds[place.kind]?.href?.(place.params) : null;
  if (!profile || !href) return `/${tool.id}`;
  return `/${tool.id}/${segment(profile.name)}/${href.path}${stringifySearch(href.search ?? {})}`;
}
