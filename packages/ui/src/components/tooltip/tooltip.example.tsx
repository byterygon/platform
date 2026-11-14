import { Button } from "@/components/button/button";
import { IconButton } from "@/components/icon-button/icon-button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipShortcut, TooltipTrigger } from "@/components/tooltip/tooltip";

const PlayIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M5 3.5v9l7-4.5z" />
  </svg>
);

const StopIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <rect x="4" y="4" width="8" height="8" rx="1" />
  </svg>
);

const DownloadIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 3v7m-3-3 3 3 3-3M3 13h10" />
  </svg>
);

/** The smallest useful Tooltip: the name of an icon button. */
export function TooltipMinimal() {
  return (
    <Tooltip>
      <TooltipTrigger render={<IconButton aria-label="Run statement" />}>
        <PlayIcon />
      </TooltipTrigger>
      <TooltipContent>Run statement</TooltipContent>
    </Tooltip>
  );
}

/**
 * The query toolbar: one Provider so moving along the buttons shows each tooltip at once, the
 * shortcut after each name, one tooltip below, and one on a text button explaining why it waits
 * (open from the start, so the gallery shows the bubble).
 */
export function TooltipRealistic() {
  return (
    <TooltipProvider delay={400}>
      <div className="flex items-center gap-inline-xs">
        <Tooltip>
          <TooltipTrigger render={<IconButton aria-label="Run statement" variant="primary" />}>
            <PlayIcon />
          </TooltipTrigger>
          <TooltipContent>
            Run statement <TooltipShortcut>Ctrl+Enter</TooltipShortcut>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<IconButton aria-label="Cancel" />}>
            <StopIcon />
          </TooltipTrigger>
          <TooltipContent>
            Cancel <TooltipShortcut>Shift+Escape</TooltipShortcut>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<IconButton aria-label="Export result" />}>
            <DownloadIcon />
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Export result <TooltipShortcut>Ctrl+Shift+S</TooltipShortcut>
          </TooltipContent>
        </Tooltip>
        <Tooltip defaultOpen>
          <TooltipTrigger render={<Button variant="ghost" size="sm" />}>Run first statement</TooltipTrigger>
          <TooltipContent side="bottom">
            The selection holds three statements; one run takes one. <TooltipShortcut>Ctrl+Enter</TooltipShortcut>
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
