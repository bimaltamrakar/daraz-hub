#!/usr/bin/env bash
# Deploy Daraz Store Hub on the server: pull, install, migrate, build, restart, health-check.
# Usage: APP_DIR=/var/www/daraz-hub PM2_APP=daraz-hub bash scripts/deploy.sh
# Docker: DEPLOY_MODE=docker bash scripts/deploy.sh
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BRANCH="${BRANCH:-main}"
PM2_APP="${PM2_APP:-daraz-hub}"
SERVICE="${SERVICE:-}"
PORT="${PORT:-4000}"
RELOAD_NGINX="${RELOAD_NGINX:-0}"
DEPLOY_MODE="${DEPLOY_MODE:-}"

cd "$APP_DIR"

if [ "${1:-}" != "--skip-git" ]; then
  echo "==> Fetching origin/$BRANCH"
  git fetch origin "$BRANCH"
  git reset --hard "origin/$BRANCH"
fi

if [ -z "$DEPLOY_MODE" ]; then
  if command -v docker >/dev/null 2>&1 && [ -f docker-compose.yml ] && [ -n "$(docker compose ps -q app 2>/dev/null || true)" ]; then
    DEPLOY_MODE="docker"
  else
    DEPLOY_MODE="pm2"
  fi
fi

if [ "$DEPLOY_MODE" = "docker" ]; then
  echo "==> Rebuilding Docker Compose service"
  docker compose up -d --build
else
  echo "==> Installing dependencies"
  # Build needs TypeScript/Vite, so include dev dependencies even when NODE_ENV=production.
  npm ci --include=dev

  echo "==> Generating Prisma client"
  npx prisma generate

  echo "==> Applying database migrations"
  npx prisma migrate deploy

  echo "==> Building API and web assets"
  npm run build

  echo "==> Restarting application"
  if command -v pm2 >/dev/null 2>&1 && pm2 describe "$PM2_APP" >/dev/null 2>&1; then
    pm2 reload "$PM2_APP" --update-env
  elif [ -n "$SERVICE" ]; then
    sudo systemctl restart "$SERVICE"
  else
    echo "No PM2 app '$PM2_APP' found and SERVICE is not set." >&2
    exit 1
  fi
fi

if [ "$RELOAD_NGINX" = "1" ]; then
  echo "==> Reloading nginx"
  sudo nginx -t
  sudo systemctl reload nginx
fi

echo "==> Health check"
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/openapi.json" >/dev/null 2>&1; then
    echo "Deployment complete: app is healthy on port ${PORT}."
    exit 0
  fi
  sleep 1
done

echo "Health check failed: app did not respond on port ${PORT}." >&2
exit 1
