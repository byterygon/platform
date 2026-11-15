import { DescriptionListDetails, DescriptionListItem, DescriptionList, DescriptionListTerm } from "@/components/description-list/description-list";

/** The smallest useful DescriptionList: two pairs. */
export function DescriptionListMinimal() {
  return (
    <DescriptionList className="max-w-panel-md">
      <DescriptionListItem>
        <DescriptionListTerm>Host</DescriptionListTerm>
        <DescriptionListDetails>db.internal:5432</DescriptionListDetails>
      </DescriptionListItem>
      <DescriptionListItem>
        <DescriptionListTerm>Database</DescriptionListTerm>
        <DescriptionListDetails>orders</DescriptionListDetails>
      </DescriptionListItem>
    </DescriptionList>
  );
}

/** The approval dialog's grant summary (divided, a long digest that wraps) and About in a narrow panel (stacked). */
export function DescriptionListRealistic() {
  return (
    <div className="flex flex-wrap items-start gap-gap-xl">
      <DescriptionList divided className="w-panel-md">
        <DescriptionListItem>
          <DescriptionListTerm>Plugin</DescriptionListTerm>
          <DescriptionListDetails>db-driver-postgres 0.1.0 (first-party)</DescriptionListDetails>
        </DescriptionListItem>
        <DescriptionListItem>
          <DescriptionListTerm>May reach</DescriptionListTerm>
          <DescriptionListDetails>db.internal:5432 over TLS</DescriptionListDetails>
        </DescriptionListItem>
        <DescriptionListItem>
          <DescriptionListTerm>Access</DescriptionListTerm>
          <DescriptionListDetails>Read-only, expires in 1 hour</DescriptionListDetails>
        </DescriptionListItem>
        <DescriptionListItem>
          <DescriptionListTerm>Digest</DescriptionListTerm>
          <DescriptionListDetails className="font-mono text-code">sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08</DescriptionListDetails>
        </DescriptionListItem>
      </DescriptionList>
      <DescriptionList layout="stacked" className="w-panel-xs">
        <DescriptionListItem>
          <DescriptionListTerm>Version</DescriptionListTerm>
          <DescriptionListDetails>DBee 0.1.0</DescriptionListDetails>
        </DescriptionListItem>
        <DescriptionListItem>
          <DescriptionListTerm>Workspace</DescriptionListTerm>
          <DescriptionListDetails>/home/analyst/.local/share/dbee/workspaces/default</DescriptionListDetails>
        </DescriptionListItem>
      </DescriptionList>
    </div>
  );
}
