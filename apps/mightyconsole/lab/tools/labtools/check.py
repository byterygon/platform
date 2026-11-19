"""`check <system>...`: the lab is up and seeded (spec section 14, TSK-79 acceptance). Each check
reads the system through its own API and fails with what is missing. Kubernetes and the Docker
host are checked by lab.mts (kubectl and docker inside their containers)."""

import asyncio
import sys
import time

from .common import credentials, log

failures = []


def expect(ok, message):
    if not ok:
        failures.append(message)
    return ok


async def check_nats():
    import nats

    creds = credentials()["nats"]
    nc = await nats.connect("nats://nats:4222", user=creds["user"], password=creds["password"])
    js = nc.jetstream()
    info = await js.stream_info("ORDERS")
    expect(info.state.messages == 1051, f"nats: ORDERS has {info.state.messages} messages, not 1051")
    consumer = await js.consumer_info("ORDERS", "billing")
    expect(consumer.num_pending > 0 and consumer.num_ack_pending > 0, f"nats: billing has pending {consumer.num_pending}, ack pending {consumer.num_ack_pending}")
    kv = await js.key_value("config")
    # nats-py's history ends at once when its new consumer briefly reports nothing pending (a race
    # in the client, seen as "NoKeysError" now and then): try again before failing.
    from nats.js.errors import NoKeysError

    history = []
    for attempt in range(5):
        try:
            history = await kv.history("feature.checkout")
            break
        except NoKeysError:
            await asyncio.sleep(0.2 * (attempt + 1))
    expect(len(history) == 3, f"nats: feature.checkout has {len(history)} revisions")
    store = await js.object_store("files")
    blob = await store.get_info("blob-5MiB.bin")
    expect(blob.size == 5 * 1024 * 1024, f"nats: blob-5MiB.bin is {blob.size} bytes")
    reply = await nc.request("lab.echo", b"ping", timeout=5)
    expect(reply.data == b"ping", "nats: the echo service did not echo")
    ping = await nc.request("$SRV.PING.echo", b"", timeout=5)
    expect(b'"name":"echo"' in ping.data.replace(b" ", b""), "nats: echo did not answer $SRV.PING")
    # The nkey user and TLS from the lab CA.
    with open(f"/generated/{creds['nkeySeedFile']}") as f:
        seed = f.read().strip()
    import ssl

    tls = ssl.create_default_context(cafile=f"/generated/{creds['caFile']}")
    nk = await nats.connect("tls://nats:4222", nkeys_seed_str=seed, tls=tls, tls_hostname="nats")
    await nk.close()
    # No credentials (the server's no_auth_user), a token, and a creds file (operator mode).
    anon = await nats.connect("nats://nats:4222")
    await anon.close()
    tok = await nats.connect("nats://nats-token:4223", token=creds["token"])
    await tok.close()
    jwt = await nats.connect("nats://nats-jwt:4224", user_credentials=f"/generated/{creds['credsFile']}")
    await jwt.close()
    await nc.close()


def check_kafka():
    from confluent_kafka.admin import AdminClient
    from confluent_kafka.schema_registry import SchemaRegistryClient

    admin = AdminClient({"bootstrap.servers": "kafka:19092"})
    topics = admin.list_topics(timeout=10).topics
    for name in ["orders", "orders-avro", "orders-proto", "payments", "compressed-gzip", "compressed-snappy", "compressed-lz4", "compressed-zstd"]:
        expect(name in topics, f"kafka: topic {name} is missing")
    expect(len(topics.get("orders").partitions) == 6 if "orders" in topics else False, "kafka: orders does not have 6 partitions")
    groups = {g.group_id: g for g in admin.list_consumer_groups().result(timeout=10).valid}
    expect("orders-batch" in groups and str(groups["orders-batch"].state).endswith("EMPTY"), f"kafka: orders-batch is {groups.get('orders-batch') and groups['orders-batch'].state}")
    deadline = time.time() + 60
    while time.time() < deadline and not ("orders-live" in groups and str(groups["orders-live"].state).endswith("STABLE")):
        time.sleep(2)
        groups = {g.group_id: g for g in admin.list_consumer_groups().result(timeout=10).valid}
    expect("orders-live" in groups and str(groups["orders-live"].state).endswith("STABLE"), "kafka: orders-live is not Stable")
    registry = SchemaRegistryClient({"url": "http://schema-registry:8081"})
    subjects = set(registry.get_subjects())
    for subject in ["orders-avro-value", "orders-proto-value", "lab/common/money.proto"]:
        expect(subject in subjects, f"registry: subject {subject} is missing")
    expect(registry.get_versions("orders-avro-value") == [1, 2], "registry: orders-avro-value does not have versions 1 and 2")
    expect(registry.get_compatibility("orders-avro-value") == "BACKWARD", "registry: orders-avro-value is not BACKWARD")
    proto = registry.get_latest_version("orders-proto-value")
    expect(any(r.subject == "lab/common/money.proto" for r in proto.schema.references), "registry: orders-proto-value has no reference to money.proto")


def check_kafka_listeners():
    """Run in Kafka's network namespace (lab.mts): the listeners as a host client sees them, at
    localhost. SCRAM-SHA-512 with the generated user (a wrong password refused), SSL against the
    lab CA."""
    from confluent_kafka import Consumer

    creds = credentials()["kafka"]
    scram = creds["scram"]
    base = {"group.id": "lab-check", "socket.timeout.ms": 5000}
    attempts = [
        ("SCRAM", {"bootstrap.servers": "localhost:9094", "security.protocol": "SASL_PLAINTEXT", "sasl.mechanism": "SCRAM-SHA-512", "sasl.username": scram["user"], "sasl.password": scram["password"]}, True),
        ("SCRAM with a wrong password", {"bootstrap.servers": "localhost:9094", "security.protocol": "SASL_PLAINTEXT", "sasl.mechanism": "SCRAM-SHA-512", "sasl.username": scram["user"], "sasl.password": "wrong", "log_level": 0}, False),
        ("SSL", {"bootstrap.servers": "localhost:9093", "security.protocol": "SSL", "ssl.ca.location": f"/generated/{creds['caFile']}"}, True),
    ]
    for name, conf, should_work in attempts:
        consumer = Consumer({**base, **conf})
        try:
            topics = consumer.list_topics(timeout=10).topics
            expect(should_work and "orders" in topics, f"kafka: {name} was accepted" if not should_work else f"kafka: {name} sees no orders topic")
        except Exception as e:  # noqa: BLE001
            expect(not should_work, f"kafka: {name} failed: {e}")
        finally:
            consumer.close()


async def check_temporal():
    from temporalio.client import Client

    client = await Client.connect("temporal:7233", namespace="lab")
    ids = set()
    async for wf in client.list_workflows():
        ids.add(wf.id)
    for wid in ["fulfilment-long-running", "completed-1", "failed-1", "retrying-1", "parent-1", "parent-1-child", "proto-1"]:
        expect(wid in ids, f"temporal: workflow {wid} is missing")
    # The family for Relations (TSK-104) forms over a few seconds: wait for its last member.
    family = ["family-root", "family-order", "family-order-fraud", "family-order-payment", "family-order-receipt", "family-support"]
    for _ in range(60):
        seen = {wf.id async for wf in client.list_workflows()}
        if all(wid in seen for wid in family):
            break
        await asyncio.sleep(1)
    for wid in family:
        expect(wid in seen, f"temporal: workflow {wid} of the family is missing")
    status = await client.get_workflow_handle("fulfilment-long-running").query("status")
    expect(status == "waiting for approval", f"temporal: fulfilment says {status!r}")
    schedules = [s.id async for s in await client.list_schedules()]
    expect("every-minute" in schedules, "temporal: schedule every-minute is missing")
    # The payload codec (TSK-92): encrypted-1's input is stored encrypted.
    expect("encrypted-1" in ids, "temporal: workflow encrypted-1 is missing")
    if "encrypted-1" in ids:
        history = await client.get_workflow_handle("encrypted-1").fetch_history()
        payload = history.events[0].workflow_execution_started_event_attributes.input.payloads[0]
        expect(payload.metadata.get("encoding") == b"binary/encrypted", "temporal: encrypted-1's input is not encrypted")
    # External Storage (TSK-103): the large input is a reference in the history, not the data.
    expect("big-payload-1" in ids, "temporal: workflow big-payload-1 is missing")
    if "big-payload-1" in ids:
        history = await client.get_workflow_handle("big-payload-1").fetch_history()
        payload = history.events[0].workflow_execution_started_event_attributes.input.payloads[0]
        expect(payload.metadata.get("messageType") == b"temporal.api.sdk.v1.ExternalStorageReference", "temporal: big-payload-1's input is not stored outside")


def check_langgraph():
    import requests

    base = "http://langgraph:2024"
    assistants = requests.post(f"{base}/assistants/search", json={"graph_id": "agent", "limit": 50}, timeout=10).json()
    expect(len(assistants) >= 2, f"langgraph: {len(assistants)} assistants")
    threads = requests.post(f"{base}/threads/search", json={"metadata": {"lab": "history"}, "limit": 5}, timeout=10).json()
    if expect(len(threads) == 1, f"langgraph: {len(threads)} history threads"):
        history = requests.post(f"{base}/threads/{threads[0]['thread_id']}/history", json={"limit": 50}, timeout=10).json()
        expect(len(history) >= 4, f"langgraph: the history thread has {len(history)} checkpoints")
    graph = requests.get(f"{base}/assistants/{assistants[0]['assistant_id']}/graph", params={"xray": "true"}, timeout=10).json()
    expect(len(graph.get("nodes", [])) >= 5, "langgraph: the graph has fewer than 5 nodes")


CHECKS = {"nats": lambda: asyncio.run(check_nats()), "kafka": check_kafka, "kafka-listeners": check_kafka_listeners, "temporal": lambda: asyncio.run(check_temporal()), "langgraph": check_langgraph}


def main(argv):
    for name in argv or list(CHECKS):
        if name not in CHECKS:
            continue
        try:
            CHECKS[name]()
        except Exception as e:  # noqa: BLE001
            failures.append(f"{name}: {type(e).__name__}: {e}")
        else:
            log(f"check: {name} done")
    if failures:
        log("check failed:\n- " + "\n- ".join(failures))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
