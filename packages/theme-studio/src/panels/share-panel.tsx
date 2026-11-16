// Share link (spec section 5; TSK-49): the Studio's address with the current state in its hash,
// the versioned `#by=1&theme=...&mode=...&density=...` of @byterygon/design-tokens (`encodeState`).
// The theme travels inside the link: nothing is uploaded and no server is involved, so the link
// opens the same theme and view in any copy of the Studio. Copy uses the Clipboard API, then a
// selected textarea; when both are refused the link stays selected in its field.
import { Alert, AlertDescription } from "@/components/alert/alert";
import { Button } from "@/components/button/button";
import { Field, FieldDescription, FieldLabel } from "@/components/field/field";
import { Input } from "@/components/input/input";
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@/components/popover/popover";
import { useEffect, useRef, useState } from "react";
import { type View, stateHash } from "../state/persist.ts";
import type { ThemeDoc } from "../state/theme-edit.ts";
import { copyText } from "./export-panel.tsx";

/** Above this many characters a link may be cut by mail and chat tools: warn. */
export const SHARE_LINK_WARN = 2000;
/** Above this many characters the Studio offers no link: export the theme file instead. */
export const SHARE_LINK_MAX = 32_000;

/** `href` with its hash replaced by `hash`. */
export function shareLink(href: string, hash: string): string {
  const at = href.indexOf("#");
  return `${at === -1 ? href : href.slice(0, at)}${hash}`;
}

export function SharePanel({ theme, view }: { theme: ThemeDoc; view: View }) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<string>();
  const [copied, setCopied] = useState<"yes" | "no">();
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCopied(undefined);
    void stateHash(theme, view).then((hash) => {
      if (!cancelled) setLink(shareLink(location.href, hash));
    });
    return () => {
      cancelled = true;
    };
  }, [open, theme, view]);

  const length = link?.length ?? 0;
  const tooLong = length > SHARE_LINK_MAX;
  const fromFile = typeof location !== "undefined" && location.protocol === "file:";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button appearance="secondary" size="small" />}>Share</PopoverTrigger>
      <PopoverContent align="end" className="w-panel-md max-w-full">
        <PopoverTitle>Share link</PopoverTitle>
        <PopoverDescription>The link holds the whole theme and the view (colour mode, density) after its #. Nothing is uploaded: opening it shows exactly this state.</PopoverDescription>
        <div className="flex flex-col gap-stack-sm pt-inset-sm">
          {link !== undefined && !tooLong && (
            <>
              <Field>
                <FieldLabel>Link</FieldLabel>
                <Input ref={field} aria-label="Share link" size="small" className="font-mono" readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
                <FieldDescription>{length.toLocaleString("en")} characters</FieldDescription>
              </Field>
              <div className="flex flex-wrap items-center gap-inline-sm">
                <Button
                  appearance="primary"
                  size="small"
                  onClick={() => {
                    void copyText(link).then((ok) => {
                      setCopied(ok ? "yes" : "no");
                      if (!ok) {
                        field.current?.focus();
                        field.current?.select();
                      }
                    });
                  }}
                >
                  Copy link
                </Button>
                <span className="text-caption-1 text-fg-muted" aria-live="polite">
                  {copied === "yes" ? "Copied to the clipboard." : copied === "no" ? "The browser refused the clipboard: the link is selected, press Ctrl+C (⌘C)." : ""}
                </span>
              </div>
            </>
          )}
          {length > SHARE_LINK_WARN && !tooLong && (
            <Alert intent="warning">
              <AlertDescription>This link is long ({length.toLocaleString("en")} characters). Some mail and chat tools cut links after {SHARE_LINK_WARN.toLocaleString("en")}; if it arrives broken, send the theme file (Export, Theme file).</AlertDescription>
            </Alert>
          )}
          {tooLong && (
            <Alert intent="danger">
              <AlertDescription>
                This theme is too large for a link ({length.toLocaleString("en")} characters; the limit is {SHARE_LINK_MAX.toLocaleString("en")}). Export the theme file and share that instead.
              </AlertDescription>
            </Alert>
          )}
          {fromFile && <p className="text-caption-1 text-fg-muted">This Studio runs from a file, so the link opens where the Studio is at the same path. The part from # on works with any copy of the Studio.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
