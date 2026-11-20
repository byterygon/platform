// The Schemas tab of a message connection (mockup frame codecs-library; DOC-21 §4.2, §5.2, §5.3,
// Open question 45 (p)): the profile's schemas (`extras.schemas`: Protobuf files or a descriptor
// set, Avro, JSON Schema) with their status on the connection, and its mappings (`extras.mappings`:
// where, part, codec, schema and type, wire format) in the order they apply, with what each decoded
// this session. Everything is the profile's, so it is exported and imported with it; a change is
// saved to the profile and given to the connection's codecs. Shared by NATS and Kafka: the tool
// gives its targets and its mapping test.
import { useContext, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { MightyClient } from "@/app/client";
import { NoticeContext, Page, PageFooter, PageHeader, PageRegion, gutterTable } from "@/app/page";
import { EmptyLine } from "@/app/states";
import type { LocalSchema, MappingTarget, SchemaMapping } from "@/gen/api";
import { Add, ArrowClockwise, ArrowDown, ArrowUp, ChevronDown, Delete, Edit, PlugConnected } from "@/lib/icons";
import { cn } from "@/lib/cn";
import type { ProfileRecord } from "@/profiles/record";
import type { TabProps } from "@/tools/types";
import { MappingSheet, type MappingTest } from "./MappingSheet";
import { CODEC_LABELS, SCHEMA_TYPE_LABELS, TARGET_LABELS, mappingCodec, mappingSchemaText, moveItem, newId, schemaSource, targetText, usesRegistry, withTargetText } from "./model";
import { RegistrySheet } from "./RegistrySheet";
import { REGISTRY_SECRETS, type RegistryFields, registryHost, registryOf } from "./registry";
import { SCHEMA_KIND_LABELS, SchemaSheet, type SchemaKind, issueText, kindOf } from "./SchemaSheet";
import { saveDecoding, saveRegistry, useDecoding } from "./use-decoding";

const KIND_VARIANT = { protobuf: "info", avro: "warning", jsonschema: "neutral" } as const;

export interface SchemasLibraryProps {
  profile: ProfileRecord;
  connId: string | null;
  client: MightyClient;
  updateProfile: TabProps["updateProfile"];
  useTabActions: TabProps["useTabActions"];
  /** The targets a mapping has in this system, in the Where select's order. */
  targets: readonly MappingTarget["kind"][];
  /** Whether mappings choose key or value (Kafka). */
  parts: boolean;
  /** The tool's mapping test, on the connection. */
  test: MappingTest;
  /** NATS: the registry sheet lists the subjects whose messages carry the wire format. */
  wireFormatSubjects: boolean;
  /** What the tab opens with: a sheet from the palette or the tree. */
  start?: "schema" | "mapping" | "registry" | null;
}

type SchemaEdit = { kind: SchemaKind; schema: LocalSchema | null };
type MappingEdit = { mapping: SchemaMapping; isNew: boolean };

export function SchemasLibrary({ profile, connId, client, updateProfile, useTabActions, targets, parts, test, wireFormatSubjects, start = null }: SchemasLibraryProps) {
  const notify = useContext(NoticeContext);
  const { schemas, mappings, status, reload } = useDecoding(client, connId, profile);
  const [schemaEdit, setSchemaEdit] = useState<SchemaEdit | null>(start === "schema" ? { kind: "protobuf", schema: null } : null);
  const blankMapping = (): SchemaMapping => ({ id: newId("m", mappings.map((m) => m.id)), target: withTargetText(targets[0] ?? "subject", ""), part: "value", codec: "json", schemaId: null, registry: null, messageType: null, wireFormat: null });
  const [mappingEdit, setMappingEdit] = useState<MappingEdit | null>(start === "mapping" ? { mapping: blankMapping(), isNew: true } : null);
  const [issues, setIssues] = useState<string[]>([]);
  const [registryOpen, setRegistryOpen] = useState(start === "registry");
  const registry = registryOf(profile);
  useTabActions({ refresh: reload, primary: () => setSchemaEdit({ kind: "protobuf", schema: null }) });

  const save = async (nextSchemas: readonly LocalSchema[], nextMappings: readonly SchemaMapping[]) => {
    const found = await saveDecoding(updateProfile, client, connId, nextSchemas, nextMappings);
    setIssues(found.map(issueText));
  };
  const undoable = async (title: string, nextSchemas: readonly LocalSchema[], nextMappings: readonly SchemaMapping[]) => {
    const before = { schemas, mappings };
    await save(nextSchemas, nextMappings);
    notify({ title, type: "success", action: { label: "Undo", onClick: () => void save(before.schemas, before.mappings) } });
  };

  const usedBy = (id: string) => mappings.filter((m) => m.schemaId === id);
  const removeSchema = (s: LocalSchema) => {
    const users = usedBy(s.id);
    if (users.length > 0) {
      notify({ title: `${s.name} is used by ${users.length === 1 ? "a mapping" : `${users.length} mappings`}`, description: "Delete or change them first.", type: "warning" });
      return;
    }
    void undoable(`Deleted schema ${s.name}`, schemas.filter((x) => x.id !== s.id), mappings);
  };
  const removeMapping = (m: SchemaMapping) => void undoable(`Deleted the mapping for ${targetText(m.target)}`, schemas, mappings.filter((x) => x.id !== m.id));
  const move = (i: number, to: number) => void save(schemas, moveItem(mappings, i, to));

  const statusOf = (s: LocalSchema) => {
    const problems = status?.issues.filter((i) => i.schemaId === s.id) ?? [];
    if (problems.length > 0)
      return (
        <Badge appearance="tint" variant="danger" title={problems.map(issueText).join("\n")}>
          {problems.length === 1 ? "1 issue" : `${problems.length} issues`}
        </Badge>
      );
    if (status?.schemas.some((x) => x.id === s.id))
      return (
        <Badge appearance="tint" variant="success">
          compiled
        </Badge>
      );
    return <span className="text-fg-muted">{connId === null ? "not connected" : "…"}</span>;
  };
  const typesOf = (s: LocalSchema) => {
    const t = status?.schemas.find((x) => x.id === s.id)?.messageTypes ?? s.messageTypes ?? [];
    if (s.type !== "protobuf" || t.length === 0) return "—";
    return t.length > 1 ? `${t[0]} +${t.length - 1}` : t[0];
  };
  const saveTheRegistry = async (next: RegistryFields | null, secrets: { password?: string; token?: string }) => {
    if (next === null) {
      const users = mappings.filter(usesRegistry);
      if (users.length > 0) throw new Error(`The registry is used by ${users.length === 1 ? "a mapping" : `${users.length} mappings`}: delete or change them first.`);
    }
    const before = registry;
    // Undo puts the secrets back too: removing the registry drops them from the profile.
    const keptSecrets: { password?: string; token?: string } = {};
    const stored = (key: string) => (typeof profile.secrets[key] === "string" ? (profile.secrets[key] as string) : "");
    if (stored(REGISTRY_SECRETS.password) !== "") keptSecrets.password = stored(REGISTRY_SECRETS.password);
    if (stored(REGISTRY_SECRETS.token) !== "") keptSecrets.token = stored(REGISTRY_SECRETS.token);
    await saveRegistry(updateProfile, client, connId, profile, next, secrets, wireFormatSubjects);
    reload();
    if (next) notify({ title: `Saved the registry ${registryHost(next.url)}`, type: "success" });
    else if (before) notify({ title: "Removed the registry", type: "success", action: { label: "Undo", onClick: () => void saveRegistry(updateProfile, client, connId, profile, before, keptSecrets, wireFormatSubjects).then(reload) } });
  };
  const countOf = (m: SchemaMapping) => status?.mappings.find((x) => x.id === m.id)?.count ?? null;
  const taken = new Set(schemas.map((s) => s.id));

  return (
    <Page>
      <PageHeader
        title="Schemas and codecs"
        subtitle={[profile.name, `${schemas.length} ${schemas.length === 1 ? "schema" : "schemas"}`, `${mappings.length} ${mappings.length === 1 ? "mapping" : "mappings"}`, registry ? `registry ${registryHost(registry.url)}` : "no registry", "kept in the profile (exported with it)"].join(" · ")}
        actions={
          <>
            <Button appearance="subtle" onClick={reload} disabled={connId === null}>
              <Icon icon={ArrowClockwise} /> Refresh
            </Button>
            <Button onClick={() => setRegistryOpen(true)}>
              <Icon icon={PlugConnected} /> {registry ? "Registry…" : "Add registry…"}
            </Button>
            <Button onClick={() => setMappingEdit({ mapping: blankMapping(), isNew: true })}>
              <Icon icon={Add} /> Add mapping
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button appearance="primary" />}>
                <Icon icon={Add} /> Add schema <Icon icon={ChevronDown} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" aria-label="Add schema">
                {(Object.keys(SCHEMA_KIND_LABELS) as SchemaKind[]).map((k) => (
                  <DropdownMenuItem key={k} onClick={() => setSchemaEdit({ kind: k, schema: null })}>
                    {SCHEMA_KIND_LABELS[k]}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <p className="max-w-panel-xs px-inline-md py-stack-xs text-caption-1 text-fg-muted">CBOR, MessagePack and JSON need no schema: map a subject to the codec.</p>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <PageRegion className="overflow-auto">
        {issues.length > 0 ? (
          <Alert intent="warning" className="mx-inset-lg mt-stack-md">
            <AlertTitle>Saved; some schemas do not compile</AlertTitle>
            <AlertDescription>{issues.join("; ")}</AlertDescription>
          </Alert>
        ) : null}
        <section aria-label="Schemas" className="flex flex-col">
          <p className="flex items-baseline gap-inline-md px-inset-lg pt-stack-md text-body-1-strong text-fg">
            Schemas <span className="text-caption-1 text-fg-muted">compiled on the server when the profile connects or a schema changes</span>
          </p>
          {schemas.length === 0 ? (
            <EmptyLine action={<Button onClick={() => setSchemaEdit({ kind: "protobuf", schema: null })}>Add a Protobuf schema</Button>}>No schemas in this profile yet.</EmptyLine>
          ) : (
            <Table aria-label="Schemas" size="small" className={gutterTable}>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Message types</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead align="end">Mappings</TableHead>
                  <TableHead align="end">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schemas.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="text-body-1-strong">{s.name}</TableCell>
                    <TableCell>
                      <Badge appearance="tint" variant={KIND_VARIANT[s.type]}>
                        {SCHEMA_TYPE_LABELS[s.type]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-fg-muted">{schemaSource(s)}</TableCell>
                    <TableCell className="max-w-panel-xs truncate font-mono text-fg-muted">{typesOf(s)}</TableCell>
                    <TableCell>{statusOf(s)}</TableCell>
                    <TableCell align="end" className="tabular-nums">
                      {usedBy(s.id).length}
                    </TableCell>
                    <TableCell align="end">
                      <IconButton aria-label={`Edit ${s.name}`} size="small" onClick={() => setSchemaEdit({ kind: kindOf(s), schema: s })}>
                        <Icon icon={Edit} />
                      </IconButton>
                      <IconButton aria-label={`Delete ${s.name}`} size="small" onClick={() => removeSchema(s)}>
                        <Icon icon={Delete} />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
        <section aria-label="Mappings" className="mt-stack-md flex flex-col border-t border-border-subtle">
          <p className="flex items-baseline gap-inline-md px-inset-lg pt-stack-md text-body-1-strong text-fg">
            Mappings <span className="text-caption-1 text-fg-muted">the first that matches wins · counts from this session</span>
          </p>
          {mappings.length === 0 ? (
            <EmptyLine action={<Button onClick={() => setMappingEdit({ mapping: blankMapping(), isNew: true })}>Add mapping</Button>}>No mappings: values are detected (JSON, CBOR, MessagePack, text, hex).</EmptyLine>
          ) : (
            <Table aria-label="Mappings" size="small" className={gutterTable}>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <span className="sr-only">Order</span>
                  </TableHead>
                  <TableHead>Where</TableHead>
                  <TableHead>Pattern</TableHead>
                  {parts ? <TableHead>Part</TableHead> : null}
                  <TableHead>Codec</TableHead>
                  <TableHead>Schema · type</TableHead>
                  <TableHead>Wire format</TableHead>
                  <TableHead align="end">Decoded</TableHead>
                  <TableHead align="end">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mappings.map((m, i) => {
                  const codec = mappingCodec(m, schemas);
                  const count = countOf(m);
                  return (
                    <TableRow key={m.id}>
                      <TableCell>
                        <span className="flex">
                          <IconButton aria-label={`Move the mapping for ${targetText(m.target)} up`} size="small" disabled={i === 0} onClick={() => move(i, i - 1)}>
                            <Icon icon={ArrowUp} />
                          </IconButton>
                          <IconButton aria-label={`Move the mapping for ${targetText(m.target)} down`} size="small" disabled={i === mappings.length - 1} onClick={() => move(i, i + 1)}>
                            <Icon icon={ArrowDown} />
                          </IconButton>
                        </span>
                      </TableCell>
                      <TableCell className="text-fg-muted">{TARGET_LABELS[m.target.kind]}</TableCell>
                      <TableCell className="font-mono">{targetText(m.target)}</TableCell>
                      {parts ? <TableCell>{m.part}</TableCell> : null}
                      <TableCell>
                        <Badge appearance="tint" variant="neutral">
                          {codec ? CODEC_LABELS[codec] : "?"}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-panel-xs truncate font-mono text-fg-muted">{mappingSchemaText(m, schemas)}</TableCell>
                      <TableCell className="font-mono text-fg-muted">{m.wireFormat === "confluent" ? "confluent" : "none"}</TableCell>
                      <TableCell align="end" className={cn("tabular-nums", count && count.failed > 0 ? "text-danger-fg" : "text-fg-muted")}>
                        {count ? `${count.decoded.toLocaleString()} · ${count.failed.toLocaleString()} failed` : "—"}
                      </TableCell>
                      <TableCell align="end">
                        <IconButton aria-label={`Edit the mapping for ${targetText(m.target)}`} size="small" onClick={() => setMappingEdit({ mapping: m, isNew: false })}>
                          <Icon icon={Edit} />
                        </IconButton>
                        <IconButton aria-label={`Delete the mapping for ${targetText(m.target)}`} size="small" onClick={() => removeMapping(m)}>
                          <Icon icon={Delete} />
                        </IconButton>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </section>
      </PageRegion>
      <PageFooter>Detection when nothing is mapped (§5.2): the Confluent wire format with a registry, a mapping, then JSON, CBOR, MessagePack, UTF-8 text, hex.</PageFooter>
      {schemaEdit ? (
        <SchemaSheet
          open
          onOpenChange={(open) => !open && setSchemaEdit(null)}
          kind={schemaEdit.kind}
          schema={schemaEdit.schema}
          others={schemas}
          newId={newId("s", taken)}
          client={client}
          profileName={profile.name}
          onSave={async (s) => {
            const at = schemas.findIndex((x) => x.id === s.id);
            const next = at >= 0 ? schemas.map((x) => (x.id === s.id ? s : x)) : [...schemas, s];
            await save(next, mappings);
            notify({ title: `Saved schema ${s.name}`, type: "success" });
          }}
        />
      ) : null}
      {mappingEdit ? (
        <MappingSheet
          open
          onOpenChange={(open) => !open && setMappingEdit(null)}
          mapping={mappingEdit.mapping}
          isNew={mappingEdit.isNew}
          schemas={schemas}
          targets={targets}
          parts={parts}
          client={client}
          connId={connId}
          hasRegistry={registry !== null}
          profileName={profile.name}
          test={connId === null ? null : test}
          onSave={async (m) => {
            const at = mappings.findIndex((x) => x.id === m.id);
            const next = at >= 0 ? mappings.map((x) => (x.id === m.id ? m : x)) : [...mappings, m];
            await save(schemas, next);
            notify({ title: `Saved the mapping for ${targetText(m.target)}`, type: "success" });
          }}
        />
      ) : null}
      {registryOpen ? <RegistrySheet open onOpenChange={setRegistryOpen} profile={profile} client={client} wireFormatSubjects={wireFormatSubjects} onSave={saveTheRegistry} /> : null}
    </Page>
  );
}
