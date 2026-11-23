// `nats.schemas {}`: the messaging core's Schemas tab on a NATS connection (TSK-85 batch 4):
// mappings by subject pattern, stream or KV bucket (values only), tested through
// `nats.schemas.test` on the last messages JetStream keeps, and a Schema Registry whose wire
// format is looked for on the subjects the profile lists (`create: "registry"` opens its sheet). Also the "Decode as…" of the NATS
// message tabs, which keeps a choice as a mapping for the message's subject or bucket.
import { type ValueQuery, useValueQuery } from "@/messaging/query";
import { useCallback, useContext, useMemo } from "react";
import type { MightyClient } from "@/app/client";
import { NoticeContext } from "@/app/page";
import type { CodecChoice, LocalSchema, MappingTarget, SchemaMapping } from "@/gen/api";
import type { MessageRow } from "@/messaging/arrow";
import { SchemasLibrary } from "@/messaging/schemas/SchemasLibrary";
import { type DecodeAs, type DecodePlace, toBase64 } from "@/messaging/schemas/DecodeAs";
import { type SchemaChoice, insertAbove, mappingFromChoice, newId } from "@/messaging/schemas/model";
import { saveDecoding, useDecoding } from "@/messaging/schemas/use-decoding";
import type { ProfileRecord } from "@/profiles/record";
import type { TabProps } from "../types";

/** What a NATS mapping can apply to. */
export const NATS_TARGETS: readonly MappingTarget["kind"][] = ["subject", "stream", "kvBucket"];


export function SchemasTab({ tab, profile, connId, client, useTabActions, updateProfile }: TabProps) {
  const test = useCallback(
    (mapping: SchemaMapping, schemas: LocalSchema[]) => {
      if (connId === null) return Promise.reject(new Error("Connect the profile first."));
      return client.nats.schemas.test({ connId, mapping, schemas, limit: null });
    },
    [client, connId],
  );
  const create = tab.params["create"];
  const start = create === "mapping" || create === "schema" || create === "registry" ? create : null;
  return <SchemasLibrary profile={profile} connId={connId} client={client} updateProfile={updateProfile} useTabActions={useTabActions} targets={NATS_TARGETS} parts={false} test={test} wireFormatSubjects start={start} />;
}

/**
 * "Decode as…" and the codec menu's schemas for a NATS message tab: `placeOf` says where a mapping
 * for a message goes (its subject, or its KV bucket), `keep` saves it above the mapping that
 * failed and gives the connection the new codecs.
 */
export function useNatsDecoding(
  client: MightyClient,
  connId: string | null,
  profile: ProfileRecord,
  updateProfile: TabProps["updateProfile"],
  placeOf: (message: MessageRow) => DecodePlace | null,
): { decodeAs: DecodeAs | undefined; decoding: ReturnType<typeof useDecoding> } {
  const notify = useContext(NoticeContext);
  const decoding = useDecoding(client, connId, profile);
  const { schemas, mappings, choices, reload } = decoding;
  const decodeAs = useMemo<DecodeAs | undefined>(() => {
    if (connId === null) return undefined;
    return {
      choices,
      placeOf,
      preview: (bytes: Uint8Array, choice: CodecChoice) => client.messaging.decode({ connId, bytes: toBase64(bytes), part: "value", target: null, choice }),
      keep: async (_message: MessageRow, place: DecodePlace, choice: CodecChoice) => {
        const mapping = mappingFromChoice(newId("m", mappings.map((m) => m.id)), place.target, "value", choice);
        const issues = await saveDecoding(updateProfile, client, connId, schemas, insertAbove(mappings, mapping, place.where));
        reload();
        notify({ title: `Mapping saved for ${place.label}`, description: issues.length > 0 ? `${issues.length} schema(s) do not compile.` : "Messages read from now on decode with it; restart to read these again.", type: "success" });
      },
    };
  }, [client, connId, choices, placeOf, mappings, schemas, updateProfile, reload, notify]);
  return { decodeAs, decoding };
}

/** A core NATS message's place, or a JetStream one's (`stream`): its subject. */
export function subjectPlace(message: MessageRow, stream: string | null = null): DecodePlace | null {
  const subject = message.subject;
  return subject ? { target: { kind: "subject", pattern: subject }, where: { kind: "subject", subject, stream }, label: `subject ${subject}` } : null;
}

/** A KV entry's place: its bucket (mappings apply to whole buckets). */
export function bucketPlace(bucket: string): DecodePlace {
  return { target: { kind: "kvBucket", bucket }, where: { kind: "kvBucket", bucket }, label: `bucket ${bucket}` };
}

/** What a message view needs for decoding: "Decode as…", the codec menu's schemas, the way to the Schemas tab. */
export interface ViewDecoding {
  decodeAs: DecodeAs | undefined;
  choices: readonly SchemaChoice[];
  onManage(): void;
  /** jq on a message's value, on the server (TSK-113). */
  query: ValueQuery;
}

export function useViewDecoding({ client, connId, profile, updateProfile, openTab }: Pick<TabProps, "client" | "connId" | "profile" | "openTab"> & { updateProfile: TabProps["updateProfile"] | undefined }, placeOf: (message: MessageRow) => DecodePlace | null): ViewDecoding {
  const { decodeAs, decoding } = useNatsDecoding(client, connId, profile, updateProfile, placeOf);
  const query = useValueQuery({ client, profile, updateProfile });
  return { decodeAs, choices: decoding.choices, onManage: () => openTab({ kind: "nats.schemas", params: {}, title: "Schemas" }), query };
}
