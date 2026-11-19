// The missing-profile page (DOC-21 §3.7, TSK-105): a link names a profile this browser lacks.
// Profiles live in each browser, so the page says so and offers the three ways on: create the
// profile with that name, import profiles, or open the place with another profile of the tool.
// Nothing connects until the person chooses.
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState, EmptyStateActions, EmptyStateDescription, EmptyStateIcon, EmptyStateTitle } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Add, ArrowImport, PlugDisconnected, Server } from "@/lib/icons";

export interface MissingProfilePageProps {
  /** The tool's label: "Temporal". */
  toolLabel: string;
  profileName: string;
  /** The place below the profile: "orders › Workflows › order-77120 › History". */
  where: string;
  /** The tool's profiles in this browser, to open the place with one of them. */
  others: readonly { id: string; name: string }[];
  onCreate: () => void;
  onImport: () => void;
  onOpenWith: (profileId: string) => void;
  /** The navigation row above the page. */
  nav: ReactNode;
}

export function MissingProfilePage({ toolLabel, profileName, where, others, onCreate, onImport, onOpenWith, nav }: MissingProfilePageProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {nav}
      <EmptyState className="m-auto max-w-panel-xl">
        <EmptyStateIcon className="size-auto bg-transparent text-fg-subtle [&_svg]:size-inset-xl!">
          <Icon icon={PlugDisconnected} />
        </EmptyStateIcon>
        <EmptyStateTitle render={<h2 />} className="text-subtitle-1">
          This link needs {/^[AEIOU]/.test(toolLabel) ? "an" : "a"} {toolLabel} profile named {profileName}
        </EmptyStateTitle>
        <EmptyStateDescription className="max-w-panel-lg">
          Profiles live in each browser, so a link opens only where a profile with that name exists. Nothing was sent anywhere. Create the profile, or import the colleague's export, and the link opens where it points.
        </EmptyStateDescription>
        <EmptyStateActions>
          <Button appearance="primary" onClick={onCreate}>
            <Icon icon={Add} /> Create profile {profileName}
          </Button>
          <Button appearance="secondary" onClick={onImport}>
            <Icon icon={ArrowImport} /> Import profiles…
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button appearance="subtle" disabled={others.length === 0} />}>Open with another profile…</DropdownMenuTrigger>
            <DropdownMenuContent aria-label={`${toolLabel} profiles`}>
              {others.map((p) => (
                <DropdownMenuItem key={p.id} onClick={() => onOpenWith(p.id)}>
                  <Icon icon={Server} />
                  <span className="truncate">{p.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </EmptyStateActions>
        <DescriptionList layout="aligned" className="mt-stack-lg text-start">
          <DescriptionListItem>
            <DescriptionListTerm>Tool</DescriptionListTerm>
            <DescriptionListDetails>{toolLabel}</DescriptionListDetails>
          </DescriptionListItem>
          <DescriptionListItem>
            <DescriptionListTerm>Profile</DescriptionListTerm>
            <DescriptionListDetails className="font-mono">{profileName}</DescriptionListDetails>
          </DescriptionListItem>
          {where ? (
            <DescriptionListItem>
              <DescriptionListTerm>Where</DescriptionListTerm>
              <DescriptionListDetails className="font-mono">{where}</DescriptionListDetails>
            </DescriptionListItem>
          ) : null}
        </DescriptionList>
      </EmptyState>
    </div>
  );
}
