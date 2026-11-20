// Add or edit a local schema (mockup frame codecs-protobuf, DOC-21 §4.2, §5.3): Protobuf `.proto`
// files compiled on the server (protox, no protoc; Google's well-known types built in), a compiled
// descriptor set (a buf image), Avro `.avsc` or JSON Schema files, the first file the schema and the
// others its imports or references. Compile (`messaging.schemas.inspect` on the draft, no connection
// needed) points at file, line and column in the editor; for Protobuf, every message type found,
// the ticked ones offered by the viewer and the mappings. Nothing is fetched.
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CodeEditor, type CodeMarker } from "@/components/ui/code-editor";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { FileInput } from "@/components/ui/file-input";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { MightyClient } from "@/app/client";
import { Required } from "@/app/form-parts";
import { useSheetGuard } from "@/app/leave-guard";
import type { Inspection, LocalSchema, SchemaFile, SchemaIssue, SchemaType } from "@/gen/api";
import { Add, Checkmark, Delete, Document, Save } from "@/lib/icons";
import { cn } from "@/lib/cn";
import { toBase64 } from "./DecodeAs";

/** What the Add schema menu offers. */
export type SchemaKind = "protobuf" | "descriptor" | "avro" | "jsonschema";

export const SCHEMA_KIND_LABELS: Record<SchemaKind, string> = {
  protobuf: "Protobuf (.proto files)",
  descriptor: "Protobuf descriptor set",
  avro: "Avro (.avsc)",
  jsonschema: "JSON Schema",
};

export function kindOf(s: LocalSchema): SchemaKind {
  if (s.type === "protobuf") return Array.isArray(s.files) ? "protobuf" : "descriptor";
  return s.type;
}

const TYPE_OF: Record<SchemaKind, SchemaType> = { protobuf: "protobuf", descriptor: "protobuf", avro: "avro", jsonschema: "jsonschema" };
const ACCEPT: Record<SchemaKind, string> = { protobuf: ".proto", descriptor: ".binpb,.desc,.pb,.bin", avro: ".avsc,.json", jsonschema: ".json" };
const UNTITLED: Record<SchemaKind, string> = { protobuf: "schema.proto", descriptor: "", avro: "schema.avsc", jsonschema: "schema.json" };

/** A path as an import names it: relative to the import root, forward slashes. */
export function importPath(path: string, root: string): string {
  const p = path.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return r !== "" && p.startsWith(`${r}/`) ? p.slice(r.length + 1) : p;
}

/** "order.proto:9:3 · message", the way the sheet lists a problem. */
export function issueText(i: SchemaIssue): string {
  const at = [i.file, i.line, i.column].filter((x) => x !== undefined && x !== null).join(":");
  return at ? `${at} · ${i.message}` : i.message;
}

export interface SchemaSheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  kind: SchemaKind;
  /** The schema being edited; a new one when absent. */
  schema?: LocalSchema | null;
  /** The ids and names of the profile's other schemas. */
  others: readonly LocalSchema[];
  newId: string;
  client: MightyClient;
  profileName: string;
  onSave(schema: LocalSchema): Promise<void>;
}

export function SchemaSheet({ open, onOpenChange, kind, schema, others, newId, client, profileName, onSave }: SchemaSheetProps) {
  const [name, setName] = useState("");
  const [files, setFiles] = useState<SchemaFile[]>([]);
  const [current, setCurrent] = useState(0);
  const [root, setRoot] = useState("");
  const [descriptor, setDescriptor] = useState<{ name: string; base64: string } | null>(null);
  const [ticked, setTicked] = useState<string[] | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tried, setTried] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const generation = useRef(0);
  // A changed draft guards the tab (DOC-21 §3.7).
  const releaseGuard = useSheetGuard(open, { name, files, descriptor, ticked });
  useEffect(() => {
    if (!open) return;
    setName(schema?.name ?? "");
    setFiles(schema && Array.isArray(schema.files) ? schema.files : []);
    setDescriptor(schema && !Array.isArray(schema.files) ? { name: "descriptor set", base64: schema.files.descriptorSetBase64 } : null);
    setCurrent(0);
    setRoot("");
    setTicked(schema?.messageTypes ?? null);
    setInspection(null);
    setTried(false);
    setFailure(null);
  }, [open, schema]);

  const draft = (): LocalSchema => ({
    id: schema?.id ?? newId,
    name: name.trim(),
    type: TYPE_OF[kind],
    files: kind === "descriptor" ? { descriptorSetBase64: descriptor?.base64 ?? "" } : files,
    messageTypes: ticked && ticked.length > 0 ? ticked : null,
  });
  const changed = () => {
    setInspection(null);
    setFailure(null);
  };
  const nameError = name.trim() === "" ? "A name is required." : others.some((o) => o.name === name.trim() && o.id !== schema?.id) ? "Another schema has this name." : null;
  const sourceError = kind === "descriptor" ? (descriptor ? null : "Choose a descriptor set file.") : files.length === 0 ? "Add at least one file." : files.some((f) => f.path.trim() === "") ? "Every file needs a path." : null;

  const compile = async (): Promise<Inspection | null> => {
    const mine = ++generation.current;
    setCompiling(true);
    setFailure(null);
    try {
      // Every message type is listed whatever is ticked, so the check runs without the list.
      const out = await client.messaging.schemas.inspect({ schema: { ...draft(), messageTypes: null } });
      if (mine !== generation.current) return null;
      setInspection(out);
      if (kind === "protobuf" || kind === "descriptor") {
        // Ticked types that no longer exist are dropped.
        setTicked((t) => (t ? t.filter((x) => out.allMessageTypes.includes(x)) : t));
      }
      return out;
    } catch (e) {
      if (mine === generation.current) setFailure(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      if (mine === generation.current) setCompiling(false);
    }
  };
  const save = async () => {
    setTried(true);
    if (nameError || sourceError) return;
    const out = inspection ?? (await compile());
    if (!out || out.errors.length > 0) return;
    if (ticked !== null && ticked.length === 0 && (kind === "protobuf" || kind === "descriptor")) {
      setFailure("Tick at least one message type.");
      return;
    }
    setSaving(true);
    try {
      releaseGuard();
      await onSave(draft());
      onOpenChange(false);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const addFiles = async (picked: File[]) => {
    if (kind === "descriptor") {
      const f = picked[0];
      if (!f) return;
      setDescriptor({ name: f.name, base64: toBase64(new Uint8Array(await f.arrayBuffer())) });
      changed();
      return;
    }
    const read = await Promise.all(picked.map(async (f) => ({ path: importPath(f.webkitRelativePath || f.name, root), text: await f.text() })));
    setFiles((list) => {
      const out = [...list];
      for (const f of read) {
        const at = out.findIndex((x) => x.path === f.path);
        if (at >= 0) out[at] = f;
        else out.push(f);
      }
      return out;
    });
    changed();
  };
  const addEmpty = () => {
    setFiles((list) => [...list, { path: list.length === 0 ? UNTITLED[kind] : "", text: "" }]);
    setCurrent(files.length);
    changed();
  };
  const setFile = (patch: Partial<SchemaFile>) => {
    setFiles((list) => list.map((f, i) => (i === current ? { ...f, ...patch } : f)));
    changed();
  };
  const removeFile = (i: number) => {
    setFiles((list) => list.filter((_, j) => j !== i));
    setCurrent((c) => Math.max(0, c > i ? c - 1 : Math.min(c, files.length - 2)));
    changed();
  };

  const file = files[current];
  const errors = inspection?.errors ?? [];
  const markers = useMemo<CodeMarker[]>(
    () => (file ? errors.filter((e) => e.file === file.path && e.line !== undefined).map((e) => ({ line: e.line!, column: e.column ?? 1, message: e.message, severity: "error" as const })) : []),
    [errors, file],
  );
  const proto = kind === "protobuf" || kind === "descriptor";
  const all = inspection?.allMessageTypes ?? [];
  const offered = ticked ?? inspection?.messageTypes ?? [];
  const toggle = (t: string, on: boolean) => {
    const base = ticked ?? inspection?.messageTypes ?? [];
    setTicked(on ? [...base.filter((x) => x !== t), t] : base.filter((x) => x !== t));
  };
  const title = `${schema ? "Edit" : "Add"} ${kind === "descriptor" ? "a Protobuf descriptor set" : kind === "protobuf" ? "a Protobuf schema" : kind === "avro" ? "an Avro schema" : "a JSON Schema"}`;
  return (
    <Sheet open={open} onOpenChange={onOpenChange} size="lg">
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{profileName} · {kind === "protobuf" ? ".proto files compiled here, no protoc" : kind === "descriptor" ? "a FileDescriptorSet, such as a buf image" : "the first file is the schema, the others its references"}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form
            id="schema-form"
            aria-label={title}
            className="flex flex-col gap-stack-md"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="grid grid-cols-2 gap-inline-md">
              <Field invalid={tried && nameError !== null}>
                <FieldLabel>
                  Name
                  <Required />
                </FieldLabel>
                <Input value={name} onValueChange={setName} placeholder="orders" autoComplete="off" spellCheck={false} />
                <FieldDescription>How mappings and the viewer call it.</FieldDescription>
                {tried && nameError ? <FieldError match>{nameError}</FieldError> : null}
              </Field>
              {kind === "protobuf" ? (
                <Field>
                  <FieldLabel>Import root</FieldLabel>
                  <Input value={root} onValueChange={setRoot} placeholder="/" autoComplete="off" spellCheck={false} className="font-mono" />
                  <FieldDescription>Dropped paths are cut to start here, as imports name them.</FieldDescription>
                </Field>
              ) : null}
            </div>
            <Field invalid={tried && sourceError !== null}>
              <FieldLabel>{kind === "descriptor" ? "Descriptor set" : "Files"}</FieldLabel>
              <FileInput
                variant="dropzone"
                multiple={kind !== "descriptor"}
                accept={ACCEPT[kind]}
                dropLabel={kind === "descriptor" ? "Drop a descriptor set (.binpb, .desc), or choose it" : `Drop ${ACCEPT[kind].split(",").join(" or ")} files, or choose them`}
                onFilesChange={(picked) => void addFiles(picked)}
              />
              {descriptor ? <FieldDescription>{descriptor.name}</FieldDescription> : null}
              {tried && sourceError ? <FieldError match>{sourceError}</FieldError> : null}
            </Field>
            {kind !== "descriptor" ? (
              <div className="flex min-h-0 gap-inline-lg">
                <div role="list" aria-label="Files" className="flex w-panel-xs shrink-0 flex-col gap-stack-xs">
                  {files.map((f, i) => {
                    const bad = errors.some((e) => e.file === f.path);
                    return (
                      <div key={`${f.path}-${i}`} role="listitem" className={cn("flex items-center gap-inline-xs rounded-md px-inline-sm", i === current ? "bg-selected" : null)}>
                        <button type="button" className="flex min-w-0 flex-1 items-center gap-inline-xs py-stack-xs text-start" aria-current={i === current} onClick={() => setCurrent(i)}>
                          <Icon icon={Document} />
                          <span className={cn("truncate font-mono text-caption-1", bad ? "text-danger-fg" : "text-fg")}>{f.path || "(no path)"}</span>
                        </button>
                        <IconButton aria-label={`Remove ${f.path || "the file"}`} size="small" onClick={() => removeFile(i)}>
                          <Icon icon={Delete} />
                        </IconButton>
                      </div>
                    );
                  })}
                  <Button appearance="subtle" size="small" className="self-start" onClick={addEmpty}>
                    <Icon icon={Add} /> {files.length === 0 ? "Paste a file" : "Add a file"}
                  </Button>
                  {kind === "protobuf" ? <p className="text-caption-1 text-fg-muted">google/protobuf/* is built in.</p> : null}
                </div>
                {file ? (
                  <div className="flex min-w-0 flex-1 flex-col gap-stack-xs">
                    <Field>
                      <FieldLabel>Path</FieldLabel>
                      <Input value={file.path} onValueChange={(path) => setFile({ path })} size="small" className="font-mono" autoComplete="off" spellCheck={false} />
                    </Field>
                    <CodeEditor aria-label={`${file.path || "File"} text`} language={kind === "protobuf" ? "protobuf" : "json"} value={file.text} onValueChange={(text) => setFile({ text })} markers={markers} className="h-panel-sm" />
                  </div>
                ) : null}
              </div>
            ) : null}
          </form>
          {errors.length > 0 ? (
            <Alert intent="danger" className="mt-stack-md">
              <AlertTitle>{errors.length === 1 ? "1 problem" : `${errors.length} problems`}</AlertTitle>
              <AlertDescription>
                <ul className="flex flex-col gap-stack-xs font-mono">
                  {errors.map((e, i) => (
                    <li key={i}>
                      {e.file ? (
                        <button type="button" className="text-start underline" onClick={() => setCurrent(Math.max(0, files.findIndex((f) => f.path === e.file)))}>
                          {issueText(e)}
                        </button>
                      ) : (
                        issueText(e)
                      )}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}
          {inspection && errors.length === 0 ? (
            <p className="mt-stack-md text-caption-1 text-success-fg">
              Compiled{proto ? `: ${all.length} message ${all.length === 1 ? "type" : "types"}` : ""}.
            </p>
          ) : null}
          {proto && inspection && errors.length === 0 ? (
            <fieldset className="mt-stack-md flex flex-col gap-stack-xs">
              <legend className="text-body-1-strong text-fg">Message types</legend>
              <p className="text-caption-1 text-fg-muted">The ticked ones are offered in the viewer's codec menu and in mappings.</p>
              <div className="grid grid-cols-2 gap-x-inline-xl gap-y-stack-xs">
                {all.map((t) => (
                  <label key={t} className="flex items-center gap-inline-sm font-mono text-caption-1 text-fg">
                    <Checkbox checked={offered.includes(t)} onCheckedChange={(on) => toggle(t, on)} /> {t}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          {failure ? (
            <Alert intent="danger" className="mt-stack-md">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          ) : null}
        </SheetBody>
        <SheetFooter>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button appearance="subtle" onClick={() => void compile()} loading={compiling} disabled={sourceError !== null}>
            <Icon icon={Checkmark} /> Compile
          </Button>
          <Button appearance="primary" type="submit" form="schema-form" loading={saving}>
            <Icon icon={Save} /> Save schema
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
