// The codec menu of a message view (DOC-21 §5.2 "Override", mockup frame codecs-viewer): Auto
// (mappings, then detection), the codecs without a schema, the codecs with one as submenus of the
// profile's schemas (and Protobuf types), and "Manage schemas and mappings…". The choice goes into
// the stream's `decode` and stays with the tab.
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import type { CodecChoice, CodecId } from "@/gen/api";
import { ChevronDown, Settings } from "@/lib/icons";
import { CODEC_LABELS, PLAIN_CODECS, SCHEMA_CODECS, type SchemaChoice, choiceKey, choiceText, codecOfType } from "./model";

export interface CodecMenuProps {
  label: string;
  value: CodecChoice;
  onChange(choice: CodecChoice): void;
  /** The profile's schemas, with their Protobuf message types. */
  schemas: readonly SchemaChoice[];
  /** Opens the Schemas tab. */
  onManage?: (() => void) | undefined;
}

export function CodecMenu({ label, value, onChange, schemas, onManage }: CodecMenuProps) {
  const current = choiceKey(value);
  const item = (choice: CodecChoice, text: string, detail?: string) => (
    <DropdownMenuCheckboxItem key={choiceKey(choice)} closeOnClick checked={choiceKey(choice) === current} onCheckedChange={() => onChange(choice)}>
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {detail ? <span className="text-caption-1 text-fg-muted">{detail}</span> : null}
    </DropdownMenuCheckboxItem>
  );
  const withSchema = (codec: CodecId) => {
    const of = schemas.filter((s) => codecOfType(s.type) === codec);
    if (of.length === 0)
      return (
        <DropdownMenuItem key={codec} disabled>
          <span className="min-w-0 flex-1">{CODEC_LABELS[codec]}</span>
          <span className="text-caption-1 text-fg-muted">no schema</span>
        </DropdownMenuItem>
      );
    return (
      <DropdownMenuSub key={codec}>
        <DropdownMenuSubTrigger>
          <span className="min-w-0 flex-1">{CODEC_LABELS[codec]}</span>
          <span className="truncate text-caption-1 text-fg-muted">{of.map((s) => s.name).join(", ")}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {of.map((s) =>
            s.type === "protobuf" && s.messageTypes.length > 1 ? (
              <DropdownMenuSub key={s.id}>
                <DropdownMenuSubTrigger>{s.name}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>{s.messageTypes.map((t) => item({ codec, schema: { local: s.id }, messageType: t }, t))}</DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : (
              item({ codec, schema: { local: s.id }, messageType: s.type === "protobuf" ? (s.messageTypes[0] ?? null) : null }, s.name, s.type === "protobuf" ? s.messageTypes[0] : undefined)
            ),
          )}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  };
  return (
    <Field className="w-auto">
      <FieldLabel>{label}</FieldLabel>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="small" className="justify-between" aria-label={`${label}: ${choiceText(value, schemas)}`} />}>
          <span className="truncate">{choiceText(value, schemas)}</span>
          <Icon icon={ChevronDown} />
        </DropdownMenuTrigger>
        <DropdownMenuContent aria-label={label}>
          {item({ codec: "auto" }, "Auto", "mappings, then detection")}
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>No schema</DropdownMenuLabel>
            {PLAIN_CODECS.map((codec) => item({ codec }, CODEC_LABELS[codec]))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>With a schema</DropdownMenuLabel>
            {SCHEMA_CODECS.map(withSchema)}
          </DropdownMenuGroup>
          {onManage ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onManage}>
                <Icon icon={Settings} /> Manage schemas and mappings…
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </Field>
  );
}
