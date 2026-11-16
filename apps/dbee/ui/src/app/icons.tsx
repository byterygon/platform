// The few icons the shell needs, inline and aria-hidden (no icon library, nothing fetched).
import type { ComponentProps } from "react";

type Props = Omit<ComponentProps<"svg">, "children">;

const base = (props: Props) => ({ viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, ...props });

export const PlusIcon = (p: Props) => (
  <svg {...base(p)}>
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);
export const PlayIcon = (p: Props) => (
  <svg {...base(p)}>
    <path d="M5 3.5v9l7-4.5z" fill="currentColor" stroke="none" />
  </svg>
);
export const StopIcon = (p: Props) => (
  <svg {...base(p)}>
    <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />
  </svg>
);
export const DatabaseIcon = (p: Props) => (
  <svg {...base(p)}>
    <ellipse cx="8" cy="4" rx="5" ry="2" />
    <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
  </svg>
);
export const SchemaIcon = (p: Props) => (
  <svg {...base(p)}>
    <path d="M2.5 4.5h4l1.5 1.5h5.5v6h-11z" />
  </svg>
);
export const TableIcon = (p: Props) => (
  <svg {...base(p)}>
    <rect x="2.5" y="3" width="11" height="10" rx="1" />
    <path d="M2.5 6.5h11M6.5 6.5v6.5" />
  </svg>
);
export const ViewIcon = (p: Props) => (
  <svg {...base(p)}>
    <path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z" />
    <circle cx="8" cy="8" r="1.5" />
  </svg>
);
export const ColumnIcon = (p: Props) => (
  <svg {...base(p)}>
    <path d="M4 3v10M8 3v10M12 3v10" />
  </svg>
);
export const GearIcon = (p: Props) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
  </svg>
);
export const DownloadIcon = (p: Props) => (
  <svg {...base(p)}>
    <path d="M8 2.5v7M5 6.5l3 3 3-3M2.5 12.5h11" />
  </svg>
);
export const MoreIcon = (p: Props) => (
  <svg {...base(p)}>
    <circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none" />
  </svg>
);
export const RefreshIcon = (p: Props) => (
  <svg {...base(p)}>
    <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />
  </svg>
);
export const HelpIcon = (p: Props) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="6" />
    <path d="M6.2 6.2a1.8 1.8 0 1 1 2.7 1.6c-.6.4-.9.8-.9 1.4M8 11.5h.01" />
  </svg>
);
