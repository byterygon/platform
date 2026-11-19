"""The lab's payload codec (TSK-92, Mightyconsole spec §9.5): AES-256-GCM encryption as a Temporal
`PayloadCodec`, and a codec server speaking Temporal's codec-server protocol (`POST /decode`,
`POST /encode`, `{"payloads": [...]}` in protobuf JSON) for Mightyconsole, the Web UI and the CLI.

The key and the server's bearer token come from credentials.json (`temporal.codec`). Payloads it
encrypts carry `encoding = binary/encrypted` and `encryption-key-id = lab`; others pass unchanged.
Lab only: a real codec would keep its key in a key manager."""

import base64
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from google.protobuf import json_format
from temporalio.api.common.v1 import Payload, Payloads
from temporalio.converter import PayloadCodec

from .common import log

ENCODING = b"binary/encrypted"
KEY_ID = b"lab"


def lab_codec():
    """The lab's codec settings from credentials.json (`temporal.codec`)."""
    with open(os.path.join("/generated", "credentials.json")) as f:
        return json.load(f)["temporal"]["codec"]


class LabEncryption(PayloadCodec):
    def __init__(self, key: bytes):
        self.aead = AESGCM(key)

    def encrypt_one(self, p: Payload) -> Payload:
        nonce = os.urandom(12)
        return Payload(metadata={"encoding": ENCODING, "encryption-key-id": KEY_ID}, data=nonce + self.aead.encrypt(nonce, p.SerializeToString(), None))

    def decrypt_one(self, p: Payload) -> Payload:
        if p.metadata.get("encoding") != ENCODING:
            return p
        if p.metadata.get("encryption-key-id") != KEY_ID:
            raise ValueError("unknown encryption key")
        out = Payload()
        out.ParseFromString(self.aead.decrypt(p.data[:12], p.data[12:], None))
        return out

    async def encode(self, payloads):
        return [self.encrypt_one(p) for p in payloads]

    async def decode(self, payloads):
        return [self.decrypt_one(p) for p in payloads]


def serve():
    settings = lab_codec()
    codec = LabEncryption(base64.b64decode(settings["key"]))
    expected = settings["authorization"]

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # quiet: one line per call below
            pass

        def answer(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            operation = self.path.rstrip("/").rsplit("/", 1)[-1]
            if operation not in ("decode", "encode"):
                return self.answer(404, {"message": "use /decode or /encode"})
            if self.headers.get("authorization") != expected:
                return self.answer(401, {"message": "unauthorized"})
            length = int(self.headers.get("content-length") or 0)
            try:
                payloads = json_format.Parse(self.rfile.read(length), Payloads())
                items = list(payloads.payloads)
                out = [codec.decrypt_one(p) for p in items] if operation == "decode" else [codec.encrypt_one(p) for p in items]
            except Exception as e:  # noqa: BLE001 - the caller sees the reason
                log(f"temporal-codec: {operation} failed: {e}")
                return self.answer(400, {"message": str(e)})
            log(f"temporal-codec: {operation} {len(items)} payload(s) namespace={self.headers.get('x-namespace', '-')}")
            return self.answer(200, json_format.MessageToDict(Payloads(payloads=out)))

    server = ThreadingHTTPServer(("0.0.0.0", 8234), Handler)
    log("temporal-codec: listening on :8234")
    server.serve_forever()
