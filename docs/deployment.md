# Deployment

The supported deployment is Docker Compose on a Linux host: one `app` container (API + web UI)
and one `db` container (PostgreSQL 17), behind a reverse proxy that terminates HTTPS. Two compose
files are provided:

- `compose.yaml`: the basic install described first;
- `docker-compose.production.example.yml`: a hardened starting point (see
  [Hardened compose](#hardened-compose)).

Backups, the master key, the write switches and day-to-day tasks are in
[operations.md](operations.md).

## Requirements

- Docker Engine 24+ with the Compose plugin.
- A DNS name pointing at the host and a reverse proxy (Caddy or Nginx examples below).
- Sankhya gateway credentials for live mode. Mock mode needs none.

## Install

```bash
git clone https://github.com/Gustavo-Ale07/db-sankhya.git
cd db-sankhya
cp .env.example .env
chmod 600 .env
nano .env
docker compose up -d --build
```

Edit at least these values in `.env`. In production the app refuses to start while they are
missing or hold the placeholders:

| Variable            | What to set                                                               |
| ------------------- | ------------------------------------------------------------------------- |
| `APP_URL`           | the public HTTPS URL, e.g. `https://sql.example.com`                      |
| `POSTGRES_PASSWORD` | a long random password (URL-safe characters: `openssl rand -hex 24`)      |
| `AUTH_SECRET`       | `openssl rand -base64 48` (the legacy name `SESSION_SECRET` still works)  |
| `ENCRYPTION_KEY`    | `openssl rand -base64 32`; back it up apart from the database (see below) |
| `SANKHYA_MODE`      | `live`, or `mock` together with `DEMO_MODE=true`                          |

`ENCRYPTION_KEY` encrypts the connection secrets stored in the database. Losing it means
re-entering them: see [operations.md](operations.md#back-up-the-master-key-separately).

Then check:

```bash
docker compose ps                     # both services "healthy"
docker compose logs -f app            # "DB-Sankhya API started"
curl -fsS http://127.0.0.1:3001/health/ready
```

### Production refusals

With `NODE_ENV=production` (the image default) the app does not start when, among others:

- `AUTH_SECRET` is missing, a placeholder or shorter than 32 random characters;
- `ENCRYPTION_KEY` is missing or not base64 of 32 bytes;
- `SANKHYA_MODE` is missing, or `mock` without `DEMO_MODE=true`;
- `DATABASE_URL` is not PostgreSQL or still has the placeholder password;
- `APP_URL` or `TRUSTED_ORIGINS` is not `https://`;
- `LOG_LEVEL` is `debug` or `trace`;
- `TRUST_PROXY` is a hop count, or trusts every address while `APP_BIND` publishes the app;
- `BOOTSTRAP_ADMIN_PASSWORD` is set (it is no longer supported);
- the `SANKHYA_BASE_URL` host is not in `SANKHYA_ALLOWED_HOSTS`.

The startup log names the failing setting. See [troubleshooting.md](troubleshooting.md).

### First administrator

There is no default password. Pick one of two ways:

- **Bootstrap token** (default). On its first start with an empty database, the app logs a
  one-time token once, at warn level: `bootstrap token: <token>`. Only its SHA-256 is stored and
  it is never logged again. Within `BOOTSTRAP_TOKEN_TTL_MINUTES` (default 30) create the
  administrator (roles from `BOOTSTRAP_ADMIN_ROLES`):

  ```bash
  docker compose logs app | grep 'bootstrap token'
  curl -X POST https://sql.example.com/api/auth/bootstrap \
    -H 'Content-Type: application/json' -H 'Origin: https://sql.example.com' \
    -d '{"token":"<token>","email":"admin@example.com","password":"<12+ chars, mixed>"}'
  ```

  The token works once. An expired token gets `410`; restart the app to issue a new one. Once any
  user exists, or while no token is pending, the endpoint answers `404`. A consumed or expired
  token left in the logs is harmless: it can no longer create an account.

- **Admin CLI**. Set `BOOTSTRAP_ADMIN_EMAIL` (no token is issued then) and run:

  ```bash
  docker compose exec app node dist/admin.mjs bootstrap --email admin@example.com
  ```

  It prints a one-time password that must be changed at the first login. On a non-empty users
  table it refuses unless `--force-additional` is given.
  `node dist/admin.mjs reset-password --email <e-mail>` resets a password the same way.

The administrator role (`ADMIN`) manages users, roles, policies, connections and the write switch.
It does not read or write ERP data by itself beyond `QUERY.SELECT`; give a second role for that
(see [permissions.md](permissions.md)).

The app listens on `127.0.0.1:3001` on the host (`APP_BIND` / `APP_PORT`). PostgreSQL has no
published port; it is reachable only from the `app` container on an internal network. If another
service already uses port 3001 on the host, set a free `APP_PORT` (e.g. `3101`) and point the
reverse proxy at it; the container keeps listening on 3001 internally.

## Connecting to Sankhya

1. Start with `SANKHYA_MODE=mock` and `DEMO_MODE=true` to validate the installation with
   fictitious data.
2. Set `SANKHYA_MODE=live` and either fill the `SANKHYA_*` connection variables (base URL, client
   id, client secret, X-Token, `SANKHYA_ENVIRONMENT`) or register connections in **Conexões**,
   then `docker compose up -d`. The gateway host must be listed in `SANKHYA_ALLOWED_HOSTS`.
3. Open **Status** in the UI: it shows the Sankhya mode, how many connections are ready and the
   state of the write switches.

Use a dedicated integration user with the least access it needs: the gateway documents no
read-only guarantee for `executeQuery` (see [sankhya.md](sankhya.md#executequery)).

### Enabling writes

With the defaults (`GLOBAL_WRITE_ENABLED=false`, `WRITE_TO_SANKHYA=false`, `SAFE_MODE=true`,
`BUSINESS_ACTIONS_ENABLED` empty) every write is refused with `READ_ONLY_MODE`, and previews still
work. When writes are needed:

1. Grant `DATA.INSERT` / `DATA.UPDATE` through a role (`OPERATOR` or a custom role).
2. Create policy rules in **Políticas** that `ALLOW` those actions on the tables and environments
   concerned. Writes are default-deny without them.
3. Set `GLOBAL_WRITE_ENABLED=true` and `WRITE_TO_SANKHYA=true`. Leave `SAFE_MODE=true` until
   writes have been tried on a `HOMOLOGATION` connection; production writes need `SAFE_MODE=false`.
4. Restart the app. Any administrator with `ADMIN.SECURITY` can stop writes again at runtime from
   **Segurança** (see [operations.md](operations.md#emergency-stop)).

Every write is previewed, confirmed and verified; see
[architecture.md](architecture.md#writes).

## Reverse proxy

### Caddy (automatic HTTPS)

```caddyfile
sql.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3001
}
```

### Nginx

```nginx
server {
  listen 443 ssl;
  http2 on;
  server_name sql.example.com;

  ssl_certificate     /etc/letsencrypt/live/sql.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/sql.example.com/privkey.pem;
  ssl_protocols       TLSv1.2 TLSv1.3;

  client_max_body_size 1m;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Keep above SANKHYA_TIMEOUT_MS.
    proxy_read_timeout 180s;
  }
}

server {
  listen 80;
  server_name sql.example.com;
  return 301 https://$host$request_uri;
}
```

Obtain the certificate with your ACME client of choice (for example
`certbot --nginx -d sql.example.com`). Do not expose `/health/*` publicly if you do not need to;
the healthchecks run inside the container.

### TRUST_PROXY

The app uses the client IP for rate limits, login lockout records and the audit log. Behind a
proxy, set `TRUST_PROXY` so it reads `X-Forwarded-For` correctly:

- `TRUST_PROXY=loopback,uniquelocal`: a proxy on the same host (the usual Caddy/Nginx setup).
  Docker forwards the published port from the network gateway, a private address, so the private
  ranges have to be trusted; with `APP_BIND=127.0.0.1` only processes on the host can reach it.
- `TRUST_PROXY=192.0.2.10,192.0.2.11`: trust only these proxy addresses.
- `TRUST_PROXY=false`: the app is exposed directly; forwarded headers are ignored.

Hop counts such as `TRUST_PROXY=1` are rejected at startup: Fastify ignores them, so every client
would share the proxy's IP (one rate-limit bucket for everybody, useless audit IPs).

Never set `TRUST_PROXY=true` or `uniquelocal` when clients can reach the app without going through
the proxy: they could spoof their IP and dodge rate limits. In production the app refuses to start
with that combination when `APP_BIND` publishes it on a non-loopback address.

To check it, sign in and look at the IP column of **Auditoria**: it must show your public address,
not `172.x.x.x`.

`APP_URL` must match the origin users type in the browser. It is used for the CSRF origin check;
a mismatch shows up as `CSRF_REJECTED`. Add any other allowed origin to `TRUSTED_ORIGINS`.

## Hardened compose

`docker-compose.production.example.yml` tightens the basic install. Copy it, never edit it in
place, and keep every real value in `.env.production` (git-ignored, never committed).

What it enforces:

- API: read-only root filesystem, `tmpfs` for `/tmp`, `cap_drop: ALL`, `no-new-privileges`,
  non-root user (set in the `Dockerfile`), CPU and memory limits, `pids_limit`, log rotation.
- Database: no published port, on an `internal: true` network reachable only by the API.
- API port bound to `127.0.0.1` only; a reverse proxy terminates TLS in front of it.
- Healthchecks: the API checks `/health/ready` (database and scratch manager), the database uses
  `pg_isready`. The API waits for a healthy database.
- Pinned image tags: `postgres:17.11-alpine` (bump deliberately) and a versioned app tag.

Setup:

```bash
cp .env.example .env.production
chmod 600 .env.production
openssl rand -base64 48   # AUTH_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY (32 random bytes, base64)
openssl rand -hex 24      # POSTGRES_PASSWORD (URL-safe, it is embedded in DATABASE_URL)
```

Set `APP_ENV=production`, `APP_URL=https://sql.example.com` (the public HTTPS origin),
`TRUST_PROXY=loopback,uniquelocal` and the Sankhya settings. `--env-file` supplies the `${...}`
values used by the compose file, `env_file` supplies the container environment:

```bash
docker compose --env-file .env.production -f docker-compose.production.example.yml up -d --build
docker compose --env-file .env.production -f docker-compose.production.example.yml ps
curl -fsS http://127.0.0.1:3001/health/ready
```

## Supply-chain checks

`.github/workflows/supply-chain.yml` runs gitleaks, generates a CycloneDX SBOM (`pnpm sbom`) as a
build artifact, and runs `pnpm audit --audit-level moderate` as a non-blocking job.

## Hardening checklist

- [ ] HTTPS only, HSTS enabled by the app; HTTP redirects to HTTPS at the proxy.
- [ ] `APP_BIND=127.0.0.1` (default) so the app is reachable only through the proxy.
- [ ] Strong, unique `AUTH_SECRET`, `ENCRYPTION_KEY` and `POSTGRES_PASSWORD`; `.env` /
      `.env.production` mode 600 and absent from git.
- [ ] `ENCRYPTION_KEY` and `AUTH_SECRET` backed up apart from the database dumps.
- [ ] `SAFE_MODE=true`, `GLOBAL_WRITE_ENABLED=false`, `WRITE_TO_SANKHYA=false` (the defaults)
      until writes are deliberately enabled.
- [ ] `BUSINESS_ACTIONS_ENABLED` empty, or listing only actions tested in `HOMOLOGATION` and
      checked against the official gateway documentation (see
      [sankhya.md](sankhya.md#business-actions)).
- [ ] The Sankhya integration user has the least access it needs.
- [ ] Users have the least roles they need (`VIEWER` by default; `ADMIN` does not write ERP data).
- [ ] Backups scheduled and a restore tested ([operations.md](operations.md#backup-and-restore)).
- [ ] Only ports 80/443 (and SSH) are open on the host firewall.
