# Production deployment (hardened compose)

`docker-compose.production.example.yml` is a hardened starting point. For the basic install, backups and
the Omie notes see [deployment.md](deployment.md). Copy the example, never edit it in place, and
keep every real value in `.env.production` (git-ignored, never committed).

## What the example enforces

- API: read-only root filesystem, `tmpfs` for `/tmp`, `cap_drop: ALL`, `no-new-privileges`, non-root
  user (set in the `Dockerfile`), CPU/memory limits, `pids_limit`, log rotation.
- Database: no published port, on an `internal: true` network reachable only by the API.
- API port bound to `127.0.0.1` only; a reverse proxy terminates TLS in front of it.
- Healthchecks: the API checks `/health/ready` (database and scratch manager), the database uses
  `pg_isready`. The API waits for a healthy database.
- Pinned image tags: `postgres:17.11-alpine` (bump deliberately) and a versioned app tag.

## Setup

```bash
cp .env.example .env.production
chmod 600 .env.production
```

Generate the secrets (see `.env.example` for the full list):

```bash
openssl rand -base64 48   # AUTH_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY (32 random bytes, base64)
openssl rand -hex 24      # POSTGRES_PASSWORD (URL-safe, it is embedded in DATABASE_URL)
```

Set `APP_ENV=production`, `APP_URL=https://app.example.com` (must be the public HTTPS origin),
`TRUST_PROXY=loopback,uniquelocal` and the Sankhya settings. The first administrator is created
with the one-time bootstrap token or the admin CLI (see [deployment.md](deployment.md)).

Start it. `--env-file` supplies the `${...}` values used by the compose file, `env_file` supplies
the container environment:

```bash
docker compose --env-file .env.production -f docker-compose.production.example.yml up -d --build
docker compose --env-file .env.production -f docker-compose.production.example.yml ps
curl -fsS http://127.0.0.1:3001/health/ready
```

## Nginx with TLS

```nginx
server {
  listen 443 ssl;
  http2 on;
  server_name app.example.com;

  ssl_certificate     /etc/letsencrypt/live/app.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;
  ssl_protocols       TLSv1.2 TLSv1.3;

  client_max_body_size 1m;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 180s;
  }
}

server {
  listen 80;
  server_name app.example.com;
  return 301 https://$host$request_uri;
}
```

Obtain the certificate with your ACME client of choice (for example `certbot --nginx -d app.example.com`).
Do not expose `/health/*` publicly if you do not need to; the healthchecks run inside the container.

## Supply-chain checks

`.github/workflows/supply-chain.yml` runs gitleaks, generates a CycloneDX SBOM (`pnpm sbom`) as a
build artifact, and runs `pnpm audit --audit-level moderate` as a non-blocking job.

## Checklist

- [ ] `.env.production` is mode 600 and absent from git (`git status` must not list it).
- [ ] Secrets are unique and generated, not the `.env.example` placeholders.
- [ ] Only ports 80/443 (and SSH) are open on the host firewall.
- [ ] Backups of the `db-data` volume are scheduled and a restore has been tested.
