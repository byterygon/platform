# Mightyconsole test lab

Every system Mightyconsole talks to, on this machine, seeded with sample data (TSK-79,
Mightyconsole spec section 14). Lab only: nothing here is shipped.

```sh
pnpm --filter @byterygon/mightyconsole lab up              # all tools; or: lab up nats kafka
pnpm --filter @byterygon/mightyconsole lab check           # every service up and seeded
pnpm --filter @byterygon/mightyconsole lab down            # remove it all, volumes included
```

`lab.mts` needs Node and Docker with compose, nothing else (Python runs in the lab's images).
Other commands: `lab seed [tool...]` (idempotent), `lab images check`, `lab images save FILE`,
`lab lock` (re-lock the Python packages), `lab langgraph-offline`.

| Tool | Service | Address (127.0.0.1) | Seeded with |
| --- | --- | --- | --- |
| nats | `nats` 2.12, JetStream; `nats-echo` | 4222 (plain or TLS from the lab CA), 8222 monitoring | stream `ORDERS` (1,000 JSON on `orders.<region>.created`, 50 Protobuf on `orders.proto.<region>`), consumer `billing` with pending and ack-pending messages, KV `config` (history, a deleted key), object store `files` (a 5 MiB blob), service `echo` (`lab.echo`, `lab.echo.upper`) |
| kafka | `kafka` 4.1 KRaft; `schema-registry` (Confluent, lab only); `kafka-member` | 9092 PLAINTEXT, 9093 SSL (lab CA), 9094 SASL SCRAM-SHA-512; registry 8081 | `orders` (6 partitions, JSON, headers), `orders-avro` (two schema versions, BACKWARD), `orders-proto` (a reference to `money.proto`), `payments` (compacted, tombstones), `compressed-{gzip,snappy,lz4,zstd}`; group `orders-batch` (Empty, lag) and `orders-live` (Stable, lag) |
| k8s | `k3s` 1.34, Traefik off | 6443, kubeconfig in `.generated/kubeconfig` | namespace `lab`: deployment (3), statefulset, daemonset, job, cronjob, services, ingress, config map, secret, CRD `widgets.lab.byterygon.dev` with two resources, a crash-looping pod, a pod logging ANSI colours |
| temporal | `temporal` dev server 1.10 (namespaces `default`, `lab`); `temporal-worker` with External Storage; `seaweedfs` 4.54, the S3 store of External Storage (MinIO no longer publishes images); `temporal-codec`, an AES-GCM payload codec server (Temporal's codec-server protocol, bearer token) | 7233, 8333, 8234 | in `lab`: a long-running workflow (signal `approve`, query `status`), a completed one, a failed one, a retrying activity, a parent with a child, a Protobuf payload, `big-payload-1` (300 KiB input and result, stored in bucket `temporal-payloads`), `encrypted-1` (task queue `lab-encrypted`, payloads encrypted by the lab codec; key and token in `credentials.json` under `temporal.codec`), schedule `every-minute`; the custom search attribute `OrderId` (Keyword) on `fulfilment-long-running`, `failed-1`, `retrying-1` and `parent-1` (TSK-94); S3 keys in `credentials.json` under `temporal.externalStorage` (read-write, and `readOnly`); long histories near Temporal's limits of a run (TSK-109, task queue `lab-long`, started and awaited by `lab seed temporal`, a minute or two): `history-many-1` (about 48,000 events, payloads of 512 bytes), `history-heavy-1` (about 46 MiB in about 1,700 events, payloads of 40 KiB), `history-follow-1` (running: 20,000 events, then an activity every 2 s, continued as new at 30,000) |
| docker | `docker-host`: Docker in Docker with sshd | 2222 (users `lab` with keys, `labpw` with a password, `nofwd` with the keys but no socket forwarding) | Compose project `shop` (two services), container `stopped`, TTY container `tty`, volume `lab-cache`, network `lab-net` |
| langgraph | `langgraph`: `langgraph dev` (in-memory) with the sample graph | 2024 | graph `agent` (fake model, tool node, conditional edge, subgraph, interrupt, store, a context schema with `user_id` required: TSK-94), assistants `agent` and `agent-strict`, a thread with history |

Credentials, keys and certificates are generated at `lab up` into `.generated/` (git-ignored),
with an index in `.generated/credentials.json`; integration tests read them from there. Images
are pinned by digest in `compose.yaml` and listed in `images.lock`; the three built images pin
their base by digest and their Python packages by hash. `lab images save` writes them to one
tarball for an offline machine; the images k3s and the Docker host pull inside (busybox, k3s's
own system images) are not in it yet.

The Confluent Schema Registry (Confluent Community License) and `langgraph dev` (langgraph-api,
Elastic License 2.0) run here only, pulled or installed by the developer, never redistributed.
`lab langgraph-offline` shows the LangGraph server starts and serves a run on a network without
egress and with no licence key.
