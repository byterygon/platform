// A secret field (TSK-135 §7, DOC-25 §3.4.7): written, never read back. Every tool's profile form
// uses this one control. A secret the server holds shows "Set", who set it and when, with Replace
// and Remove; a secret it does not hold shows the field to type it in. The value never comes back
// to the browser. The profile sheet provides what is stored (`SecretsProvider`); the form says
// which field this is.
//
// - Replace… opens an empty field and moves focus into it; Escape there cancels the replacement,
//   not the sheet; the old secret stays until Save.
// - Remove asks in a small popover; the removal happens when the sheet is saved.
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { PasswordInput } from "@/components/ui/password-input";
import { Popover, PopoverClose, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Key, LockClosed } from "@/lib/icons";

export interface SecretInfo {
  setBy: string;
  setAt: number;
}

export interface SecretsState {
  /** The secrets the server holds (browser keys), less those being removed. */
  stored: ReadonlySet<string>;
  /** Who set each stored secret and when. */
  info: Readonly<Record<string, SecretInfo>>;
  /** The secrets that will be removed when the sheet is saved. */
  removed: ReadonlySet<string>;
  /** Who the signed-in person is, so "you" can be said. */
  self?: string;
  /** The keys whose control is on screen; the rest are listed by the sheet. */
  shown(key: string): () => void;
  remove(key: string): void;
  keep(key: string): void;
  /** Keys that would be lost to a changed target, for the "enter it again" prompt. */
  lost: ReadonlySet<string>;
}

const Context = createContext<SecretsState | null>(null);

export function SecretsProvider({ value, children }: { value: SecretsState; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The keys with a control on screen, for a sheet to list the stored secrets no field shows. */
export function useShownSecrets(): { keys: ReadonlySet<string>; shown(key: string): () => void } {
  const [keys, setKeys] = useState<ReadonlySet<string>>(new Set());
  const counts = useRef(new Map<string, number>());
  const shown = useCallback((key: string) => {
    counts.current.set(key, (counts.current.get(key) ?? 0) + 1);
    setKeys(new Set(counts.current.keys()));
    return () => {
      const n = (counts.current.get(key) ?? 1) - 1;
      if (n <= 0) counts.current.delete(key);
      else counts.current.set(key, n);
      setKeys(new Set(counts.current.keys()));
    };
  }, []);
  return { keys, shown };
}

/** "Nov 12, 14:02" for a Unix-ms time. */
export function whenText(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/** "you", or the id without its kind prefix ("oidc:bao"). */
export function whoText(setBy: string, self?: string): string {
  if (self && setBy === self) return "you";
  return setBy.replace(/^human:/, "");
}

export interface SecretControlProps {
  /** The secret's key in the form (the browser's key). */
  secretKey: string;
  /** What the person typed. */
  value: string;
  onValueChange(value: string): void;
  /** What this secret is, for the buttons ("password", "token"). */
  noun?: string;
  /** A multi-line value (a key, a credentials file). */
  multiline?: boolean;
  rows?: number;
  /** What the empty field shows. */
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
}

export function SecretControl({ secretKey, value, onValueChange, noun = "secret", multiline = false, rows = 3, placeholder, disabled }: SecretControlProps) {
  const state = useContext(Context);
  const id = useId();
  const [replacing, setReplacing] = useState(false);
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const shown = state?.shown;
  useEffect(() => shown?.(secretKey), [shown, secretKey]);
  useEffect(() => {
    if (replacing) field.current?.focus();
  }, [replacing]);

  const stored = state?.stored.has(secretKey) ?? false;
  const removed = state?.removed.has(secretKey) ?? false;
  const info = state?.info[secretKey];
  const typed = value !== "";
  const lost = state?.lost.has(secretKey) ?? false;

  const input = (extra: { onKeyDown?(event: KeyboardEvent): void; label?: string }) =>
    multiline ? (
      <Textarea ref={field} id={`${id}-in`} {...(extra.label ? { "aria-label": extra.label } : {})} value={value} onValueChange={onValueChange} rows={rows} spellCheck={false} placeholder={placeholder} disabled={disabled} onKeyDown={extra.onKeyDown} />
    ) : (
      <PasswordInput ref={field} id={`${id}-in`} {...(extra.label ? { "aria-label": extra.label } : {})} value={value} onValueChange={onValueChange} placeholder={placeholder} autoComplete="off" disabled={disabled} onKeyDown={extra.onKeyDown} />
    );

  // No sheet around (a form used on its own): the plain field.
  if (!state) return input({});

  // Held by the server and not being replaced or removed: Set, who and when, Replace, Remove.
  if (stored && !replacing && !typed) {
    return (
      <div className="flex flex-wrap items-center gap-inline-md" data-secret={secretKey} data-state="set">
        <span className="flex items-center gap-inline-xs text-body-1">
          <Icon icon={LockClosed} className="text-success-fg" />
          Set
        </span>
        <span className="min-w-0 flex-1 text-caption-1 text-fg-muted">{info ? `Set by ${whoText(info.setBy, state.self)} on ${whenText(info.setAt)}` : ""}</span>
        <Button size="small" disabled={disabled} onClick={() => setReplacing(true)} aria-label={`Replace the ${noun}`}>
          Replace…
        </Button>
        <Popover>
          <PopoverTrigger render={<Button size="small" appearance="subtle" disabled={disabled} aria-label={`Remove the ${noun}`} />}>Remove</PopoverTrigger>
          <PopoverContent align="end">
            <PopoverTitle>Remove the {noun}?</PopoverTitle>
            <PopoverDescription>Connections stop working until it is set again. It is removed when you save.</PopoverDescription>
            <div className="flex justify-end gap-inline-sm">
              <PopoverClose render={<Button size="small" />}>Cancel</PopoverClose>
              <PopoverClose render={<Button size="small" appearance="primary" onClick={() => state.remove(secretKey)} />}>Remove</PopoverClose>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    );
  }

  // Replacing a stored secret: an empty field; Escape or Cancel keeps the old one.
  if (stored) {
    const cancel = () => {
      onValueChange("");
      setReplacing(false);
    };
    return (
      <div className="flex flex-col gap-stack-sm" data-secret={secretKey} data-state="replacing">
        {input({
          label: `New ${noun}`,
          onKeyDown: (event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            }
          },
        })}
        <div className="flex items-center gap-inline-md">
          <span className="min-w-0 flex-1 text-caption-1 text-fg-muted">Stored encrypted on the server when you save. Nobody can read it back, you included.</span>
          <Button size="small" appearance="subtle" onClick={cancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // Not held by the server: the field itself, with what the state is.
  return (
    <div className="flex flex-col gap-stack-sm" data-secret={secretKey} data-state={removed ? "removed" : "unset"}>
      {input({})}
      <div className="flex items-center gap-inline-md text-caption-1 text-fg-muted">
        <Icon icon={Key} />
        <span className="min-w-0 flex-1">{removed ? `Removed when you save${info ? ` (it was set by ${whoText(info.setBy, state.self)} on ${whenText(info.setAt)})` : ""}` : lost ? "Not set: the target changed, enter it again" : "Not set"}</span>
        {removed ? (
          <Button size="small" appearance="subtle" onClick={() => state.keep(secretKey)}>
            Keep it
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The state a profile sheet provides, built from what the form holds. */
export function useSecretsState(args: {
  stored: ReadonlySet<string>;
  info: Readonly<Record<string, SecretInfo>>;
  removed: ReadonlySet<string>;
  self?: string;
  lost: ReadonlySet<string>;
  shown(key: string): () => void;
  remove(key: string): void;
  keep(key: string): void;
}): SecretsState {
  const { stored, info, removed, self, lost, shown, remove, keep } = args;
  return useMemo(() => ({ stored, info, removed, ...(self ? { self } : {}), lost, shown, remove, keep }), [stored, info, removed, self, lost, shown, remove, keep]);
}
