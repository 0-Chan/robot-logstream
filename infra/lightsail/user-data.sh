#!/bin/bash
# Runs once at first boot (Lightsail launch script, as root).
set -euxo pipefail

apt-get update
apt-get install -y docker.io docker-compose-v2 rsync
usermod -aG docker ubuntu

# 2 GB of RAM is enough for the server, but image loads and Caddy start better with swap behind it.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

mkdir -p /srv/robot-logstream/data/prepared
chown -R ubuntu:ubuntu /srv/robot-logstream
