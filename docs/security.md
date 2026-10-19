# Security

This document describes the threat model and the controls in place. Report vulnerabilities as
described in [SECURITY.md](../SECURITY.md).

## Threat model

| Asset                             | Main threats                                                          |
| --------------------------------- | --------------------------------------------------------------------- |
| Sankhya gateway credentials       | leaking to the browser, logs, audit records, error messages, the repo |
| ERP data read through the gateway | unauthorized reads, over-fetching, exfiltration                       |
| ERP records (future writes)       | accidental or malicious changes (mutations are refused today)         |
| User accounts and sessions        | brute force, session theft or fixation, CSRF, privilege escalation    |
| The server itself                 | SSRF through configurable URLs, injection, resource exhaustion        |

The application is meant for a small team behind HTTPS. It is **not** designed to be exposed to
anonymous users.

## Credentials

- Gateway credentials come from the environment (`SANKHYA_*`, the default connection) or from
  connections registered in the admin panel, whose secrets are encrypted at rest with
  `ENCRYPTION_KEY`. They are used only by the server (`packages/sankhya-client`); the web bundle
  never receives them and no endpoint returns them.
- Every structure that leaves the server (responses, history, audit, logs, errors) goes through
  `packages/shared/src/redact.ts`, which replaces values of sensitive keys (`authorization`,
  `cookie`, `client_secret`, `x-token`, `*token`, `*secret`, `*password`, `*apikey`, …) with
  `***REDACTED***` and also scrubs the literal configured secret values from any string.
- Configuration is validated with a schema at boot. In production the server **refuses to
  start** when a secret is short or a placeholder, when the bootstrap password is the placeholder
  or weak, when `DATABASE_URL` still contains the placeholder password or points to the in-memory
  database, when `APP_URL` is not HTTPS, when `LOG_LEVEL` is `debug`/`trace`, when
  `ENCRYPTION_KEY` is missing, or when `SANKHYA_MODE` is missing (or `mock` without
  `DEMO_MODE=true`). Problems are listed by name; secret values are never printed.
- `SANKHYA_BASE_URL` must be an `https://` origin whose host is in `SANKHYA_ALLOWED_HOSTS`, so
  configuration cannot be turned into an SSRF primitive.

## Authentication and sessions

- Passwords are hashed with Argon2id (`@node-rs/argon2`). Policy: at least 12 characters and three
  of upper case, lower case, digits and symbols. The bootstrap administrator must change the
  password on first login (`PASSWORD_CHANGE_REQUIRED` until then).
- Login failures are counted per account; after `LOGIN_MAX_ATTEMPTS` the account is locked for
  `LOGIN_LOCK_MINUTES`. A locked account gets the same `INVALID_CREDENTIALS` answer as a wrong
  password, so lockouts do not reveal which e-mails exist; the lock is recorded in the audit log. Login and password change are also rate-limited per IP.
  Unknown e-mails and wrong passwords return the same error, and the password hash is verified
  against a dummy hash for unknown users to keep timing similar.
- Session tokens are 256-bit random values. Only their SHA-256 hash is stored. A new token is
  issued at login and after a password change (all other sessions of the user are revoked), so a
  pre-set cookie cannot be fixed onto a session.
- In production the cookie is `__Host-dbx_session`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, with an
  absolute expiry (`SESSION_HOURS`). Deactivating a user revokes their sessions; role and
  group changes apply on the user's next request, because permissions are resolved per request.

## Identity providers (OIDC readiness)

- `users.identity_provider` (default `'local'`) records which provider owns an account's
  credentials. Only `local` accounts can log in with a password; others are refused by the local path.
- `IdentityProvider` (`apps/api/src/services/identity.ts`) is the extension point:
  `authenticate(input)` returns a verified `{ externalId, email }` or `null`. The built-in local
  provider wraps the existing Argon2id password check. No OIDC implementation exists yet; a future
  provider must feed the same lockout, session and audit logic and must not create accounts implicitly.

## Authorization

Every route checks one permission from a fixed catalog (`packages/shared/src/permissions.ts`):
`QUERY.SELECT`, `TEMP.*`, `DATA.INSERT|UPDATE|DELETE`, `DDL.CUSTOM.GENERATE`,
`SANKHYA.BUSINESS_ACTION.EXECUTE`, `APPROVAL.DECIDE`, `AUDIT.READ` and `ADMIN.*`. A user's effective
permissions are the union of the roles assigned to them and the roles of their **active** groups; a
disabled group grants nothing, and permission strings outside the catalog are ignored.

| Seeded role | Permissions                                                          |
| ----------- | -------------------------------------------------------------------- |
| `VIEWER`    | `QUERY.SELECT`, `TEMP.*`                                             |
| `OPERATOR`  | `VIEWER` plus `DATA.INSERT`, `DATA.UPDATE`                           |
| `ADMIN`     | `ADMIN.*`, `AUDIT.READ`, `APPROVAL.DECIDE`, `QUERY.SELECT`, `TEMP.*` |

There is no administrator bypass: `ADMIN` gets no `DATA.*`, `DDL.*` or `SANKHYA.*` permission, and no
permission ever allows DDL on native ERP tables. `DATA.DELETE` is granted only through a custom role.
Seeded roles cannot be deleted or have their permissions changed.

Nobody changes their own effective permissions, through any path. The server refuses with
`FORBIDDEN`, and records the attempt in the audit log with status `denied`, when an actor:

- changes their own direct roles;
- adds themselves to a group or removes themselves from one;
- changes the roles of a group they belong to, enables or disables it, or deletes it;
- edits the permissions of a role they hold (directly or through any group), or deletes it.

As a backstop, every administrative change also compares the actor's roles and permissions before
and after, inside the same transaction, and is rolled back if they differ. Assigning roles to a user,
whether at creation or later, needs `ADMIN.ROLES` in addition to `ADMIN.USERS`, and granting roles to
a group needs `ADMIN.ROLES` in addition to `ADMIN.GROUPS`.

Nobody grants a permission they do not hold themselves. The actor's effective permissions must
include every permission that a change would add. This applies when the actor:

- assigns roles to a user, at creation or later;
- gives roles to a group;
- adds members to a group (the actor must hold everything the group grants, active or not);
- re-enables a group;
- creates a role or adds permissions to one.

An actor can only reduce the grants of users they fully cover. Removing a user's roles or group
memberships, deleting a group, removing roles from a group, and removing permissions from or deleting
a role are refused when any affected user, judged before the change, has a permission the actor
lacks. Otherwise an actor could strip a stronger account and then reset its password. The
self-change and last-administrator rules apply as well.

Nobody takes over an account that is stronger than their own. Resetting a user's password, or
reactivating a disabled user, is refused when the target has any permission the actor lacks. This
counts the roles of the target's disabled groups too, since those can be re-enabled.

Deactivating an account is allowed, because it grants nothing.

All of these refusals use `FORBIDDEN`, are audited as `denied`, and are checked inside the same
transaction as the change. There is no exception for `ADMIN`. Because `ADMIN` holds no `DATA.*`, a
plain `ADMIN` can neither create or promote `OPERATOR` users nor reset their passwords; that needs an
administrator who also holds `OPERATOR`, such as a bootstrap admin with `BOOTSTRAP_ADMIN_ROLES=ADMIN,OPERATOR`.

These changes run one at a time under a PostgreSQL advisory lock. A change that would leave no active
user with `ADMIN.USERS` is refused, so two administrators who remove each other concurrently cannot
lock everyone out.

**Residual risk:** an administrator can create accounts, or reset weaker ones, with at most their
own permissions, and then sign in as them (an equal-privilege "sock puppet"). This does not raise
their privileges, but it hides who acted behind a second identity. The audit log records who created
or reset each account and with which roles, and approvals that require a second person (four-eyes)
are planned for Stage 14.

Permission checks happen on the server for every request. History, saved queries, running executions
and write previews are always scoped by the owner's user id (no IDOR through ids in the URL);
administrators see the audit log of all users.

## Write protection

Mutations are **not available yet**. Every mutation entry point fails closed:

- `POST /api/query` with `INSERT`, `UPDATE`, `DELETE` or DDL answers `SQL_UNSUPPORTED`
  ("Mutations are not available yet.") before anything is planned or sent, whatever the user's
  role or the flags below. The refusal is recorded in the history and audited as `write.denied`.
- `POST /api/query/confirm` always answers `SQL_UNSUPPORTED` and is audited as `write.denied`.
- Reads go through a lexical gate that refuses write keywords, so a mutation cannot reach the
  gateway through the read path either (`SQL_FORBIDDEN`).

`SAFE_MODE=true`, `GLOBAL_WRITE_ENABLED=false` and `WRITE_TO_SANKHYA=false` are the defaults and
are kept as kill switches for the future write path. Turning them on does not enable writes today.

## Query safety

- A read is sent to the gateway only after the token gate and the AST allowlist accept it and
  every table it reads is in the connection's catalog (see [sql-dialect.md](sql-dialect.md)).
  Anything unknown is refused, never passed through.
- Application data in PostgreSQL is accessed only through Drizzle's parameterized queries.
- Limits on returned rows (`SANKHYA_MAX_ROWS`), gateway time (`SANKHYA_TIMEOUT_MS`) and SQL
  length (20,000 characters) bound the work any statement can cause. A user can cancel their own
  running query; an administrator can cancel any.
- Gateway calls share a process-wide rate budget (`SANKHYA_RATE_PER_MINUTE`), a concurrency limit
  and a circuit breaker. Only idempotent calls are retried.

## HTTP hardening

- **CSRF** — state-changing requests must carry an `Origin` (or `Referer`) equal to `APP_URL`;
  bodies must be `application/json`, which rules out HTML form posts; cookies are
  `SameSite=Strict`.
- **CORS** — not enabled. The UI and API share one origin.
- **Headers** (`@fastify/helmet`) — strict CSP (`default-src 'self'`, no inline scripts,
  `frame-ancestors 'none'`, `object-src 'none'`), HSTS, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, frame denial. API responses with user data are
  `Cache-Control: no-store`.
- **XSS** — React escapes all output; the app never uses `dangerouslySetInnerHTML`. Monaco and its
  workers are served from our origin.
- **CSV export** — values starting with `=`, `+`, `-`, `@`, tab or carriage return are prefixed
  with `'` to prevent formula injection in spreadsheets.
- **Rate limits** — global per-IP limit plus stricter limits on login and password change. Behind a proxy set `TRUST_PROXY` so the client IP is correct.
- **Errors** — responses carry a stable `code`, a message and a `requestId`. Stack traces and
  internal details are only logged on the server.

## Logging and audit

Logs are structured (pino) and go to stdout. Request logs omit bodies, cookies and authorization
headers. The audit log stores: logins (success, and failures including lockouts), logouts, password changes,
user administration, read denials and write denials. It never stores gateway credentials, session
tokens, passwords, cookies or authorization headers.

## Supply chain

- Exact dependency versions, a committed lockfile and `pnpm install --frozen-lockfile` in CI and
  Docker. pnpm only runs install scripts for allowlisted packages.
- GitHub Actions are pinned to commit SHAs. CodeQL (`security-extended`), dependency review,
  gitleaks secret scanning and Dependabot run on the repository.
- The runtime image contains only production dependencies and runs as the unprivileged `node`
  user; compose drops all capabilities, sets `no-new-privileges` and mounts the root filesystem
  read-only.

## Known limitations

- Open editor tabs are kept in the browser's `localStorage` so drafts survive a reload. They are
  removed on logout; closing the browser without logging out leaves them on that device.
- Rate limits and the gateway call budget are kept per process. Run a single instance, or put a shared
  limiter in front of several.
