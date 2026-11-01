#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu 22.04/24.04 VM in an Israeli region.
#   curl -fsSL https://raw.githubusercontent.com/mattimunk/beit-shamai/main/deploy/setup-vm.sh | bash
set -euo pipefail

echo "==> Installing Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

echo "==> Getting the code"
if [ ! -d beit-shamai ]; then
  git clone https://github.com/mattimunk/beit-shamai.git
fi
cd beit-shamai
git pull --ff-only

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=$(openssl rand -hex 32)/" .env
  echo "==> Created .env with a random ADMIN_TOKEN (see: cat .env)"
fi
if [ ! -f config/sources.json ]; then
  cp config/sources.example.json config/sources.json
  echo "==> Created config/sources.json from the example (edit cities as needed)"
fi

echo "==> Building and starting"
sudo docker compose up -d --build
sleep 8
curl -fsS http://localhost/health && echo
echo "==> Done. Next: run the source check:"
echo "    sudo docker compose exec app bun run server/probe.ts"
