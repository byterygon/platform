// Subjects as tags (mockup frame nats-subscribe): each subject or pattern a removable tag, a field
// that adds one on Enter, comma or space, and the profile's bookmarks offered beside it. Patterns
// are checked as they are added (`*` and `>` allowed, `>` last).
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Dismiss } from "@/lib/icons";
import { validatePattern } from "./profile";

export interface SubjectsInputProps {
  label: string;
  value: readonly string[];
  onChange(subjects: string[]): void;
  /** Offered as one-click additions (the profile's bookmarks). */
  suggestions?: readonly string[];
  disabled?: boolean;
  placeholder?: string;
}

export function SubjectsInput({ label, value, onChange, suggestions = [], disabled = false, placeholder = "Add a subject or pattern" }: SubjectsInputProps) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const listId = useId();
  const add = (raw: string) => {
    const subject = raw.trim();
    if (subject === "") return;
    const p = validatePattern(subject);
    if (p) {
      setProblem(`${subject}: ${p}`);
      return;
    }
    setProblem(null);
    setDraft("");
    if (!value.includes(subject)) onChange([...value, subject]);
  };
  const offered = suggestions.filter((s) => !value.includes(s));
  return (
    <Field invalid={problem !== null} className="min-w-0 flex-1">
      <FieldLabel>{label}</FieldLabel>
      <div className="flex min-w-0 flex-wrap items-center gap-inline-sm">
        <ul aria-label={label} className="flex flex-wrap items-center gap-inline-xs">
          {value.map((s) => (
            <li key={s}>
              <Badge appearance="tint" variant="neutral" className="gap-inline-xs font-mono">
                {s}
                <IconButton size="small" appearance="subtle" aria-label={`Remove ${s}`} disabled={disabled} onClick={() => onChange(value.filter((x) => x !== s))}>
                  <Icon icon={Dismiss} />
                </IconButton>
              </Badge>
            </li>
          ))}
        </ul>
        <Input
          aria-label={`${label}: add`}
          size="small"
          className="min-w-0 flex-1 font-mono"
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          aria-describedby={offered.length > 0 ? listId : undefined}
          onValueChange={(v) => {
            setProblem(null);
            if (/[,\s]$/.test(v)) add(v.slice(0, -1));
            else setDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => add(draft)}
        />
      </div>
      {offered.length > 0 ? (
        <div id={listId} className="flex flex-wrap items-center gap-inline-xs text-caption-1 text-fg-muted">
          Bookmarks:
          {offered.map((s) => (
            <Button key={s} size="small" appearance="subtle" className="font-mono" disabled={disabled} onClick={() => add(s)}>
              {s}
            </Button>
          ))}
        </div>
      ) : null}
      {problem ? <FieldError match>{problem}</FieldError> : null}
    </Field>
  );
}
