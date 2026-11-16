// Export (DBee spec §3.8, Decision 15): the core re-runs the statement through export.run and
// encodes; on desktop it writes the file behind a handle from files.chooseSavePath, on web the
// bytes stream here and are saved as a Blob download with a stated cap. Progress and Cancel work
// through the stream.
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldItem, FieldLabel, FieldLegend } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectItem } from "@/components/ui/select";
import type { ExportFormat, ExportInput, ExportSummary, LineEnding } from "@/gen/api";
import { type Services, useServices } from "../client";
import { type Described, describeError, formatCount } from "../messages";
import type { Shell } from "../shortcuts";

/** Web downloads are built in memory: the dialog states the cap (spec Open question 4). */
export const WEB_EXPORT_CAP_BYTES = 256 * 1024 * 1024;

export interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string | null;
  sql: string;
  shell: Shell;
  /** Opens the session when the tab has none yet. */
  ensureSession: () => Promise<string>;
}

type Phase = { kind: "form" } | { kind: "running"; rows: number; bytes: number } | { kind: "done"; summary: ExportSummary } | { kind: "error"; error: Described };

const EXT: Record<ExportFormat, string> = { csv: "csv", tsv: "tsv", jsonl: "jsonl" };
const MIME: Record<ExportFormat, string> = { csv: "text/csv", tsv: "text/tab-separated-values", jsonl: "application/x-ndjson" };

/** Runs export.run with the chosen destination; `onProgress` reports rows and bytes. */
export async function runExport(services: Services, input: Omit<ExportInput, "destination">, shell: Shell, suggestedName: string, onProgress: (rows: number, bytes: number) => void, signal: AbortSignal): Promise<ExportSummary | null> {
  if (shell === "desktop") {
    const chosen = await services.client.files.chooseSavePath({ suggestedName, filters: [{ name: input.format.toUpperCase(), extensions: [EXT[input.format]] }] });
    if (chosen === null) return null;
    const stream = services.client.export.run({ ...input, destination: { kind: "file", handle: chosen.handle } }, { signal, timeoutMs: 3_600_000 });
    for await (const _chunk of stream.chunks()) {
      // The core writes the file; nothing streams here.
    }
    return stream.result;
  }
  const stream = services.client.export.run({ ...input, destination: { kind: "client" } }, { signal, timeoutMs: 3_600_000 });
  const parts: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of stream.chunks()) {
    parts.push(chunk);
    bytes += chunk.byteLength;
    onProgress(0, bytes);
    if (bytes > WEB_EXPORT_CAP_BYTES) {
      stream.cancel();
      throw new Error(`The export passed ${formatCount(WEB_EXPORT_CAP_BYTES / (1024 * 1024))} MiB; set a row limit or use the desktop app.`);
    }
  }
  const summary = await stream.result;
  const blob = new Blob(parts as BlobPart[], { type: MIME[input.format] });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return summary;
}

export function ExportDialog({ open, onOpenChange, sessionId, sql, shell, ensureSession }: ExportDialogProps) {
  const services = useServices();
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [header, setHeader] = useState(true);
  const [delimiter, setDelimiter] = useState(",");
  const [quote, setQuote] = useState('"');
  const [nullText, setNullText] = useState("");
  const [lineEnding, setLineEnding] = useState<LineEnding>("lf");
  const [maxRows, setMaxRows] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [controller, setController] = useState<AbortController | null>(null);

  const start = async () => {
    const c = new AbortController();
    setController(c);
    setPhase({ kind: "running", rows: 0, bytes: 0 });
    try {
      const session = sessionId ?? (await ensureSession());
      const summary = await runExport(
        services,
        { sessionId: session, sql, format, options: { header, delimiter, quote, nullText, lineEnding }, maxRows },
        shell,
        `result.${EXT[format]}`,
        (rows, bytes) => setPhase({ kind: "running", rows, bytes }),
        c.signal,
      );
      if (summary === null) setPhase({ kind: "form" });
      else setPhase({ kind: "done", summary });
    } catch (e) {
      setPhase({ kind: "error", error: describeError(e, "export") });
    } finally {
      setController(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) controller?.abort();
        onOpenChange(o);
        if (!o) setPhase({ kind: "form" });
      }}
      size="md"
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export result</DialogTitle>
          <DialogDescription>
            The statement runs again in the core and the full result is encoded there. {shell === "web" ? `Web downloads are capped at ${WEB_EXPORT_CAP_BYTES / (1024 * 1024)} MiB; set a row limit beyond that.` : "You choose the file; the core writes it."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-stack-md">
          {phase.kind === "form" || phase.kind === "error" ? (
            <>
              <Field>
                <RadioGroup value={format} onValueChange={(v) => setFormat(v as ExportFormat)}>
                  <FieldLegend>Format</FieldLegend>
                  <FieldItem>
                    <FieldLabel>
                      <RadioGroupItem value="csv" /> CSV
                    </FieldLabel>
                  </FieldItem>
                  <FieldItem>
                    <FieldLabel>
                      <RadioGroupItem value="tsv" /> TSV
                    </FieldLabel>
                  </FieldItem>
                  <FieldItem>
                    <FieldLabel>
                      <RadioGroupItem value="jsonl" /> JSON Lines
                    </FieldLabel>
                  </FieldItem>
                </RadioGroup>
              </Field>
              {format !== "jsonl" ? (
                <Field>
                  <FieldLabel>
                    <Checkbox checked={header} onCheckedChange={(v) => setHeader(v)} /> Header row
                  </FieldLabel>
                </Field>
              ) : null}
              {format === "csv" ? (
                <div className="grid grid-cols-2 gap-gap-md">
                  <Field>
                    <FieldLabel>Delimiter</FieldLabel>
                    <Input value={delimiter} onValueChange={setDelimiter} maxLength={1} className="font-mono" />
                  </Field>
                  <Field>
                    <FieldLabel>Quote</FieldLabel>
                    <Input value={quote} onValueChange={setQuote} maxLength={1} className="font-mono" />
                  </Field>
                </div>
              ) : null}
              {format !== "jsonl" ? (
                <Field>
                  <FieldLabel>Null text</FieldLabel>
                  <Input value={nullText} onValueChange={setNullText} placeholder="empty" className="font-mono" />
                  <FieldDescription>Written for NULL; empty by default.</FieldDescription>
                </Field>
              ) : null}
              <div className="grid grid-cols-2 gap-gap-md">
                <Field>
                  <FieldLabel>Line ending</FieldLabel>
                  <Select items={{ lf: "LF", crlf: "CRLF" }} value={lineEnding} onValueChange={(v) => v && setLineEnding(v as LineEnding)}>
                    <SelectItem value="lf">LF</SelectItem>
                    <SelectItem value="crlf">CRLF</SelectItem>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel>Row limit</FieldLabel>
                  <NumberInput value={maxRows} onValueChange={setMaxRows} min={1} placeholder="unlimited" />
                </Field>
              </div>
              {phase.kind === "error" ? (
                <Alert variant="danger">
                  <AlertTitle>{phase.error.title}</AlertTitle>
                  {phase.error.description ? <AlertDescription>{phase.error.description}</AlertDescription> : null}
                </Alert>
              ) : null}
            </>
          ) : phase.kind === "running" ? (
            <Progress value={null} label={`Exporting… ${phase.bytes > 0 ? `${formatCount(Math.round(phase.bytes / 1024))} KiB` : ""}`} />
          ) : (
            <Alert variant="success">
              <AlertTitle>Exported {formatCount(phase.summary.rows)} rows</AlertTitle>
              <AlertDescription>
                {formatCount(phase.summary.bytes)} bytes{phase.summary.path ? ` written to ${phase.summary.path}` : " downloaded"}.
              </AlertDescription>
            </Alert>
          )}
        </DialogBody>
        <DialogFooter>
          {phase.kind === "running" ? (
            <Button appearance="secondary" onClick={() => controller?.abort()}>
              Cancel
            </Button>
          ) : (
            <>
              <DialogClose render={<Button appearance="subtle" />}>Close</DialogClose>
              {phase.kind !== "done" ? (
                <Button onClick={() => void start()}>{shell === "desktop" ? "Choose file…" : "Download"}</Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
