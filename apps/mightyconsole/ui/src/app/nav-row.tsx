// The navigation row (DOC-21 §3.7, TSK-105): one row at the top of every tab, above the tool's
// screen. Back and Forward step the tab's own history (right-click or hold Back for the list);
// the breadcrumb is the matched routes of the tab's place, each segment going back up to its
// level, a segment with siblings opening their menu; when the row is short the first segments fold
// into "…" (the last two always show) after the link text has gone; the link and Copy link close
// it. The row is a toolbar: one tab stop, arrows between its controls, Down opens a segment's menu.
import { type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BREADCRUMB_INDEX, BREADCRUMB_OVERFLOW, Breadcrumb, BreadcrumbEllipsis, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator, useBreadcrumbOverflow } from "@/components/ui/breadcrumb";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { Toolbar, ToolbarButton } from "@/components/ui/toolbar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { ArrowLeft, ArrowRight, Checkmark, ChevronDown, type IconDefinition, Link, List } from "@/lib/icons";

/** Room the link text needs beside the whole breadcrumb before it shows (DOC-21 §3.7). */
export const LINK_ROOM = 120;
/** A hold on Back this long opens the tab's list. */
export const HOLD_MS = 500;

/** A segment's siblings as the row shows them: the shell binds what picking one does. */
export interface SiblingMenu {
  heading: string;
  items: { key: string; label: string; description?: string; current: boolean; select(): void }[];
  all?: { label: string; select(): void };
}

export interface NavCrumb {
  key: string;
  label: string;
  /** The profile's segment shows the server icon. */
  icon?: IconDefinition;
  /** Goes back up to this level; absent on a level that is not a place, and on the current one. */
  open?: (newTab: boolean) => void;
  /** Loads the menu of places beside this level; a rejection is shown in the menu. */
  siblings?: () => Promise<SiblingMenu>;
}

export interface NavStep {
  label: string;
  current: boolean;
}

export interface NavRowProps {
  crumbs: readonly NavCrumb[];
  /** The router href shown as the link; `null` when the tab has no URL of its own. */
  link: string | null;
  onCopyLink: () => void;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  /** How many steps the tab has. */
  stepCount: number;
  /** The tab's steps, oldest first, read when the list opens; picking one moves the tab there. */
  steps: () => readonly NavStep[];
  onStep: (index: number) => void;
}

const crumbButton = "max-w-panel-xs gap-inline-xs px-inline-sm text-fg-muted hover:text-fg data-popup-open:bg-hover data-popup-open:text-fg";

/** The row. Its controls are a toolbar labelled "Location". */
export function NavRow({ crumbs, link, onCopyLink, canBack, canForward, onBack, onForward, stepCount, steps, onStep }: NavRowProps) {
  const middle = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = middle.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setRoom(el.clientWidth));
    observer.observe(el);
    setRoom(el.clientWidth);
    return () => observer.disconnect();
  }, []);
  const signature = crumbs.map((c) => `${c.key}=${c.label}`).join("\u0000");
  const overflow = useBreadcrumbOverflow({ count: crumbs.length, signature, available: room });
  const showLink = link !== null && overflow.width !== null && room !== undefined && overflow.width + LINK_ROOM <= room;
  const hidden = new Set(overflow.hidden);

  return (
    <Toolbar variant="plain" aria-label="Location" className="min-h-control-lg shrink-0 gap-inline-xs overflow-x-visible border-b border-border-subtle ps-inset-md pe-inset-lg" data-nav-row="">
      <BackButton canBack={canBack} onBack={onBack} stepCount={stepCount} steps={steps} onStep={onStep} />
      <RowButton label="Forward" tip="Forward (Alt+Right)" icon={ArrowRight} disabled={!canForward} onClick={onForward} />
      <div ref={middle} className="ms-inline-md flex min-w-0 flex-1 items-center gap-inline-md">
        <Breadcrumb className={showLink ? "shrink-0" : "min-w-0 flex-1"}>
          <BreadcrumbList ref={overflow.ref} className="flex-nowrap gap-inline-xs">
            {crumbs.map((crumb, i) => {
              if (hidden.has(i)) {
                if (i !== overflow.hidden[0]) return null;
                return (
                  <Segment key="…" first={i === 0} overflow>
                    <FoldedMenu crumbs={overflow.hidden.map((h) => crumbs[h]!)} />
                  </Segment>
                );
              }
              return (
                <Segment key={crumb.key} index={i} first={i === 0 || (overflow.hidden[0] === 0 && i === overflow.hidden.length)}>
                  <CrumbControl crumb={crumb} current={i === crumbs.length - 1} />
                </Segment>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
        {showLink ? (
          <span className="min-w-0 flex-1 truncate text-end font-mono text-caption-1 text-fg-muted" title={link}>
            {link}
          </span>
        ) : null}
      </div>
      <RowButton label="Copy link" tip="Copy link" icon={Link} disabled={link === null} onClick={onCopyLink} />
    </Toolbar>
  );
}

/** A breadcrumb item with the separator before it (none before the first). */
function Segment({ children, first, index, overflow = false }: { children: ReactNode; first: boolean; index?: number; overflow?: boolean }) {
  return (
    <>
      {first ? null : <BreadcrumbSeparator />}
      <BreadcrumbItem {...(index !== undefined ? { [BREADCRUMB_INDEX]: index } : {})} {...(overflow ? { [BREADCRUMB_OVERFLOW]: "" } : {})} className="shrink-0">
        {children}
      </BreadcrumbItem>
    </>
  );
}

function RowButton({ label, tip, icon, disabled, onClick }: { label: string; tip: string; icon: IconDefinition; disabled: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<ToolbarButton aria-label={label} disabled={disabled} onClick={onClick} className="w-control-sm px-0" />}>
        <Icon icon={icon} />
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/** Back: a click steps; right-click, a hold or the context menu key opens this tab's list. */
function BackButton({ canBack, onBack, stepCount, steps, onStep }: Pick<NavRowProps, "canBack" | "onBack" | "stepCount" | "steps" | "onStep">) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const stopHold = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
  };
  useEffect(() => stopHold, []);
  const list = open ? steps().map((s, i) => ({ ...s, index: i })).reverse() : [];
  return (
    <span className="relative inline-flex">
      <Tooltip>
        <TooltipTrigger
          ref={button}
          render={
            <ToolbarButton
              aria-label="Back"
              disabled={!canBack && stepCount < 2}
              className={cn("w-control-sm px-0", open && "bg-selected")}
              onClick={() => {
                if (held.current) {
                  held.current = false;
                  return;
                }
                if (canBack) onBack();
              }}
              onContextMenu={(e: ReactMouseEvent) => {
                e.preventDefault();
                if (stepCount > 1) setOpen(true);
              }}
              onPointerDown={(e: React.PointerEvent) => {
                if (e.button !== 0 || stepCount < 2) return;
                held.current = false;
                stopHold();
                hold.current = setTimeout(() => {
                  held.current = true;
                  setOpen(true);
                }, HOLD_MS);
              }}
              onPointerUp={stopHold}
              onPointerLeave={stopHold}
            />
          }
        >
          <Icon icon={ArrowLeft} />
        </TooltipTrigger>
        <TooltipContent>Back (Alt+Left)</TooltipContent>
      </Tooltip>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger aria-hidden="true" tabIndex={-1} nativeButton={false} render={<span />} className="pointer-events-none absolute inset-0" />
        <DropdownMenuContent aria-label="Back history of this tab" finalFocus={button} className="w-panel-pane overflow-x-hidden">
          <DropdownMenuGroup>
            <DropdownMenuLabel>This tab</DropdownMenuLabel>
            {list.map((step) => (
              <DropdownMenuItem key={step.index} onClick={() => onStep(step.index)} className={step.current ? "text-body-1-strong" : ""}>
                <span className="flex w-icon-md shrink-0 justify-center">{step.current ? <Icon icon={Checkmark} /> : null}</span>
                <span className="min-w-0 truncate">{step.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <p className="px-inset-sm py-stack-xs text-caption-1 text-fg-muted">
            Back and Forward move inside this tab, as in a browser tab: Alt+Left and Alt+Right, the mouse's back and forward buttons, and the browser's own buttons. Right-click or hold Back for this list.
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

/** Whether a click asks for another tab: Ctrl or Cmd held, or the middle button. */
export function wantsNewTab(event: { ctrlKey: boolean; metaKey: boolean; button: number }): boolean {
  return event.ctrlKey || event.metaKey || event.button === 1;
}

function CrumbLabel({ crumb }: { crumb: NavCrumb }) {
  return (
    <>
      {crumb.icon ? <Icon icon={crumb.icon} /> : null}
      <span className="truncate">{crumb.label}</span>
    </>
  );
}

/** A segment: the current page, a link up, a menu of siblings, or both a link and a chevron. */
function CrumbControl({ crumb, current }: { crumb: NavCrumb; current: boolean }) {
  const link =
    !current && crumb.open ? (
      <ToolbarButton
        className={crumbButton}
        onClick={(e: ReactMouseEvent) => crumb.open!(wantsNewTab(e))}
        onAuxClick={(e: ReactMouseEvent) => {
          if (e.button === 1) {
            e.preventDefault();
            crumb.open!(true);
          }
        }}
      >
        <CrumbLabel crumb={crumb} />
      </ToolbarButton>
    ) : null;
  if (crumb.siblings) {
    if (link) {
      return (
        <span className="inline-flex items-center">
          {link}
          <SiblingsMenu crumb={crumb} trigger={<Icon icon={ChevronDown} />} label={`Places beside ${crumb.label}`} narrow />
        </span>
      );
    }
    return (
      <SiblingsMenu
        crumb={crumb}
        current={current}
        trigger={
          <>
            <CrumbLabel crumb={crumb} />
            <Icon icon={ChevronDown} />
          </>
        }
      />
    );
  }
  if (link) return link;
  if (current) {
    return (
      <BreadcrumbPage className="inline-flex items-center gap-inline-xs px-inline-sm [&_svg]:size-icon-sm">
        <CrumbLabel crumb={crumb} />
      </BreadcrumbPage>
    );
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-inline-xs px-inline-sm text-fg-muted [&_svg]:size-icon-sm">
      <CrumbLabel crumb={crumb} />
    </span>
  );
}

type Load = { state: "loading" } | { state: "ready"; menu: SiblingMenu } | { state: "failed"; message: string };

function SiblingsMenu({ crumb, trigger, label, narrow = false, current = false }: { crumb: NavCrumb; trigger: ReactNode; label?: string; narrow?: boolean; current?: boolean }) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const asked = useRef(0);
  const show = (next: boolean) => {
    setOpen(next);
    if (!next || !crumb.siblings) return;
    const ask = ++asked.current;
    setLoad({ state: "loading" });
    crumb.siblings().then(
      (menu) => ask === asked.current && setLoad({ state: "ready", menu }),
      (e: unknown) => ask === asked.current && setLoad({ state: "failed", message: e instanceof Error ? e.message : String(e) }),
    );
  };
  return (
    <DropdownMenu open={open} onOpenChange={show}>
      <DropdownMenuTrigger
        render={
          <ToolbarButton
            {...(label ? { "aria-label": label } : {})}
            {...(current ? { "aria-current": "page" as const } : {})}
            className={cn(crumbButton, narrow && "w-control-xs px-0", current && "text-body-1-strong text-fg")}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                show(true);
              }
            }}
          />
        }
      >
        {trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-panel-sm overflow-x-hidden">
        {load.state === "loading" ? (
          <div className="flex items-center gap-inline-md px-inset-sm py-stack-sm text-body-1 text-fg-muted">
            <Spinner size="sm" label="Loading" /> Loading…
          </div>
        ) : load.state === "failed" ? (
          <p className="px-inset-sm py-stack-sm text-body-1 text-fg-muted">{load.message}</p>
        ) : (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel>{load.menu.heading}</DropdownMenuLabel>
              {load.menu.items.length === 0 ? <p className="px-inset-sm py-stack-xs text-body-1 text-fg-muted">Nothing else here.</p> : null}
              {load.menu.items.map((item) => (
                <DropdownMenuItem key={item.key} onClick={item.select} className={item.current ? "text-body-1-strong" : ""}>
                  <span className="flex w-icon-md shrink-0 justify-center">{item.current ? <Icon icon={Checkmark} /> : null}</span>
                  <span className="min-w-0 truncate">{item.label}</span>
                  {item.description ? <span className="ms-auto shrink-0 ps-inline-lg text-caption-1 text-fg-muted">{item.description}</span> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            {load.menu.all ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={load.menu.all.select}>
                  <Icon icon={List} />
                  <span>{load.menu.all.label}</span>
                </DropdownMenuItem>
              </>
            ) : null}
            <p className="px-inset-sm py-stack-xs text-caption-1 text-fg-muted">Switching keeps the view where it can.</p>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The folded first segments, as a menu under "…". */
function FoldedMenu({ crumbs }: { crumbs: readonly NavCrumb[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<ToolbarButton aria-label="Show the hidden path" className={cn(crumbButton, "px-inline-xs")} />}>
        <BreadcrumbEllipsis />
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label="Hidden path">
        {crumbs.map((crumb) => (
          <DropdownMenuItem key={crumb.key} disabled={!crumb.open} onClick={(e: ReactMouseEvent) => crumb.open?.(wantsNewTab(e))}>
            {crumb.icon ? <Icon icon={crumb.icon} /> : null}
            <span className="truncate">{crumb.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
