"""Holds the consumer group `orders-live` (Stable, with lag): it reads 100 messages, commits, then
keeps its membership without reading more, so reset offsets must refuse it (TSK-86)."""

import time

from confluent_kafka import Consumer

from .common import log, wait_for


def main():
    consumer = Consumer({"bootstrap.servers": "kafka:19092", "group.id": "orders-live", "auto.offset.reset": "earliest", "enable.auto.commit": False, "session.timeout.ms": 30000})
    wait_for(lambda: "orders" in consumer.list_topics(timeout=5).topics, "the topic orders (run the kafka seed)", 600)
    consumer.subscribe(["orders"])
    read = 0
    while read < 100:
        msg = consumer.poll(1.0)
        if msg is not None and msg.error() is None:
            read += 1
    consumer.commit(asynchronous=False)
    consumer.pause(consumer.assignment())
    log("kafka-member: orders-live holds its partitions with lag")
    while True:
        consumer.poll(1.0)
        consumer.pause(consumer.assignment())
        time.sleep(0.5)


if __name__ == "__main__":
    main()
