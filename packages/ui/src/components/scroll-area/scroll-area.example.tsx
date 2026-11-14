import { ScrollArea } from "@/components/scroll-area/scroll-area";

const notices = Array.from({ length: 40 }, (_, i) => `NOTICE ${String(i + 1).padStart(2, "0")}: relation "orders_${i}" already exists, skipping`);

/** The smallest useful ScrollArea: a fixed-height list that scrolls. */
export function ScrollAreaMinimal() {
  return (
    <ScrollArea aria-label="Notices" className="h-panel-xs w-panel-sm rounded-md border border-border">
      <ul className="flex flex-col gap-stack-xs p-inset-sm text-body text-fg">
        {notices.map((notice) => (
          <li key={notice}>{notice}</li>
        ))}
      </ul>
    </ScrollArea>
  );
}

/** A server log in a results panel: long unbroken lines scroll sideways, both scrollbars drawn. */
export function ScrollAreaRealistic() {
  return (
    <ScrollArea scrollbars="both" aria-label="Server log" className="h-panel-xs max-w-panel-md rounded-md border border-border bg-inset">
      <pre className="p-inset-sm font-mono text-code text-fg">
        {notices.map((notice, i) => `2026-11-14 09:${String(i).padStart(2, "0")}:00.000 UTC [4812] ${notice} (statement: create table if not exists orders_${i} (id bigint primary key, payload jsonb not null))`).join("\n")}
      </pre>
    </ScrollArea>
  );
}
