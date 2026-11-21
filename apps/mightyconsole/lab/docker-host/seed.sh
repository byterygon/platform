#!/bin/sh
# Seeds the Docker host (TSK-81): the Compose project shop, a stopped container, a TTY container,
# named volumes and user networks (lab-scratch and lab-scratch-net unused). Idempotent.
set -e
BUSYBOX=busybox:1.37@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec
docker compose -f /lab/shop.yaml up -d
docker network inspect lab-net >/dev/null 2>&1 || docker network create lab-net >/dev/null
docker volume inspect lab-cache >/dev/null 2>&1 || docker volume create lab-cache >/dev/null
# Unused, for the acceptance walk to remove; each seed brings them back.
docker volume inspect lab-scratch >/dev/null 2>&1 || docker volume create lab-scratch >/dev/null
docker network inspect lab-scratch-net >/dev/null 2>&1 || docker network create lab-scratch-net >/dev/null
if ! docker inspect stopped >/dev/null 2>&1; then
  docker run --name stopped --network lab-net -v lab-cache:/cache $BUSYBOX sh -c 'echo "ran once"; exit 3' || true
fi
if ! docker inspect tty >/dev/null 2>&1; then
  docker run -d -t --name tty --network lab-net $BUSYBOX sh -c 'while true; do printf "\033[32mgreen\033[0m tty line\n"; sleep 3; done' >/dev/null
else
  # Kept from an earlier run of the lab (its volume): running again, as the checks expect.
  docker start tty >/dev/null
fi
echo "docker-host: project shop, containers stopped and tty, volumes lab-cache and lab-scratch, networks lab-net and lab-scratch-net"
