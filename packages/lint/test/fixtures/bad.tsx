// One violation per line; test/eslint.test.js lists them by line.
import { cva } from "class-variance-authority";

declare function cn(...inputs: unknown[]): string;

const panelClass = "bg-white p-4";

export const chipVariants = cva("text-[13px]", {
  variants: { tone: { alert: "bg-red-600 text-white", calm: "border-gray-200" } },
});

export function Bad({ on }: { on: boolean }) {
  return (
    <div className={cn(panelClass, on && "gap-3", { "bg-[#0e7490]": on })}>
      <span className="p-[13px]" />
      <span className={`mt-2 ${on ? "h-8" : "w-36"}`} />
      <span className="max-h-[50dvh] bg-[var(--by-color-blue-9)] w-[var(--sidebar)]" />
      <span style={{ backgroundColor: "#ff0000" }} />
      {/* eslint-disable-next-line byterygon/no-arbitrary-value */}
      <span className="rounded-[6px]" />
      {/* eslint-disable-next-line byterygon/no-arbitrary-value -- a deliberate value, with its reason */}
      <span className="rounded-[6px]" />
    </div>
  );
}
