// Export (spec section 5): every format with Copy and Download and its install note. The text comes
// from `exportTheme` of @byterygon/design-tokens, the function `by-tokens export` calls, with the
// header source `<name>.theme.json` (the name the theme-file export saves), so
// `by-tokens export <format> --theme <name>.theme.json` prints the same bytes. A test compares them.
import { EXPORT_FORMATS, type ExportFormat, type ExportResult, exportFormat, exportTheme } from "@byterygon/design-tokens/build";
import { Alert, AlertDescription, AlertTitle } from "@/components/alert/alert";
import { Button } from "@/components/button/button";
import { CodeBlock } from "@/components/code-block/code-block";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/dialog/dialog";
import { Spinner } from "@/components/spinner/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/toggle-group/toggle-group";
import { useEffect, useMemo, useState } from "react";
import type { ThemeDoc } from "../state/theme-edit.ts";

/** What the Export panel shows for a theme and a format: exactly `exportTheme`'s result. */
export const studioExport = (theme: ThemeDoc, format: ExportFormat): Promise<ExportResult> => exportTheme(theme, format);

/** Copies text; falls back to a selected textarea where the Clipboard API is missing or refused. */
export async function copyText(text: string, doc: Document = document): Promise<boolean> {
  try {
    await doc.defaultView?.navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = doc.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    doc.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = doc.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/** Saves text as a file through a blob URL (works from file:// and needs no server). */
export function downloadText(text: string, name: string, mediaType: string, doc: Document = document): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mediaType};charset=utf-8` }));
  const link = doc.createElement("a");
  link.href = url;
  link.download = name;
  link.hidden = true;
  doc.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const PREVIEW_CHARS = 400_000;

function ExportView({ theme, format }: { theme: ThemeDoc; format: ExportFormat }) {
  const info = exportFormat(format)!;
  const key = useMemo(() => JSON.stringify(theme), [theme]);
  const [result, setResult] = useState<{ key: string; format: ExportFormat; value: ExportResult }>();
  const [copied, setCopied] = useState<"yes" | "no">();

  useEffect(() => {
    let cancelled = false;
    setCopied(undefined);
    void studioExport(theme, format).then((value) => {
      if (!cancelled) setResult({ key, format, value });
    });
    return () => {
      cancelled = true;
    };
  }, [key, format, theme]);

  const current = result && result.key === key && result.format === format ? result.value : undefined;
  const name = current?.theme ?? (typeof theme["name"] === "string" ? theme["name"] : "theme");
  const fileName = info.download(name);
  const content = current?.content;

  return (
    <section aria-label={info.label} className="flex min-w-0 flex-1 flex-col gap-stack-md">
      <div className="flex flex-wrap items-center gap-inline-sm">
        <h3 className="text-heading-4 text-fg">{info.label}</h3>
        <code className="font-mono text-caption text-fg-muted">{fileName}</code>
      </div>
      <p className="text-body text-fg-muted">{info.install}</p>
      <p className="font-mono text-caption text-fg-muted">
        by-tokens export {format} --theme ./{name}.theme.json
      </p>
      {!current && (
        <p className="flex items-center gap-inline-sm text-body text-fg-muted" aria-live="polite">
          <Spinner size="sm" label="Rendering" /> Rendering {info.label}…
        </p>
      )}
      {current && !current.ok && (
        <Alert intent="danger">
          <AlertTitle>The theme breaks {current.diagnostics.filter((d) => d.severity === "error").length} rules</AlertTitle>
          <AlertDescription>Nothing is exported until it validates, as with by-tokens. The Problems tab lists each rule with a fix.</AlertDescription>
        </Alert>
      )}
      {content !== undefined && (
        <>
          <div className="flex flex-wrap items-center gap-inline-sm">
            <Button
              appearance="primary"
              size="small"
              onClick={() => {
                void copyText(content).then((ok) => setCopied(ok ? "yes" : "no"));
              }}
            >
              Copy
            </Button>
            <Button appearance="secondary" size="small" onClick={() => downloadText(content, fileName, info.mediaType)}>
              Download {fileName}
            </Button>
            <span className="text-caption text-fg-muted" aria-live="polite">
              {copied === "yes" ? "Copied to the clipboard." : copied === "no" ? "The browser refused the clipboard; use Download." : `${new TextEncoder().encode(content).length.toLocaleString("en")} bytes`}
            </span>
          </div>
          <CodeBlock
            aria-label={`${info.label} contents`}
            className="max-h-[60dvh]"
            language={info.mediaType === "application/json" ? "json" : "text"}
            code={content.length > PREVIEW_CHARS ? `${content.slice(0, PREVIEW_CHARS)}\n… (${content.length - PREVIEW_CHARS} more characters in the file)` : content}
          />
        </>
      )}
    </section>
  );
}

export function ExportPanel({ theme }: { theme: ThemeDoc }) {
  const [format, setFormat] = useState<ExportFormat>("css");
  const [open, setOpen] = useState(false);
  return (
    <Dialog size="xl" open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button appearance="primary" size="small" />}>Export</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
          <DialogDescription>Copy or download the theme in any format. by-tokens gives the same bytes from the theme file.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-gap-md md:flex-row">
            <ToggleGroup aria-label="Format" orientation="vertical" appearance="subtle" size="small" className="shrink-0 items-stretch" value={[format]} onValueChange={(next: unknown[]) => next[0] !== undefined && setFormat(next[0] as ExportFormat)}>
              {EXPORT_FORMATS.map((info) => (
                <ToggleGroupItem key={info.format} value={info.format} className="justify-start">
                  {info.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {open && <ExportView theme={theme} format={format} />}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
