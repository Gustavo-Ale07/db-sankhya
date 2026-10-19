# Migration audit: DBExplorer (Omie) → DB-Sankhya

Status: Phase 1 (read-only diagnosis). Nothing in the codebase was changed to produce this document.

This audit covers the existing code base copied from the DBExplorer Omie project and classifies
every part as **KEEP**, **REFACTOR**, **REMOVE**, **REPLACE** or **ADD** for the new product:
DB-Sankhya, an independent SQL IDE and administration tool for the Sankhya ERP.

> DB-Sankhya is an independent project. It is not affiliated with, endorsed by or maintained by
> Sankhya Gestão de Negócios. "Sankhya" is used only to describe compatibility.

---

## 1. Baseline

| Check        | Result                                                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toolchain    | Node 24.19, pnpm 11.23, TypeScript 6                                                                                                                  |
| Install      | `CI=true pnpm install --frozen-lockfile` works (the copied `node_modules` needed a purge, which pnpm refuses to do without a TTY unless `CI=true`).   |
| Lint         | passes                                                                                                                                                |
| Typecheck    | passes                                                                                                                                                |
| Tests        | 20 files, 217 tests pass (unit + integration, about 80 s)                                                                                             |
| `pnpm audit` | 3 advisories: `esbuild@0.18.20` (moderate, dev-server only, pulled in through drizzle-kit), `dompurify@3.4.15` ×2 (low, pulled in by `monaco-editor`) |

The baseline is healthy. The migration starts from green tests, and every stage must end green.

## 2. Repository, history and license

### 2.1 Git

- `.git` **belongs to the DBExplorer Omie repository**: `origin = https://github.com/Gustavo-Ale07/dbexplorer-omie.git`, 31 commits, all by the owner's existing identity.
- No commit message contains AI attribution trailers. The only keyword hit is a commit subject that uses "generated" for screenshots produced by the E2E run.
- The history contains no company data. Every CNPJ hit comes from the mock generator (`fakeCnpj`, which uses intentionally invalid check digits). Every "plac" hit is `placeholder` or `replace`.

**Decision:** the Omie history is **not** carried into `db-sankhya`.

1. Move the current `.git` to a local backup directory outside the working tree. This is a move, not a delete, so it can be reversed.
2. Run `git init -b main` with the existing `user.name` and `user.email`. No remote is added until the release stage.
3. Before the first push: run the secret scan (gitleaks, if available, plus a contextual grep), the company-data audit and the attribution grep, check the author identity, and confirm with `git remote -v` that origin is `Gustavo-Ale07/db-sankhya`.
4. Never push to, force-push to or change `dbexplorer-omie`.

### 2.2 License

`LICENSE` is MIT, "Copyright (c) 2026 Gustavo-Ale07". The copied code was written by the same owner who will publish `db-sankhya`, so the owner may relicense or reuse it freely.

The repository contains no code taken from Omie or Sankhya. The Omie integration was written against public API documentation, and the Sankhya integration will be written the same way.

**Decision: KEEP MIT** with the same copyright holder.

Third-party dependencies are all permissive (MIT, Apache-2.0, BSD, ISC). This must be rechecked whenever a dependency is added.

## 3. Research findings: Sankhya integration surface

Sources: the official developer portal (`developer.sankhya.com.br`, including its `llms.txt` index) and public community code. Statements marked **UNVERIFIED** are not in official docs and the implementation must treat them as assumptions.

### 3.1 Authentication (official)

- Request: `POST https://api.sankhya.com.br/authenticate` (sandbox: `https://api.sandbox.sankhya.com.br/authenticate`).
- Headers: `X-Token: <gateway token>` and `Content-Type: application/x-www-form-urlencoded`. The token is generated in Sankhya Om ≥ 4.16, on the "Configurações Gateway" screen.
- Body: `client_id`, `client_secret`, `grant_type=client_credentials`.
- Response: `access_token` (JWT), `expires_in` (300 s in the examples), `refresh_expires_in` (0, so there is no refresh token), `token_type: Bearer`.
- Errors: 400, 401, 500.
- The legacy appkey/token login was discontinued after 31 March 2026 and **must not be implemented**.
- Behaviour observed in the field (UNVERIFIED): the gateway can reject a token as "Não autorizado" before its stated expiry. Handle this with **one** re-authentication and retry for idempotent reads only, using a single-flight token refresh. Writes are never retried automatically.

### 3.2 Gateway services (official)

All services share the same request shape:

- URL: `https://api.sankhya.com.br/gateway/v1/{mge|mgecom}/service.sbr?serviceName=<X>&outputType=json`
- Header: `Authorization: Bearer`
- Body: `{ serviceName, requestBody }`

A service belongs to exactly one module (MGE or MGECOM) and fails if called through the other.

| Service                                                                                                        | Module | Use in DB-Sankhya                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DbExplorerSP.executeQuery`                                                                                    | MGE    | Read path (SELECT). Officially listed but the body is not documented. Body used by community clients: `{ sql }`. Response: `responseBody.fieldsMetadata[{name}]`, `responseBody.rows[[...]]`. **UNVERIFIED:** about 1000 rows per call; two concurrent calls on the same HTTP session are refused ("situação de concorrência"); a server-side read-only guarantee is **not documented**. |
| `CRUDServiceProvider.loadRecords` / `loadRecord` / `loadView`                                                  | MGE    | Entity reads by criteria, paged with `offsetPage` and `hasMoreResult`. Supports `modifiedSince`. Used for before/after snapshots and post-write verification by PK.                                                                                                                                                                                                                      |
| `DatasetSP.save`                                                                                               | MGE    | INSERT (no `pk`) and UPDATE (with `pk`) on entities. Response has `status:"1"`, `transactionId`, `responseBody.result`. **This is the only documented generic write.**                                                                                                                                                                                                                   |
| `GatewayServiceProviderSP.logAlteracoesTabelas`                                                                | MGE    | Optional change log (requires an ERP setting, at most 7 days of retention). Can be used as a drift signal.                                                                                                                                                                                                                                                                               |
| `CACSP.IncluirNota`, `incluirAlterarItemNota`, `excluirItemNota`, `cancelarNota`; `SelecaoDocumentoSP.faturar` | MGECOM | Business actions. These are explicit, typed actions and are never inferred from SQL.                                                                                                                                                                                                                                                                                                     |

**Errors and limits (official):**

- Business errors return HTTP 200 with `status != "1"` and a `statusMessage`, often with `[CORE_Exxxxx]` codes.
- Gateway codes: `GTW2510`/`GTW2511` (bad or missing Authorization), `GTW3403` (invalid or expired token), `GTW2509` (`offsetPage` required).
- HTTP 504 is returned after 2 minutes of processing.
- Limits: 1000 requests per minute, 10 MB per request, 2 minutes processing time. Exceeding them can cause a temporary block.
- Field and entity names are case-sensitive.
- The integration user's screen permissions limit what each service can access.

**Generic DELETE:** no official generic delete service is documented, so DB-Sankhya will **not** claim to support `DELETE` on ERP tables. It is classified **UNSUPPORTED** (see §6). Deleting a note item goes through the business action `CACSP.excluirItemNota`.

### 3.3 DDL (official)

Native tables must never be altered. Sankhya's docs state that changing native tables (`TGFPRO`, `TGFCAB`, `TSIUSU`, …) is forbidden: changes are lost on upgrade, destabilise the ERP and void support.

Custom objects are deployed through **Add-on Studio**, in one of two ways:

- **AutoDDL:** a `datadictionary/*.xml` file with `<table>`, `<primaryKey>` and `<field dataType=TEXTO|INTEIRO|DECIMAL|DATA|DATA_HORA|HORA|CHECKBOX|CAIXA_TEXTO|ARQUIVO>`. It never drops tables or columns, never renames, and does not manage indexes or foreign keys.
- **dbscripts:** versioned files `V<n>.xml` with `<sql nomeTabela ordem executar=SE_NAO_EXISTIR|SE_EXISTIR|SEMPRE tipoObjeto nomeObjeto>` and separate `<oracle>` / `<mssql>` bodies. These are immutable once applied and must not end in `;`.

The docs advise against the generic `AD_` prefix and recommend a unique project prefix. The brief requires `AD_*` support (the convention customers use in their own dictionary), so DB-Sankhya will support a **configurable allowed custom prefix list** (default: `AD_`), with a documented warning.

**Consequence:** the only mode for custom DDL is **SUPPORTED VIA GENERATED ARTIFACT**. DB-Sankhya generates the AutoDDL XML or the dbscript XML for both dialects, plus a structural diff (SAFE / CAUTION / DESTRUCTIVE). It **never executes DDL** against the ERP.

### 3.4 Backend database dialect

A Sankhya installation runs on Oracle **or** SQL Server; the Add-on docs map types for both. Of the `node-sql-parser` 5.4 grammars bundled with the project, `transactsql` accepts the widest range of Sankhya-style SELECTs (CTEs, CASE, TOP, OFFSET/FETCH, subqueries), but it is **permissive**. A probe confirmed it accepts all of the following:

- `SELECT … INTO new_table`
- database links (`TGFPRO@remote` becomes a table name)
- `seq.NEXTVAL`
- multi-statement input

There is no Oracle grammar.

**Decision (fail closed, two layers):**

1. **Token-level gate** (our own tokenizer):
   - exactly one statement;
   - an explicit deny list, matched outside string literals, of `INTO`, `FOR UPDATE`, `@`-qualified names, `NEXTVAL`, `CURRVAL`, `DBMS_*`, `UTL_*`, `SYS.`, `EXEC`, `EXECUTE`, `CALL`, `BEGIN`, `DECLARE`, `MERGE`, `INSERT`, `UPDATE`, `DELETE`, `GRANT`, `REVOKE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `COMMIT`, `ROLLBACK`, `LOCK`, `WAITFOR`, `OPENROWSET`, `OPENQUERY`, `xp_*`, `sp_*`;
   - comments are refused.
2. **AST allowlist** (`node-sql-parser`, `transactsql`):
   - only `select` (CTEs allowed);
   - only allowlisted functions;
   - every referenced table resolved against cached metadata and authorised by the policy engine at table and column level;
   - `SELECT *` expanded against metadata so that column policy can be enforced.

If the parser cannot understand the statement, it is not executed. The row cap is enforced on our side (the response is truncated and flagged) and, where the dialect is configured, also injected into the SQL. The connection setting `dialect: oracle | mssql` selects the injection form.

The deployment guide will also recommend a **dedicated, least-privilege integration user** in Sankhya. The ERP-side permission layer is the last line of defence.

### 3.5 Metadata

The Sankhya data dictionary lives in the ERP tables `TDDTAB` (tables), `TDDCAM` (fields) and `TDDINS` (entity instances) and is readable with `executeQuery`.

**UNVERIFIED:** the exact column set differs between versions, so the metadata adapter must be tolerant:

- unknown columns are ignored;
- missing ones degrade to "type unknown";
- PK and FK information is used when found and otherwise shown as "not discovered".

Metadata is cached in the app database per connection, with a TTL and a manual refresh. Autocomplete uses only that cache.

## 4. Current architecture (as found)

- **apps/api:** Fastify 5. Services: users, sessions, audit, history, saved queries, confirmations, executions, Omie runtime, AI. Routes: auth, query, data, admin, system, ai.
- **apps/web:** React 19 SPA with a Monaco editor, tabs, a virtualized grid, history, saved queries, the schema tree, explain, the write-preview dialog, API inspector, admin users and audit, and a status page.
- **packages/sql-engine:** a "virtual SQL layer" that turns a restricted SQL dialect into Omie REST calls. It contains the parser, planner (pushdown into API parameters), local executor (joins, group, order), writes and a registry of 13 hand-written Omie resources.
- **packages/omie-client:** a resilient HTTP client (concurrency limiter, rate limiter, timeout, retry with backoff for reads, redacted traces) plus Omie transport, error classifier and mock.
- **packages/shared:** RBAC (3 fixed roles), redaction, error codes, shared types.
- **packages/database:** Drizzle schema and migrations. Tables: `users`, `sessions`, `saved_queries`, `query_history`, `audit_events` (has an `omie_calls` column), `write_previews`.
- **e2e:** 11 serial Playwright tests against the built server in mock mode.
- **Infra:**
  - multi-stage Dockerfile (non-root, HEALTHCHECK);
  - compose (read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, internal database network, app bound to 127.0.0.1);
  - CI (SHA-pinned actions, read-only permissions, compose smoke test), CodeQL, dependency review, gitleaks, dependabot.

## 5. Classification

### 5.1 KEEP (reuse as is, or with renames only)

| Item                                                                                                                                                   | Why                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth routes and `UsersService`, `SessionsService`                                                                                                      | Argon2id (OWASP parameters), dummy verify so timing doesn't reveal accounts, lockout that doesn't reveal which accounts exist, hashed opaque session tokens, rotation on login and password change, last-admin protection, forced password change. |
| `security/crypto.ts`                                                                                                                                   | Argon2id, `randomToken`, HMAC, `safeEqual`.                                                                                                                                                                                                        |
| `http.ts`                                                                                                                                              | Strict zod bodies (unknown fields rejected), `requireAuth`/`requirePermission`, `no-store`.                                                                                                                                                        |
| CSRF origin check, JSON-only bodies, helmet CSP and HSTS, rate limits, request IDs, `TRUST_PROXY` validation                                           | Already tested in `app.int.test.ts`.                                                                                                                                                                                                               |
| `ExecutionsService`                                                                                                                                    | Per-user concurrency cap, owner-scoped cancel, one write at a time per user, abort on shutdown.                                                                                                                                                    |
| `routes/data.ts`, `HistoryService`, `SavedQueriesService`                                                                                              | Owner-scoped, protected against IDOR.                                                                                                                                                                                                              |
| `packages/shared/redact.ts` (extend)                                                                                                                   | Key and value redaction. ADD keys `client_secret`, `x-token`, `access_token`, `refresh_token`, `bearer`.                                                                                                                                           |
| `omie-client/limiter.ts`                                                                                                                               | Generic concurrency and token-bucket rate limiters, abortable.                                                                                                                                                                                     |
| `sql-engine/eval.ts`                                                                                                                                   | Generic expression compiler (three-valued logic, safe LIKE, aggregates). Reused by the hybrid executor (scratch ⋈ materialized).                                                                                                                   |
| `sql-engine/tokenizer.ts`                                                                                                                              | Statement splitter and lexer. Extend with the deny-list gate.                                                                                                                                                                                      |
| Web: login, change password, history, saved queries, `ResultGrid` (text-only rendering), admin Users and Audit, CSV export with formula neutralisation | No ERP coupling.                                                                                                                                                                                                                                   |
| Dockerfile structure, compose hardening, `.gitignore`, `.dockerignore`, `.gitleaks.toml`, CI workflows                                                 | Rename Omie strings only.                                                                                                                                                                                                                          |
| `config.ts` pattern                                                                                                                                    | Production refuses placeholder or weak secrets. Extend it to the new variables.                                                                                                                                                                    |
| ADRs 0003 (write confirmation), 0005 (single origin), 0006 (TS monorepo)                                                                               | Still valid. 0003 evolves into immutable plans.                                                                                                                                                                                                    |
| `mock/random.ts`                                                                                                                                       | Deterministic random generator and fake identifiers for the new mock.                                                                                                                                                                              |

### 5.2 REFACTOR

| Item                                                                                      | Change                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `omie-client/client.ts`                                                                   | Becomes a generic `ResilientClient`: concurrency, rate limit (≤ 1000 per minute budget), timeout, retry with backoff for **reads only**, **circuit breaker** (ADD), redacted traces.                                                               |
| `ConfirmationsService` + `write_previews`                                                 | Becomes the **immutable execution plan** store: plan hash covering SQL, parameters, user, session, connection, environment, policy version and target snapshot; default TTL 5 minutes; invalidated when any input changes; single-use consumption. |
| `sql-engine/writes.ts`                                                                    | Keep the write-shape checks, target resolution, `statementHash`, `targetsHashOf`, before/after, `WriteExecution` (success/partial/failed, `writeOutcomeUnknown`). Replace payload building with `DatasetSP.save`.                                  |
| `sql-engine/executor.ts` steps 3–8                                                        | Extract them as a generic in-memory relational evaluator for scratch-plus-materialized hybrid queries.                                                                                                                                             |
| `sql-engine/context.ts`, `normalize.ts`                                                   | Make them client-agnostic. Replace Omie date and flag handling with Sankhya JSON values.                                                                                                                                                           |
| `sql-engine/registry/index.ts`                                                            | Keep the safe path helpers. The registry becomes a **metadata model** fed by the dictionary cache.                                                                                                                                                 |
| `sql-engine/engine.ts`                                                                    | Keep the facade, timeout wiring and `sanitizeParam`. Replace its internals with the pipeline Parser → Validator → Policy → Planner → Capability resolver → Adapter.                                                                                |
| RBAC (`shared/rbac.ts`, `users.role` check)                                               | Fixed roles become **granular permissions** plus groups, roles and policies with scopes. `VIEWER`, `OPERATOR` and `ADMIN` remain as seeded default roles, and existing users are migrated.                                                         |
| `AuditService` and the `audit_events` schema                                              | Drop `omie_calls`. ADD `connection_id`, `environment`, `plan_id`, `plan_hash`, `capability`, `verification`, `approval_id`, `policy_decision`, configurable before/after snapshots. Must stay searchable and redacted.                             |
| `routes/system.ts`                                                                        | `/health/ready` checks the database plus the scratch engine. Sankhya reachability is reported separately (not part of readiness, so an ERP outage doesn't restart the app). Inspector endpoints are removed.                                       |
| `routes/admin.ts`                                                                         | Grows into the admin API: users, groups, roles, permissions, policies, environments, connections, approvals, audit, security.                                                                                                                      |
| `logger.ts`                                                                               | Redact Sankhya credentials; keep the allowlisting serializers.                                                                                                                                                                                     |
| Web editor, completion, tabs, schema tree, explain, write-preview dialog, status page     | Full-SQL keywords, dictionary-fed completion, environment banner (with text), capability badge, honest preview labels, plan countdown, typed strong confirmation, approval state.                                                                  |
| `lib/format.ts`                                                                           | Also neutralise **TSV clipboard copy** (gap found).                                                                                                                                                                                                |
| `server.ts`                                                                               | Bootstrap admin through a CLI or one-time token instead of env passwords (ADD), and a new startup log name.                                                                                                                                        |
| e2e                                                                                       | New scenarios on the mock Sankhya.                                                                                                                                                                                                                 |
| Docs that survive: `deployment.md`, `development.md`, `security.md`, `troubleshooting.md` | Rewrite their content for Sankhya.                                                                                                                                                                                                                 |

### 5.3 REPLACE

| Item                                                                                | Replacement                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/omie-client` (transport, classify, mock, fixtures)                        | `packages/sankhya-client`: OAuth2 client_credentials with a single-flight token cache refreshed early, gateway transport (module routing MGE/MGECOM, `redirect: 'error'`, response size cap, `Retry-After`), Sankhya error classifier (`status`/`statusMessage`, `GTW*`, `CORE_E*`, 401/403 handling), a 1000/min budget and a serialised `executeQuery` lane. |
| `sql-engine/planner.ts` (API pushdown)                                              | The capability planner: decides SANKHYA_READ / SANKHYA_SAVE / BUSINESS_ACTION / SCRATCH / HYBRID / GENERATED_ARTIFACT / UNSUPPORTED, with the reason.                                                                                                                                                                                                          |
| `sql-engine/registry/resources.ts`, `types.ts`                                      | The metadata service (dictionary discovery and cache).                                                                                                                                                                                                                                                                                                         |
| `sql-engine/parser.ts` restricted MySQL dialect                                     | Two parse profiles: **Sankhya read** (`transactsql` with token gate and AST allowlist, CTEs and subqueries) and **scratch** (PostgreSQL grammar for the scratch engine).                                                                                                                                                                                       |
| Mock Omie                                                                           | **Mock Sankhya:** a fake gateway (authenticate, executeQuery over PGlite, DatasetSP.save, CRUDServiceProvider.loadRecords, a business-action stub) with clearly fictitious data and dictionary tables. Used by dev, tests, e2e and DEMO mode.                                                                                                                  |
| README, README.pt-BR, SECURITY.md, `architecture.md`, `sql-dialect.md`, screenshots | New Sankhya-focused documents. Screenshots are regenerated from the mock and labelled DEMO.                                                                                                                                                                                                                                                                    |
| `CODEOWNERS`                                                                        | Same owner, with the path rules reviewed.                                                                                                                                                                                                                                                                                                                      |
| `.env.example`                                                                      | `SANKHYA_*`, `SAFE_MODE=true`, `WRITE_TO_SANKHYA=false`, `GLOBAL_WRITE_ENABLED=false`, `MASTER_KEY` (placeholder), scratch quotas.                                                                                                                                                                                                                             |

### 5.4 REMOVE

| Item                                                                                           | Reason                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registry/resources.ts` (13 Omie resources), `docs/omie-resources.md`, `scripts` generating it | Omie only.                                                                                                                                                                                                                                                                                           |
| API Inspector (routes, `InspectorPage`, Request/Response trace tabs)                           | Exposes raw gateway payloads. Not a fit for an ERP with sensitive data; partial redaction is not enough.                                                                                                                                                                                             |
| **AI assistant** (`routes/ai.ts`, `ai/*`, `AI_*` and provider key config, UI panel, ADR 0007)  | Out of scope for the brief. Sending ERP schema and data to third-party LLMs raises data-governance concerns. Base URLs can be overridden without host validation (SSRF gap). It also conflicts with the release attribution grep. It can return later as an opt-in plugin with its own threat model. |
| ADRs 0001 (virtual SQL layer), 0002 (resource registry), 0004 (no transactions)                | Superseded. They will be replaced by new ADRs rather than silently deleted (marked superseded in the new ADR index).                                                                                                                                                                                 |
| `OMIE_*` error codes, `omieMode`, `omieCalls`, Omie UI strings, footer disclaimer              | Replaced by Sankhya equivalents and the independence notice.                                                                                                                                                                                                                                         |

### 5.5 ADD

| Area                        | Additions                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration                 | Abstraction `ErpConnector` with `capabilities()`. Sankhya connector, mock connector.                                                                                                                                                                                                                                                               |
| Connections                 | Multiple connections with credentials encrypted at rest (AES-256-GCM, key from `MASTER_KEY`). Masked display; replace, rotate and test only. Base URL **SSRF guard**: https only, host allowlist (default `api.sankhya.com.br`, `api.sandbox.sankhya.com.br`), DNS resolution check against private, loopback and link-local ranges, no redirects. |
| Environments                | PRODUCTION / HOMOLOGATION / SANDBOX per connection, shown as text in the banner and in every confirmation.                                                                                                                                                                                                                                         |
| Policy engine               | Rules on subject (user or group), environment, connection, entity, column and action, with effect ALLOW/DENY (DENY wins). Limits: `max_read_rows`, `max_write_rows`, `require_where`, `require_preview`, `require_confirmation`, `require_strong_confirmation`, `require_approval`. **No hidden bypass:** admin role ≠ ERP permission.             |
| Permissions                 | `QUERY.SELECT`, `TEMP.*`, `DATA.INSERT/UPDATE/DELETE`, `DDL.CUSTOM.*`, `SANKHYA.BUSINESS_ACTION.*`, `ADMIN.*`, `APPROVAL.*`, `AUDIT.READ`.                                                                                                                                                                                                         |
| Mutation lifecycle          | PARSE→VALIDATE→AUTHORIZE→PLAN→PREVIEW→IMPACT→CONFIRM→RE-AUTHORIZE→EXECUTE→VERIFY→AUDIT, with an optimistic concurrency check (snapshot hash) at execution and post-write verification (VERIFIED / PARTIALLY_VERIFIED / UNVERIFIED / FAILED).                                                                                                       |
| Preview                     | Honest labels: SIMULATED PREVIEW (computed locally), IMPACT ANALYSIS (targets plus counts). TRANSACTIONAL DRY RUN is **only** for the scratch engine, because Sankhya exposes no transactional dry run.                                                                                                                                            |
| Approvals                   | Four-eyes, no self-approval, bound to the plan hash, expiry.                                                                                                                                                                                                                                                                                       |
| Scratch engine              | A PGlite instance per user workspace, isolated in memory, never touching the app database. Quotas on tables, rows and bytes; TTL and idle eviction; global cap on workspaces; statement timeout. `MATERIALIZE` imports a Sankhya SELECT result for hybrid joins.                                                                                   |
| Kill switch & safe defaults | `GLOBAL_WRITE_ENABLED=false`, `WRITE_TO_SANKHYA=false`, `SAFE_MODE=true`, plus a runtime admin toggle that can only make things **more** restrictive than env.                                                                                                                                                                                     |
| Idempotency                 | Plan consumption is single-use. `Idempotency-Key` header on execute.                                                                                                                                                                                                                                                                               |
| Bootstrap                   | `pnpm --filter @dbx/api admin:bootstrap` (CLI) or a one-time bootstrap token printed once in the logs. Never `admin/admin`.                                                                                                                                                                                                                        |
| Observability               | `/metrics` (optional, auth-protected), counters with low-cardinality labels only.                                                                                                                                                                                                                                                                  |
| Docs                        | `architecture`, `security`, `deployment`, `sankhya`, `permissions`, `development`, `operations` (backup and restore), capability matrix, new ADRs.                                                                                                                                                                                                 |
| Production                  | `docker-compose.production.example.yml`, digest-pinned base image (recommended), SBOM and image scan in CI.                                                                                                                                                                                                                                        |

## 6. Capability matrix (initial, honest)

| Operation                                                             | Target  | Classification                                                                           | Mechanism                                                              |
| --------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `SELECT` (CTE, joins, subqueries, aggregates)                         | Sankhya | **SUPPORTED** (subject to validation and the unverified row ceiling)                     | `DbExplorerSP.executeQuery`                                            |
| `SELECT` across Sankhya and scratch                                   | Hybrid  | **SUPPORTED**                                                                            | materialize to scratch, then run locally                               |
| `INSERT` single entity                                                | Sankhya | **SUPPORTED** (policy-gated, off by default)                                             | `DatasetSP.save` without pk                                            |
| `UPDATE … WHERE`                                                      | Sankhya | **SUPPORTED** (policy-gated, off by default, row cap)                                    | target resolution via SELECT, then `DatasetSP.save` with pk per record |
| `UPDATE`/`DELETE` without `WHERE`                                     | any     | **BLOCKED** even for admins, unless an explicit policy override plus strong confirmation | —                                                                      |
| `DELETE`                                                              | Sankhya | **UNSUPPORTED** (no documented generic service)                                          | —                                                                      |
| Note/item actions (include, change, remove item, cancel, invoice)     | Sankhya | **SUPPORTED** as typed business actions, never from free SQL                             | `CACSP.*`, `SelecaoDocumentoSP.faturar`                                |
| `CREATE/ALTER/DROP TABLE` on custom tables (allowed prefixes)         | Sankhya | **SUPPORTED VIA GENERATED ARTIFACT**                                                     | AutoDDL XML / dbscript XML (Oracle + MSSQL)                            |
| DDL on native tables                                                  | Sankhya | **UNSUPPORTED** (forbidden)                                                              | —                                                                      |
| `CREATE/DROP/ALTER TEMP TABLE`, `INSERT/UPDATE/DELETE` on temp tables | Scratch | **SCRATCH ONLY**                                                                         | PGlite workspace                                                       |
| Transactions, `MERGE`, procedures, `GRANT`, multi-statement           | Sankhya | **UNSUPPORTED**                                                                          | —                                                                      |

## 7. Risks and open questions

1. **`executeQuery` read-only behaviour** is not documented. Mitigations: the two-layer gate (§3.4), a least-privilege integration user and an audit of every call. This will be stated plainly in `docs/sankhya.md`.
2. **Dictionary column names** (`TDDTAB`/`TDDCAM`/`TDDINS`) vary by version, so the metadata adapter must tolerate differences.
3. **`DatasetSP.save` field semantics** (index-based `values` map, `standAlone`) come from the official examples. Every write is verified afterwards with a PK read, and a verification mismatch is reported, never hidden.
4. **Rate and concurrency:** 1000 requests/min and serial `executeQuery` per session. Mitigations: a per-connection queue and budget, and batching of verification reads.
5. **No transactions** across `DatasetSP.save` calls, so multi-row updates can end partially. This is reported as PARTIAL, with assisted rollback that is itself a new planned mutation.
6. **dompurify/esbuild advisories:** bump through dependabot or overrides during the hardening stage.

## 8. Next step

Phase 2: `docs/migration-plan.md`, an incremental, staged plan where every stage keeps lint, typecheck and tests green.
