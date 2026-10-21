# Security

This document describes the threat model and the controls in place. Report vulnerabilities as
described in [SECURITY.md](../SECURITY.md).

## Threat model

| Asset                             | Main threats                                                          |
| --------------------------------- | --------------------------------------------------------------------- |
| Sankhya gateway credentials       | leaking to the browser, logs, audit records, error messages, the repo |
| ERP data read through the gateway | unauthorized reads, over-fetching, exfiltration                       |
| ERP records                       | accidental or malicious changes, partial or unverifiable writes       |
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
  `cookie`, `session`, `bearer`, `client_secret`, `x-token`, `*token`, `*secret`, `*password`,
  `*apikey`, …) with
  `***REDACTED***` and also scrubs the literal configured secret values from any string.
- Configuration is validated with a schema at boot. In production the server **refuses to
  start** when a secret is short or a placeholder, when the removed `BOOTSTRAP_ADMIN_PASSWORD`
  is still set, when `DATABASE_URL` still contains the placeholder password or points to the in-memory
  database, when `APP_URL` is not HTTPS, when `LOG_LEVEL` is `debug`/`trace`, when
  `ENCRYPTION_KEY` is missing, or when `SANKHYA_MODE` is missing (or `mock` without
  `DEMO_MODE=true`). Problems are listed by name; secret values are never printed.
- `SANKHYA_BASE_URL` must be an `https://` origin whose host is in `SANKHYA_ALLOWED_HOSTS`, so
  configuration cannot be turned into an SSRF primitive.

## Authentication and sessions

- Passwords are hashed with Argon2id (`@node-rs/argon2`). Policy: at least 12 characters and three
  of upper case, lower case, digits and symbols. There is no default password: the first
  administrator is created with a one-time bootstrap token (32 random bytes, only its SHA-256
  stored, compared in constant time, logged once at warn level, single use, rate-limited like
  login) or with the admin CLI. Passwords printed by the CLI are one-time: the user must change
  them on first login (`PASSWORD_CHANGE_REQUIRED` until then).
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
or reset each account and with which roles. Writes covered by a rule with `requireApproval` need a
second person (four-eyes, see [Write protection](#write-protection)), and the requester can never
approve their own plan.

**Separation of duties for policies.** An account that holds any `DATA.*`, `DDL.CUSTOM.GENERATE` or
`SANKHYA.BUSINESS_ACTION.EXECUTE` permission cannot create, change or delete policy rules, even with
`ADMIN.POLICIES`; it can still read them. Otherwise it could remove the `requireApproval` or `WHERE`
rule that governs its own writes and skip four-eyes. The refusal is `FORBIDDEN` with reason
`separation_of_duties` and is audited as `denied`. A plain `ADMIN` is not affected; an
`ADMIN,OPERATOR` account (such as that bootstrap admin) needs a second, policy-only administrator.

Permission checks happen on the server for every request. History, saved queries, running executions
and write previews are always scoped by the owner's user id (no IDOR through ids in the URL);
administrators see the audit log of all users.

Reads and scratch statements are also evaluated by the stored policy rules, after the permission
check. A rule with an empty connection list applies to every connection, including the
`env-default` connection defined by `SANKHYA_*` (in its `SANKHYA_ENVIRONMENT`), and scratch
statements are evaluated as the pseudo connection `scratch` in the `SANDBOX` environment. A rule's
connection list holds connection uuids only, so `env-default` and `scratch` can never be named
there: they are targeted by environment, or by a rule with no connection list. A rule scoped to
`SANDBOX` therefore applies both to real SANDBOX connections and to every scratch workspace.

- A read is evaluated with the tables and columns it touches. A star counts as `*`, which every
  column rule on its table hits, and is also expanded from the catalog, so a column DENY refuses
  `SELECT *` even for a column the dictionary does not list; `COUNT(*)` reads no column and is not
  expanded, while `COUNT(col)` references `col`. On Oracle, a quoted table or CTE name that is not
  upper case is refused: `"tgfpar"` names another object than `TGFPAR`, and a CTE so named could
  hide a read of the real table.
- A write is checked against the policy for its table before the table's dictionary is read, so
  the answer for a table the caller may not change does not depend on whether it exists.
- A scratch `SELECT` is evaluated with the columns it reads. Scratch has no catalog, so a star or
  a whole-row reference (`row_to_json(t)`) or a `NATURAL JOIN` counts as `*`, which every column
  rule on that table hits, and a `JOIN … USING (c)` column counts on every table of the statement.
  Every other scratch statement is evaluated as `*` on each table it touches. The policy's
  `maxReadRows` truncates scratch results (ceiling `SCRATCH_MAX_ROWS`, clamped to the policy hard
  maximum of 100000). `maxWriteRows` applies to scratch only when a matching ALLOW rule sets it:
  then it caps the rows one scratch `INSERT`/`UPDATE`/`DELETE` (or DDL) may change, and a larger
  change is refused and rolled back. Without such a rule, the default write limit (meant for ERP
  writes) does not apply, and scratch writes are bounded by the workspace quotas
  (`SCRATCH_MAX_ROWS`, `SCRATCH_MAX_TABLES` and the storage size).
- `GET /api/scratch/tables` evaluates `QUERY.SELECT` in the scratch context with no entities, so
  only a rule without entities or columns can deny it.
- Materialization (`POST /api/scratch/materialize`) evaluates `TEMP.MATERIALIZE` in both contexts
  and needs it allowed in each: on the scratch side (`scratch`, `SANDBOX`, the target table) and on
  the source side (the Sankhya connection and its environment, then the tables and columns the
  read touches). `QUERY.SELECT` is evaluated on the source side. A rule such as DENY
  `TEMP.MATERIALIZE` in `PRODUCTION`, or on `TGF*`, stops copying that data into scratch without
  stopping reads of it.
  The copy is capped at `MATERIALIZE_MAX_ROWS` and at the lowest `maxReadRows` of the rules matched
  in either context.

## Policy engine

After the permission check, every read, write, scratch statement, materialization, DDL artifact
and business action is evaluated by the policy engine (`packages/shared/src/policy.ts`) against
the stored rules (**Políticas**, `ADMIN.POLICIES`). A rule has an effect (`ALLOW` or `DENY`), a
subject (a user, a group or everyone), and optional filters: environments, connections, actions,
entities (tables, `*` wildcards allowed) and columns. It can carry limits and the
`overrideWhereRequired` flag.

The decision is made in this order:

1. The user lacks the permission for the action: **DENY**.
2. Any enabled `DENY` rule overlaps the request: **DENY**. A deny always wins.
3. Writes (`DATA.*`, `DDL.CUSTOM.GENERATE`, `SANKHYA.BUSINESS_ACTION.EXECUTE`) are
   **default-deny**: every entity the request touches must be covered by an `ALLOW` rule. Other
   actions are allowed by the permission unless denied.
4. Limits from every matching rule are combined, the most restrictive value winning: `maxReadRows`
   and `maxWriteRows` take the lowest value; `requireWhere`, `requireStrongConfirmation` and
   `requireApproval` are on if any rule sets them; `auditSnapshots` is off if any rule turns it
   off. `requirePreview` and `requireConfirmation` are always on.
5. Any write on a `PRODUCTION` connection requires strong confirmation.
6. An `UPDATE` of a Sankhya table without `WHERE` is refused unless an `ALLOW` rule with
   `overrideWhereRequired` covers each entity and no rule sets `requireWhere`. The override then
   forces strong confirmation and approval. A `DELETE` without `WHERE` is always refused, and so
   is a scratch (`TEMP.WRITE`) `UPDATE` or `DELETE` without `WHERE`, with no override, whether it
   runs directly or through a plan. A `WHERE` that does not restrict rows (`1 = 1`, `a = a`) counts
   as none.

Defaults when no rule sets a limit: `maxReadRows` 1000, `maxWriteRows` 50, strong confirmation and
approval off, snapshots on. Hard ceilings: 100000 rows read, 1000 rows written. There is no
administrator bypass. The policy version is frozen into each plan and checked again before
execution, so changing the rules invalidates pending plans.

## Write protection

`POST /api/query` never executes a mutation: `INSERT`, `UPDATE` and `DELETE` are refused with
`SQL_UNSUPPORTED` and a pointer to the preview route, other mutations are refused outright, and
both are audited as `write.denied`. The legacy `POST /api/query/confirm` is always refused. Reads
go through a lexical gate that refuses write keywords, so a mutation cannot reach the gateway
through the read path either (`SQL_FORBIDDEN`). Native DDL is never executed for anyone.

A write runs only as a plan (see [architecture.md](architecture.md#writes)):

- **Capability first.** Only `INSERT` and `UPDATE` of catalog tables (through `DatasetSP.save`)
  and registered business actions can reach Sankhya. Everything else is `UNSUPPORTED` (see
  [capabilities.md](capabilities.md)).
- **Immutable plans.** The previewed plan is stored with a hash; the token is an HMAC over the
  plan id, its hash and the session, signed with `AUTH_SECRET`, valid for `PLAN_TTL_SECONDS`,
  and consumed at most once. What runs is exactly what was previewed.
- **Typed confirmation.** `PRODUCTION` writes, and rules that ask for it, need the exact phrase
  `<ENVIRONMENT> <ACTION> <N> <ENTITY>`.
- **Four-eyes approval.** A rule with `requireApproval` (and every `WHERE` override) needs a second
  active user with `APPROVAL.DECIDE`, the plan's permissions and a policy `ALLOW`. The requester
  cannot approve their own plan; a rejection invalidates it. Nobody who can write can change the
  rules that ask for approval (see separation of duties above).
- **Re-authorization.** Permissions, policy version, capability, target rows and the kill
  switches are checked again at execution, and the switches and policy version again before every
  gateway call.
- **Kill switches.** `GLOBAL_WRITE_ENABLED` (default `false`, with a runtime half that an
  administrator with `ADMIN.SECURITY` can turn off without a restart), `WRITE_TO_SANKHYA` (default
  `false`) and `SAFE_MODE` (default `true`, blocks `PRODUCTION` writes). Business actions also
  need their id in `BUSINESS_ACTIONS_ENABLED` on live connections.
- **No retries.** A write is sent once. An unclear outcome is reported as `WRITE_OUTCOME_UNKNOWN`,
  never repeated automatically.
- **Verification.** Every changed row is read back and the run is labelled `VERIFIED`,
  `PARTIALLY_VERIFIED`, `UNVERIFIED` or `FAILED`.
- **Audit.** `PLAN_CREATED`, `PLAN_DENIED`, `PLAN_EXECUTED` and `VERIFICATION` events carry the
  plan, the decision and the before and after rows (unless `auditSnapshots` is off). An assisted
  rollback is a new plan built from those snapshots and goes through every step above.

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
the bootstrap, user, group, role, policy and connection administration (`connection.rotate_secrets`
included), the runtime write switch (`security.update`), reads (`read.executed`, `read.denied`),
write refusals (`write.denied`), the plan lifecycle (`PLAN_CREATED`, `PLAN_DENIED`,
`PLAN_EXECUTED`, `VERIFICATION`), approvals (`approval.request`, `approval.decide`,
`approval.execute`), rollback plans (`rollback.planned`), DDL artifacts (`ddl.generate`,
`ddl.denied`) and scratch materializations (`scratch.materialize`, `scratch.denied`). Scratch
reads are not audited. Row snapshots are capped (50 rows, 256 KiB, strings clipped at 2000
characters) and redacted like everything else. It never stores gateway credentials, session
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
