// Parts of the Workflows list from the TSK-91 mockup frame `temporal-workflows`: the Columns
// chooser (hide and reorder, kept per tab kind in this browser) and Save query (into the profile's
// saved queries, which the tree lists under Workflows, where its menu renames and deletes them).
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { ArrowDown, ArrowUp, ColumnTriple, Star } from "@/lib/icons";
import type { ResourceAction } from "../types";
import { savedQueriesOf, type SavedQuery } from "./profile";

/** The list's columns after Workflow ID (which always shows first). */
export const WORKFLOW_COLUMNS = [
  { id: "status", label: "Status" },
  { id: "type", label: "Type" },
  { id: "start", label: "Start" },
  { id: "close", label: "Close" },
  { id: "duration", label: "Duration" },
  { id: "taskQueue", label: "Task queue" },
  { id: "history", label: "History" },
  { id: "runId", label: "Run ID" },
] as const;
export type WorkflowColumn = (typeof WORKFLOW_COLUMNS)[number]["id"];

/** Which columns show, in which order. */
export interface ColumnChoice {
  order: WorkflowColumn[];
  hidden: WorkflowColumn[];
}

const DEFAULT_CHOICE: ColumnChoice = { order: WORKFLOW_COLUMNS.map((c) => c.id), hidden: [] };
const KNOWN = new Set<string>(WORKFLOW_COLUMNS.map((c) => c.id));

/** A stored choice made whole: unknown ids dropped, new columns added at the end. */
export function normalizeChoice(raw: unknown): ColumnChoice {
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const order = (Array.isArray(value["order"]) ? value["order"] : []).filter((id): id is WorkflowColumn => typeof id === "string" && KNOWN.has(id));
  const unique = [...new Set(order)];
  for (const c of WORKFLOW_COLUMNS) if (!unique.includes(c.id)) unique.push(c.id);
  const hidden = (Array.isArray(value["hidden"]) ? value["hidden"] : []).filter((id): id is WorkflowColumn => typeof id === "string" && KNOWN.has(id));
  return { order: unique, hidden: [...new Set(hidden)] };
}

/** The columns shown, in order. */
export function shownColumns(choice: ColumnChoice): WorkflowColumn[] {
  return choice.order.filter((id) => !choice.hidden.includes(id));
}

/** Moves a column one place up (-1) or down (+1). */
export function moveColumn(choice: ColumnChoice, id: WorkflowColumn, by: -1 | 1): ColumnChoice {
  const order = [...choice.order];
  const at = order.indexOf(id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= order.length) return choice;
  [order[at], order[to]] = [order[to]!, order[at]!];
  return { ...choice, order };
}

/** The choice kept per tab kind in this browser; the default when storage is empty or refused. */
export function useColumnChoice(kind: string): [ColumnChoice, (next: ColumnChoice) => void] {
  const key = `mightyconsole.columns.${kind}`;
  const [choice, setChoice] = useState<ColumnChoice>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? normalizeChoice(JSON.parse(raw)) : DEFAULT_CHOICE;
    } catch {
      return DEFAULT_CHOICE;
    }
  });
  const update = (next: ColumnChoice) => {
    setChoice(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // A private window or blocked storage: the choice lasts for this tab only.
    }
  };
  return [choice, update];
}

/** The Columns button beside Run: show, hide and reorder the columns. */
export function ColumnsButton({ choice, onChange }: { choice: ColumnChoice; onChange(next: ColumnChoice): void }) {
  const label = (id: WorkflowColumn) => WORKFLOW_COLUMNS.find((c) => c.id === id)!.label;
  return (
    <Popover>
      <PopoverTrigger render={<IconButton appearance="subtle" aria-label="Columns" />}>
        <Icon icon={ColumnTriple} />
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Columns">
        <PopoverTitle>Columns</PopoverTitle>
        <ul className="flex flex-col gap-stack-xs">
          {choice.order.map((id, i) => (
            <li key={id} className="flex items-center gap-inline-sm">
              <Field orientation="horizontal" className="min-w-0 flex-1">
                <Checkbox checked={!choice.hidden.includes(id)} onCheckedChange={(v) => onChange({ ...choice, hidden: v === true ? choice.hidden.filter((h) => h !== id) : [...choice.hidden, id] })} />
                <FieldLabel>{label(id)}</FieldLabel>
              </Field>
              <IconButton size="small" aria-label={`Move ${label(id)} up`} disabled={i === 0} onClick={() => onChange(moveColumn(choice, id, -1))}>
                <Icon icon={ArrowUp} />
              </IconButton>
              <IconButton size="small" aria-label={`Move ${label(id)} down`} disabled={i === choice.order.length - 1} onClick={() => onChange(moveColumn(choice, id, 1))}>
                <Icon icon={ArrowDown} />
              </IconButton>
            </li>
          ))}
        </ul>
        <Button size="small" appearance="subtle" className="self-start" onClick={() => onChange(DEFAULT_CHOICE)}>
          Reset to default
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/** Save query: names the query shown and keeps it in the profile; a saved one can be removed. */
export function SaveQueryButton({ query, saved, onSave, onRemove, disabled }: { query: string; saved: readonly SavedQuery[]; onSave(name: string): Promise<void>; onRemove(name: string): Promise<void>; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const existing = saved.find((s) => s.query === query);
  const clash = saved.find((s) => s.name === name.trim() && s.query !== query);
  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    try {
      await run();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setName(existing?.name ?? "");
      }}
    >
      <PopoverTrigger render={<Button appearance="secondary" disabled={disabled === true || query.trim() === ""} />}>
        <Icon icon={Star} /> {existing ? "Saved" : "Save query"}
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Save query">
        <form
          className="flex flex-col gap-stack-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void act(() => onSave(name.trim()));
          }}
        >
          <PopoverTitle>{existing ? `Saved as ${existing.name}` : "Save this query"}</PopoverTitle>
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input value={name} onValueChange={setName} placeholder="Failed today" autoComplete="off" autoFocus />
            <FieldDescription>{clash ? `Replaces the saved query "${clash.name}".` : "It shows under Workflows in the tree and in the query's suggestions."}</FieldDescription>
          </Field>
          <div className="flex items-center gap-inline-sm">
            <Button type="submit" size="small" appearance="primary" disabled={name.trim() === ""} loading={busy}>
              {existing ? "Rename" : "Save"}
            </Button>
            {existing ? (
              <Button size="small" appearance="subtle" onClick={() => void act(() => onRemove(existing.name))}>
                Remove
              </Button>
            ) : null}
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** The saved queries with `name` set to `query` (replacing one of that name or that query). */
export function withSaved(list: readonly SavedQuery[], name: string, query: string): SavedQuery[] {
  return [...list.filter((s) => s.name !== name && s.query !== query), { name, query }];
}

/** The saved queries with `from` named `to`, in the same place; unchanged when `from` is gone. */
export function renameSaved(list: readonly SavedQuery[], from: string, to: string): SavedQuery[] {
  return list.flatMap((s) => (s.name === to && s.name !== from ? [] : s.name === from ? [{ ...s, name: to }] : [s]));
}

/** Why `to` cannot be the new name of `from`, or null. */
export function renameError(list: readonly SavedQuery[], from: string, to: string): string | null {
  if (to === "") return "A name is required.";
  return to !== from && list.some((s) => s.name === to) ? `A saved query is already named "${to}".` : null;
}

/** A saved query's Rename and Delete in the tree's context menu (TSK-95). */
export function savedQueryActions(name: string, list: readonly SavedQuery[]): ResourceAction[] {
  return [
    {
      label: "Rename saved query…",
      prompt: { title: `Rename "${name}"`, label: "Name", value: name, submit: "Rename", validate: (to) => renameError(list, name, to) },
      run: ({ value, updateProfile }) => updateProfile((r) => ({ ...r, extras: { ...r.extras, savedQueries: renameSaved(savedQueriesOf(r.extras), name, value) } })),
    },
    {
      // Named in full: the profile's own Delete is in the same menu.
      label: "Delete saved query…",
      danger: true,
      confirm: { title: `Delete the saved query "${name}"?`, description: "It leaves the tree and the query's suggestions. Tabs showing its results stay open.", submit: "Delete" },
      run: ({ updateProfile }) => updateProfile((r) => ({ ...r, extras: { ...r.extras, savedQueries: savedQueriesOf(r.extras).filter((s) => s.name !== name) } })),
    },
  ];
}
