#!/usr/bin/env bash
# Runs ON THE SERVER, from the deploy directory. Pulls the image the pipeline just built and
# restarts the container. Idempotent — safe to run again, and safe to run by hand for a rollback.
#
# Inputs (environment):
#   IMAGE        the exact image to run, e.g. ghcr.io/macrix-technology-group/bss-admin:<sha>.
#                Defaults to the :latest tag if unset.
#   GHCR_USER    optional — a GitHub username, only needed if the package is private.
#   GHCR_TOKEN   optional — a token with read:packages, paired with GHCR_USER for a private pull.
#
# Expects docker-compose.prod.yml and a filled .env in the current directory.
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
export IMAGE="${IMAGE:-ghcr.io/macrix-technology-group/bss-admin:latest}"

if [ ! -f "$COMPOSE_FILE" ]; then
    echo "Error: $COMPOSE_FILE not found in $(pwd). Run this from the deploy directory." >&2
    exit 1
fi
if [ ! -f .env ]; then
    echo "Error: .env not found in $(pwd). Create it once before the first deploy (see DEPLOYMENT.md)." >&2
    exit 1
fi

# Log in only when credentials are provided — a public package needs none.
if [ -n "${GHCR_USER:-}" ] && [ -n "${GHCR_TOKEN:-}" ]; then
    echo "Logging in to ghcr.io as $GHCR_USER ..."
    echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
fi

echo "Deploying $IMAGE ..."
docker compose -f "$COMPOSE_FILE" pull
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

# Drop the now-unreferenced old image so the disk does not fill up over many deploys.
docker image prune -f >/dev/null 2>&1 || true

echo "Done. Current state:"
docker compose -f "$COMPOSE_FILE" ps
