"""`seed <system>...`: the sample data of spec section 14, written through each system's own API.
Idempotent: a second run leaves the data as the first one did (streams, topics and subjects are
recreated). The NATS `echo` service, the Kafka group member and the Temporal worker are services
of their own (nats_echo.py, kafka_member.py, temporal_worker.py)."""

import asyncio
import json
import os
import sys
import time
from decimal import Decimal

from . import protos
from .common import credentials, log, wait_for

NATS_URL = "nats://nats:4222"
KAFKA_BOOTSTRAP = "kafka:19092"
REGISTRY_URL = "http://schema-registry:8081"
LANGGRAPH_URL = "http://langgraph:2024"
SCHEMAS = os.path.join(os.path.dirname(__file__), "..", "schemas")


# --------------------------------------------------------------------------------------------
# NATS


async def seed_nats():
    import nats
    from nats.js.api import ConsumerConfig, KeyValueConfig, ObjectStoreConfig, StreamConfig
    from nats.js.errors import NotFoundError

    creds = credentials()["nats"]
    nc = await nats.connect(NATS_URL, user=creds["user"], password=creds["password"])
    js = nc.jetstream()
    try:
        await js.delete_stream("ORDERS")
    except NotFoundError:
        pass
    await js.add_stream(StreamConfig(name="ORDERS", subjects=["orders.>"]))
    regions = ["eu", "us", "apac"]
    for i in range(1000):
        body = {"id": f"ord-{i:05d}", "customer": f"customer-{i % 17}", "amount": round(10 + (i % 90) + i / 100, 2), "region": regions[i % 3]}
        headers = {"Lab-Seq": str(i), "Content-Type": "application/json"}
        await js.publish(f"orders.{regions[i % 3]}.created", json.dumps(body).encode(), headers=headers)
    for i in range(50):
        await js.publish(f"orders.proto.{regions[i % 3]}", protos.order(i).SerializeToString(), headers={"Content-Type": "application/x-protobuf", "Lab-Seq": str(i)})
    # One message over 1 MiB, for "Load full payload" (spec §5.1): a JSON document of 1.5 MiB.
    large = json.dumps({"id": "ord-large", "note": "x" * (1536 * 1024)}).encode()
    await js.publish("orders.large", large, headers={"Content-Type": "application/json", "Lab-Seq": "large"})
    # A durable pull consumer with pending messages: 100 fetched and acked, the rest pending.
    await js.add_consumer("ORDERS", ConsumerConfig(durable_name="billing", filter_subject="orders.eu.>", ack_wait=30))
    sub = await js.pull_subscribe("orders.eu.>", durable="billing", stream="ORDERS")
    acked = 0
    while acked < 100:
        for msg in await sub.fetch(min(50, 100 - acked), timeout=5):
            await msg.ack()
            acked += 1
    # Three more fetched and not acked: "ack pending".
    for msg in await sub.fetch(3, timeout=5):
        pass

    try:
        await js.delete_key_value("config")
    except NotFoundError:
        pass
    kv = await js.create_key_value(KeyValueConfig(bucket="config", history=5))
    for revision in range(3):
        await kv.put("feature.checkout", json.dumps({"enabled": revision % 2 == 0, "revision": revision}).encode())
    await kv.put("limits.orders", b'{"perMinute": 600}')
    await kv.put("motd", b"Welcome to the lab")
    await kv.put("legacy.flag", b"true")
    await kv.delete("legacy.flag")

    try:
        await js.delete_object_store("files")
    except NotFoundError:
        pass
    store = await js.create_object_store("files", config=ObjectStoreConfig(description="Mightyconsole lab"))
    blob = bytes((i * 31 + 7) % 251 for i in range(5 * 1024 * 1024))
    await store.put("blob-5MiB.bin", blob)
    await store.put("readme.txt", b"Files of the Mightyconsole lab.\n")
    await nc.close()
    log("nats: stream ORDERS (1,051 messages, one of 1.5 MiB), consumer billing, KV config, object store files")


# --------------------------------------------------------------------------------------------
# Kafka and Schema Registry


def seed_kafka():
    from confluent_kafka import Consumer, Producer
    from confluent_kafka.admin import AdminClient, NewTopic, ScramCredentialInfo, ScramMechanism, UserScramCredentialUpsertion
    from confluent_kafka.schema_registry import SchemaRegistryClient
    from confluent_kafka.schema_registry.avro import AvroSerializer
    from confluent_kafka.schema_registry.protobuf import ProtobufSerializer
    from confluent_kafka.serialization import MessageField, SerializationContext

    creds = credentials()["kafka"]
    admin = AdminClient({"bootstrap.servers": KAFKA_BOOTSTRAP})

    # The SCRAM user of the SASL listener.
    scram = creds["scram"]
    upsert = UserScramCredentialUpsertion(scram["user"], ScramCredentialInfo(ScramMechanism.SCRAM_SHA_512, 8192), scram["password"].encode())
    for future in admin.alter_user_scram_credentials([upsert]).values():
        future.result()

    codecs = ["gzip", "snappy", "lz4", "zstd"]
    topics = [
        NewTopic("orders", num_partitions=6, replication_factor=1),
        NewTopic("orders-avro", num_partitions=3, replication_factor=1),
        NewTopic("orders-proto", num_partitions=3, replication_factor=1),
        NewTopic("payments", num_partitions=2, replication_factor=1, config={"cleanup.policy": "compact", "min.cleanable.dirty.ratio": "0.01", "segment.ms": "60000"}),
    ] + [NewTopic(f"compressed-{c}", num_partitions=1, replication_factor=1, config={"compression.type": "producer"}) for c in codecs]
    existing = set(admin.list_topics(timeout=10).topics)
    stale = [t.topic for t in topics if t.topic in existing]
    if stale:
        for future in admin.delete_topics(stale).values():
            future.result()
        wait_for(lambda: not (set(stale) & set(admin.list_topics(timeout=10).topics)), "the old topics to go", 60)
    for future in admin.create_topics(topics).values():
        future.result()
    for name in ["orders-batch", "orders-live"]:
        try:
            for future in admin.delete_consumer_groups([name]).values():
                future.result()
        except Exception:
            pass

    producer = Producer({"bootstrap.servers": KAFKA_BOOTSTRAP, "linger.ms": 5})
    for i in range(2000):
        key = f"customer-{i % 17}"
        value = {"id": f"ord-{i:05d}", "customer": key, "amount": round(10 + (i % 90) + i / 100, 2), "status": ["placed", "paid", "shipped"][i % 3]}
        producer.produce("orders", key=key.encode(), value=json.dumps(value).encode(), headers=[("lab-seq", str(i).encode()), ("content-type", b"application/json"), ("trace-id", f"t-{i:06x}".encode())])
    for i in range(300):
        account = f"acct-{i % 25}"
        producer.produce("payments", key=account.encode(), value=json.dumps({"account": account, "balance": i * 3}).encode())
    for i in range(5):
        producer.produce("payments", key=f"acct-{i}".encode(), value=None)  # tombstones
    producer.flush(30)
    for codec in codecs:
        p = Producer({"bootstrap.servers": KAFKA_BOOTSTRAP, "compression.type": codec, "linger.ms": 20})
        for i in range(200):
            p.produce(f"compressed-{codec}", key=str(i).encode(), value=json.dumps({"codec": codec, "n": i, "text": "lorem ipsum " * 8}).encode())
        p.flush(30)

    # Schema Registry: two versions of the Avro value subject under BACKWARD; Protobuf with a
    # reference to money.proto.
    registry = SchemaRegistryClient({"url": REGISTRY_URL})
    for subject in ["orders-avro-value", "orders-proto-value", "lab/common/money.proto"]:
        try:
            registry.delete_subject(subject, permanent=False)
            registry.delete_subject(subject, permanent=True)
        except Exception:
            pass
    registry.set_compatibility("orders-avro-value", "BACKWARD")
    with open(os.path.join(SCHEMAS, "order-v1.avsc")) as f:
        v1 = f.read()
    with open(os.path.join(SCHEMAS, "order-v2.avsc")) as f:
        v2 = f.read()
    for version, schema in [(1, v1), (2, v2)]:
        serializer = AvroSerializer(registry, schema, conf={"auto.register.schemas": True})
        for i in range(100):
            value = {"id": f"ord-{version}-{i:04d}", "customer": f"customer-{i % 17}", "amount": Decimal(f"{10 + i}.{i % 100:02d}"), "placedAt": int(time.time() * 1000) - i * 60_000, "note": None if i % 4 else "gift"}
            if version == 2:
                value["channel"] = ["WEB", "STORE", "PHONE"][i % 3]
            producer.produce("orders-avro", key=value["customer"].encode(), value=serializer(value, SerializationContext("orders-avro", MessageField.VALUE)))
    proto_serializer = ProtobufSerializer(protos.Order, registry, conf={"use.deprecated.format": False, "auto.register.schemas": True})
    for i in range(100):
        message = protos.order(i)
        producer.produce("orders-proto", key=message.customer.encode(), value=proto_serializer(message, SerializationContext("orders-proto", MessageField.VALUE)))
    producer.flush(30)

    # Consumer groups: `orders-batch` read 500 messages and left (Empty, with lag); `orders-live`
    # is held by the kafka-member service.
    consumer = Consumer({"bootstrap.servers": KAFKA_BOOTSTRAP, "group.id": "orders-batch", "auto.offset.reset": "earliest", "enable.auto.commit": False})
    consumer.subscribe(["orders"])
    read = 0
    deadline = time.time() + 60
    while read < 500 and time.time() < deadline:
        msg = consumer.poll(1.0)
        if msg is not None and msg.error() is None:
            read += 1
    consumer.commit(asynchronous=False)
    consumer.close()
    log(f"kafka: 8 topics, SCRAM user {scram['user']}, registry subjects, group orders-batch ({read} read)")


# --------------------------------------------------------------------------------------------
# Temporal: the worker starts the samples; the seed starts the long histories (TSK-109) and waits
# for them, as they take a minute or two to build.


async def seed_temporal_long(timeout=900):
    from temporalio.client import Client, WorkflowExecutionStatus

    from .temporal_worker import LONG_PLANS, LONG_QUEUE

    client = None
    for _ in range(120):
        try:
            client = await Client.connect("temporal:7233", namespace="lab")
            break
        except Exception:  # noqa: BLE001 - the server is starting
            await asyncio.sleep(1)
    assert client is not None, "Temporal did not answer"
    for workflow_id, plan in LONG_PLANS.items():
        try:
            await client.start_workflow("LongHistory", plan, id=workflow_id, task_queue=LONG_QUEUE)
        except Exception as e:  # noqa: BLE001 - already started on an earlier seed
            if "already" not in str(e).lower():
                raise
    deadline = time.monotonic() + timeout
    for workflow_id, plan in LONG_PLANS.items():
        while True:
            described = await client.get_workflow_handle(workflow_id).describe()
            built = described.history_length >= plan["buildTo"] if "buildTo" in plan else described.status == WorkflowExecutionStatus.COMPLETED
            if built:
                size = described.raw_description.workflow_execution_info.history_size_bytes
                log(f"temporal: {workflow_id} has {described.history_length:,} events, {size / 1048576:.1f} MiB")
                break
            if described.status not in (WorkflowExecutionStatus.RUNNING, WorkflowExecutionStatus.COMPLETED):
                raise RuntimeError(f"temporal: {workflow_id} ended {described.status.name}")
            if time.monotonic() > deadline:
                raise RuntimeError(f"temporal: {workflow_id} has only {described.history_length:,} events after {timeout} s")
            await asyncio.sleep(3)


# --------------------------------------------------------------------------------------------
# LangGraph


def seed_langgraph():
    import requests

    base = LANGGRAPH_URL
    wait_for(lambda: requests.get(f"{base}/ok", timeout=2).ok, "the LangGraph server", 120)
    assistants = requests.post(f"{base}/assistants/search", json={"graph_id": "agent", "limit": 50}, timeout=10).json()
    if not any(a.get("name") == "agent-strict" for a in assistants):
        requests.post(f"{base}/assistants", json={"graph_id": "agent", "name": "agent-strict", "config": {"configurable": {"require_approval": True}}, "metadata": {"lab": True}}, timeout=10).raise_for_status()
    seed_langgraph_heavy(base)
    threads = requests.post(f"{base}/threads/search", json={"metadata": {"lab": "history"}, "limit": 5}, timeout=10).json()
    if threads:
        log("langgraph: assistants and the history thread are there")
        return
    thread = requests.post(f"{base}/threads", json={"metadata": {"lab": "history"}}, timeout=10).json()
    run = {"assistant_id": "agent", "input": {"messages": [{"role": "user", "content": "What is 6 times 7?"}]}}
    requests.post(f"{base}/threads/{thread['thread_id']}/runs/wait", json=run, timeout=60).raise_for_status()
    # The run stops at the approval interrupt; resume it.
    resume = {"assistant_id": "agent", "command": {"resume": "approved"}}
    requests.post(f"{base}/threads/{thread['thread_id']}/runs/wait", json=resume, timeout=60).raise_for_status()
    log(f"langgraph: assistant agent-strict, thread {thread['thread_id']} with history")


def seed_langgraph_heavy(base):
    """TSK-108: a thread with many runs and a thread with heavy checkpoints, to show that replies
    stay under the frame limit (4 MiB a page, a value over 1 MiB left out with a note).

    Sizes are what `langgraph dev` (in memory) and the lab VM bear: the whole thing is about 50 MiB
    of checkpoints, not the tens of megabytes per checkpoint a production thread can reach (the
    server's tests cover those against a stand-in server)."""
    import requests

    def thread(kind):
        found = requests.post(f"{base}/threads/search", json={"metadata": {"lab": kind}, "limit": 1}, timeout=10).json()
        return None if found else requests.post(f"{base}/threads", json={"metadata": {"lab": kind}}, timeout=10).json()["thread_id"]

    def run(thread_id, text, metadata=None):
        body = {"assistant_id": "agent", "input": {"messages": [{"role": "user", "content": text}]}, "metadata": metadata or {}}
        requests.post(f"{base}/threads/{thread_id}/runs/wait", json=body, timeout=120).raise_for_status()

    many = thread("many-runs")
    if many:
        # 40 runs of 128 KiB of metadata (5 MiB: two pages of 4 MiB), the 41st with 2 MiB (left out).
        for i in range(40):
            run(many, f"run {i}", {"index": i, "blob": "m" * (128 * 1024)})
        run(many, "run 40", {"index": 40, "blob": "M" * (2 * 1024 * 1024)})
        log(f"langgraph: thread {many} with 41 runs of big metadata")
    heavy = thread("heavy-state")
    if heavy:
        # Two messages of 1.5 MiB: checkpoints of 1.5 to 6 MiB (their values are over the 1 MiB
        # share in History and under the 8 MiB of one state).
        for i in range(2):
            run(heavy, f"heavy {i} " + chr(97 + i) * (3 * 512 * 1024))
        log(f"langgraph: thread {heavy} with checkpoints of up to 6 MiB")


SEEDS = {"nats": lambda: asyncio.run(seed_nats()), "kafka": seed_kafka, "temporal": lambda: asyncio.run(seed_temporal_long()), "langgraph": seed_langgraph}


def main(argv):
    names = argv or list(SEEDS)
    for name in names:
        if name in SEEDS:
            SEEDS[name]()
        else:
            log(f"seed: nothing to seed here for {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
