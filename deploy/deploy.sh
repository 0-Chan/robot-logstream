#!/usr/bin/env bash
# Build the images locally, copy them and the prepared data to the Lightsail instance, start them.
#
#   deploy/deploy.sh <static-ip>                 # everything
#   SKIP_DATA=1 deploy/deploy.sh <static-ip>     # code only (data already uploaded)
#   SSH_KEY=~/.ssh/robot-logstream deploy/deploy.sh <static-ip>   # use a specific key
#
# First deploy asks for the site address and alert channels; with no terminal input (e.g. < /dev/null)
# it uses the defaults: <ip>.sslip.io and no channels (add them later in the server's .env).
#
# The instance comes from infra/lightsail (Terraform). No registry is needed: images travel over ssh.
set -euo pipefail

HOST=${1:?usage: deploy/deploy.sh <static-ip>}
SEQUENCE=${SEQUENCE:-2024-11-02-17-10-25}
REMOTE=ubuntu@$HOST
APP_DIR=/srv/robot-logstream
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
[[ -n "${SSH_KEY:-}" ]] && SSH_OPTS+=(-i "$SSH_KEY" -o IdentitiesOnly=yes)
ssh_() { ssh "${SSH_OPTS[@]}" "$@"; }
ask() { read -r "$@" || true; } # EOF (no terminal input) = take the default

echo "== build images (linux/amd64: Lightsail instances are x86_64)"
for target in server web; do
  docker buildx build --platform linux/amd64 --target "$target" -t "robot-logstream-${target}:latest" --load "$ROOT/dashboard"
done

echo "== copy images"
docker save robot-logstream-server:latest robot-logstream-web:latest | gzip | ssh_ "$REMOTE" 'gunzip | docker load'

if [[ -z "${SKIP_DATA:-}" ]]; then
  echo "== upload data/prepared/$SEQUENCE (about 11 GB the first time; later runs send only changes)"
  rsync -az --delete -e "ssh ${SSH_OPTS[*]}" "$ROOT/data/prepared/$SEQUENCE/" "$REMOTE:$APP_DIR/data/prepared/$SEQUENCE/"
fi

echo "== copy compose.yaml and Caddyfile"
scp "${SSH_OPTS[@]}" "$ROOT/deploy/compose.yaml" "$ROOT/deploy/Caddyfile" "$REMOTE:$APP_DIR/"

if ! ssh_ -n "$REMOTE" "test -f $APP_DIR/.env"; then
  echo "== first deploy: create $APP_DIR/.env on the server"
  site_default="${HOST//./-}.sslip.io"
  site="" slack="" discord="" ntfy="" smtp="" email_to=""
  ask -p "site address [$site_default]: " site
  echo "Transfer alert channels (Enter to skip each; see deploy/.env.example):"
  ask -sp "  Slack webhook URL: " slack; echo
  ask -sp "  Discord webhook URL: " discord; echo
  ask -sp "  ntfy topic URL (e.g. https://ntfy.sh/<hard-to-guess>): " ntfy; echo
  ask -sp "  SMTP URL for e-mail (e.g. smtps://you%40gmail.com:app-password@smtp.gmail.com:465): " smtp; echo
  [[ -n "$smtp" ]] && ask -p "  alert e-mail recipients (comma separated): " email_to
  ssh_ "$REMOTE" "umask 077 && mkdir -p $APP_DIR/state && cat > $APP_DIR/.env" <<EOF
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
ssh_ -n "$REMOTE" "mkdir -p $APP_DIR/state && cd $APP_DIR && docker compose up -d && docker compose ps"
site=$(ssh_ -n "$REMOTE" "grep ^SITE_ADDRESS= $APP_DIR/.env | cut -d= -f2")
echo "done: https://$site"
