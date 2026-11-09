#!/usr/bin/env bash
# Build the images locally, copy them and the prepared data to the Lightsail instance, start them.
#
#   deploy/deploy.sh <static-ip>                 # everything
#   SKIP_DATA=1 deploy/deploy.sh <static-ip>     # code only (data already uploaded)
#
# The instance comes from infra/lightsail (Terraform). No registry is needed: images travel over ssh.
set -euo pipefail

HOST=${1:?usage: deploy/deploy.sh <static-ip>}
SEQUENCE=${SEQUENCE:-2024-11-02-17-10-25}
REMOTE=ubuntu@$HOST
APP_DIR=/srv/robot-logstream
ROOT=$(cd "$(dirname "$0")/.." && pwd)

echo "== build images (linux/amd64: Lightsail instances are x86_64)"
for target in server web; do
  docker buildx build --platform linux/amd64 --target "$target" -t "robot-logstream-${target}:latest" --load "$ROOT/dashboard"
done

echo "== copy images"
docker save robot-logstream-server:latest robot-logstream-web:latest | gzip | ssh "$REMOTE" 'gunzip | docker load'

if [[ -z "${SKIP_DATA:-}" ]]; then
  echo "== upload data/prepared/$SEQUENCE (about 11 GB the first time; later runs send only changes)"
  rsync -az --delete "$ROOT/data/prepared/$SEQUENCE/" "$REMOTE:$APP_DIR/data/prepared/$SEQUENCE/"
fi

echo "== copy compose.yaml and Caddyfile"
scp "$ROOT/deploy/compose.yaml" "$ROOT/deploy/Caddyfile" "$REMOTE:$APP_DIR/"

if ! ssh "$REMOTE" "test -f $APP_DIR/.env"; then
  echo "== first deploy: create $APP_DIR/.env on the server"
  site_default="${HOST//./-}.sslip.io"
  read -rp "site address [$site_default]: " site
  ssh "$REMOTE" "umask 077 && cat > $APP_DIR/.env" <<EOF
SITE_ADDRESS=${site:-$site_default}
SEQUENCE=$SEQUENCE
DATA_DIR=./data
EOF
fi

echo "== start"
ssh "$REMOTE" "cd $APP_DIR && docker compose up -d && docker compose ps"
site=$(ssh "$REMOTE" "grep ^SITE_ADDRESS= $APP_DIR/.env | cut -d= -f2")
echo "done: https://$site"
