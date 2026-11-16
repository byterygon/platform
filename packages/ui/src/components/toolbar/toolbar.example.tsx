import { Icon } from "@/components/icon/icon";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarInput, ToolbarLink, ToolbarSeparator } from "@/components/toolbar/toolbar";
import { Play, Stop } from "@/lib/icons";

const PlayIcon = () => <Icon icon={Play} />;
const StopIcon = () => <Icon icon={Stop} />;

/** The smallest useful Toolbar: two buttons. */
export function ToolbarMinimal() {
  return (
    <Toolbar aria-label="Query">
      <ToolbarButton>
        <PlayIcon />
        Run
      </ToolbarButton>
      <ToolbarButton>Format</ToolbarButton>
    </Toolbar>
  );
}

/** A query tab's tool row: run group with a disabled Cancel, a filter field, a link, and a plain vertical toolbar. */
export function ToolbarRealistic() {
  return (
    <div className="flex max-w-panel-lg flex-col gap-stack-md">
      <Toolbar aria-label="Query tools">
        <ToolbarGroup aria-label="Execution">
          <ToolbarButton>
            <PlayIcon />
            Run statement
          </ToolbarButton>
          <ToolbarButton disabled focusableWhenDisabled aria-label="Cancel">
            <StopIcon />
          </ToolbarButton>
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup aria-label="Editor">
          <ToolbarButton>Format</ToolbarButton>
          <ToolbarButton>Explain</ToolbarButton>
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarInput aria-label="Row limit" defaultValue="1000" className="w-control-lg" />
        <ToolbarLink href="#audit">Audit log</ToolbarLink>
      </Toolbar>
      <Toolbar aria-label="Panel" orientation="vertical" variant="plain" className="w-panel-xs">
        <ToolbarButton>Connections</ToolbarButton>
        <ToolbarSeparator />
        <ToolbarButton>History</ToolbarButton>
      </Toolbar>
    </div>
  );
}
