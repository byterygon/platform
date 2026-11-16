import { Icon } from "@/components/icon/icon";
import { Button } from "@/components/button/button";
import { IconButton } from "@/components/icon-button/icon-button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipShortcut, TooltipTrigger } from "@/components/tooltip/tooltip";
import { ArrowDownload, Play, Stop } from "@/lib/icons";

/** The smallest useful Tooltip: the name of an icon button. */
export function TooltipMinimal() {
  return (
    <Tooltip>
      <TooltipTrigger render={<IconButton aria-label="Run statement" />}>
        <Icon icon={Play} />
      </TooltipTrigger>
      <TooltipContent>Run statement</TooltipContent>
    </Tooltip>
  );
}

/**
 * The query toolbar: one Provider so moving along the buttons shows each tooltip at once, the
 * shortcut after each name, one inverted (Fluent's dark bubble), one tooltip below, and one on a
 * text button explaining why it waits (both open from the start, so the gallery shows them).
 */
export function TooltipRealistic() {
  return (
    <TooltipProvider delay={400}>
      <div className="flex items-center gap-inline-xs">
        <Tooltip>
          <TooltipTrigger render={<IconButton aria-label="Run statement" appearance="primary" />}>
            <Icon icon={Play} />
          </TooltipTrigger>
          <TooltipContent>
            Run statement <TooltipShortcut>Ctrl+Enter</TooltipShortcut>
          </TooltipContent>
        </Tooltip>
        <Tooltip appearance="inverted" defaultOpen>
          <TooltipTrigger render={<IconButton aria-label="Cancel" />}>
            <Icon icon={Stop} />
          </TooltipTrigger>
          <TooltipContent>
            Cancel <TooltipShortcut>Shift+Escape</TooltipShortcut>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<IconButton aria-label="Export result" />}>
            <Icon icon={ArrowDownload} />
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Export result <TooltipShortcut>Ctrl+Shift+S</TooltipShortcut>
          </TooltipContent>
        </Tooltip>
        <Tooltip defaultOpen>
          <TooltipTrigger render={<Button appearance="subtle" size="small" />}>Run first statement</TooltipTrigger>
          <TooltipContent side="bottom">
            The selection holds three statements; one run takes one. <TooltipShortcut>Ctrl+Enter</TooltipShortcut>
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
