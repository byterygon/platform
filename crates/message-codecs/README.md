# message-codecs

The message model, codecs and schema sources of Mightyconsole's messaging core (Mightyconsole
spec §5, TSK-80). NATS and Kafka both use it without either knowing the other, and Temporal uses
it for payloads. It has no tool code and opens no connection except to a Schema Registry the caller
configures. Licence: MIT OR Apache-2.0.

## What is in it

| Module | What |
| --- | --- |
| `message` | `Message`: source, subject, partition, offset, sequence, timestamp and its kind, operation, reply subject, headers, key, payload. Raw bytes are always kept. |
| `codec` | The codec registry and `Codecs`, which holds one connected profile's registry, local schemas and mappings. `decode` never fails (a failure is in `Decoded::error`); `encode` returns `Invalid` errors with the field and the position. |
| `schema` | `CompiledSchema` (Avro, Protobuf pool, JSON Schema validator), local schemas, mappings, NATS subject matching. |
| `registry` | Confluent Schema Registry client: schemas by id (cached forever), subject versions, references resolved recursively, register, compatibility checks, levels, mode. |
| `wire` | The Confluent wire format: magic byte 0, the schema id, then for Protobuf the message indexes. |
| `naming` | `TopicNameStrategy`, `RecordNameStrategy`, `TopicRecordNameStrategy`, plus the topics that use a subject. |
| `filter` | The filter of §5.4: key, subject (NATS wildcards), headers, text, time and position ranges, and jq through jaq; `check` lists issues per part with jq line and column. |
| `inspect` | A schema as the JSON Schema of its codec's JSON (Avro natural form, Protobuf canonical JSON), with an example payload. |
| `types` | The wire types of the procedures (camelCase). With the `codegen` feature they derive `ts_rs::TS` and `schemars::JsonSchema`. |

## Codecs

| Id | Decoded to | Library |
| --- | --- | --- |
| `utf8` | text | std |
| `json` | the text as sent, plus its value | serde_json |
| `hex`, `base64` | their text | hex, base64 |
| `msgpack` | JSON: binary as `{"$binary": b64}`, ext as `{"$ext": type, "data": b64}` | rmpv |
| `avro` | natural JSON: unions unwrapped; enums and uuids as strings; bytes and fixed as base64; decimals as strings; dates `YYYY-MM-DD`; times `HH:MM:SS.fff`; timestamps RFC 3339 at the type's precision | apache-avro |
| `protobuf` | proto3 canonical JSON (dynamic messages; `.proto` text compiled at run time) | prost-reflect, protox |
| `jsonschema` | JSON. Violations are listed in `decodeError` and do not fail the decode; encoding refuses them. | jsonschema |

Integers beyond 2^53 are written as strings so a JavaScript reader keeps every digit. Object key
order is kept, both when decoding and when encoding MessagePack.

**Auto-detect order** (key and value separately):

1. the wire format, when the profile has a registry and the id resolves;
2. a mapping to a local schema;
3. `json` (an object or an array; a bare number or string stays text);
4. `msgpack` (one map or array, the whole payload);
5. `utf8` (95% printable);
6. `hex`.

`base64` is never detected.

## Schema sources

- **Registry.** `RegistryConfig { url, auth: None | Basic | Bearer, tls, client_key_pem, timeout }`.
  The client is a small HTTP/1.1 client on hyper and rustls. There is no proxy and no redirects.
  An `https` registry needs its CA in the profile, because no system roots are loaded (spec Open
  question 6). `Debug` never prints a password, token or key.
- **Local schemas**: `.avsc` files (the first is the schema, the rest named types it uses), `.proto`
  files with imports (Google's well-known types are built in), a compiled `FileDescriptorSet`,
  or JSON Schema files (the rest are `$ref` targets). They compile when `Codecs::new` runs, and
  `Codecs::issues` names the file, line and column of each failure. `$ref`s and imports resolve
  only among the given files: nothing is fetched.

## Tests

```sh
cargo test -p message-codecs                    # unit tests, plus a fake registry on loopback
MESSAGE_CODECS_REGISTRY_URL=http://127.0.0.1:8081 \
  cargo test -p message-codecs --test registry_lab   # against the lab's Confluent registry
```

The lab test is skipped without the variable, unless `BYTERYGON_REQUIRE_LAB=1` (the Mightyconsole
lab workflow sets both). Start the registry with `pnpm --filter @byterygon/mightyconsole lab up kafka`.

## Licences of dependencies

Everything passes `deny.toml`. One crate needs an exception: `borrow-or-share` is `MIT-0`, which
is MIT without the attribution clause. It comes in through `fluent-uri`, which every Rust JSON
Schema validator uses. The exception is listed per crate, pending approval (Mightyconsole spec
Open question 29).
