// Connect through (DOC-23 §10, (v); mockup frames routes-connect-menu, routes-connect-test and
// routes-error-missing): the select in a profile sheet of every tool that takes a route — Direct
// (the default), the routes the profile may name, and New route…, which opens the route editor
// over the sheet and returns with the new route chosen. A route whose command nobody confirmed is
// shown with its badge and cannot be picked. Under the select, the route's path, small. A profile
// whose route was deleted shows "Route missing": "Connect Direct…" is a choice with its own
// confirmation, never what happens by default.
import { useState } from "react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select, SelectItem } from "@/components/ui/select";
import type { RouteView } from "@/gen/api";
import { useRoutes } from "@/profiles/routes";
import type { MightyClient } from "../client";
import { PathFigure } from "./PathFigure";
import { RouteEditor } from "./RouteEditor";

const DIRECT = "__direct__";
const NEW = "__new__";

/** The tools whose connections go through a route (DOC-23 §7; NATS with TSK-118). */
export const ROUTE_TOOLS: ReadonlySet<string> = new Set(["docker", "temporal", "langgraph"]);

/** Why a profile of `tool` with `fields` takes no route, or `null` when it takes one. */
export function noRouteReason(tool: string, fields: Record<string, unknown>): string | null {
  if (tool === "nats") return "NATS connects through routes with its loopback forwarder (TSK-118), not yet.";
  if (!ROUTE_TOOLS.has(tool)) return "This tool connects to nothing a route could reach.";
  if (tool === "docker" && fields["transport"] === "socket") return "A local socket is on this server's own machine: there is nothing to route.";
  return null;
}

/** The address a profile of `tool` connects to, `host:port`, for the path and a route's Test. */
export function targetOf(tool: string, fields: Record<string, unknown>): string | undefined {
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (tool === "temporal") return text(fields["address"]) || undefined;
  if (tool === "langgraph") {
    try {
      const url = new URL(text(fields["url"]));
      return `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
    } catch {
      return undefined;
    }
  }
  if (tool === "docker" && fields["transport"] === "tcp") {
    const host = text(fields["host"]);
    const port = typeof fields["port"] === "number" ? fields["port"] : (fields["tls"] as { enabled?: boolean } | undefined)?.enabled ? 2376 : 2375;
    return host ? `${host}:${port}` : undefined;
  }
  return undefined;
}

export interface ConnectThroughProps {
  client: MightyClient;
  tool: string;
  fields: Record<string, unknown>;
  /** The profile's owner: it names routes of the same owner. */
  shared: boolean;
  disabled?: boolean;
  /** Overrides the target (Docker over SSH: its SSH host's address). */
  target?: string | undefined;
  onChange: (routeId: string | null) => void;
}

export function ConnectThrough({ client, tool, fields, shared, disabled = false, target, onChange }: ConnectThroughProps) {
  const routes = useRoutes();
  const [making, setMaking] = useState(false);
  const [editing, setEditing] = useState<RouteView | null>(null);
  const [goDirect, setGoDirect] = useState(false);
  const reason = noRouteReason(tool, fields);
  const routeId = typeof fields["routeId"] === "string" && fields["routeId"] !== "" ? fields["routeId"] : null;
  const owner = shared ? "shared" : "personal";
  const choices = routes.filter((r) => r.owner.kind === owner);
  const current = routeId ? routes.find((r) => r.id === routeId) : undefined;
  const missing = routeId !== null && current === undefined;
  const address = target ?? targetOf(tool, fields);
  if (reason) {
    return (
      <Field>
        <FieldLabel>Connect through</FieldLabel>
        <FieldDescription>{reason}</FieldDescription>
      </Field>
    );
  }
  return (
    <Field>
      <FieldLabel>Connect through</FieldLabel>
      {missing ? (
        <Alert intent="danger">
          <AlertTitle>Route missing</AlertTitle>
          <AlertDescription>
            The route this profile connects through was deleted. Choose another route below; it never connects Direct on its own.
            <Button size="small" appearance="subtle" className="ms-inline-sm" disabled={disabled} onClick={() => setGoDirect(true)}>
              Connect Direct…
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <Select
        aria-label="Connect through"
        value={missing ? null : (routeId ?? DIRECT)}
        placeholder="Choose a route"
        disabled={disabled}
        onValueChange={(v) => {
          if (v === NEW) setMaking(true);
          else if (v === DIRECT) onChange(null);
          else if (typeof v === "string") onChange(v);
        }}
      >
        <SelectItem value={DIRECT}>Direct</SelectItem>
        {choices.map((r) => (
          <SelectItem key={r.id} value={r.id} disabled={!r.confirmed}>
            {r.name} · {r.kind === "system" ? "System proxy" : `${r.hops.length} hop${r.hops.length === 1 ? "" : "s"}`}
            {r.confirmed ? "" : " · Not confirmed"}
          </SelectItem>
        ))}
        <SelectItem value={NEW}>New route…</SelectItem>
      </Select>
      {current ? (
        <div className="flex flex-col gap-stack-xs">
          {current.kind === "system" ? (
            <FieldDescription>The server's HTTPS_PROXY, ALL_PROXY and NO_PROXY, read at each connection.</FieldDescription>
          ) : (
            <div className="overflow-x-auto">
              <PathFigure size="small" hops={current.hops.map((h) => ({ kind: h.kind, label: h.label, name: h.nodeName }))} target={address ?? null} />
            </div>
          )}
          <Button size="small" appearance="subtle" className="self-start" disabled={disabled} onClick={() => setEditing(current)}>
            Edit route
          </Button>
        </div>
      ) : !missing ? (
        <FieldDescription>Direct: the server connects to the target itself. A route reaches it through proxies, jump hosts or an access agent; one route per profile.</FieldDescription>
      ) : null}
      {making || editing ? (
        <RouteEditor
          open
          onOpenChange={(open) => {
            if (!open) {
              setMaking(false);
              setEditing(null);
            }
          }}
          client={client}
          route={editing ?? undefined}
          sharedByDefault={shared}
          testTarget={address}
          onSaved={(saved) => {
            if (making && saved.confirmed) onChange(saved.id);
          }}
        />
      ) : null}
      <AlertDialog open={goDirect} onOpenChange={(o) => !o && setGoDirect(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Connect Direct?</AlertDialogTitle>
            <AlertDialogDescription>The server will connect to {address ?? "the target"} itself, around any proxy or jump host the deleted route went through. Do this only if the target is reachable and allowed from the server.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              appearance="primary"
              onClick={() => {
                setGoDirect(false);
                onChange(null);
              }}
            >
              Connect Direct
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Field>
  );
}
