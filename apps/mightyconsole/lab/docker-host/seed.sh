#!/bin/sh
# Seeds the Docker host (TSK-81): the Compose project shop, a stopped container, a TTY container,
# named volumes and a user network. Idempotent.
set -e
BUSYBOX=busybox:1.37@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec
docker compose -f /lab/shop.yaml up -d
docker network inspect lab-net >/dev/null 2>&1 || docker network create lab-net >/dev/null
docker volume inspect lab-cache >/dev/null 2>&1 || docker volume create lab-cache >/dev/null
if ! docker inspect stopped >/dev/null 2>&1; then
  docker run --name stopped --network lab-net -v lab-cache:/cache $BUSYBOX sh -c 'echo "ran once"; exit 3' || true
fi
if ! docker inspect tty >/dev/null 2>&1; then
  docker run -d -t --name tty --network lab-net $BUSYBOX sh -c 'while true; do printf "\033[32mgreen\033[0m tty line\n"; sleep 3; done' >/dev/null
fi
echo "docker-host: project shop, containers stopped and tty, volume lab-cache, network lab-net"
