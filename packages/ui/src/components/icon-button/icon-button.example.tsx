import { IconButton } from "@/components/icon-button/icon-button";

// Inline icons, so the examples need no icon package; any 16 x 16 `<svg aria-hidden>` works.
const icon = { "aria-hidden": true, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function CopyIcon() {
  return (
    <svg {...icon}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg {...icon}>
      <path d="M5 3.5v9l7-4.5z" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg {...icon}>
      <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg {...icon}>
      <path d="M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.5 9h6l.5-9" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg {...icon}>
      <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.5} />
    </svg>
  );
}

/** The smallest useful IconButton: an icon and the label a screen reader announces. */
export function IconButtonMinimal() {
  return (
    <IconButton aria-label="Copy connection string">
      <CopyIcon />
    </IconButton>
  );
}

/** A query editor's toolbar: run, refresh while loading, a disabled delete, more actions, in every size. */
export function IconButtonRealistic() {
  return (
    <div className="flex flex-col gap-stack-sm">
      <div role="toolbar" aria-label="Query" className="flex items-center gap-inline-xs">
        <IconButton variant="primary" aria-label="Run query">
          <PlayIcon />
        </IconButton>
        <IconButton aria-label="Refresh results" loading>
          <RefreshIcon />
        </IconButton>
        <IconButton variant="danger" aria-label="Delete query" disabled>
          <TrashIcon />
        </IconButton>
        <IconButton variant="secondary" aria-label="More actions">
          <MoreIcon />
        </IconButton>
      </div>
      <div className="flex items-center gap-inline-xs">
        <IconButton size="sm" aria-label="Copy, small">
          <CopyIcon />
        </IconButton>
        <IconButton size="md" aria-label="Copy, medium">
          <CopyIcon />
        </IconButton>
        <IconButton size="lg" aria-label="Copy, large">
          <CopyIcon />
        </IconButton>
      </div>
    </div>
  );
}
