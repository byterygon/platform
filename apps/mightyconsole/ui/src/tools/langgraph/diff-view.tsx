// A JSON diff as the mockup draws it (History's "What changed since step N", Edit state's "What
// changes"; TSK-96): removed lines on danger, added on success, long unchanged runs folded.
import { foldSame, type DiffLine } from "@/lib/diff";
import { cn } from "@/lib/cn";

export function DiffView({ lines, label, className }: { lines: readonly DiffLine[]; label: string; className?: string }) {
  const folded = foldSame(lines);
  return (
    <pre aria-label={label} data-slot="diff" className={cn("overflow-auto rounded-md bg-layer-alt py-inset-xs font-mono text-code text-fg", className)}>
      {folded.map((l, i) =>
        l.kind === "folded" ? (
          <div key={i} data-kind="folded" className="px-inset-xs text-fg-muted">
            {"  "}…{l.count} unchanged
          </div>
        ) : (
          <div key={i} data-kind={l.kind} className={cn("px-inset-xs", l.kind === "removed" && "bg-danger-subtle text-danger-fg", l.kind === "added" && "bg-success-subtle text-success-fg")}>
            {l.kind === "removed" ? "- " : l.kind === "added" ? "+ " : "  "}
            {l.text}
          </div>
        ),
      )}
    </pre>
  );
}
