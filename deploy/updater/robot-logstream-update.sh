#!/bin/sh
# Run by robot-logstream-update.timer every minute: pull the images compose.yaml names
# (latest, or IMAGE_TAG from .env) and recreate only the containers whose image changed.
# A failed pull leaves the running containers as they are.
set -eu
cd /srv/robot-logstream
before=$(docker compose images -q | sort | tr '\n' ' ')
docker compose pull --quiet
docker compose up -d --remove-orphans --quiet-pull
after=$(docker compose images -q | sort | tr '\n' ' ')
if [ "$before" != "$after" ]; then
  echo "updated to:"
  docker compose images
  docker image prune -f >/dev/null
fi
