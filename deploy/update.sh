#!/usr/bin/env bash
# Pull the latest code and restart (data is kept in the appdata volume).
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
sudo docker compose up -d --build
sudo docker image prune -f
# The app needs a few seconds to start; until then the proxy answers 502.
for i in $(seq 1 30); do
  if curl -fsS http://localhost/health; then echo; echo "==> Updated and running."; exit 0; fi
  sleep 2
done
echo "==> The app did not answer within a minute. Check: sudo docker compose logs --tail=50 app"
exit 1
