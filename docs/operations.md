# Operations

Day-to-day running of a DB-Sankhya installation: backups, keys, the write switches and what to do
when a write ends in an uncertain state. Installation is in [deployment.md](deployment.md).

The commands below use the default `compose.yaml`. With the hardened file, add
`--env-file .env.production -f docker-compose.production.example.yml` to each `docker compose`
command.

## Backup and restore

All application state lives in PostgreSQL: users, roles, groups, policies, sessions, history,
saved queries, connections (secrets encrypted), the cached data dictionary, plans, approvals,
runtime settings and the audit log. ERP rows are not stored, apart from the snapshots of rows that
plans changed. The scratch workspaces are in memory and are not backed up.

### Back up the database

```bash
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > backup-$(date +%F).dump
```

Schedule it with cron or a systemd timer, keep copies off the host and test a restore regularly.
The dump holds password hashes, the audit log (with row snapshots) and the encrypted connection
secrets: store it encrypted and restrict who can read it.

### Restore the database

```bash
docker compose stop app
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  < backup-2026-01-31.dump
docker compose start app
```

`--clean --if-exists` replaces the existing objects. Restore into the same or an older app version,
never a newer dump into an older app: migrations only move forward and run when the app starts.

### Back up the master key separately

`ENCRYPTION_KEY` encrypts the connection secrets (gateway client secret and X-Token) stored in the
database. **It is not in the dump.** Keep it, and `AUTH_SECRET`, in a password manager or secret
store, **separately from the database backups**: a stolen dump without the key exposes no
gateway credentials, and a restore with the key brings the connections back as they were.

| You restore with …                     | Result                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| the dump and the same key              | everything works as before                                                              |
| the dump and a different/lost key      | users, policies and audit are intact; **stored connection secrets cannot be decrypted** |
| the dump and a different `AUTH_SECRET` | pending plan tokens become invalid: preview those writes again                          |

**Losing `ENCRYPTION_KEY` means every stored connection secret must be entered again.** There is
no recovery. Generate a new key (`openssl rand -base64 32`), start the app with it, then for each
connection open **Conexões** and replace its secrets (`PUT /api/admin/connections/:id/secrets`,
audited as `connection.rotate_secrets`). Until then, using that connection fails with "The
connection credentials cannot be decrypted; replace them". The environment connection
(`env-default`) is not stored in the database and is not affected: its secrets come from
`SANKHYA_*`.

## Write switches

| Variable                   | Default | Meaning                                                 |
| -------------------------- | ------- | ------------------------------------------------------- |
| `GLOBAL_WRITE_ENABLED`     | `false` | master switch for planned writes and business actions   |
| `WRITE_TO_SANKHYA`         | `false` | allows writes to Sankhya tables                         |
| `SAFE_MODE`                | `true`  | blocks writes on `PRODUCTION` connections while on      |
| `BUSINESS_ACTIONS_ENABLED` | empty   | comma-separated action ids allowed on live connections  |
| `PLAN_TTL_SECONDS`         | `300`   | how long a previewed plan can be confirmed (30 to 3600) |
| `APPROVAL_TTL_MINUTES`     | `60`    | how long a plan waiting for approval stays valid        |
| `PLAN_REDACT_HOURS`        | `24`    | settled plans lose their before values and preview      |
| `PLAN_RETENTION_DAYS`      | `30`    | settled plans without an approval request are deleted   |

With the defaults no write reaches the ERP. To allow writes on a homologation connection set
`GLOBAL_WRITE_ENABLED=true` and `WRITE_TO_SANKHYA=true`; production writes also need
`SAFE_MODE=false`. Users then still need the permissions and an `ALLOW` policy rule (see
[permissions.md](permissions.md) and [security.md](security.md#policy-engine)).

### Emergency stop

An administrator with `ADMIN.SECURITY` can stop every planned write and business action at once
without a restart: **Segurança** → turn writes off, or

```bash
curl -X PUT https://app.example.com/api/admin/security \
  -H 'Content-Type: application/json' -H 'Origin: https://app.example.com' \
  -H 'Cookie: <session cookie>' -d '{"globalWriteEnabled":false}'
```

It takes effect before the next gateway save, including the remaining rows of a plan already
running, and is audited as `security.update`. This is the only switch that acts without a restart:
`WRITE_TO_SANKHYA`, `SAFE_MODE` and the environment half of `GLOBAL_WRITE_ENABLED` change only with
the environment and a restart. The runtime switch can only turn writes off; while
`GLOBAL_WRITE_ENABLED` is `false` in the environment, turning it on again changes nothing.

`GET /api/status` (signed in) shows the current state:

```json
{
  "writes": {
    "safeMode": true,
    "globalWriteEnabled": false,
    "globalWrite": { "env": true, "runtime": false, "effective": false },
    "writeToSankhya": true,
    "available": false,
    "productionAvailable": false,
    "scratchAvailable": false
  }
}
```

`effective` is `env` AND `runtime`. If the stored runtime value cannot be read, writes are refused
("The write switches could not be read."). `scratchAvailable` refers only to planned scratch
writes; statements run directly in the scratch editor (`/api/scratch/exec`) and materialization do
not check the switches, since they never reach the ERP.

## Operator notes

These are known behaviours to keep in mind when reading results and audit records.

- **`WRITE_OUTCOME_UNKNOWN`.** The gateway did not confirm a save (timeout, dropped connection,
  unreadable answer), or the audit could not be written after it. The change may or may not be in
  the ERP. **Do not repeat the plan.** Check the row in the ERP first, then prepare a new plan if
  it is still needed.
- **A lost single-step response shows as `PARTIALLY_VERIFIED` at best.** When the gateway's
  answer is lost, the row is still read back. A match is labelled `PARTIALLY_VERIFIED`, not
  `VERIFIED`, because the save was never confirmed; a mismatch is `FAILED`; a read that fails is
  `UNVERIFIED`. Check the row in the ERP before acting.
- **`INSERT` verification trusts the key returned by the gateway.** The new row is read back by
  the key in the save result and only the inserted columns are compared. If the gateway returned
  the wrong key, the check reads the wrong row. Without a complete key the step is `UNVERIFIED`.
- **Rollback SQL uses the app's dialect.** In an assisted rollback, string literals have their
  backslashes doubled, because the app's SQL parser reads backslash escapes. The text is correct
  for DB-Sankhya (preview it and execute it in the app) but **wrong if pasted into a native Oracle
  or SQL Server tool**, which would write two backslashes. A negative zero in a snapshot is
  restored as `0`.
- **Rollback is a new plan.** It is offered only for a fully `VERIFIED` `UPDATE` with complete
  snapshots, needs `DATA.UPDATE` and an `ALLOW` rule, and only the first statement is prepared
  for you. Conflicts (rows that changed or no longer exist) are checked only for that prepared
  first statement.
- **The `auditSnapshots` policy limit.** A rule with `auditSnapshots: false` (any matching rule
  wins) stops storing the before and after rows. The audit still keeps the counts, the row keys
  (up to 50) and the full SQL text, **including the values in `SET`**. With snapshots off, no
  rollback plan can be built for that write. Use it for tables whose values must not be copied
  into the audit, and keep sensitive literals out of the statements themselves.
- **Business actions.** Test one cancellation in `HOMOLOGATION` before listing
  `CACSP.cancelarNota` in `BUSINESS_ACTIONS_ENABLED` for a production installation. Its request
  body was validated only against the bundled mock. See
  [sankhya.md](sankhya.md#business-actions).
- **Plans expire.** A preview older than `PLAN_TTL_SECONDS` is `CONFIRMATION_EXPIRED`; preview
  again. A plan can be executed once (`CONFIRMATION_USED`); repeating with the same
  `idempotencyKey` returns the first result.
- **`TARGETS_CHANGED`.** The rows changed between preview and execution. Preview again.
- **Plans from before an upgrade.** A Sankhya plan previewed before the entity instance was frozen
  in plans is refused at execution (`CONFIRMATION_INVALID`). Preview it again.
- **An incomplete catalog.** A degraded catalog is never stored and is read again after
  `METADATA_DEGRADED_TTL_SECONDS` (default 600). A dictionary bigger than `METADATA_MAX_PAGES`
  pages of the gateway's row cap (default 100) is always cut; raise it rather than read it again. `POST /api/schema/refresh` (the refresh button of
  the schema tree) reads it now; it is rate limited and audited as `schema.refresh`. Changing a
  connection or its secrets drops its catalog. See [sankhya.md](sankhya.md#data-dictionary).

## Health, logs and version

| Task               | Command / where                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------- |
| Logs               | `docker compose logs -f app` (JSON lines; ship them to your log stack)                   |
| Liveness           | `GET /health/live`                                                                       |
| Readiness          | `GET /health/ready` (database and scratch manager)                                       |
| Version and commit | footer of the UI, `GET /api/meta`; the commit comes from the `GIT_COMMIT` build argument |
| Writes and Sankhya | **Status** page, `GET /api/status`                                                       |
| Audit trail        | **Auditoria** page (`AUDIT.READ`)                                                        |
| Stop               | `docker compose down` (data stays in the `db-data` volume)                               |
| Remove everything  | `docker compose down -v` — **deletes the database volume**                               |

`LOG_LEVEL` is `info` by default; `debug` and `trace` are refused in production. Secrets are
redacted from logs.

**`GIT_COMMIT` is mandatory for a release build.** Without it the footer and `GET /api/meta` show
`dev`, and nobody can tell which commit runs. Always build with
`GIT_COMMIT=$(git rev-parse --short HEAD)` (see Upgrades) and check `GET /api/meta` after the start.

### Fixed scratch limits

A workspace and its `tmp_` tables are dropped after `SCRATCH_TTL_MINUTES` (default 60) without
activity; the **Temporárias (tmp\_\*)** group of the editor's tree says so and lists each table with
its columns and rows (`GET /api/scratch/tables?columns=1`, filtered by policy).

Besides `SCRATCH_MAX_WORKSPACES`, `SCRATCH_MAX_ROWS`, `SCRATCH_MAX_TABLES`, `SCRATCH_TTL_MINUTES`,
`SCRATCH_STATEMENT_TIMEOUT_MS` and `MATERIALIZE_MAX_ROWS`, a scratch workspace has limits that are
set in code (`SCRATCH_DEFAULTS` in `apps/api/src/services/scratch.ts`) and cannot be changed by
environment: 64 MiB of storage per workspace, 16 MiB per result, 1 GiB of WASM memory, 4 queued
statements per workspace, 200 preview rows per side of a dry run, and 100 000 characters per
statement. Changing them needs a new build.

## Accounts

```bash
# First administrator, when BOOTSTRAP_ADMIN_EMAIL is set (prints a one-time password)
docker compose exec app node dist/admin.mjs bootstrap --email admin@example.com

# Reset a password (prints a one-time password that must be changed at the next login)
docker compose exec app node dist/admin.mjs reset-password --email user@example.com
```

`bootstrap` refuses when users already exist, unless `--force-additional` is given. Another
administrator can also reset a password in **Usuários**.

## Upgrades

```bash
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > pre-upgrade.dump
git pull
GIT_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build
```

Migrations are versioned and applied when the app starts. Read the release notes first: upgrading
from a version before the permission catalog changes what administrators can do (see
[permissions.md](permissions.md#upgrading-from-an-earlier-version)).

### Controlled publication

Publish a release with writes off and check it read-only before anyone relies on it.

1. **Before.** Note the running commit (`GET /api/meta`) as the rollback target, take the
   `pre-upgrade.dump` above, and confirm `SAFE_MODE=true`, `GLOBAL_WRITE_ENABLED=false` and
   `WRITE_TO_SANKHYA=false` in the environment. Do not change `.env` for the upgrade.
2. **Build and start** the new commit as above. Migrations run on start; a release without new
   files under `packages/database/migrations` changes no table.
3. **Health.** `GET /health/live` and `GET /health/ready` answer 200; `GET /api/meta` shows the new
   commit; `docker compose logs app` has no `error` lines from the start.
4. **Read-only smoke test** (as a user with `QUERY.SELECT`):
   - **Status** shows writes unavailable and the three switches off;
   - the schema tree loads; time the first `GET /api/schema` (the first catalog load reads the
     dictionary in pages, see [sankhya.md](sankhya.md#data-dictionary)) and look for
     `degraded` in its response;
   - a `SELECT` of a few rows from a table you may read returns them; a column a policy denies is
     still refused;
   - expanding a large table in the schema tree lists all its columns;
   - an `UPDATE` preview of a known column (on a row you choose, without executing) shows the
     plan; **Executar** stays disabled and `/api/query/execute` answers `READ_ONLY_MODE`.
5. **Watch** the logs for `SANKHYA_*` errors and catalog read times during the first hour.
6. **Rollback.** Check out the previous commit and rebuild it the same way. Restore the dump only
   if a migration of the new release ran and must be undone.
