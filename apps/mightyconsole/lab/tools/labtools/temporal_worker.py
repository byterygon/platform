"""The lab's Temporal worker (task queue `lab`, namespace `lab`) and its sample workflows (TSK-83):
a long-running one with a signal and a query, a completed one, a failed one, one with an activity
that keeps retrying, a parent with a child, one with a Protobuf payload, a family for Relations
(TSK-104: family-root starts family-order, which starts three children, one failing, and is
signalled by family-support), and a schedule that runs every minute. Started once when the worker starts; ids are fixed, so a restart starts nothing
twice. External Storage (TSK-103): payloads of 256 KiB or more go to the lab's S3 store through the
SDK's S3 driver; `big-payload-1` has a 300 KiB input and result. A payload codec (TSK-92): a second
worker on task queue `lab-encrypted` encrypts its payloads with the lab's AES-GCM codec;
`encrypted-1` is stored encrypted."""

import asyncio
import dataclasses
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.client import Client, Schedule, ScheduleActionStartWorkflow, ScheduleIntervalSpec, ScheduleSpec
from temporalio.common import RetryPolicy
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


@activity.defn
async def charge(order_id: str) -> str:
    return f"charged {order_id}"


@activity.defn
async def flaky(order_id: str) -> str:
    raise ApplicationError(f"the payment provider is down for {order_id}")


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
    for run, arg, workflow_id in samples:
        try:
            await client.start_workflow(run, arg, id=workflow_id, task_queue=TASK_QUEUE)
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
    worker = Worker(client, task_queue=TASK_QUEUE, workflows=[Fulfilment, Completed, Failed, Retrying, Parent, ProtoOrder, BigPayload, FamilyRoot, FamilyOrder, FamilySupport], activities=[charge, flaky])
    # The encrypted side: the same converter with the lab's codec, its own task queue.
    import base64

    codec = lab_codec()
    encrypted_client = await Client.connect("temporal:7233", namespace="lab", data_converter=dataclasses.replace(converter, payload_codec=LabEncryption(base64.b64decode(codec["key"]))))
    encrypted_worker = Worker(encrypted_client, task_queue=codec["taskQueue"], workflows=[Encrypted])
    async with worker, encrypted_worker:
        try:
            await encrypted_client.start_workflow(Encrypted.run, {"card": "4111111111111111", "amount": 42, "name": "Ana"}, id="encrypted-1", task_queue=codec["taskQueue"])
        except Exception as e:  # noqa: BLE001 - already started on an earlier start
            if "already" not in str(e).lower():
                raise
        await start_samples(client)
        log("temporal-worker: samples started in namespace lab, schedule every-minute")
        await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
