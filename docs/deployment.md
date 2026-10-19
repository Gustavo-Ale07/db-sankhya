# Deployment

The supported deployment is Docker Compose on a Linux host: one `app` container (API + web UI)
and one `db` container (PostgreSQL 17), behind a reverse proxy that terminates HTTPS.

## Requirements

- Docker Engine 24+ with the Compose plugin.
- A DNS name pointing at the host and a reverse proxy (Caddy or Nginx examples below).
- Sankhya gateway credentials for live mode. Mock mode needs none.

## Install

```bash
git clone https://github.com/Gustavo-Ale07/db-sankhya.git
cd db-sankhya
cp .env.example .env
nano .env
docker compose up -d --build
```

Edit at least these values in `.env` — the app refuses to start in production while they hold
the placeholders:

| Variable            | What to set                                                          |
| ------------------- | -------------------------------------------------------------------- |
| `APP_URL`           | the public HTTPS URL, e.g. `https://sql.example.com`                 |
| `POSTGRES_PASSWORD` | a long random password (URL-safe characters: `openssl rand -hex 24`) |
| `SESSION_SECRET`    | `openssl rand -base64 48`                                            |

Then check:

```bash
docker compose ps                     # both services "healthy"
docker compose logs -f app            # "DB-Sankhya API started"
curl -fsS http://127.0.0.1:3001/health/ready
```

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
  user exists the endpoint answers `404`.

- **Admin CLI**. Set `BOOTSTRAP_ADMIN_EMAIL` (no token is issued then) and run:

  ```bash
  docker compose exec app node dist/admin.mjs bootstrap --email admin@example.com
  ```

  It prints a one-time password that must be changed at the first login. On a non-empty users
  table it refuses unless `--force-additional` is given.
  `node dist/admin.mjs reset-password --email <e-mail>` resets a password the same way.

The app listens on `127.0.0.1:3001` on the host (`APP_BIND` / `APP_PORT`). PostgreSQL has no
published port; it is reachable only from the `app` container on an internal network. If another
service already uses port 3001 on the host, set a free `APP_PORT` (e.g. `3101`) and point the
reverse proxy at it; the container keeps listening on 3001 internally.

## Connecting to Sankhya

1. Start with `SANKHYA_MODE=mock` and `DEMO_MODE=true` to validate the installation with
   fictitious data.
2. Set `SANKHYA_MODE=live` and either fill the `SANKHYA_*` connection variables (base URL, client
   id, client secret, X-Token) or register a connection in the admin panel, then
   `docker compose up -d`. The gateway host must be listed in `SANKHYA_ALLOWED_HOSTS`.
3. Open **Status** in the UI: it shows the Sankhya mode and how many connections are ready.

Mutations are not available yet; `SAFE_MODE`, `GLOBAL_WRITE_ENABLED` and `WRITE_TO_SANKHYA` keep
their safe defaults.

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
  listen 443 ssl http2;
  server_name sql.example.com;

  ssl_certificate     /etc/letsencrypt/live/sql.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/sql.example.com/privkey.pem;

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

### TRUST_PROXY

The app uses the client IP for rate limits, login lockout records and the audit log. Behind a
proxy, set `TRUST_PROXY` so it reads `X-Forwarded-For` correctly:

- `TRUST_PROXY=loopback,uniquelocal` — a proxy on the same host (the usual Caddy/Nginx setup).
  Docker forwards the published port from the network gateway, a private address, so the private
  ranges have to be trusted; with `APP_BIND=127.0.0.1` only processes on the host can reach it.
- `TRUST_PROXY=10.0.0.10,10.0.0.11` — trust only these proxy addresses.
- `TRUST_PROXY=false` — the app is exposed directly; forwarded headers are ignored.

Hop counts such as `TRUST_PROXY=1` are rejected at startup: Fastify ignores them, so every client
would share the proxy's IP (one rate-limit bucket for everybody, useless audit IPs).

Never set `TRUST_PROXY=true` or `uniquelocal` when clients can reach the app without going through
the proxy: they could spoof their IP and dodge rate limits. In production the app refuses to start
with that combination when `APP_BIND` publishes it on a non-loopback address.

To check it, sign in and look at the IP column of **Auditoria**: it must show your public address,
not `172.x.x.x`.

`APP_URL` must match the origin users type in the browser. It is used for the CSRF origin check;
a mismatch shows up as `CSRF_REJECTED`.

## Backup and restore

All application state (users, history, saved queries, connections, the cached data dictionary,
audit log) lives in PostgreSQL. ERP rows are not stored, so there is nothing else to back up.

```bash
# Backup (compressed custom format)
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > backup-$(date +%F).dump

# Restore into the running database (replaces existing objects)
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  < backup-2026-01-31.dump
docker compose restart app
```

Schedule the backup with cron or a systemd timer, keep copies off the host and test a restore
regularly. The dump contains password hashes and the audit log: store it encrypted.

## Upgrades

```bash
git pull
GIT_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build
```

Database migrations are versioned and applied automatically when the app starts. Take a backup
before upgrading.

## Operations

| Task                 | Command / where                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------- |
| Logs                 | `docker compose logs -f app` (JSON lines; ship them to your log stack)                   |
| Liveness / readiness | `GET /health/live`, `GET /health/ready` (database)                                       |
| Version and commit   | footer of the UI, `GET /api/meta`; the commit comes from the `GIT_COMMIT` build argument |
| Lost admin password  | another admin resets it in **Usuários**; see [troubleshooting](troubleshooting.md)       |
| Stop                 | `docker compose down` (data stays in the `db-data` volume)                               |
| Remove everything    | `docker compose down -v` — **deletes the database volume**                               |

## Hardening checklist

- [ ] HTTPS only, HSTS enabled by the app; HTTP redirects to HTTPS at the proxy.
- [ ] `APP_BIND=127.0.0.1` (default) so the app is reachable only through the proxy.
- [ ] Strong, unique `SESSION_SECRET` and `POSTGRES_PASSWORD`; `.env` readable only by root
      (`chmod 600 .env`).
- [ ] `SAFE_MODE=true`, `GLOBAL_WRITE_ENABLED=false`, `WRITE_TO_SANKHYA=false` (the defaults).
- [ ] Users have the least roles they need (`VIEWER` by default; `ADMIN` does not write ERP data).
- [ ] Backups scheduled and restore tested.
- [ ] Host firewall allows only 80/443 (and SSH).
