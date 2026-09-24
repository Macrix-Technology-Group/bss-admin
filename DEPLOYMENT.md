# Deploying the inquiry desk

The pipeline builds the app into a container image, stores that image in GitHub, and tells the
server to pull it and restart. The server never builds anything — it only runs the image. Every
build is tagged with its commit, so going back to an earlier version is just running an earlier tag.

Push to `main` → it deploys. There is also a **Run workflow** button on the Actions tab for a
manual redeploy or a rollback.

---

## What runs where

- **GitHub Actions** builds the image and pushes it to **GitHub Container Registry** (ghcr.io),
  tagged with the commit and with `latest`.
- **The server** pulls that image and restarts the container. It needs Docker and nothing else.
- **The database** is Neon (managed Postgres, the same one the website uses). Nothing about the
  database is deployed here; the container just connects to it over the internet.
- On start the container applies the schema (`scripts/init-db.mjs`) and then serves the app. If it
  cannot reach the database it stops rather than pretend to be healthy.

The app listens on `127.0.0.1:3100` on the server — reachable only from the server itself. A
reverse proxy in front of it decides who can actually open it. The screen has no login of its own,
so this binding is the boundary; do not change it to a public port without adding a login first.

---

## One-time setup

### 1. On the server

```bash
# Docker with the compose plugin must be installed. Then:
mkdir -p /home/sherin/bss-admin        # this is SERVER_PATH below
cd /home/sherin/bss-admin

# Create the secrets file. These are the real values (never committed anywhere).
cat > .env << 'EOF'
DATABASE_URL="postgres://…"            # same value as the website's DATABASE_URL
MS_TENANT_ID=…
MS_CLIENT_ID=…
MS_CLIENT_SECRET=…
MAIL_MAILBOX=contact@bss-logisq.com
MAIL_REPLY_ADDRESS=contact@bss-logisq.com
POLL_TOKEN=…
EOF
```

Do **not** put `DEMO_DATA=1` in that file — that is the offline demo screen, not production.

### 2. In GitHub (repo → Settings → Secrets and variables → Actions)

| Secret | What it is |
| --- | --- |
| `SSH_HOST` | the server's address |
| `SSH_USER` | the SSH user (e.g. `sherin`) |
| `SSH_KEY` | that user's **private** SSH key (add the matching public key to the server's `authorized_keys`) |
| `SSH_PORT` | the SSH port (usually `22`) |
| `SERVER_PATH` | the deploy directory, e.g. `/home/sherin/bss-admin` |
| `GHCR_PAT` | **only if the image package is private** — a token with `read:packages`, so the server can pull. If you make the package public, leave this unset. |

Key-based SSH is used, not a password.

### 3. Reverse proxy

Point your proxy (nginx, Caddy, …) at `http://127.0.0.1:3100` and let it handle who reaches the
desk. That is where any access control lives.

---

## Deploying

- **Automatic:** push to `main`. The Actions run builds, pushes, and restarts the server.
- **Manual / redeploy:** Actions tab → **Build and deploy** → **Run workflow**.

## Rolling back

Every commit has its own image tag. To go back to a known-good build, on the server:

```bash
cd /home/sherin/bss-admin
IMAGE=ghcr.io/macrix-technology-group/bss-admin:<old-commit-sha> bash scripts/server-deploy.sh
```

(Find the sha in the Actions history or the repo's commit list.)

---

## Everyday commands (on the server)

```bash
cd /home/sherin/bss-admin

docker compose -f docker-compose.prod.yml logs -f     # live logs
docker compose -f docker-compose.prod.yml ps          # is it up / healthy
docker compose -f docker-compose.prod.yml restart     # restart without changing the image
docker compose -f docker-compose.prod.yml down        # stop it
```

## Running it locally instead

`docker-compose.yml` (not `.prod.yml`) builds and runs the app on your own machine with a local
`.env`: `docker compose up --build`.
