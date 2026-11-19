// The layout of a tool screen (TSK-91, DOC-21 §3.1 "Tab content", the layout rules of Open
// question 45): one surface per region. The tab is one layer; a header (title, a muted subtitle
// with the context, the actions on its row), a bar of filters in one row, then the content region
// that starts with a divider. Spacing comes from the token roles on the 4 px grid: the page gutter
// is inset-lg (24 / 16), header → bar → content stack-md (16 / 12). Tables sit directly on the
// layer (TSK-90's Table) with their first and last cells on the page gutter.
import { type ReactNode, createContext, useContext } from "react";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { ChevronLeft, ChevronRight, Copy } from "@/lib/icons";

/** A tool screen: header, bar and region in a column that fills the tab. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex min-h-0 flex-1 flex-col", className)}>{children}</div>;
}

export interface PageHeaderProps {
  /** The screen's title (subtitle-1). */
  title: ReactNode;
  /** Beside the title: a status badge, a copy button. */
  adornment?: ReactNode;
  /** One muted line of context: profile, namespace, count. */
  subtitle?: ReactNode;
  /** On the title row's end, the primary action last. */
  actions?: ReactNode;
  /** Below the subtitle: a row of facts (DescriptionList), for detail screens. */
  children?: ReactNode;
}

export function PageHeader({ title, adornment, subtitle, actions, children }: PageHeaderProps) {
  return (
    <header className="flex shrink-0 flex-col gap-stack-md px-inset-lg pt-inset-lg">
      <div className="flex items-start gap-inline-xl">
        <div className="flex min-w-0 flex-1 flex-col gap-stack-xs">
          <h2 className="flex min-w-0 items-center gap-inline-md text-subtitle-1 text-fg">
            <span className="truncate">{title}</span>
            {adornment}
          </h2>
          {subtitle ? <p className="truncate text-body-1 text-fg-muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-inline-md">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}

/** The filters of a screen in one row, under the header. */
export function PageBar({ children, className, "aria-label": label }: { children: ReactNode; className?: string; "aria-label"?: string }) {
  return (
    <div role="group" aria-label={label} className={cn("flex shrink-0 flex-wrap items-center gap-inline-md px-inset-lg pt-stack-md", className)}>
      {children}
    </div>
  );
}

/** The content under the header and the bar: starts with a divider, fills the rest. */
export function PageRegion({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mt-stack-md flex min-h-0 flex-1 flex-col border-t border-border-subtle", className)}>{children}</div>;
}

/** Under a table: the range, paging, a note. */
export function PageFooter({ children }: { children: ReactNode }) {
  return <div className="flex shrink-0 items-center gap-inline-md border-t border-border-subtle px-inset-lg py-stack-sm text-caption-1 text-fg-muted">{children}</div>;
}

/** A Table's classes that put its first and last cells on the page gutter. */
export const gutterTable = "[&_th:first-child]:ps-inset-lg [&_td:first-child]:ps-inset-lg [&_th:last-child]:pe-inset-lg [&_td:last-child]:pe-inset-lg";

/** A short notice (the shell provides the toast; outside it, nothing is shown). */
export interface Notice {
  title: string;
  description?: ReactNode;
  type: "success" | "warning";
  /** One button under the text (Open workflow); the toast then stays longer. */
  action?: { label: string; onClick(): void };
}
export const NoticeContext = createContext<(notice: Notice) => void>(() => {});

/**
 * Copies a value and says so (DOC-21 Open question 45 (j)): a subtle icon button with a tooltip; a
 * toast names what was copied; a refused clipboard says so.
 */
export function CopyButton({ value, what, className }: { value: string; what: string; className?: string }) {
  const notify = useContext(NoticeContext);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      notify({ title: `Copied ${what}`, description: value.length > 64 ? `${value.slice(0, 61)}…` : value, type: "success" });
    } catch {
      notify({ title: `Could not copy ${what}`, description: "The browser refused the clipboard. Select the text instead.", type: "warning" });
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger render={<IconButton size="small" appearance="subtle" aria-label={`Copy ${what}`} {...(className ? { className } : {})} onClick={(e) => (e.stopPropagation(), void copy())} />}>
        <Icon icon={Copy} />
      </TooltipTrigger>
      <TooltipContent>Copy {what}</TooltipContent>
    </Tooltip>
  );
}

export interface PagerProps {
  /** "1–50 of 1,284". */
  range: ReactNode;
  page: number;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev(): void;
  onNext(): void;
  /** Back to page 1; the button shows only when given. */
  onFirst?: (() => void) | undefined;
  busy?: boolean;
}

/**
 * Previous and Next with the range (Open question 45 (i)): token APIs (Temporal) and offset APIs
 * alike; no jump to page n, which a token API cannot do.
 */
export function Pager({ range, page, hasPrev, hasNext, onPrev, onNext, onFirst, busy = false }: PagerProps) {
  return (
    <>
      <span className="text-fg">{range}</span>
      <span className="flex-1" />
      <span>Page {page}</span>
      {onFirst ? (
        <Button size="small" appearance="subtle" disabled={!hasPrev || busy} onClick={onFirst}>
          First
        </Button>
      ) : null}
      <IconButton size="small" appearance="subtle" aria-label="Previous page" disabled={!hasPrev || busy} onClick={onPrev}>
        <Icon icon={ChevronLeft} />
      </IconButton>
      <IconButton size="small" appearance="subtle" aria-label="Next page" disabled={!hasNext || busy} onClick={onNext}>
        <Icon icon={ChevronRight} />
      </IconButton>
    </>
  );
}
