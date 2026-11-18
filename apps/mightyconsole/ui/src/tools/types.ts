// The UI side of the tool contract (Mightyconsole spec §2.2, §4.4): a tool is one module,
// `src/tools/<tool>/index.ts`, exporting a ToolModule. The shell knows tools only through
// `src/tools/registry.ts`, so a later plugin system can supply the same object.
import type { ComponentType, ReactNode } from "react";
import type { IconDefinition } from "@/lib/icons";
import type { MightyClient } from "@/app/client";
import type { ProfileRecord } from "@/profiles/record";

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
}

/** What a tab's component gets from the shell. */
export interface TabProps {
  tab: TabRecord;
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
  /** Saves a change to this tab's profile (its extras: templates, saved filters). */
  updateProfile?: (change: (record: ProfileRecord) => ProfileRecord) => Promise<void>;
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
}

export interface TabKind {
  /** The tab's title from its params. */
  title(params: Record<string, unknown>): string;
  Component: ComponentType<TabProps>;
}

/** A persisted tab (spec §3.2). */
export interface TabRecord {
  id: string;
  tool: string;
  profileId: string;
  /** One of the tool's tab kinds, e.g. `kafka.topic`. */
  kind: string;
  params: Record<string, unknown>;
  title: string;
  pinned: boolean;
}

/** An action a tool adds to the palette. */
export interface ToolAction {
  id: string;
  label: string;
  keywords?: readonly string[];
  /** Runs it on the selected profile's live handle. */
  run(context: { client: MightyClient; profile: ProfileRecord; connId: string }): void | Promise<void>;
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
  readonly tabKinds: Readonly<Record<string, TabKind>>;
  readonly actions: readonly ToolAction[];
  /** Opens the live handle (`<tool>.connect { profile: toConnect(record) }`). */
  connect(client: MightyClient, record: ProfileRecord): Promise<{ connId: string }>;
  /** Releases it (`<tool>.disconnect`). */
  disconnect(client: MightyClient, connId: string): Promise<void>;
}
