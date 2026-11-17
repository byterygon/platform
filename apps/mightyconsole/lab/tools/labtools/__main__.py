"""python -m labtools <generate|seed|check|nats-echo|kafka-member|temporal-worker> [args]"""

import asyncio
import sys

from . import check, generate, seed


def main():
    command, args = (sys.argv[1], sys.argv[2:]) if len(sys.argv) > 1 else ("", [])
    if command == "generate":
        return generate.main(args)
    if command == "seed":
        return seed.main(args)
    if command == "check":
        return check.main(args)
    if command == "nats-echo":
        from . import nats_echo

        return asyncio.run(nats_echo.main())
    if command == "kafka-member":
        from . import kafka_member

        return kafka_member.main()
    if command == "temporal-worker":
        from . import temporal_worker

        return asyncio.run(temporal_worker.main())
    print(__doc__, file=sys.stderr)
    return 2


sys.exit(main())
