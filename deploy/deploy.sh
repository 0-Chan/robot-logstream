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
  echo "Transfer alert channels (Enter to skip each; see deploy/.env.example):"
  read -rsp "  Slack webhook URL: " slack; echo
  read -rsp "  Discord webhook URL: " discord; echo
  read -rsp "  ntfy topic URL (e.g. https://ntfy.sh/<hard-to-guess>): " ntfy; echo
  read -rsp "  SMTP URL for e-mail (e.g. smtps://you%40gmail.com:app-password@smtp.gmail.com:465): " smtp; echo
  email_to=""
  [[ -n "$smtp" ]] && read -rp "  alert e-mail recipients (comma separated): " email_to
  ssh "$REMOTE" "umask 077 && mkdir -p $APP_DIR/state && cat > $APP_DIR/.env" <<EOF
SITE_ADDRESS=${site:-$site_default}
SEQUENCE=$SEQUENCE
DATA_DIR=./data
TRANSFER_ALLOWANCE_GB=3000
SPIKE_GB_PER_HOUR=50
OVERAGE_USD_PER_GB=0.13
NOTIFY_TEST=1
SLACK_WEBHOOK_URL=$slack
DISCORD_WEBHOOK_URL=$discord
NTFY_TOPIC_URL=$ntfy
ALERT_WEBHOOK_URL=
SMTP_URL=$smtp
ALERT_EMAIL_TO=$email_to
ALERT_EMAIL_FROM=
EOF
  echo "   NOTIFY_TEST=1: the first start sends a test alert to every channel. Set it empty in $APP_DIR/.env afterwards."
fi

echo "== start"
ssh "$REMOTE" "mkdir -p $APP_DIR/state && cd $APP_DIR && docker compose up -d && docker compose ps"
site=$(ssh "$REMOTE" "grep ^SITE_ADDRESS= $APP_DIR/.env | cut -d= -f2")
echo "done: https://$site"
