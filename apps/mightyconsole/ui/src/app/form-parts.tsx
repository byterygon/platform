// Parts the tools' Write sheets share (Temporal's Start workflow and schedule sheets, TSK-92; NATS's
// stream and consumer sheets, TSK-85): the required mark, a folded section that shows its value,
// and a duration field read as the servers read durations.
import type { ReactNode } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { ChevronRight } from "@/lib/icons";
import { parseDuration } from "./duration";

/** The mark of a required field, after its label (the control itself carries `required`). */
export function Required() {
  return (
    <span aria-hidden="true" className="ps-inline-xs text-danger-fg">
      *
    </span>
  );
}

/** A section folded by default; its summary line shows what it holds ("Not set" when nothing). */
export function Fold({ title, value, children, open }: { title: string; value: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="group border-t border-border-subtle" open={open}>
      <summary className="flex cursor-pointer list-none items-center gap-inline-sm py-stack-sm text-body-1 text-fg">
        <Icon icon={ChevronRight} className="transition-transform group-open:rotate-90" />
        <span className="text-body-1-strong">{title}</span>
        <span className="min-w-0 flex-1 truncate text-fg-muted">{value}</span>
      </summary>
      <div className="flex flex-col gap-stack-md pb-stack-md">{children}</div>
    </details>
  );
}

/** Why a duration text cannot be sent, or null. */
export function durationError(text: string): string | null {
  return parseDuration(text) === "invalid" ? "A duration such as 30s, 5m, 1h30m or 2d." : null;
}

/** A duration as text ("30s", "1h30m"); empty is the server's default. */
export function DurationField({ label, value, onChange, description, placeholder = "Server default" }: { label: string; value: string; onChange(value: string): void; description?: string; placeholder?: string }) {
  const error = durationError(value);
  return (
    <Field invalid={error !== null}>
      <FieldLabel>{label}</FieldLabel>
      <Input value={value} onValueChange={onChange} placeholder={placeholder} autoComplete="off" spellCheck={false} />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {error ? <FieldError match>{error}</FieldError> : null}
    </Field>
  );
}
