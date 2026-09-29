#!/bin/sh
# Update the system to the latest version from GitHub (run in the project folder on the server).
set -eu
echo "== backup before update =="; docker compose exec -T backup backup.sh
echo "== pulling latest code =="; git pull --ff-only
echo "== rebuilding and restarting =="; docker compose up -d --build
docker compose ps
echo "== done. health: =="; sleep 5; docker compose exec -T app wget -qO- http://127.0.0.1:3000/healthz; echo
