// `temporal.payload { namespace, payloadId, label, workflowId?, runId? }` (Mightyconsole spec §9.3
// "Large payload", TSK-92): one large payload in a tab of its own, opened from a stub in History,
// Pending or Queries. Its value is kept on the server for 10 minutes after its last use, so the tab
// has no URL; once it is gone the tab says so and opens the workflow to read the event again.
import { useEffect, useState } from "react";
import { Page, PageHeader, PageRegion, LinkButton } from "@/app/page";
import { DisconnectedState, ErrorState, LoadingRows } from "@/app/states";
import { linkTo } from "@/app/tab-view";
import type { PayloadNode } from "@/gen/api";
import type { DescribedError, TabProps } from "../types";
import { PayloadView, type LargeStub } from "./LargePayload";
import { namespaceOf } from "./profile";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function PayloadTab(props: TabProps) {
  const { tab, profile, connId, client, note } = props;
  const go = linkTo(props);
  const namespace = str(tab.params["namespace"]) || namespaceOf(profile);
  const payloadId = str(tab.params["payloadId"]);
  const label = str(tab.params["label"]) || "Payload";
  const workflowId = str(tab.params["workflowId"]);
  const runId = str(tab.params["runId"]);
  const [root, setRoot] = useState<PayloadNode | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);

  useEffect(() => {
    if (connId === null || payloadId === "") return;
    let live = true;
    client.temporal.payload.node({ connId, payloadId, path: "", offset: null, limit: 1 }).then(
      (node) => live && setRoot(node),
      (e: unknown) => live && setError(note(e)),
    );
    return () => {
      live = false;
    };
  }, [client, connId, payloadId, note]);

  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;
  const openWorkflow = workflowId ? () => go({ kind: "temporal.workflow", params: { namespace, workflowId, ...(runId ? { runId } : {}), view: "history" }, title: workflowId }) : undefined;
  const info = root?.info;
  const stub: LargeStub | null = info ? { id: payloadId, bytes: info.bytes, decodedBytes: info.decodedBytes, encoding: info.encoding, ...(info.codec ? { codec: { codec: info.codec, from: info.codecFrom ?? "" } } : {}) } : null;

  return (
    <Page>
      <PageHeader
        title={label}
        subtitle={
          <>
            Large payload · namespace <span className="text-body-1-strong text-fg">{namespace}</span>
            {workflowId ? (
              <>
                {" "}
                · workflow <LinkButton {...(openWorkflow ? { onOpen: openWorkflow } : {})}>{workflowId}</LinkButton>
              </>
            ) : null}
          </>
        }
      />
      <PageRegion>
        {error ? (
          error.kind === "NotFound" ? (
            <ErrorState error={{ ...error, description: workflowId ? "Open the workflow and its event to read the payload again." : "Read its event again to open it." }} {...(openWorkflow ? { onRetry: openWorkflow } : {})} />
          ) : (
            <ErrorState error={error} />
          )
        ) : stub ? (
          <PayloadView client={client} connId={connId} stub={stub} label={label} fileName={`${workflowId || "payload"}-${payloadId.slice(0, 8)}`} note={note} {...(openWorkflow ? { onReload: openWorkflow } : {})} />
        ) : (
          <LoadingRows label="Loading the payload" />
        )}
      </PageRegion>
    </Page>
  );
}
