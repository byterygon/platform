"""Shared helpers of the lab tools."""

import json
import os
import sys
import time

GENERATED = os.environ.get("LAB_GENERATED", "/generated")


def credentials():
    with open(os.path.join(GENERATED, "credentials.json")) as f:
        return json.load(f)


def log(message):
    print(message, flush=True)


def wait_for(check, what, timeout=60):
    """Calls `check` until it returns true (exceptions count as false) or `timeout` seconds pass."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            if check():
                return
        except Exception as e:  # noqa: BLE001 - the service is starting
            last = e
        time.sleep(1)
    sys.exit(f"timed out waiting for {what}: {last}")
