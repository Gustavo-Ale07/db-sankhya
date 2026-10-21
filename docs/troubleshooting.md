# Troubleshooting

Every error shown in the UI has a stable code (for example `READ_ONLY_MODE`) and a request id.
Search the server logs for the request id to find the details:

```bash
docker compose logs app | grep '<request id>'
```

## The app does not start

**`Invalid configuration:` followed by a list** — the environment failed validation. Each line
names the variable and the problem. Common ones:

| Message                                                         | Fix                                                 |
| --------------------------------------------------------------- | --------------------------------------------------- |
| `AUTH_SECRET (legacy name SESSION_SECRET) is missing, …`        | `openssl rand -base64 48` and paste it into `.env`  |
| `ENCRYPTION_KEY is required in production`                      | `openssl rand -base64 32`; keep a copy apart        |
| `BOOTSTRAP_ADMIN_PASSWORD is no longer supported`               | remove it; use the bootstrap token or the admin CLI |
| `DATABASE_URL still contains the placeholder database password` | change `POSTGRES_PASSWORD` in `.env`                |
| `APP_URL must use https:// in production`                       | use the public HTTPS URL served by your proxy       |
| `SANKHYA_MODE (live or mock) is required in production`         | set `SANKHYA_MODE=live`                             |
| `SANKHYA_BASE_URL host is not in SANKHYA_ALLOWED_HOSTS`         | add the gateway host to `SANKHYA_ALLOWED_HOSTS`     |
| `LOG_LEVEL debug/trace is not allowed in production`            | use `info`                                          |

**`set POSTGRES_PASSWORD in .env`** from `docker compose` — the variable is empty.

**Database connection refused / authentication failed** — `POSTGRES_PASSWORD` was changed after
the volume was created. PostgreSQL keeps the password it was initialized with. Either put the
old password back, or change it inside the database:

```bash
docker compose exec db psql -U dbsankhya -d dbsankhya -c "ALTER USER dbsankhya PASSWORD '<new>'"
```

Special characters such as `@`, `/`, `:` or `#` in `POSTGRES_PASSWORD` break the generated
`DATABASE_URL`. Use a hex or alphanumeric password.

## Login

| Symptom                                                | Cause and fix                                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CSRF_REJECTED` on login                               | `APP_URL` differs from the address in the browser (scheme, host or port).                                                                              |
| Login succeeds but you are sent back to the login page | The session cookie is `Secure`: open the app over HTTPS.                                                                                               |
| `INVALID_CREDENTIALS` with the right password          | The account is locked after repeated failures. Wait `LOGIN_LOCK_MINUTES` or ask an admin to reset the password (the audit log shows `ACCOUNT_LOCKED`). |
| `RATE_LIMITED`                                         | Too many requests from one IP. Behind a proxy, check `TRUST_PROXY`.                                                                                    |
| No `bootstrap token` in the logs                       | Users already exist, `BOOTSTRAP_ADMIN_EMAIL` selects the admin CLI, or a token is pending from an earlier boot (it is shown only once).                |

**All administrators locked out.** Reset one password with the admin CLI. It prints a one-time
password, unlocks the account and revokes its sessions:

```bash
docker compose exec app node dist/admin.mjs reset-password --email admin@example.com
```

## Queries

| Code                     | Meaning and fix                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SQL_FORBIDDEN`          | The read gate or analyzer refused the statement (comments, several statements, write keywords, an unknown construct). See [sql-dialect.md](sql-dialect.md). |
| `SQL_UNSUPPORTED`        | A mutation sent to the read route. Use the write dialog (preview, then confirm); DDL is not executed. See [capabilities.md](capabilities.md).               |
| `RESOURCE_NOT_FOUND`     | The table is not in the connection's catalog. Check the schema tree.                                                                                        |
| `SANKHYA_NOT_CONFIGURED` | No Sankhya connection is ready. Set the `SANKHYA_*` variables or register a connection.                                                                     |

### `COLUMN_NOT_FOUND` on a column that exists in the ERP

Before this release, the column dictionary (`TDDCAM`) was read in one query that the gateway cut
at its row cap, and a mutation preview could refuse a real column (for example `TGFPAR.NOMEPARC`).
The dictionary is now read in pages, and previews, `SELECT *`, DDL and the schema tree read the
table on its own when the catalog is partial ([sankhya.md](sankhya.md#data-dictionary)). If the
error persists, check with read-only queries in the editor:
`SELECT COUNT(*) FROM TDDCAM` and `SELECT NOMECAMPO FROM TDDCAM WHERE NOMETAB = 'TGFPAR'`.
A `SANKHYA_API_ERROR` on a preview means the table's own dictionary read failed; nothing was
planned. Preview again.

## Gateway errors

| Code                   | Meaning                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `SANKHYA_AUTH_ERROR`   | The gateway rejected the connection's credentials. Check them in the environment or admin panel. |
| `SANKHYA_RATE_LIMITED` | The gateway throttled the requests. Wait and try again.                                          |
| `SANKHYA_TIMEOUT`      | The gateway did not answer within `SANKHYA_TIMEOUT_MS`.                                          |
| `SANKHYA_UNAVAILABLE`  | Network error or gateway 5xx.                                                                    |
| `SANKHYA_API_ERROR`    | The Sankhya service refused the request; its message is shown with credentials redacted.         |
| `SANKHYA_BAD_RESPONSE` | The response did not have the expected shape.                                                    |

## Writes

| Code                       | Meaning and fix                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `READ_ONLY_MODE`           | A kill switch is off ("Writes are disabled (<switch>)"). See **Status** and [operations.md](operations.md#write-switches).                  |
| `FORBIDDEN`                | Missing permission, or no policy `ALLOW` rule covers the table. Writes are default-deny.                                                    |
| `OPERATION_NOT_SUPPORTED`  | The statement or action has no supported route (for example a Sankhya `DELETE`, or an action not in `BUSINESS_ACTIONS_ENABLED`).            |
| `WHERE_REQUIRED`           | An `UPDATE` or `DELETE` without `WHERE`. Add a `WHERE`, or ask for an override rule.                                                        |
| `WRITE_ROW_LIMIT_EXCEEDED` | More rows than the policy's `maxWriteRows`. Narrow the `WHERE`.                                                                             |
| `CONFIRMATION_REQUIRED`    | A destructive DDL artifact needs the typed confirmation `DESTRUCTIVE <TABLE>`.                                                              |
| `CONFIRMATION_INVALID`     | Wrong token, session or typed phrase (e.g. `PRODUCTION UPDATE 3 TGFPAR`). Check the phrase, or preview again.                               |
| `CONFIRMATION_EXPIRED`     | The plan is older than `PLAN_TTL_SECONDS`. Preview again.                                                                                   |
| `CONFIRMATION_USED`        | The plan was already executed. Check **Auditoria** for its result.                                                                          |
| `TARGETS_CHANGED`          | The rows changed between preview and execution. Preview again.                                                                              |
| `WRITE_OUTCOME_UNKNOWN`    | The gateway did not confirm the save. **Do not repeat it**: check the row in the ERP first ([operations.md](operations.md#operator-notes)). |

`SANKHYA_NOT_CONFIGURED` with "The connection credentials cannot be decrypted; replace them" means
`ENCRYPTION_KEY` changed since the connection was saved. Replace its secrets in **Conexões** (see
[operations.md](operations.md#back-up-the-master-key-separately)).
