// Put a key through the messaging core's Composer (§6.3 "Put through the Composer"): the key, an
// optional expected revision (only if the key is still at it; 0: only if it does not exist yet),
// and the value with its codec and schema. KV entries have no headers. A wrong revision is
// Conflict: the sheet says so and keeps the draft.
import { useSheetGuard } from "@/app/leave-guard";
import { useCallback, useEffect, useState } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { MightyClient } from "@/app/client";
import type * as api from "@/gen/api";
import { Composer, type ComposerDraft, EMPTY_DRAFT } from "@/messaging/Composer";
import { describeError, schemaChoices } from "@/messaging/compose-helpers";
import type { ProfileRecord } from "@/profiles/record";
import { parseCount } from "./stream-form";

const KEY = /^[-/_=A-Za-z0-9]+(\.[-/_=A-Za-z0-9]+)*$/;

/** Why a key cannot be put, or null. */
export function validateKey(key: string): string | null {
  const k = key.trim();
  if (k === "") return "A key is required.";
  if (!KEY.test(k)) return "Letters, digits, - / _ = and dots; not starting or ending with a dot.";
  return null;
}

export interface KvPutSheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  bucket: string;
  /** The key and its current revision when putting a new value of an existing key. */
  initial?: { key: string; revision?: number; draft?: ComposerDraft };
  profile: ProfileRecord;
  connId: string;
  client: MightyClient;
  onPut(key: string, revision: number): void;
}

export function KvPutSheet({ open, onOpenChange, bucket, initial, profile, connId, client, onPut }: KvPutSheetProps) {
  const [key, setKey] = useState("");
  const [expect, setExpect] = useState("");
  const [draft, setDraft] = useState<ComposerDraft>(EMPTY_DRAFT);
  const releaseGuard = useSheetGuard(open, { key, expect, draft });
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    setKey(initial?.key ?? "");
    setExpect(initial?.revision !== undefined ? String(initial.revision) : "");
    setDraft(initial?.draft ?? EMPTY_DRAFT);
    setFieldError(null);
  }, [open, initial]);
  const encode = useCallback((payload: api.ComposePayload) => client.messaging.encode({ connId, target: { kind: "kvBucket", bucket }, part: "value", payload }), [client, connId, bucket]);
  const inspect = useCallback((schema: api.SchemaRef, messageType: string | null) => client.messaging.schemas.inspect({ connId, schema, messageType }), [client, connId]);
  const expectN = parseCount(expect);
  const send = async (d: ComposerDraft) => {
    const problem = validateKey(key);
    if (problem) {
      setFieldError({ field: "key", message: problem });
      throw new Error(problem);
    }
    if (expectN !== null && Number.isNaN(expectN)) {
      setFieldError({ field: "expectRevision", message: "A revision number, 0, or empty." });
      throw new Error("A revision number, 0, or empty.");
    }
    setFieldError(null);
    try {
      const out = await client.nats.kv.put({ connId, bucket, key: key.trim(), payload: d.value, expectRevision: expectN });
      releaseGuard();
      onPut(key.trim(), out.revision);
      return `Put ${key.trim()} at revision ${out.revision} (${out.bytes.toLocaleString()} bytes).`;
    } catch (e) {
      const err = describeError(e);
      if (err.field === "key" || err.field === "expectRevision") setFieldError({ field: err.field, message: err.title });
      throw e;
    }
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange} size="lg">
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Put a key in {bucket}</SheetTitle>
          <SheetDescription>{profile.name} · a new revision of the key</SheetDescription>
        </SheetHeader>
        <SheetBody className="flex min-h-0 flex-col">
          <Composer
            withHeaders={false}
            target={
              <>
                <Field className="min-w-0 flex-1" invalid={fieldError?.field === "key"}>
                  <FieldLabel>Key</FieldLabel>
                  <Input value={key} onValueChange={setKey} placeholder="feature.checkout" className="font-mono" spellCheck={false} autoComplete="off" />
                  {fieldError?.field === "key" ? <FieldError match>{fieldError.message}</FieldError> : null}
                </Field>
                <Field className="w-auto" invalid={fieldError?.field === "expectRevision"}>
                  <FieldLabel>Only if at revision</FieldLabel>
                  <Input value={expect} onValueChange={setExpect} inputMode="numeric" placeholder="Any" className="font-mono" />
                  <FieldDescription>0: only if the key does not exist.</FieldDescription>
                  {fieldError?.field === "expectRevision" ? <FieldError match>{fieldError.message}</FieldError> : null}
                </Field>
              </>
            }
            schemas={schemaChoices(profile)}
            draft={draft}
            onDraftChange={setDraft}
            encode={encode}
            inspect={inspect}
            onSend={send}
            describe={(e) => {
              const d = describeError(e);
              return d.field === "payload" ? { ...d, field: "value" } : d;
            }}
          />
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
