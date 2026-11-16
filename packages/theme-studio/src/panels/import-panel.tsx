// Import (spec section 5, "Import"; TSK-49): paste or load Byterygon CSS variables, Byterygon DTCG
// JSON, a stock shadcn/ui globals.css or a theme file, and open the theme file it becomes. The work
// is the engine's `importTheme`, the function `by-tokens import` calls, and the file shown is its
// `text`, so the CLI prints the same bytes. The opened theme validates like any other; when it
// breaks a rule the Studio opens the Contrast tab with the engine's fixes.
import { IMPORT_FORMATS, IMPORT_FORMAT_LABELS, type ImportFormat, type ImportResult, importTheme } from "@byterygon/design-tokens";
import { Alert, AlertDescription, AlertTitle } from "@/components/alert/alert";
import { Button } from "@/components/button/button";
import { CodeBlock } from "@/components/code-block/code-block";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/dialog/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/field/field";
import { FileInput } from "@/components/file-input/file-input";
import { Input } from "@/components/input/input";
import { Textarea } from "@/components/textarea/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/toggle-group/toggle-group";
import { useState } from "react";
import type { ThemeDoc } from "../state/theme-edit.ts";

type Choice = "auto" | ImportFormat;

/** What the Import dialog shows for a text: exactly `importTheme`'s result. */
export const studioImport = (text: string, format: Choice, name: string): ImportResult =>
  importTheme(text, { ...(format === "auto" ? {} : { format }), ...(name.trim() ? { name } : {}) });

export function ImportPanel({ onOpen }: { onOpen: (theme: ThemeDoc) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [format, setFormat] = useState<Choice>("auto");
  const [name, setName] = useState("");
  const [result, setResult] = useState<ImportResult>();

  const read = (source = text) => setResult(source.trim() ? studioImport(source, format, name) : undefined);
  const command = `by-tokens import <file>${format === "auto" ? "" : ` --format ${format}`}${name.trim() ? ` --name ${name.trim()}` : ""}`;

  return (
    <Dialog size="xl" open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button appearance="secondary" size="small" />}>Import</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import a theme</DialogTitle>
          <DialogDescription>Paste or load Byterygon CSS variables (--by-*), Byterygon DTCG JSON, a shadcn/ui globals.css or a theme file. It becomes a theme file of seeds and overrides; opening it replaces the theme you are editing.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-stack-md overflow-y-auto">
          <Field>
            <FieldLabel>Text</FieldLabel>
            <Textarea
              className="font-mono"
              rows={8}
              value={text}
              placeholder={":root {\n  --radius: 0.625rem;\n  --background: oklch(1 0 0);\n  --primary: oklch(0.205 0 0);\n}"}
              onValueChange={(value: string) => {
                setText(value);
                setResult(undefined);
              }}
            />
          </Field>
          <div className="flex flex-wrap items-end gap-inline-md">
            <Field className="min-w-0 flex-1">
              <FieldLabel>Or load a file</FieldLabel>
              <FileInput
                accept=".css,.json,text/css,application/json"
                onFilesChange={(files: File[]) => {
                  const file = files[0];
                  if (!file) return;
                  void file.text().then((content) => {
                    setText(content);
                    read(content);
                  });
                }}
              />
            </Field>
            <Field className="w-panel-xs">
              <FieldLabel>Theme name</FieldLabel>
              <Input size="small" className="font-mono" placeholder="from the source" value={name} onValueChange={(value: string) => setName(value)} />
            </Field>
          </div>
          <div className="flex flex-col gap-stack-xs">
            <span className="text-body-1-strong text-fg">Format</span>
            <ToggleGroup aria-label="Format" size="small" value={[format]} onValueChange={(next: unknown[]) => next[0] !== undefined && setFormat(next[0] as Choice)}>
              <ToggleGroupItem value="auto">Detect</ToggleGroupItem>
              {IMPORT_FORMATS.map((f) => (
                <ToggleGroupItem key={f} value={f}>
                  {IMPORT_FORMAT_LABELS[f]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="flex flex-wrap items-center gap-inline-sm">
            <Button appearance="primary" size="small" disabled={!text.trim()} onClick={() => read()}>
              Read
            </Button>
            <code className="font-mono text-caption-1 text-fg-muted">{command}</code>
          </div>

          {result && !result.ok && (
            <Alert intent="danger">
              <AlertTitle>Nothing could be read</AlertTitle>
              <AlertDescription>{result.diagnostics.map((d) => `${d.message}. ${d.fix?.summary ?? ""}`).join(" ")}</AlertDescription>
            </Alert>
          )}
          {result?.ok && (
            <section aria-label="Imported theme" className="flex flex-col gap-stack-sm">
              <p className="text-body-1 text-fg" aria-live="polite">
                Read as {IMPORT_FORMAT_LABELS[result.format!]}: {result.mapped} {result.format === "shadcn" ? "colours and lengths placed" : result.format === "theme" ? "theme file" : "tokens read"}.
              </p>
              {result.diagnostics.length > 0 && (
                <Alert intent="warning">
                  <AlertTitle>
                    {result.diagnostics.length} {result.diagnostics.length === 1 ? "note" : "notes"}
                  </AlertTitle>
                  <AlertDescription>
                    <ul className="flex list-disc flex-col gap-stack-xs ps-inset-md">
                      {result.diagnostics.map((d, index) => (
                        <li key={index}>{d.message}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              <CodeBlock aria-label="Theme file" className="max-h-[40dvh]" language="json" code={result.text!} />
            </section>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            appearance="primary"
            size="small"
            disabled={!result?.ok}
            onClick={() => {
              onOpen(result!.theme!);
              setOpen(false);
            }}
          >
            Open this theme
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
