// The frame of every page that comes before the app (the sign-in, the password change, the
// two-step setup, the "no role yet" page): the backdrop, one centred layer with the brand, and the
// page's heading. Built on Byterygon UI with token roles only, so the page follows Light and Dark
// and both densities like the app does.
//
// Sizes follow the approved mockup (TSK-135, "Signing in"): a 440 px card (`panel-md`), a wider
// one for pages with more to say (`panel-lg`), the brand on a 32 px accent tile, and large fields
// and buttons that fill the card (TSK-162). Below `sm` the card takes the whole width with less
// padding, so a 360 px window keeps every field usable; from `2xl` (1536 px) it is one step wider.
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { layerSurface } from "@/lib/control";
import { Server } from "@/lib/icons";

/** The brand row: the mark, the product, and the server the person is signing in to. */
export function Brand({ host }: { host?: string }) {
  return (
    <div className="flex items-center gap-inline-md">
      <span className="inline-flex size-control-md shrink-0 items-center justify-center rounded-lg bg-accent-solid text-accent-solid-fg" aria-hidden="true">
        <Icon icon={Server} filled size="lg" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-subtitle-2">Mightyconsole</span>
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
    <div className="mc-root flex min-h-full w-full items-start justify-center overflow-auto p-inset-md text-fg sm:items-center sm:p-inset-lg">
      <main data-auth-card className={cn(layerSurface, "flex w-full flex-col gap-stack-lg p-inset-lg shadow-flyout sm:p-inset-xl", wide ? "max-w-panel-lg 2xl:max-w-panel-xl" : "max-w-panel-md 2xl:max-w-panel-lg")}>
        <Brand {...(host ? { host } : {})} />
        <h1 className="text-title-3">{title}</h1>
        {children}
      </main>
    </div>
  );
}
