"""The lab's NATS service `echo` (NATS micro): discovered with $SRV.PING, INFO and STATS (TSK-85)."""

import asyncio

import nats
from nats.micro import ServiceConfig, add_service
from nats.micro.service import EndpointConfig

from .common import credentials, log


async def main():
    creds = credentials()["nats"]
    nc = await nats.connect("nats://nats:4222", user=creds["user"], password=creds["password"], max_reconnect_attempts=-1)
    service = await add_service(nc, ServiceConfig(name="echo", version="1.0.0", description="Echoes the request (Mightyconsole lab)"))

    async def echo(request):
        await request.respond(request.data, headers={"Lab-Service": "echo"})

    async def upper(request):
        await request.respond(request.data.upper())

    await service.add_endpoint(EndpointConfig(name="echo", subject="lab.echo", handler=echo))
    await service.add_endpoint(EndpointConfig(name="upper", subject="lab.echo.upper", handler=upper))
    log("nats-echo: service echo on lab.echo and lab.echo.upper")
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
