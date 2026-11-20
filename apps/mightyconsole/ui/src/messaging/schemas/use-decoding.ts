// The connection's decoding state for the message tabs and the Schemas tab: the codecs' status
// (`messaging.schemas.status`: schemas in use with their message types, compile issues, mapping
// counts), the menus' schema choices, and saving a change to the profile and to the server.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MightyClient } from "@/app/client";
import type { LocalSchema, SchemaIssue, SchemaMapping, SchemasStatusOutput } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { type SchemaChoice, mappingsOf, schemasOf, withDecoding } from "./model";

/** The menus' schemas: the profile's, with the message types the server compiled (or the ones the profile lists). */
export function schemaChoices(schemas: readonly LocalSchema[], status: SchemasStatusOutput | null): SchemaChoice[] {
  return schemas.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    messageTypes: status?.schemas.find((x) => x.id === s.id)?.messageTypes ?? s.messageTypes ?? [],
  }));
}

export interface Decoding {
  schemas: LocalSchema[];
  mappings: SchemaMapping[];
  /** `null` while loading or without a connection. */
  status: SchemasStatusOutput | null;
  choices: SchemaChoice[];
  reload(): void;
}

export function useDecoding(client: MightyClient, connId: string | null, profile: ProfileRecord): Decoding {
  const schemas = useMemo(() => schemasOf(profile), [profile]);
  const mappings = useMemo(() => mappingsOf(profile), [profile]);
  const [status, setStatus] = useState<SchemasStatusOutput | null>(null);
  const generation = useRef(0);
  const reload = useCallback(() => {
    const mine = ++generation.current;
    if (connId === null) {
      setStatus(null);
      return;
    }
    // A server without the procedure (or a stub) answers as one that failed.
    Promise.resolve()
      .then(() => client.messaging.schemas.status({ connId }))
      .then(
        (s) => {
          if (mine === generation.current) setStatus(s);
        },
        () => {
          if (mine === generation.current) setStatus(null);
        },
      );
  }, [client, connId]);
  // Again whenever the profile's schemas or mappings change.
  useEffect(() => {
    reload();
  }, [reload, schemas, mappings]);
  const choices = useMemo(() => schemaChoices(schemas, status), [schemas, status]);
  return { schemas, mappings, status, choices, reload };
}

/**
 * Saves the profile's schemas and mappings, then gives them to the connection's codecs (streams
 * already running keep the codecs they started with). Returns the schemas that do not compile.
 */
export async function saveDecoding(
  updateProfile: ((change: (record: ProfileRecord) => ProfileRecord) => Promise<void>) | undefined,
  client: MightyClient,
  connId: string | null,
  schemas: readonly LocalSchema[],
  mappings: readonly SchemaMapping[],
): Promise<SchemaIssue[]> {
  if (!updateProfile) throw new Error("This tab cannot change its profile.");
  await updateProfile((record) => withDecoding(record, schemas, mappings));
  if (connId === null) return [];
  const out = await client.messaging.schemas.update({ connId, schemas: [...schemas], mappings: [...mappings] });
  return out.issues;
}
