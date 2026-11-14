import { ToggleGroup, ToggleGroupItem } from "@/components/toggle-group/toggle-group";

const AlignIcon = ({ d }: { d: string }) => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d={d} />
  </svg>
);

/** The smallest useful ToggleGroup: one view out of three. */
export function ToggleGroupMinimal() {
  return (
    <ToggleGroup aria-label="Result view" defaultValue={["grid"]}>
      <ToggleGroupItem value="grid">Grid</ToggleGroupItem>
      <ToggleGroupItem value="json">JSON</ToggleGroupItem>
      <ToggleGroupItem value="chart">Chart</ToggleGroupItem>
    </ToggleGroup>
  );
}

/**
 * A result toolbar: cell alignment (one of three, icon-only, ghost), visible columns (several at
 * once, small), a vertical panel picker (large) and a disabled group.
 */
export function ToggleGroupRealistic() {
  return (
    <div className="flex flex-wrap items-start gap-inline-lg">
      <ToggleGroup aria-label="Cell alignment" variant="ghost" defaultValue={["start"]}>
        <ToggleGroupItem value="start" aria-label="Align start">
          <AlignIcon d="M2 4h12M2 8h7M2 12h10" />
        </ToggleGroupItem>
        <ToggleGroupItem value="center" aria-label="Align center">
          <AlignIcon d="M2 4h12M4.5 8h7M3 12h10" />
        </ToggleGroupItem>
        <ToggleGroupItem value="end" aria-label="Align end">
          <AlignIcon d="M2 4h12M7 8h7M4 12h10" />
        </ToggleGroupItem>
      </ToggleGroup>
      <ToggleGroup aria-label="Visible columns" size="sm" multiple defaultValue={["type", "nullable"]}>
        <ToggleGroupItem value="type">Type</ToggleGroupItem>
        <ToggleGroupItem value="nullable">Nullable</ToggleGroupItem>
        <ToggleGroupItem value="default">Default</ToggleGroupItem>
      </ToggleGroup>
      <ToggleGroup aria-label="Side panel" size="lg" orientation="vertical" defaultValue={["schema"]}>
        <ToggleGroupItem value="schema">Schema</ToggleGroupItem>
        <ToggleGroupItem value="history">History</ToggleGroupItem>
      </ToggleGroup>
      <ToggleGroup aria-label="Isolation level" disabled defaultValue={["read-committed"]}>
        <ToggleGroupItem value="read-committed">Read committed</ToggleGroupItem>
        <ToggleGroupItem value="serializable">Serializable</ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
