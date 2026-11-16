import { Icon } from "@/components/icon/icon";
import { ToggleGroup, ToggleGroupItem } from "@/components/toggle-group/toggle-group";
import { TextAlignCenter, TextAlignLeft, TextAlignRight } from "@/lib/icons";

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
 * A result toolbar: cell alignment (one of three, icon-only, subtle), visible columns (several at
 * once, small), a vertical panel picker (large) and a disabled group.
 */
export function ToggleGroupRealistic() {
  return (
    <div className="flex flex-wrap items-start gap-inline-lg">
      <ToggleGroup aria-label="Cell alignment" appearance="subtle" defaultValue={["start"]}>
        <ToggleGroupItem value="start" aria-label="Align start">
          <Icon icon={TextAlignLeft} />
        </ToggleGroupItem>
        <ToggleGroupItem value="center" aria-label="Align center">
          <Icon icon={TextAlignCenter} />
        </ToggleGroupItem>
        <ToggleGroupItem value="end" aria-label="Align end">
          <Icon icon={TextAlignRight} />
        </ToggleGroupItem>
      </ToggleGroup>
      <ToggleGroup aria-label="Visible columns" size="small" multiple defaultValue={["type", "nullable"]}>
        <ToggleGroupItem value="type">Type</ToggleGroupItem>
        <ToggleGroupItem value="nullable">Nullable</ToggleGroupItem>
        <ToggleGroupItem value="default">Default</ToggleGroupItem>
      </ToggleGroup>
      <ToggleGroup aria-label="Side panel" size="large" orientation="vertical" defaultValue={["schema"]}>
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
