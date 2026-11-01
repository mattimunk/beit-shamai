#!/usr/bin/env bash
# Pull the latest code and restart (data is kept in the appdata volume).
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
sudo docker compose up -d --build
sudo docker image prune -f
curl -fsS http://localhost/health && echo
