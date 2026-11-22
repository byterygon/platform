"""The lab's Temporal worker (task queue `lab`, namespace `lab`) and its sample workflows (TSK-83):
a long-running one with a signal and a query, a completed one, a failed one, one with an activity
that keeps retrying, a parent with a child, one with a Protobuf payload, a family for Relations
(TSK-104: family-root starts family-order, which starts three children, one failing, and is
signalled by family-support), and a schedule that runs every minute. Started once when the worker starts; ids are fixed, so a restart starts nothing
twice. Four samples carry the custom search attribute `OrderId` (TSK-94), their order id:
fulfilment-long-running, failed-1, retrying-1 and parent-1; the others' started events stay as
the payload and relation tests read them. External Storage (TSK-103): payloads of 256 KiB or more go to the lab's S3 store through the
SDK's S3 driver; `big-payload-1` has a 300 KiB input and result. A payload codec (TSK-92): a second
worker on task queue `lab-encrypted` encrypts its payloads with the lab's AES-GCM codec;
`encrypted-1` is stored encrypted. Standalone activities (TSK-92): `sa-charge-1`, a `charge` run without a
workflow; `hold` heartbeats until it is cancelled, for the cancel test. Large payloads (TSK-92): `large-1`
has an input of about 1.5 MiB (12,480 inventory lines) kept in the history itself (started by a
client without External Storage), under Temporal's 2 MiB limit. Long histories (TSK-109): the
`LongHistory` runs of LONG_PLANS on task queue `lab-long`, started by `lab seed temporal`, near
Temporal's own limits of a run (51,200 events, 50 MiB)."""

import asyncio
import dataclasses
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.client import Client, Schedule, ScheduleActionStartWorkflow, ScheduleIntervalSpec, ScheduleSpec
from temporalio.common import ActivityIDReusePolicy, RetryPolicy, SearchAttributeKey, SearchAttributePair, TypedSearchAttributes
from temporalio.contrib.aws.s3driver import S3StorageDriver
from temporalio.converter import DataConverter, ExternalStorage
from temporalio.exceptions import ApplicationError, ChildWorkflowError, TemporalError
from temporalio.service import RPCError
from temporalio.worker import Worker

with workflow.unsafe.imports_passed_through():
    from . import protos
    from .common import log
    from .codec import LabEncryption, lab_codec
    from .s3 import LabS3, lab_s3

TASK_QUEUE = "lab"
LONG_QUEUE = "lab-long"
# The custom search attribute compose.yaml registers (`--search-attribute OrderId=Keyword`).
ORDER_ID = SearchAttributeKey.for_keyword("OrderId")


@activity.defn
async def charge(order_id: str) -> str:
    return f"charged {order_id}"


@activity.defn
async def flaky(order_id: str) -> str:
    raise ApplicationError(f"the payment provider is down for {order_id}")


@activity.defn
async def hold(seconds: int) -> str:
    """Heartbeats every half second for `seconds`; a cancel arrives through the heartbeat."""
    for _ in range(int(seconds) * 2):
        activity.heartbeat()
        await asyncio.sleep(0.5)
    return f"held {seconds}s"


@workflow.defn
class Fulfilment:
    """Waits for `approve`; `status` answers where it is."""

    def __init__(self) -> None:
        self._approved = False
        self._status = "waiting for approval"

    @workflow.run
    async def run(self, order_id: str) -> str:
        await workflow.wait_condition(lambda: self._approved)
        self._status = "charging"
        result = await workflow.execute_activity(charge, order_id, start_to_close_timeout=timedelta(seconds=30))
        self._status = "done"
        return result

    @workflow.signal
    def approve(self, by: str) -> None:
        self._approved = True
        self._status = f"approved by {by}"

    @workflow.query
    def status(self) -> str:
        return self._status


@workflow.defn
class Completed:
    @workflow.run
    async def run(self, order_id: str) -> str:
        return await workflow.execute_activity(charge, order_id, start_to_close_timeout=timedelta(seconds=30))


@workflow.defn
class Failed:
    @workflow.run
    async def run(self, order_id: str) -> str:
        raise ApplicationError(f"order {order_id} was rejected", type="Rejected", non_retryable=True)


@workflow.defn
class Retrying:
    @workflow.run
    async def run(self, order_id: str) -> str:
        return await workflow.execute_activity(flaky, order_id, start_to_close_timeout=timedelta(seconds=10), retry_policy=RetryPolicy(initial_interval=timedelta(seconds=5), backoff_coefficient=1.0))


@workflow.defn
class Parent:
    @workflow.run
    async def run(self, order_id: str) -> str:
        child = await workflow.execute_child_workflow(Completed.run, f"{order_id}-child", id=f"{workflow.info().workflow_id}-child")
        return f"parent of {child}"


@workflow.defn
class FamilyRoot:
    """The root of the Relations family (TSK-104): starts the order and waits for it."""

    @workflow.run
    async def run(self, order_id: str) -> str:
        return await workflow.execute_child_workflow(FamilyOrder.run, order_id, id="family-order")


@workflow.defn
class FamilyOrder:
    """Three children (one completes, one keeps running, one fails), then waits for
    `customerConfirmed` from the support workflow and for the payment."""

    def __init__(self) -> None:
        self._confirmed = False

    @workflow.run
    async def run(self, order_id: str) -> str:
        await workflow.execute_child_workflow(Completed.run, f"{order_id}-fraud", id="family-order-fraud")
        payment = await workflow.start_child_workflow(Fulfilment.run, f"{order_id}-payment", id="family-order-payment")
        try:
            await workflow.execute_child_workflow(Failed.run, f"{order_id}-receipt", id="family-order-receipt")
        except ChildWorkflowError:
            pass
        await workflow.wait_condition(lambda: self._confirmed)
        return await payment

    @workflow.signal(name="customerConfirmed")
    def customer_confirmed(self, by: str) -> None:
        self._confirmed = True


@workflow.defn
class FamilySupport:
    """Another workflow that signals the order (an external signal), then stays open."""

    @workflow.run
    async def run(self, target: str) -> None:
        handle = workflow.get_external_workflow_handle(target)
        for _ in range(60):
            try:
                await handle.signal("customerConfirmed", "support")
                break
            except TemporalError:
                # The order is not started yet (the signal failed): try again.
                await workflow.sleep(timedelta(seconds=1))
        await workflow.wait_condition(lambda: False)


# Long histories (TSK-109). Temporal terminates a run past 51,200 events or 50 MiB of history, so
# these stop short of both: `history-many-1` is the event limit (payloads of 512 bytes),
# `history-heavy-1` the size limit (payloads of 40 KiB, about 1,700 events: a page of 1,000 of
# them is over Ambidex's 16 MiB frame), `history-follow-1` a running run with a long history that
# grows by an activity every 2 seconds (it continues as new before a limit).
LONG_PLANS = {
    "history-many-1": {"events": 48_000, "bytes": 45 * 1024 * 1024, "payload": 512},
    "history-heavy-1": {"events": 48_000, "bytes": 46 * 1024 * 1024, "payload": 40 * 1024},
    "history-follow-1": {"events": 30_000, "bytes": 20 * 1024 * 1024, "payload": 512, "buildTo": 20_000, "trickleSeconds": 2},
}
# Activities started at once while a history is built.
LONG_BATCH = 100


def filler(line: int, size: int) -> str:
    """A line's text of `size` characters, the same on every replay."""
    head = f"{line:06d} "
    return head + ("abcdefghijklmnopqrstuvwxyz0123456789" * (size // 36 + 1))[: max(size - len(head), 0)]


@activity.defn
async def echo_line(line: dict) -> dict:
    """Returns the line's text (a result as big as the input), after `delay` seconds."""
    if line.get("delay"):
        await asyncio.sleep(line["delay"])
    return {"line": line["line"], "echo": line["text"]}


@workflow.defn
class LongHistory:
    """Builds a history to `buildTo` (else `events`) events or `bytes` bytes, whichever comes
    first, with activities whose input and result carry `payload` characters each; with
    `trickleSeconds`, then adds one activity that long at a time up to `events` and continues as
    new, so the run stays open."""

    @workflow.run
    async def run(self, plan: dict) -> dict:
        info = workflow.info()
        per_activity = 2 * plan["payload"] + 1024
        timeout = timedelta(seconds=120)
        line = 0

        def call(n: int, delay: float = 0) -> object:
            return workflow.execute_activity(echo_line, {"line": n, "text": filler(n, plan["payload"]), "delay": delay}, task_queue=LONG_QUEUE, start_to_close_timeout=timeout)

        build_to = plan.get("buildTo", plan["events"])
        while True:
            # About 5 events an activity (its 3 and its share of workflow tasks): never past a limit.
            n = min(LONG_BATCH, (build_to - info.get_current_history_length()) // 5, (plan["bytes"] - info.get_current_history_size()) // per_activity)
            if n < 1:
                break
            await asyncio.gather(*(call(line + i) for i in range(n)))
            line += n
        if plan.get("trickleSeconds"):
            while plan["events"] - info.get_current_history_length() > 50 and plan["bytes"] - info.get_current_history_size() > 4 * per_activity:
                await call(line, plan["trickleSeconds"])
                line += 1
            workflow.continue_as_new(plan)
        return {"lines": line, "events": info.get_current_history_length(), "bytes": info.get_current_history_size()}


def big_text(seed: str, size: int = 300 * 1024) -> str:
    line = f"{seed} " + "x" * 100 + "\n"
    return (line * (size // len(line) + 1))[:size]


@workflow.defn
class Encrypted:
    @workflow.run
    async def run(self, order: dict) -> dict:
        return {"charged": order.get("amount"), "card": "****" + str(order.get("card", ""))[-4:]}


@workflow.defn
class BigPayload:
    @workflow.run
    async def run(self, document: dict) -> dict:
        return {"received": len(document.get("text", "")), "echo": big_text("result")}


@workflow.defn
class LargeInput:
    @workflow.run
    async def run(self, snapshot: dict) -> dict:
        items = snapshot.get("items", [])
        return {"items": len(items), "outOfStock": sum(1 for i in items if i.get("qty") == 0)}


def large_snapshot() -> dict:
    """About 1.5 MiB of JSON: 12,480 inventory lines, each with its recent history."""
    items = [
        {"sku": f"A-{i:05d}", "qty": 0 if i % 40 == 1 else 1 + (i * 7) % 23, "bin": f"BER-1/{i % 40:02d}/{i % 9}", "history": [{"at": f"2026-11-{1 + i % 18:02d}", "delta": (i % 5) - 2}] * 2}
        for i in range(12_480)
    ]
    return {"warehouseIds": ["BER-1", "HAM-2"], "items": items, "snapshotAt": "2026-11-18T10:29:58Z", "debug": {"source": "lab", "note": "n" * 40_000, "rev": 7}}


@workflow.defn
class ProtoOrder:
    @workflow.run
    async def run(self, order: protos.Order) -> protos.Order:
        updated = protos.Order()
        updated.CopyFrom(order)
        updated.status = 2
        return updated


async def start_samples(client: Client) -> None:
    samples = [
        (Fulfilment.run, "ord-long", "fulfilment-long-running"),
        (Completed.run, "ord-done", "completed-1"),
        (Failed.run, "ord-bad", "failed-1"),
        (Retrying.run, "ord-flaky", "retrying-1"),
        (Parent.run, "ord-parent", "parent-1"),
        (FamilyRoot.run, "ord-family", "family-root"),
        (FamilySupport.run, "family-order", "family-support"),
        (ProtoOrder.run, protos.order(7), "proto-1"),
        (BigPayload.run, {"kind": "big", "text": big_text("input")}, "big-payload-1"),
    ]
    # OrderId only where TSK-94 needs it; other tests read the other samples' events as they were.
    tagged = {"fulfilment-long-running", "failed-1", "retrying-1", "parent-1"}
    for run, arg, workflow_id in samples:
        tags = TypedSearchAttributes([SearchAttributePair(ORDER_ID, str(arg))]) if workflow_id in tagged else None
        try:
            await client.start_workflow(run, arg, id=workflow_id, task_queue=TASK_QUEUE, search_attributes=tags)
        except Exception as e:  # noqa: BLE001 - already started on an earlier start
            if "already" not in str(e).lower():
                raise
    try:
        await client.create_schedule(
            "every-minute",
            Schedule(action=ScheduleActionStartWorkflow(Completed.run, "ord-scheduled", id="scheduled", task_queue=TASK_QUEUE), spec=ScheduleSpec(intervals=[ScheduleIntervalSpec(every=timedelta(minutes=1))])),
        )
    except Exception as e:  # noqa: BLE001
        if "already" not in str(e).lower():
            raise


def data_converter() -> DataConverter:
    s3 = lab_s3()
    store = LabS3(s3["internalEndpoint"], s3["accessKeyId"], s3["secretAccessKey"], s3["region"])
    store.create_bucket(s3["bucket"])
    driver = S3StorageDriver(client=store, bucket=s3["bucket"])
    return dataclasses.replace(DataConverter.default, external_storage=ExternalStorage(drivers=[driver]))


async def main() -> None:
    client = None
    converter = None
    for _ in range(120):
        try:
            converter = converter or data_converter()
            client = await Client.connect("temporal:7233", namespace="lab", data_converter=converter)
            break
        except RPCError:
            await asyncio.sleep(1)
        except (OSError, RuntimeError):
            await asyncio.sleep(1)
    assert client is not None, "Temporal did not answer"
    worker = Worker(client, task_queue=TASK_QUEUE, workflows=[Fulfilment, Completed, Failed, Retrying, Parent, ProtoOrder, BigPayload, LargeInput, FamilyRoot, FamilyOrder, FamilySupport], activities=[charge, flaky, hold])
    # The encrypted side: the same converter with the lab's codec, its own task queue.
    import base64

    codec = lab_codec()
    encrypted_client = await Client.connect("temporal:7233", namespace="lab", data_converter=dataclasses.replace(converter, payload_codec=LabEncryption(base64.b64decode(codec["key"]))))
    encrypted_worker = Worker(encrypted_client, task_queue=codec["taskQueue"], workflows=[Encrypted])
    # Long histories on their own task queue, so building them does not hold up the samples.
    long_worker = Worker(client, task_queue=LONG_QUEUE, workflows=[LongHistory], activities=[echo_line])
    async with worker, encrypted_worker, long_worker:
        try:
            await encrypted_client.start_workflow(Encrypted.run, {"card": "4111111111111111", "amount": 42, "name": "Ana"}, id="encrypted-1", task_queue=codec["taskQueue"])
        except Exception as e:  # noqa: BLE001 - already started on an earlier start
            if "already" not in str(e).lower():
                raise
        await start_samples(client)
        # Large payloads: started without External Storage, so the input stays in the history.
        plain = await Client.connect("temporal:7233", namespace="lab")
        try:
            await plain.start_workflow(LargeInput.run, large_snapshot(), id="large-1", task_queue=TASK_QUEUE)
        except Exception as e:  # noqa: BLE001 - already started on an earlier start
            if "already" not in str(e).lower():
                raise
        try:
            await client.start_activity(charge, "ord-sa-1", id="sa-charge-1", task_queue=TASK_QUEUE, start_to_close_timeout=timedelta(seconds=30), id_reuse_policy=ActivityIDReusePolicy.REJECT_DUPLICATE)
        except Exception as e:  # noqa: BLE001 - already run on an earlier start
            if "already" not in str(e).lower():
                raise
        log("temporal-worker: samples started in namespace lab, schedule every-minute")
        await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
