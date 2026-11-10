#!/bin/sh
# Run by robot-logstream-update.timer every minute: pull the images compose.yaml names
# (latest, or IMAGE_TAG from .env) and recreate only the containers whose image changed.
# A failed pull leaves the running containers as they are. Logs only updates and errors.
set -eu
cd /srv/robot-logstream
run() {
  out=$("$@" 2>&1) || { echo "$out"; exit 1; }
}
before=$(docker compose images -q | sort | tr '\n' ' ')
run docker compose pull --quiet
run docker compose up -d --remove-orphans --quiet-pull
after=$(docker compose images -q | sort | tr '\n' ' ')
if [ "$before" != "$after" ]; then
  echo "updated to:"
  docker compose images
  docker image prune -f >/dev/null
fi
