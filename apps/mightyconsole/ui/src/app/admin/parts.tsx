// Pieces the three Users and roles screens share: loading with a reload, a failure shown in place,
// and the "where it applies" choice of an assignment (everywhere, or some profiles, or one profile's
// namespaces, DOC-25 §3.3.3).
import { useCallback, useEffect, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { MightyClient } from "../client";
import { describeError } from "../messages";
import { ErrorState } from "../states";
import { scopeOf } from "./admin";

export interface Loaded<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload(): void;
}

/** Runs `load` now and again on `reload()`; a stale answer is dropped. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => mine === seq.current && setState({ data, error: null, loading: false }),
      (error: unknown) => mine === seq.current && setState((s) => ({ ...s, error, loading: false })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, reload };
}

/** A failed load or action, in place: a refusal reads as one, anything else as the error it is. */
export function Failure({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return <ErrorState error={describeError(error)} {...(onRetry ? { onRetry } : {})} />;
}

export interface ProfileChoice {
  id: string;
  name: string;
  tool: string;
}

/** The stored profiles an assignment can be limited to. */
export function useProfileChoices(client: MightyClient): ProfileChoice[] {
  const [list, setList] = useState<ProfileChoice[]>([]);
  useEffect(() => {
    let live = true;
    client.profiles.list({}).then(
      (out) => live && setList(out.profiles.map((p) => ({ id: p.id, name: p.name, tool: p.tool }))),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client]);
  return list;
}

export interface WhereValue {
  /** Chosen profile ids; none = everywhere. */
  profiles: string[];
  /** One namespace pattern, when exactly one profile is chosen. */
  namespace: string;
}

export const EVERYWHERE: WhereValue = { profiles: [], namespace: "" };

export const scopeFrom = (value: WhereValue): string[] | null => scopeOf(value.profiles, value.namespace);

/** "Where it applies": everywhere unless profiles are ticked; one profile may be limited to namespaces. */
export function WhereField({ profiles, value, onChange }: { profiles: readonly ProfileChoice[]; value: WhereValue; onChange(next: WhereValue): void }) {
  const tick = (id: string, on: boolean) => {
    const next = on ? [...value.profiles, id] : value.profiles.filter((p) => p !== id);
    onChange({ profiles: next, namespace: next.length === 1 ? value.namespace : "" });
  };
  return (
    <fieldset className="flex flex-col gap-stack-sm">
      <legend className="text-body-1-strong">Where it applies</legend>
      <p className="text-caption-1 text-fg-muted">{value.profiles.length === 0 ? "Everywhere: no profile is ticked." : "Only on the profiles ticked."}</p>
      <div className="flex max-h-panel-xs flex-col gap-stack-xs overflow-auto">
        {profiles.length === 0 ? <span className="text-caption-1 text-fg-muted">No stored profiles yet.</span> : null}
        {profiles.map((p) => (
          <label key={p.id} className="flex items-center gap-inline-sm text-body-1">
            <Checkbox checked={value.profiles.includes(p.id)} onCheckedChange={(on) => tick(p.id, on === true)} aria-label={`${p.name} (${p.tool})`} />
            <span>{p.name}</span>
            <span className="text-caption-1 text-fg-muted">{p.tool}</span>
          </label>
        ))}
      </div>
      {value.profiles.length === 1 ? (
        <Field>
          <FieldLabel>Namespaces (optional)</FieldLabel>
          <Input value={value.namespace} onValueChange={(namespace) => onChange({ ...value, namespace })} className="font-mono" placeholder="orders-*" autoComplete="off" spellCheck={false} />
          <FieldDescription>A name, or a prefix ending in *. Leave empty for the whole profile.</FieldDescription>
        </Field>
      ) : null}
    </fieldset>
  );
}
