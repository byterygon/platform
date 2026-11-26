// The frame of every page that comes before the app (the sign-in, the password change, the
// two-step setup, the "no role yet" page): the backdrop, one centred layer with the brand, and the
// page's heading. Built on Byterygon UI with token roles only, so the page follows Light and Dark
// and both densities like the app does.
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { layerSurface } from "@/lib/control";
import { Server } from "@/lib/icons";

/** The brand row: the mark, the product, and the server the person is signing in to. */
export function Brand({ host }: { host?: string }) {
  return (
    <div className="flex items-center gap-inline-md">
      <Icon icon={Server} filled size="lg" tone="accent" />
      <span className="flex min-w-0 flex-col">
        <span className="text-body-1-strong">Mightyconsole</span>
        {host ? <span className="truncate text-caption-1 text-fg-muted">{host}</span> : null}
      </span>
    </div>
  );
}

export interface AuthShellProps {
  /** The page's one heading. */
  title: string;
  children: ReactNode;
  /** The server's address, under the brand. */
  host?: string;
  /** A wider layer, for a page with more to say. */
  wide?: boolean;
}

/** One centred layer on the backdrop; the title is the page's `<h1>`. */
export function AuthShell({ title, children, host = typeof location === "undefined" ? undefined : location.host, wide = false }: AuthShellProps) {
  return (
    <div className="mc-root flex min-h-full w-full items-start justify-center overflow-auto p-inset-lg text-fg sm:items-center">
      <main className={cn(layerSurface, "flex w-full flex-col gap-stack-lg p-inset-xl shadow-flyout", wide ? "max-w-panel-md" : "max-w-panel-sm")}>
        <Brand {...(host ? { host } : {})} />
        <h1 className="text-title-3">{title}</h1>
        {children}
      </main>
    </div>
  );
}
