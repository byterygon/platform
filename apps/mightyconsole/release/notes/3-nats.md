## NATS (TSK-85)

- Connect to a NATS system with a user and password, a token, an NKey or a creds file, over plain
  `nats://` or TLS with a pinned CA and an optional client certificate. Nothing but the NATS servers
  in your profile is contacted (and, if you add one, your schema registry).
- **Server**: the server's info, its JetStream account and limits.
- **Subjects**: subscribe to subjects with wildcards and a queue group, live, with headers; publish
  and request-reply through the Composer, the reply beside the form, and a history of what you
  sent.
- **Streams**: list, info (counts, limits as bars, configuration, cluster, mirror and sources, the
  busiest subjects), create and edit with fields fixed after creation locked, purge (all, by
  subject, keep the newest) and delete behind the typed name. Browse messages from the first, the
  last, a sequence or a time, and follow; load a large message's payload in full.
- **Consumers**: list, state with pending and ack counts, the consumer's position as a bar of its
  stream, create and delete.
- **Key-Value**: buckets, keys, a key's entry and history with revisions compared, "Put revision n
  back" sent with the expected revision, put through the Composer, watch, delete and purge.
- **Object Store**: buckets, objects, upload in parts with progress, download, metadata, delete.
- **Services**: services found with `$SRV.PING`, `INFO` and `STATS`.
- **Decoding**, shared with Kafka: a Schemas tab per connection for Protobuf (.proto files or a
  descriptor set), Avro and JSON Schema; mappings by subject pattern, stream or KV bucket, tested on
  the last 20 matching messages before saving; "Decode as…" on a message that failed to decode; a
  CBOR codec; and a Confluent-compatible schema registry on the profile for messages in the wire
  format on the subjects you list.
- Every place has its own URL, for example `/nats/<profile>/streams/ORDERS/messages`, with the
  breadcrumb and back and forward per tab.
