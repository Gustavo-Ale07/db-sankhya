# Architecture

DB-Sankhya is a SQL workspace over the Sankhya ERP **gateway**. The browser never talks to
Sankhya: the server holds the gateway credentials, checks every statement and sends only reads
it has proved safe. Mutations are not available yet; every mutation entry point fails closed
(see [Writes](#writes)).

```mermaid
flowchart LR
  subgraph Browser
    UI[React UI<br/>Monaco editor, result grid]
  end
  subgraph Server["Server (Node.js, Fastify)"]
    API[HTTP API<br/>auth, RBAC, CSRF, rate limits]
    ENG[SQL engine<br/>gate, analyzer]
    SC[Sankhya client<br/>auth, limiter, circuit breaker, redaction]
    DB[(PostgreSQL<br/>users, sessions, history,<br/>saved queries, audit, catalog cache)]
  end
  GW[(Sankhya gateway)]

  UI -- "JSON over HTTPS<br/>(session cookie)" --> API
  API --> ENG
  API --> SC -- "credentials<br/>(server only)" --> GW
  API --> DB
```

Gateway credentials come from the environment (`SANKHYA_*`, the default connection) or from
connections registered in the admin panel, stored encrypted with `ENCRYPTION_KEY`. They are
redacted from every log, history row and audit record.

## Read path

```mermaid
flowchart LR
  SQL[SQL text] --> G[Token gate] --> A[Read analyzer] --> C[Catalog check]
  C --> P[Authorization] --> W[Row cap] --> X[Gateway executeQuery] --> RES[Rows]
```

| Stage          | Module                                     | Responsibility                                                                                                    |
| -------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Token gate     | `packages/sql-engine/src/gate.ts`          | Lexical, fail-closed: refuses comments, several statements, write/DDL/procedural keywords, db links, sequences.   |
| Read analyzer  | `packages/sql-engine/src/read-analyzer.ts` | Parses the statement in the connection's dialect (Oracle or SQL Server) and allows only a known set of AST nodes. |
| Catalog        | `apps/api/src/services/metadata.ts`        | Data dictionary discovered from the gateway and cached; every table in the read must exist in it.                 |
| Read executor  | `apps/api/src/services/read-executor.ts`   | Runs the steps above, applies the row cap and sends the read to the gateway.                                      |
| Sankhya client | `packages/sankhya-client`                  | HTTP transport, token handling, rate and concurrency limits, circuit breaker, retries for idempotent calls only.  |
| API            | `apps/api`                                 | Fastify server: sessions, RBAC, CSRF, history, saved queries, audit, static web UI.                               |
| Web            | `apps/web`                                 | React 19 + Vite UI: schema tree from the catalog, tabs, Monaco with completion, virtualized grid, admin pages.    |
| Database       | `packages/database`                        | Drizzle schema and versioned SQL migrations for PostgreSQL (PGlite in memory for development and tests).          |

Anything the gate or the analyzer does not recognise is refused with `SQL_FORBIDDEN`; it is
never sent to the gateway. The server caps the rows it returns (`truncated: true` tells the UI
the result was cut).

`packages/sql-engine` also keeps a small in-memory evaluator (`src/local/evaluate.ts`,
`evaluateSelect`) that runs a parsed SELECT over rows already in memory. It is not on the
gateway read path.

## Writes

Mutations (INSERT, UPDATE, DELETE, DDL) are **not available yet**. `POST /api/query` and
`POST /api/query/confirm` refuse them with `SQL_UNSUPPORTED` ("Mutations are not available
yet.") and record a `write.denied` audit event. `SAFE_MODE`, `GLOBAL_WRITE_ENABLED` and
`WRITE_TO_SANKHYA` are kept as kill switches for the future write path; turning them on does not
enable writes today.

> Superseded by Stage 11: writes now run as plans (preview, confirmation, execute, verification);
> see "Business actions" below and `docs/migration-plan.md`.

### Business actions

Besides the dataset save, the API can call only the gateway services listed in a typed registry
(`apps/api/src/services/business-actions.ts`). Each entry declares its gateway module, the
permission it needs (`SANKHYA.BUSINESS_ACTION.EXECUTE`), the one entity it changes, a zod schema
for its input, the key of the row it changes, and the values that row must hold afterwards. There
is no generic "call any service" endpoint.

- `POST /api/actions/:id/prepare` with `{ "input": { ... }, "connectionId"?: "..." }` validates
  the input, evaluates the PolicyEngine with `entities = [the action's entity]`, reads the real
  row (`IMPACT_ANALYSIS`) and returns the expected change (`SIMULATED_PREVIEW`) plus a plan
  token. An unknown action id is `404`.
- `POST /api/actions/:id/execute` with `{ planId, token, idempotencyKey, strongConfirmation? }`
  runs the plan through the same lifecycle as a SQL write: confirmation (or approval),
  re-authorization, kill switches, one non-idempotent call that is never retried, read-back by
  key (`VERIFIED` only when the row holds the expected values) and audit. An action plan cannot
  be executed through `/api/query/execute`, nor a SQL plan through an action route.
- A row already in the target state is refused at preview: reading it back would prove nothing.
- On a `live` connection an action is disabled (`OPERATION_NOT_SUPPORTED`) unless its id is listed
  in `BUSINESS_ACTIONS_ENABLED` (empty by default). Mock connections run every registered action.

The request bodies in the registry are written against the bundled gateway mock. **Before
listing an action in `BUSINESS_ACTIONS_ENABLED`, validate its request body and its expected effect
against the official gateway documentation of the target version.** If the real effect differs
(for example, the row is moved instead of updated), the read-back reports `FAILED` or
`UNVERIFIED`, never `VERIFIED`, but the call itself has already happened.

An `INSERT` whose primary key is generated by the gateway is read back by the key returned in the
save result; when the result carries no complete key the step stays `UNVERIFIED`. That
verification trusts the key the gateway returned and compares only the inserted columns.

## Persistence

PostgreSQL stores application data: users (Argon2id hashes), sessions (hashed tokens), query
history, saved queries, registered connections (secrets encrypted), the cached data dictionary
and the audit log. Migrations are generated by drizzle-kit, versioned in
`packages/database/migrations` and applied on boot.

## Deployment shape

A single container serves the API and the built web UI on one origin (no CORS), behind a reverse
proxy that terminates TLS. PostgreSQL runs on an internal Docker network with no published port.
See [deployment.md](deployment.md).
