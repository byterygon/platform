"""A small S3 client on the standard library (TSK-103): enough for the Temporal SDK's S3 storage
driver against the lab's SeaweedFS (path-style, SigV4, plain HTTP inside the compose network).
No aioboto3: the driver takes any `S3StorageDriverClient`."""

import asyncio
import datetime
import hashlib
import hmac
import json
import os
import urllib.error
import urllib.parse
import urllib.request

from temporalio.contrib.aws.s3driver import S3StorageDriverClient

EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()


def lab_s3():
    """The lab's S3 settings from credentials.json (`temporal.externalStorage`)."""
    with open(os.path.join("/generated", "credentials.json")) as f:
        return json.load(f)["temporal"]["externalStorage"]


def _sign(key, msg):
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


class LabS3(S3StorageDriverClient):
    def __init__(self, endpoint, access_key, secret_key, region="us-east-1"):
        self.endpoint = endpoint.rstrip("/")
        self.host = urllib.parse.urlsplit(self.endpoint).netloc
        self.access_key = access_key
        self.secret_key = secret_key
        self.region = region

    def describe(self):
        return {"endpoint": self.endpoint}

    def _request(self, method, path, body=b""):
        now = datetime.datetime.now(datetime.timezone.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        date = now.strftime("%Y%m%d")
        payload_hash = hashlib.sha256(body).hexdigest() if body else EMPTY_SHA256
        quoted = urllib.parse.quote(path, safe="/-_.~")
        headers = {"host": self.host, "x-amz-content-sha256": payload_hash, "x-amz-date": amz_date}
        signed = ";".join(sorted(headers))
        canonical = "\n".join([method, quoted, "", "".join(f"{k}:{headers[k]}\n" for k in sorted(headers)), signed, payload_hash])
        scope = f"{date}/{self.region}/s3/aws4_request"
        to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
        k = _sign(("AWS4" + self.secret_key).encode(), date)
        for part in (self.region, "s3", "aws4_request"):
            k = _sign(k, part)
        signature = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
        headers["authorization"] = f"AWS4-HMAC-SHA256 Credential={self.access_key}/{scope}, SignedHeaders={signed}, Signature={signature}"
        request = urllib.request.Request(self.endpoint + quoted, data=body if method == "PUT" else None, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def create_bucket(self, bucket):
        status, body = self._request("PUT", f"/{bucket}")
        if status not in (200, 409) and b"BucketAlreadyOwnedByYou" not in body:
            raise RuntimeError(f"create bucket {bucket}: {status} {body[:200]!r}")

    async def put_object(self, *, bucket, key, data):
        status, body = await asyncio.to_thread(self._request, "PUT", f"/{bucket}/{key}", data)
        if status != 200:
            raise RuntimeError(f"put s3://{bucket}/{key}: {status} {body[:200]!r}")

    async def object_exists(self, *, bucket, key):
        status, body = await asyncio.to_thread(self._request, "HEAD", f"/{bucket}/{key}")
        if status == 404:
            return False
        if status != 200:
            raise RuntimeError(f"head s3://{bucket}/{key}: {status}")
        return True

    async def get_object(self, *, bucket, key):
        status, body = await asyncio.to_thread(self._request, "GET", f"/{bucket}/{key}")
        if status != 200:
            raise RuntimeError(f"get s3://{bucket}/{key}: {status} {body[:200]!r}")
        return body
