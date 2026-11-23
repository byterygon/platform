// The UI side of the tool contract (Mightyconsole spec §2.2, §4.4): a tool is one module,
// `src/tools/<tool>/index.ts`, exporting a ToolModule. The shell knows tools only through
// `src/tools/registry.ts`, so a later plugin system can supply the same object.
import type { AnyRoute } from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";
import type { IconDefinition } from "@/lib/icons";
import type { MightyClient } from "@/app/client";
import type { ProfileRecord } from "@/profiles/record";
import type { HostKeyDetails, HostKeyFingerprint } from "@/gen/api";

/** Field errors by field name, as TanStack Form or a plain form shows them. */
export type FieldErrors = Record<string, string>;

/** A tool's versioned profile schema (spec §4.4). */
export interface ProfileSchema {
  /** The version the app writes. v0.1 ships version 1 everywhere. */
  readonly version: number;
  /** A new profile's fields, secrets and extras. */
  defaults(): Pick<ProfileRecord, "fields" | "secrets" | "extras">;
  /** Field errors of a record; empty when it is valid. */
  validate(record: ProfileRecord): FieldErrors;
  /** `migrations[n]` turns a version-n record into version n + 1. */
  readonly migrations: Readonly<Record<number, (record: ProfileRecord) => ProfileRecord>>;
  /** The server's `Connect<Tool>Profile` input, versioned with the API, not with the record. */
  toConnect(record: ProfileRecord): unknown;
}

/** Props of a tool's connection form: the tool's own fields; name and colour are the shell's. */
export interface ConnectionFormProps {
  fields: Record<string, unknown>;
  secrets: Record<string, unknown>;
  /** Which secrets the stored record holds, for "Set" / "Not set" (write-only display). */
  storedSecrets: ReadonlySet<string>;
  errors: FieldErrors;
  onFields(patch: Record<string, unknown>): void;
  onSecrets(patch: Record<string, unknown>): void;
  disabled?: boolean;
  /** The saved profile's id (none while it is being added): the Temporal codec endpoint's path names it. */
  profileId?: string;
  /** The server, for checks the form runs on its draft (Temporal's Test codec). */
  client?: MightyClient;
  /** The record as it would be saved now. */
  draft?: () => ProfileRecord;
}

/** A node under a connected profile in the sidebar (the tool's resource tree). */
export interface ResourceNode {
  id: string;
  label: string;
  icon?: ReactNode;
  meta?: ReactNode;
  /** The tab this node opens on Enter or double-click. */
  open?: { kind: string; params: Record<string, unknown>; title: string };
  children?: readonly ResourceNode[];
  /** Opens the first time the node shows (the person can close it after). */
  expanded?: boolean;
  /** Items of the tree's context menu for this node (a saved query's Rename and Delete). */
  actions?: readonly ResourceAction[];
}

/**
 * A context-menu item of a resource node. The shell asks first when the item says so (a name in a
 * dialog, or a confirmation), then calls `run` with the answer and a way to change the profile.
 */
export interface ResourceAction {
  label: string;
  danger?: boolean;
  /** A dialog with one text field before `run` (Rename): `validate` returns the field's error. */
  prompt?: { title: string; label: string; value: string; submit: string; validate?: (value: string) => string | null };
  /** A confirmation before `run` (Delete). */
  confirm?: { title: string; description: string; submit: string };
  run(context: { value: string; updateProfile(change: (record: ProfileRecord) => ProfileRecord): Promise<void> }): Promise<void> | void;
}

/**
 * Data a tool's tree shows once a profile is connected (counts, the namespaces of a cluster): the
 * shell calls `load` for each connected profile, and draws the tree again when `version` changes.
 * `load` is called often; the tool loads once per connection.
 */
export interface SidebarData {
  load(context: { profile: ProfileRecord; connId: string; client: MightyClient }): void;
  subscribe(onChange: () => void): () => void;
  version(): number;
}

/** What a tab's component gets from the shell. */
export interface TabProps {
  tab: TabView;
  profile: ProfileRecord;
  /** The live handle, `null` while the profile is not connected (the Disconnected state). */
  connId: string | null;
  client: MightyClient;
  /** Whether this tab is the one shown. */
  active: boolean;
  /** Registers the handlers of the shell's tab actions (Mod+Enter, Shift+Escape, …). */
  useTabActions(handlers: TabActionHandlers): void;
  /** Reports the tab's live state for the tab strip and the status bar. */
  onLive(live: LiveState | null): void;
  /** Records an error in About's diagnostics and returns how to show it. */
  note(error: unknown): DescribedError;
  /** Opens (or focuses) another tab of this tool and profile, e.g. a thread from a list of threads. */
  openTab(open: { kind: string; params: Record<string, unknown>; title: string }): void;
  /**
   * Moves this tab to another place of its tool and profile (DOC-21 §3.7): a step in the tab's own
   * back and forward history, or with `replace` a change of the current step (a section shown).
   */
  navigate?: (place: TabPlace, options?: { replace?: boolean }) => void;
  /**
   * Follows a link inside the page (DOC-21 §3.7, TSK-105): a step in this tab, or another tab
   * (opened or focused) when the event asks for one, Mod+click or the middle button.
   */
  go?: (place: TabPlace, event?: LinkEvent) => void;
  /** Saves a change to this tab's profile (its extras: templates, saved filters). */
  updateProfile?: (change: (record: ProfileRecord) => ProfileRecord) => Promise<void>;
}

/** What a link's click says about where it opens: Ctrl or Cmd held, the middle button. */
export interface LinkEvent {
  ctrlKey?: boolean;
  metaKey?: boolean;
  button?: number;
}

/** The shell's per-tab actions (spec §3.4). */
export interface TabActionHandlers {
  primary?: () => void;
  stop?: () => void;
  pause?: () => void;
  clear?: () => void;
  refresh?: () => void;
  find?: () => void;
}

/** The tab's live view, for the status bar ("Live · 1,240 msg/s · 3 dropped"). */
export interface LiveState {
  status: "live" | "paused" | "ended";
  ratePerSec?: number;
  dropped?: number;
  buffered?: number;
  reason?: string;
}

/** An error as the UI shows it (spec §2.6). */
export interface DescribedError {
  title: string;
  description?: string;
  code?: string;
  correlationId?: string;
  kind?: string;
  remoteCode?: string;
  /** For `HostKey`: the key the host presented (spec §10.2), for the trust dialog. */
  hostKey?: HostKeyDetails;
  /** The target's error name, when the tool gives one (`StandaloneActivitiesUnsupported`). */
  remoteName?: string;
}

/** Where a tab is: one of its tool's tab kinds with its params (DOC-21 §3.7). */
export interface TabPlace {
  kind: string;
  params: Record<string, unknown>;
  title: string;
}

/** A tab place's URL under `/<tool>/<profile name>/` (DOC-21 §3.7). */
export interface PlaceHref {
  /** Percent-encoded segments ending with a view word, e.g. `orders/workflows/order-1/history`. */
  path: string;
  /** Short identity values only: never a secret, a payload or a form value. */
  search?: Record<string, string>;
}

export interface TabKind {
  /** The tab's title from its params. */
  title(params: Record<string, unknown>): string;
  Component: ComponentType<TabProps>;
  /**
   * The URL of a place of this kind, matching a route of the tool's `routes` whose
   * `staticData.place` gives the params back. A kind without one keeps the URL at `/<tool>`.
   */
  href?(params: Record<string, unknown>): PlaceHref | null;
}

/** A tab's own back and forward history (DOC-21 §3.7): at most 50 places. */
export interface TabHistory {
  entries: TabPlace[];
  index: number;
}

/** A persisted tab (spec §3.2, §3.7): `kind`, `params` and `title` are `history.entries[history.index]`. */
export interface TabRecord {
  id: string;
  tool: string;
  profileId: string;
  /** One of the tool's tab kinds, e.g. `kafka.topic`. */
  kind: string;
  params: Record<string, unknown>;
  title: string;
  pinned: boolean;
  /**
   * A preview tab (DOC-21 §3.2.1): opened by a single click in the tree and replaced by the next
   * one, its title in italics, until something keeps it (a double click, Keep open, state to lose).
   */
  preview?: boolean;
  history: TabHistory;
}

/** A tab as its screen sees it: the history is the shell's. */
export type TabView = Omit<TabRecord, "history">;

/** An action a tool adds to the palette. */
export interface ToolAction {
  id: string;
  label: string;
  keywords?: readonly string[];
  /** Runs it on the selected profile's live handle. */
  run(context: { client: MightyClient; profile: ProfileRecord; connId: string; openTab(open: { kind: string; params: Record<string, unknown>; title: string }): void }): void | Promise<void>;
}

/**
 * The navigation's groups (DOC-21 Open question 45 (a)): what a tool is for. A tool without one
 * sits under "Other".
 */
export type ToolCategory = "Messaging" | "Infrastructure" | "Workflows and agents" | "Other";

export interface ToolModule {
  /** The server namespace: `echo`, `nats`, `kafka`, `k8s`, `temporal`, `docker`, `langgraph`. */
  readonly id: string;
  readonly label: string;
  /** A Fluent icon: the fallback when the tool has no `mark`, and its sign wherever a mark is not wanted. */
  readonly icon: IconDefinition;
  /**
   * The tool's own mark from `src/tools/marks.ts` (vendored, sha256-pinned, notices in
   * `marks/NOTICE.md`), drawn monochrome by the Icon component. Optional: `toolIcon` falls back to `icon`.
   */
  readonly mark?: IconDefinition;
  /** The navigation group; `toolCategory` gives "Other" when it is missing. */
  readonly category?: ToolCategory;
  /** Position in the navigation, lower first; tools without one follow in registry order. */
  readonly order?: number;
  /** "No Kafka connections yet" uses the label; this line explains the tool. */
  readonly description: string;
  readonly profile: ProfileSchema;
  readonly ConnectionForm: ComponentType<ConnectionFormProps>;
  /** The resource tree under a connected profile. */
  sidebarTree(context: { profile: ProfileRecord; connId: string }): readonly ResourceNode[];
  /** What the tree loads after connecting; none when absent. */
  readonly sidebarData?: SidebarData;
  readonly tabKinds: Readonly<Record<string, TabKind>>;
  /**
   * The tool's routes under `/<tool>/<profile name>` (DOC-21 §3.7), built with `createRoute` on the
   * given parent: each with `staticData.crumb`, the places with `staticData.place`. Optional: a
   * tool without routes keeps working, its tabs' URL staying at `/<tool>`.
   */
  routes?(profileRoute: AnyRoute): readonly AnyRoute[];
  readonly actions: readonly ToolAction[];
  /** Opens the live handle (`<tool>.connect { profile: toConnect(record) }`). */
  connect(client: MightyClient, record: ProfileRecord): Promise<{ connId: string }>;
  /** Releases it (`<tool>.disconnect`). */
  disconnect(client: MightyClient, connId: string): Promise<void>;
  /**
   * For a tool that connects over SSH (spec §10.2): the record trusting `key`. The shell calls it
   * when the person trusts the key a `HostKey` error named, saves the record and connects again.
   */
  trustHostKey?(record: ProfileRecord, key: HostKeyFingerprint): ProfileRecord;
  /** `host:port` of the record, for the trust dialog. */
  targetOf?(record: ProfileRecord): string;
}
