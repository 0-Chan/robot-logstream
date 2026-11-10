#!/usr/bin/env bash
# Set up (or re-sync) the Lightsail instance: prepared data, compose.yaml, Caddyfile, .env and the
# update timer. Code changes do not need this: CI pushes images to GHCR on every main commit and the
# timer (deploy/updater) pulls them within a minute. Run it again only when data or these files change.
#
#   deploy/deploy.sh <static-ip>                 # everything
#   SKIP_DATA=1 deploy/deploy.sh <static-ip>     # config and timer only (data already uploaded)
#   SSH_KEY=~/.ssh/robot-logstream deploy/deploy.sh <static-ip>   # use a specific key
#
# First deploy asks for the site address and alert channels; with no terminal input (e.g. < /dev/null)
# it uses the defaults: <ip>.sslip.io and no channels (add them later in the server's .env).
#
# The instance comes from infra/lightsail (Terraform). Images: ghcr.io/0-chan/robot-logstream-{server,web}
# (public packages, so the server pulls them without logging in).
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

if [[ -z "${SKIP_DATA:-}" ]]; then
  echo "== upload data/prepared/$SEQUENCE (about 11 GB the first time; later runs send only changes)"
  rsync -az --delete -e "ssh ${SSH_OPTS[*]}" "$ROOT/data/prepared/$SEQUENCE/" "$REMOTE:$APP_DIR/data/prepared/$SEQUENCE/"
fi

echo "== copy compose.yaml, Caddyfile and the update script"
scp "${SSH_OPTS[@]}" "$ROOT/deploy/compose.yaml" "$ROOT/deploy/Caddyfile" \
  "$ROOT/deploy/updater/robot-logstream-update.sh" "$REMOTE:$APP_DIR/"

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
IMAGE_TAG=
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

echo "== install the update timer (pulls new images every minute)"
scp "${SSH_OPTS[@]}" "$ROOT/deploy/updater/robot-logstream-update.service" \
  "$ROOT/deploy/updater/robot-logstream-update.timer" "$REMOTE:/tmp/"
ssh_ -n "$REMOTE" "sudo install -m 644 /tmp/robot-logstream-update.service /tmp/robot-logstream-update.timer /etc/systemd/system/ \
  && sudo systemctl daemon-reload && sudo systemctl enable --now robot-logstream-update.timer"

echo "== start"
ssh_ -n "$REMOTE" "mkdir -p $APP_DIR/state && cd $APP_DIR && chmod +x robot-logstream-update.sh \
  && docker compose pull --quiet && docker compose up -d --remove-orphans && docker compose ps"
site=$(ssh_ -n "$REMOTE" "grep ^SITE_ADDRESS= $APP_DIR/.env | cut -d= -f2")
echo "done: https://$site"
