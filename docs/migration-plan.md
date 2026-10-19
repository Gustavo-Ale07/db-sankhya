# DB-Sankhya Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the DBExplorer Omie code base into DB-Sankhya, a secure SQL IDE and admin tool for the Sankhya ERP. Every ERP mutation passes through a policy engine and an immutable, previewed, confirmed, verified and audited plan.

**Architecture:** Incremental migration. The Omie path keeps the test suite green until the Sankhya path replaces it in Stage 5, and is deleted after that.

The new request pipeline is:

1. Tokenizer gate
2. Parser/AST (`node-sql-parser`)
3. Validator
4. Policy engine
5. Capability resolver
6. Planner
7. Adapter: Sankhya gateway, scratch PGlite, or hybrid

Writes reach Sankhya only through `DatasetSP.save` or typed business actions. Custom DDL is emitted as Add-on Studio artifacts and never executed.

**Tech Stack:** Node 24, pnpm 11, TypeScript 6, Fastify 5, Drizzle with PostgreSQL 17 / PGlite, React 19 + Vite + Monaco + TanStack, `node-sql-parser` 5.4, zod 4, `@node-rs/argon2`, pino, Vitest 5, Playwright.

**Spec:** the DB-Sankhya brief (owner's request) and `docs/migration-audit.md`. Read both. The audit's §3 (Sankhya facts) and §6 (capability matrix) are normative for this plan.

## Global Constraints

- **No AI attribution anywhere.** No co-author trailers, generator notices or AI tool or vendor names in code, docs or commits. Use the existing git identity only. Commit messages follow Conventional Commits.
- **Generic public core.** No real company, person, CNPJ, IP, private hostname or domain, or real Sankhya ID in the repo. Examples use `example.com` / `.example` and fictitious data.
- **No secrets in the repo.** Never commit `.env*` (except `.env.example` with placeholders), `*.pem`, `*.key`, `*.p12`, `*.pfx`, dumps, logs or cookies. Production refuses to start with missing, placeholder or weak secrets.
- **Secrets stay server-side.** `client_secret`, `X-Token` and access tokens never reach the frontend, logs or audit. Redact these keys: `authorization`, `bearer`, `client_secret`, `x-token`, `password`, `cookie`, `session`, `access_token`, `refresh_token`.
- **Every mutation goes through `PolicyEngine.evaluate`.** No admin bypass. The ADMIN role never grants native ERP DDL.
- **No `startsWith` classification.** Never classify SQL by prefix. Unparseable input is refused (fail closed).
- **Safe defaults:**
  - `SAFE_MODE=true`
  - `WRITE_TO_SANKHYA=false`
  - `GLOBAL_WRITE_ENABLED=false`
  - plan TTL 300 s
  - `UPDATE`/`DELETE` without `WHERE` blocked for everyone, unless an explicit policy override plus strong confirmation
- **Lifecycle order is fixed:** PARSE→VALIDATE→AUTHORIZE→PLAN→PREVIEW→IMPACT→CONFIRM→RE-AUTHORIZE→EXECUTE→VERIFY→AUDIT. Nothing executes on the first submit.
- **Honest labels.** Preview labels are exactly `SIMULATED_PREVIEW`, `TRANSACTIONAL_DRY_RUN` and `IMPACT_ANALYSIS`. Verification values are `VERIFIED`, `PARTIALLY_VERIFIED`, `UNVERIFIED` and `FAILED`. Capability values are `SUPPORTED`, `SUPPORTED_VIA_GENERATED_ARTIFACT`, `SCRATCH_ONLY` and `UNSUPPORTED`. Environments are `PRODUCTION`, `HOMOLOGATION` and `SANDBOX`, always shown as text.
- **Dependencies.** No new runtime dependency without a license and supply-chain check. Pin exact versions, as the repo already does.
- **Green after every task.** `pnpm lint && pnpm typecheck && pnpm test` passes after each task. Run `pnpm test:e2e` at the end of every stage that touches UI or HTTP flows.
- **Git safety.**
  - Never push to or alter `dbexplorer-omie`.
  - Never `git push --force` to `db-sankhya`; the owner's baseline on `origin/main` is preserved, and our work lands as fast-forward commits on top of it.
  - Nothing is pushed before Stage 18.

## Review Focus

1. **Comments and string literals hiding keywords.** `SELECT 'DELETE' FROM T` must pass. `SELECT 1 /*x*/ FROM T` and `SELECT 1 -- x` must be refused (comments are refused). `SELECT "INTO" FROM T` with a quoted identifier must pass. Tests are added in Task 4.1.
2. **Token expiry during a long read.** A gateway `GTW3403` mid-session triggers exactly one re-authentication and one retry for reads, and **zero** retries for `DatasetSP.save`. Tests are added in Task 2.3.
3. **Plan replay after a permission change.** A user loses `DATA.UPDATE` between preview and confirm, so confirm must return `FORBIDDEN` and audit a denied event. Tests are added in Task 11.2.
4. **Concurrent change between preview and execute.** The target row changes after preview, so execution returns `TARGETS_CHANGED` and nothing is written. Tests are added in Task 11.2.
5. **Scratch memory exhaustion.** `INSERT INTO t SELECT … FROM generate_series(1, 1e9)` stops at the row quota or statement timeout, and the server stays healthy. Tests are added in Task 6.2.

---

## Stage 0 — Repository reset onto the db-sankhya baseline (no code change)

The remote `db-sankhya` already has a baseline on `origin/main`: 11 commits by the owner. They add README, .gitignore, .env.example, SECURITY.md, CONTRIBUTING.md, .editorconfig, .gitattributes, `.github/CODEOWNERS`, the issue and PR templates. That baseline is **preserved and built upon, never overwritten**. The inherited Omie `.git` is never pushed or modified.

### Task 0.1: Detach from the Omie history and attach to origin/main

**Files:** none in the tree, other than the merged baseline files in Task 0.2.

- [ ] **Step 1:** Verify `git status` shows only the two `docs/migration-*.md` files as untracked and that `git remote -v` shows `dbexplorer-omie`.
- [ ] **Step 2:** Move `.git` to `../dbexplorer-omie-git-backup-<YYYYMMDD>` (a move, not a delete). Verify with `git --git-dir=<backup> rev-list --all --count` → `31`.
- [ ] **Step 3:** Run these commands:
  - `git init -b main`
  - `git remote add origin https://github.com/Gustavo-Ale07/db-sankhya.git`
  - `git fetch origin`
  - `git reset origin/main`, a mixed reset that points `main` at the baseline and leaves the working tree untouched.
  - `git switch -c migration`

  Confirm that `git config user.name` / `user.email` are unchanged.

- [ ] **Step 4:** Run `git status`. Files that exist only in the baseline (CONTRIBUTING.md, templates) show as deleted. Restore them with `git checkout origin/main -- <those paths>`.

### Task 0.2: Merge the colliding baseline files

Start from the baseline's version and expand it. Never drop a baseline protection.

| File                              | Merge                                                                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.gitignore`                      | Baseline + local extras: `credentials.*`, `blob-report/`, `.vitest/`, `data/`, `.pglite/`.                                                                  |
| `.editorconfig`, `.gitattributes` | Baseline. Add a local rule only if one differs and is needed.                                                                                               |
| `.github/CODEOWNERS`              | Baseline (identical owner).                                                                                                                                 |
| `README.md`, `SECURITY.md`        | Baseline text verbatim for now; expanded in Stage 18. The Omie README/SECURITY are discarded.                                                               |
| `.env.example`                    | Baseline keys and order kept. Keys the app needs are appended until Task 3.1 reconciles names. The Omie/AI keys stay only until Stages 1 and 5 remove them. |

- [ ] **Step 1:** Apply the merges.
  - Run `git ls-files -ci --exclude-standard`. Expect empty: no tracked file is hidden by the new ignores.
  - Run `git status --ignored` and confirm that no `.env` or secrets are staged.
- [ ] **Step 2:** Run the attribution grep and a secret grep over the tree.
- [ ] **Step 3:** Run `pnpm lint && pnpm typecheck && pnpm test`. Expect PASS.
- [ ] **Step 4:** Commit on `migration` as `chore: import application foundation from predecessor project`.

**History hygiene:** commits on `migration` before Stage 5 still contain Omie code. They are never pushed. After Stage 5 (no Omie residue left), the steps below collapse them **locally** into one commit on top of `origin/main`, so the public history is the owner's baseline plus sanitized commits only:

1. Tag the backup with `git branch backup/pre-squash`.
2. Run `git reset --soft origin/main`.
3. Commit as `feat: Sankhya gateway foundation`.

Later stages keep granular commits.

## Stage 1 — Foundation cleanup

### Task 1.1: Remove the AI assistant and the API inspector

**Files:**

- Delete:
  - `apps/api/src/routes/ai.ts`, `apps/api/src/ai/**`
  - `apps/web/src/explorer/AiPanel.tsx`, `apps/web/src/pages/InspectorPage.tsx`
  - `docs/adr/0007-ai-suggests-only.md` (move it to a "superseded" note in `docs/adr/README.md`)
- Modify:
  - `apps/api/src/app.ts`: drop the AI and inspector route registration.
  - `apps/api/src/routes/system.ts`: drop the inspector endpoints.
  - `apps/api/src/config.ts`: drop `AI_*` and the provider key settings.
  - `.env.example`
  - `apps/web/src/components/Layout.tsx`, `ExplorerPage.tsx`: remove the AI panel and the inspector view. The `ResultsPanel.tsx` Request/Response tabs render the Omie call trace, so they go with that trace model in Stage 5.
  - `apps/api/src/logger.ts`, `packages/shared/src/redact.test.ts`: remove provider-specific entries.
  - `e2e/tests/explorer.spec.ts`: drop the AI step.
- Test: `apps/api/src/app.int.test.ts`, `apps/api/src/config.test.ts`

- [ ] **Step 1:** Change the integration tests.
  - `POST /api/ai/generate` → expect 404 JSON. `GET /api/inspector/calls` → expect 404.
  - Delete the tests that assert AI behaviour.
  - In `config.test.ts`, assert that `loadConfig({ AI_PROVIDER: 'openai' })` ignores the unknown key. It must not throw: the env schema is non-strict, so verify this before changing anything.
- [ ] **Step 2:** Run `pnpm vitest run --project integration -t "ai|inspector"`. Expect FAIL, because the routes still exist.
- [ ] **Step 3:** Delete and modify the files listed above.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test`. Expect PASS.
- [ ] **Step 5:** Commit: `refactor: remove AI assistant and raw API inspector`.

### Task 1.2: Neutral naming and product identity

**Files:**

- Modify:
  - Root `package.json`: name `db-sankhya` and description.
  - `apps/web/index.html`: title "DB-Sankhya".
  - `components/Footer.tsx`: independence notice, see the copy below.
  - `Layout.tsx`: brand.
  - `routes/system.ts`: `/api/meta` returns `{ name: 'DB-Sankhya', … }`.
  - `server.ts`: startup log "DB-Sankhya API started".
  - `compose.yaml`: project and image name `db-sankhya`.
  - `Dockerfile`: comments only.
  - `.github/workflows/ci.yml`: image tag `db-sankhya:latest` (compose runs it with `--no-build`).
- Test: `app.int.test.ts` meta test.

Exact copy for the footer, in Portuguese since the UI is pt-BR:

> "DB-Sankhya é uma ferramenta independente, sem afiliação com a Sankhya Gestão de Negócios."

- [ ] **Step 1:** Change the meta test so it expects `name === 'DB-Sankhya'`.
- [ ] **Step 2:** Run it and confirm it fails.
- [ ] **Step 3:** Apply the renames. Do not touch the Omie engine yet.
- [ ] **Step 4:** Run the full suite and the e2e suite. Expect PASS.
- [ ] **Step 5:** Commit: `chore: rename product to DB-Sankhya`.

### Task 1.3: Extend redaction

**Files:** `packages/shared/src/redact.ts`, `redact.test.ts`, `apps/api/src/logger.ts`

- [ ] **Step 1:** Write the test `redacts sankhya credential keys`.
  - Input: `{ client_secret: 'a', 'X-Token': 'b', access_token: 'c', refresh_token: 'd', nested: { Authorization: 'Bearer e' } }`.
  - Every value must become the shared `REDACTED` marker (`***REDACTED***`).
  - The string `"Bearer eyJabc.def.ghi"` inside free text must become `"Bearer ***REDACTED***"`. Bare JWTs are scrubbed too; prose such as "the bearer of" is kept.
- [ ] **Step 2:** Run it and confirm it fails.
- [ ] **Step 3:** Implement.
  - Add `clientsecret`, `xtoken`, `accesstoken`, `refreshtoken` and `bearer` to `SENSITIVE_EXACT` (keys are normalised by removing `-` and `_` and lowercasing).
  - Add value patterns for `Bearer <credential>` (case-insensitive) and compact JWTs, applied by both `redact` and `createRedactor`.
  - Add the pino redact paths `req.headers["x-token"]` and `*.client_secret`.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(shared): redact Sankhya gateway credentials`.

## Stage 2 — Generic integration layer and Sankhya client

New package `packages/sankhya-client` (`@dbx/sankhya-client`). It depends only on `@dbx/shared`.

Move `limiter.ts` (and its test) here from `omie-client`. Keep `omie-client` re-exporting it until Stage 5.

### Task 2.1: Circuit breaker

**Files:** Create `packages/sankhya-client/src/circuit.ts` and `circuit.test.ts`.

**Interfaces:**

- Produces `class CircuitBreaker`.
  - Constructor: `new CircuitBreaker(opts: { failureThreshold: number; resetAfterMs: number; now?: () => number })`.
  - `state(): 'CLOSED' | 'OPEN' | 'HALF_OPEN'`
  - `run<T>(fn: () => Promise<T>, isFailure?: (e: unknown) => boolean): Promise<T>`
  - When OPEN, `run` throws `AppError('SANKHYA_UNAVAILABLE')`.

- [ ] **Step 1: Tests**
  - `opens after N consecutive failures`: threshold 3, three rejects, then `state() === 'OPEN'` and the fourth call rejects with code `SANKHYA_UNAVAILABLE` without calling `fn`.
  - `half-opens after resetAfterMs and closes on success`.
  - `re-opens on failure while half-open`.
  - `business errors do not count`: `isFailure` returns false, so the state stays CLOSED.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement. In HALF_OPEN, exactly one trial call is allowed; concurrent callers get `SANKHYA_UNAVAILABLE`.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(sankhya-client): add circuit breaker`.

### Task 2.2: OAuth2 token provider

**Files:** Create `packages/sankhya-client/src/auth.ts` and `auth.test.ts`. Modify `packages/shared/src/errors.ts` to add the `SANKHYA_*` codes:

| Code                     | HTTP status |
| ------------------------ | ----------- |
| `SANKHYA_AUTH_ERROR`     | 502         |
| `SANKHYA_RATE_LIMITED`   | 429         |
| `SANKHYA_UNAVAILABLE`    | 503         |
| `SANKHYA_API_ERROR`      | 502         |
| `SANKHYA_BAD_RESPONSE`   | 502         |
| `SANKHYA_NOT_CONFIGURED` | 503         |
| `SANKHYA_TIMEOUT`        | 504         |
| `WRITE_OUTCOME_UNKNOWN`  | 502         |

**Interfaces:**

- Produces `createTokenProvider(opts)`.
  - Options: `{ authUrl: string; clientId: string; clientSecret: string; xToken: string; fetch: typeof fetch; timeoutMs: number; earlyRefreshSeconds?: number /* default 30 */; now?: () => number }`
  - Returns a `TokenProvider`: `{ getToken(signal?: AbortSignal): Promise<string>; invalidate(): void }`.

- [ ] **Step 1: Tests** (use a fake `fetch` that records requests)
  - `posts form-encoded client_credentials with X-Token`: method POST; content-type `application/x-www-form-urlencoded`; body parses to exactly `client_id`, `client_secret` and `grant_type=client_credentials`; header `X-Token`.
  - `caches until expires_in minus early refresh`: `expires_in: 300` with `now` advanced 269 s gives 1 fetch; advanced 271 s gives 2 fetches.
  - `single-flight`: 5 concurrent `getToken` calls give 1 fetch.
  - `invalidate forces re-auth`.
  - `401 maps to SANKHYA_AUTH_ERROR and the message contains no secret`: the error message and `JSON.stringify(err)` do not contain the clientSecret or the xToken.
  - `redirects are refused`: the fetch is called with `redirect: 'error'`.
  - `malformed body maps to SANKHYA_BAD_RESPONSE`.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement. A failed in-flight call clears the single-flight promise.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(sankhya-client): OAuth2 client_credentials token provider`.

### Task 2.3: Gateway transport, classifier and client

**Files:** Create `packages/sankhya-client/src/{types.ts,classify.ts,transport.ts,client.ts,index.ts}` with tests `classify.test.ts` and `client.test.ts`, plus `transport.int.test.ts` (a real HTTP server on 127.0.0.1).

**Interfaces:**

- `types.ts`:
  - `type GatewayModule = 'mge' | 'mgecom'`
  - `interface GatewayRequest { module: GatewayModule; serviceName: string; requestBody: unknown }`
  - `interface GatewayEnvelope { status: string; statusMessage?: string; transactionId?: string; responseBody?: unknown }`
  - `interface CallTrace { serviceName: string; module: GatewayModule; durationMs: number; attempts: number; outcome: 'ok' | 'error'; errorCode?: string }`. The trace holds no bodies.
- `classify.ts`:
  - `classifyGateway(httpStatus: number, body: unknown): { ok: true; envelope: GatewayEnvelope } | { ok: false; code: ErrorCode; retryable: boolean; reauth: boolean; message: string }`
- `transport.ts`:
  - `createGatewayTransport(opts: { baseUrl: string; tokens: TokenProvider; fetch: typeof fetch; timeoutMs: number; maxResponseBytes: number })`
  - Returns `{ send(req: GatewayRequest, signal?: AbortSignal): Promise<{ httpStatus: number; body: unknown }> }`.
- `client.ts`:
  - `class SankhyaClient`, constructed with `{ transport; tokens; breaker: CircuitBreaker; rate: CallRateLimiter; concurrency: ConcurrencyLimiter; retry: { maxRetries: number; baseMs: number }; onTrace?: (t: CallTrace) => void }`. Methods:
    - `call(req: GatewayRequest, opts: { idempotent: boolean; signal?: AbortSignal }): Promise<GatewayEnvelope>`
    - `executeQuery(sql: string, signal?: AbortSignal): Promise<{ columns: string[]; rows: unknown[][] }>`, serialised through a dedicated FIFO lane.
    - `loadRecords(input: { rootEntity: string; fields: string[]; criteria?: { expression: string; parameters: Array<{ value: string | number; type: 'I' | 'S' | 'D' | 'F' }> }; offsetPage?: number }, signal?): Promise<{ records: Record<string, unknown>[]; hasMore: boolean }>`
    - `save(input: { entityName: string; fields: string[]; records: Array<{ pk?: Record<string, unknown>; values: Record<string, unknown> }> }): Promise<{ results: unknown[][]; transactionId?: string }>`. Callers pass `values` keyed by field name; the method converts them to the index-based map.

- [ ] **Step 1: Classifier tests**
  - `status "1"` → ok.
  - HTTP 200 with `status "0"` and `statusMessage "[CORE_E01234] x"` → `SANKHYA_API_ERROR`, retryable false.
  - `GTW3403` (HTTP 403) → `SANKHYA_AUTH_ERROR`, reauth true.
  - HTTP 401 → reauth true.
  - HTTP 429 → `SANKHYA_RATE_LIMITED`, retryable.
  - HTTP 504 and 502/503 → retryable, with `SANKHYA_TIMEOUT` and `SANKHYA_UNAVAILABLE` respectively.
  - A non-JSON body → `SANKHYA_BAD_RESPONSE`.
  - A message with "Não autorizado" (accented and unaccented) → reauth true.
  - The message is redacted.
- [ ] **Step 2: Client tests**
  - `executeQuery maps fieldsMetadata/rows`.
  - `executeQuery calls are serialised`: two concurrent calls never overlap; assert this with an in-flight counter in the fake transport.
  - `reads re-auth once on reauth error`: the first response is GTW3403, so `tokens.invalidate` is called once and the second attempt succeeds.
  - `save is never retried`: a 503 on save makes the transport get called once and the error is `WRITE_OUTCOME_UNKNOWN`. A business error on save is `SANKHYA_API_ERROR`, sent once.
  - `save maps field names to index-keyed values`: fields `['A','B']` with `values {B: 2, A: 1}` give the request body `values {"0":1,"1":2}`.
  - `uses module in URL`: the URL is `/gateway/v1/mgecom/service.sbr?serviceName=CACSP.cancelarNota&outputType=json`.
  - `trace contains no bodies or tokens`.
  - `breaker opens after repeated 5xx`.
- [ ] **Step 3: Transport integration tests**
  - Bearer header present.
  - `redirect: 'error'` honoured: a 302 response rejects.
  - A response bigger than `maxResponseBytes` is aborted with `SANKHYA_BAD_RESPONSE`.
  - The timeout aborts with `SANKHYA_TIMEOUT`.
  - `Retry-After` is parsed.
- [ ] **Step 4:** Run the tests and confirm they fail.
- [ ] **Step 5:** Implement, adapting the retry and backoff code from `omie-client/client.ts`.
- [ ] **Step 6:** Run the tests. Expect PASS.
- [ ] **Step 7:** Commit: `feat(sankhya-client): gateway transport, error classifier and client`.

### Task 2.4: Mock Sankhya gateway

**Files:**

- Create in `packages/sankhya-client/src/mock/`:
  - `dataset.ts`: fictitious seeded rows for `TGFPAR`, `TGFPRO`, `TGFCAB`, `TGFITE`, `TSICID`, `TGFEST`, `AD_EXEMPLO`, plus dictionary tables `TDDTAB`, `TDDCAM`, `TDDINS` describing them.
  - `server.ts`
  - `mock.test.ts`
- Move `random.ts` here and rename `omieDate` to `fakeDate`.

**Interfaces:**

- Produces `createMockSankhya(opts?: { seed?: number; clientId?: string; clientSecret?: string; xToken?: string; tokenTtlSeconds?: number; faults?: MockFaults })`.
- Returns `{ fetch: typeof fetch; db: PGlite; close(): Promise<void>; calls: Array<{ serviceName: string }> }`.
- The mock implements over PGlite:
  - `POST /authenticate`
  - `DbExplorerSP.executeQuery`: **SELECT only**. It applies the same token gate as Task 4.1 so the mock never becomes a write path.
  - `CRUDServiceProvider.loadRecords`
  - `DatasetSP.save` (insert and update by pk)
  - `CACSP.cancelarNota` (stub that sets a flag)
- Wrong-module calls return an error envelope.
- Default credentials are the literal placeholders `mock-client-id` / `mock-client-secret` / `mock-x-token`.
- Fictitious data rules: company names from word lists; e-mails `@demo.example`; `fakeCnpj` with invalid check digits.

- [ ] **Step 1: Tests**
  - Authentication with wrong credentials → 401.
  - executeQuery returns `fieldsMetadata` and `rows` for `SELECT CODPARC, NOMEPARC FROM TGFPAR ORDER BY CODPARC`.
  - executeQuery with `DELETE FROM TGFPAR` → error envelope, row count unchanged.
  - Insert via save returns the generated pk.
  - Update via save changes exactly that row.
  - A MGECOM service called through `mge` → error.
  - The expired-token fault → HTTP 403 with `GTW3403`.
  - The dataset contains no `@` address outside `.example`.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(sankhya-client): fictitious mock Sankhya gateway`.

## Stage 3 — Configuration, connections and secrets at rest

### Task 3.1: Config for the new runtime

**Files:** `apps/api/src/config.ts`, `config.test.ts`, `.env.example`

New variables:

The names follow the owner's baseline `.env.example`:

| Variable                                                                            | Rule                                                                                                                                            |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`                                                                           | `development`/`production`. Production strictness applies if `APP_ENV` **or** `NODE_ENV` is `production`.                                       |
| `AUTH_SECRET`                                                                       | Replaces `SESSION_SECRET`.                                                                                                                      |
| `ENCRYPTION_KEY`                                                                    | Replaces the "master key": base64 of 32 bytes.                                                                                                  |
| `REDIS_URL`                                                                         | Kept in `.env.example` but documented as reserved and unused by the current version; the config ignores it.                                     |
| `SANKHYA_BASE_URL`, `SANKHYA_CLIENT_ID`, `SANKHYA_CLIENT_SECRET`, `SANKHYA_X_TOKEN` | Optional. When all are set, they define an **env-sourced connection**: secrets live only in env and are never written to the DB (see Task 3.3). |

The variables in the table below are new. In it, read `MASTER_KEY` as `ENCRYPTION_KEY`.

| Variable                       | Default / format                                                |
| ------------------------------ | --------------------------------------------------------------- |
| `SANKHYA_MODE`                 | `mock` or `live`; default `mock` in dev, required in production |
| `SAFE_MODE`                    | `true`                                                          |
| `WRITE_TO_SANKHYA`             | `false`                                                         |
| `GLOBAL_WRITE_ENABLED`         | `false`                                                         |
| `MASTER_KEY`                   | base64 of 32 bytes                                              |
| `PLAN_TTL_SECONDS`             | `300`                                                           |
| `SANKHYA_ALLOWED_HOSTS`        | `api.sankhya.com.br,api.sandbox.sankhya.com.br`                 |
| `SANKHYA_TIMEOUT_MS`           | `60000`                                                         |
| `SANKHYA_RATE_PER_MINUTE`      | `300`, capped at 1000                                           |
| `SCRATCH_MAX_WORKSPACES`       | `20`                                                            |
| `SCRATCH_MAX_ROWS`             | `100000`                                                        |
| `SCRATCH_MAX_TABLES`           | `20`                                                            |
| `SCRATCH_TTL_MINUTES`          | `60`                                                            |
| `SCRATCH_STATEMENT_TIMEOUT_MS` | `10000`                                                         |
| `MATERIALIZE_MAX_ROWS`         | `5000`                                                          |
| `CUSTOM_TABLE_PREFIXES`        | `AD_`                                                           |
| `BOOTSTRAP_TOKEN_TTL_MINUTES`  | `30`                                                            |

Remove all `OMIE_*` variables in Stage 5, not here.

- [ ] **Step 1: Tests**
  - Defaults are as in the table.
  - Production rejects a missing `MASTER_KEY`, `MASTER_KEY` equal to the `.env.example` placeholder, a key that does not decode to 32 bytes, and `SANKHYA_MODE=mock` while `DEMO_MODE` is not `true`.
  - `SANKHYA_RATE_PER_MINUTE=5000` is rejected.
  - `secretValues()` includes the master key.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement. Also add `DEMO_MODE` (default `false`), which forces mock mode and shows a DEMO banner.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(api): configuration for Sankhya runtime and safe defaults`.

### Task 3.2: Secret box and SSRF guard

**Files:**

- `apps/api/src/security/secretbox.ts` + test
- `apps/api/src/security/ssrf.ts` + test

**Interfaces:**

- `encryptSecret(key: Buffer, plaintext: string, aad: string): string` and `decryptSecret(key: Buffer, sealed: string, aad: string): string`.
  - AES-256-GCM with a 12-byte random IV.
  - Output format `v1.<iv b64url>.<tag b64url>.<ct b64url>`.
  - `aad = connectionId + ':' + fieldName`.
- `assertSafeGatewayUrl(url: string, opts: { allowHosts: string[]; resolve: (host: string) => Promise<string[]> }): Promise<URL>`
  - Rejects with `VALIDATION_ERROR` when: the scheme is not https; credentials are in the URL; a port other than 443 is used; the host is not in `allowHosts` (exact, case-insensitive); or any resolved address is loopback, private, link-local, CGNAT, ULA or unspecified.

- [ ] **Step 1: Tests**
  - Round trip works.
  - A tampered tag throws.
  - A wrong AAD throws.
  - Two encryptions of the same plaintext differ.
  - SSRF rejects `http://api.sankhya.com.br`, `https://user:pw@api.sankhya.com.br`, `https://api.sankhya.com.br:8443`, `https://evil.example`, and an allowed host resolving to `127.0.0.1`, `10.0.0.5`, `169.254.169.254` or `::1`.
  - SSRF accepts an allowed host resolving to `203.0.113.10`, a documentation address used here as a "public" address in the stub resolver.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement with `node:crypto` and `node:net` `BlockList`.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(api): secret encryption at rest and gateway SSRF guard`.

### Task 3.3: Connections and environments

**Files:**

- `packages/database/src/schema.ts`
- migration `0001_connections.sql` (generated with `pnpm db:generate`, then reviewed)
- `apps/api/src/services/connections.ts` + `connections.int.test.ts`
- `apps/api/src/services/sankhya-runtime.ts`

**Table `connections`:**

- `id` uuid pk
- `name` unique
- `environment` text with check `PRODUCTION`/`HOMOLOGATION`/`SANDBOX`
- `mode` with check `live`/`mock`
- `base_url`
- `dialect` with check `oracle`/`mssql`
- `client_id_enc`, `client_secret_enc`, `x_token_enc`
- `secrets_rotated_at`
- `enabled` boolean, default true
- `created_at`, `updated_at`

**Interfaces:**

- `ConnectionsService`:
  - `list(): Promise<ConnectionPublic[]>`, where `ConnectionPublic` = `{ id, name, environment, mode, baseUrl, dialect, enabled, secrets: { clientId: string /* masked "abcd…wxyz" */; clientSecret: 'SET' | 'NOT_SET'; xToken: 'SET' | 'NOT_SET' }; secretsRotatedAt }`
  - `create(input)`
  - `update(id, patch)`
  - `rotateSecrets(id, secrets)`
  - `test(id): Promise<{ ok: boolean; latencyMs: number; errorCode?: string }>`
  - `getRuntime(id): Promise<SankhyaRuntime>`
- `sankhya-runtime.ts`: `createSankhyaRuntime(conn: DecryptedConnection, cfg: Config): SankhyaRuntime`, where `SankhyaRuntime = { client: SankhyaClient; connectionId: string; environment: Environment; dialect: 'oracle' | 'mssql'; close(): void }`. Runtimes are cached per connection id and dropped on update or rotation.

**Env-sourced connection:** with `SANKHYA_BASE_URL` and its credentials set, `ConnectionsService` exposes a read-only connection `env-default`. Its environment comes from `SANKHYA_ENVIRONMENT`, default `PRODUCTION` (the most restrictive). Its secrets come from env and are never persisted. Admin endpoints cannot edit it, only test it.

- [ ] **Step 1: Tests**
  - The env connection is listed with masked secrets and the DB holds no row with its secrets.
  - Creating a connection stores ciphertext: a raw select shows no plaintext secret.
  - `list()` never returns secret values; `JSON.stringify` contains neither the secret nor the X-Token.
  - Rotation invalidates the cached runtime: it is a new object.
  - `create` with a non-allowlisted base URL → `VALIDATION_ERROR` (mock mode skips DNS but still requires an allowlisted host or the literal `mock://local`).
  - `test()` against the mock returns ok.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(api): encrypted multi-connection store with environments`.

## Stage 4 — SQL analysis for Sankhya reads

### Task 4.1: Token gate

**Files:** `packages/sql-engine/src/gate.ts` + `gate.test.ts`

**Interfaces:**

- `tokenGate(sql: string): { ok: true } | { ok: false; code: 'SQL_FORBIDDEN'; reason: string }`
- It reuses `tokenizer.ts` and extends it with:
  - `--` and `/* */` comment tokens;
  - `[bracket]` and `"double"` quoted identifiers;
  - N'' strings.

- [ ] **Step 1: Tests**
  - **Allowed:**
    - `SELECT 'DELETE' FROM TGFPAR`
    - `SELECT "INTO" FROM TGFPAR`
    - `WITH x AS (SELECT 1 A FROM DUAL) SELECT * FROM x`
  - **Refused:**
    - `SELECT 1 FROM DUAL; SELECT 2 FROM DUAL`
    - comments in either form
    - `SELECT * INTO T2 FROM T`
    - `SELECT * FROM T FOR UPDATE`
    - `SELECT * FROM T@lnk`
    - `SELECT S.NEXTVAL FROM DUAL`
    - `SELECT DBMS_RANDOM.VALUE FROM DUAL`
    - `SELECT * FROM OPENQUERY(x,'y')`
    - `EXEC sp_who`
    - `BEGIN NULL; END`
    - `MERGE INTO …`
    - `WAITFOR DELAY '0:0:5'`
    - an unterminated string
  - **Case variants:** `select * InTo …` is refused.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement. Keywords are matched only on bare word tokens; quoted identifiers and strings are skipped. Deny list (from audit §3.4):

```ts
const DENY_WORDS = new Set([
  'INTO',
  'UPDATE',
  'DELETE',
  'INSERT',
  'MERGE',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'EXEC',
  'EXECUTE',
  'CALL',
  'BEGIN',
  'DECLARE',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'LOCK',
  'WAITFOR',
  'OPENROWSET',
  'OPENQUERY',
  'OPENDATASOURCE',
  'NEXTVAL',
  'CURRVAL',
  'SHUTDOWN',
  'KILL',
  'BACKUP',
  'RESTORE',
  'DBCC',
  'RECONFIGURE',
  'USE',
  'SET',
]);
const DENY_PREFIXES = ['DBMS_', 'UTL_', 'XP_', 'SP_', 'SYS.', 'OWA_', 'CTX_'];
```

`FOR UPDATE` is caught because `UPDATE` is denied. `@` outside strings and quotes is refused. `SET` is denied: it is not valid in SELECT, and `UPDATE … SET` is already refused through `UPDATE`.

- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(sql-engine): fail-closed token gate for Sankhya reads`.

### Task 4.2: Read analyzer (AST allowlist)

**Files:** `packages/sql-engine/src/read-analyzer.ts` + test, `packages/sql-engine/src/functions.ts`

**Interfaces:**

- `analyzeRead(sql: string): ReadAnalysis`. It throws `AppError` `SQL_PARSE_ERROR` or `SQL_UNSUPPORTED`.
- `interface ReadAnalysis { tables: Array<{ name: string; alias?: string }>; columns: Array<{ table?: string; name: string }>; star: Array<{ table?: string }>; functions: string[]; ctes: string[] }`
- `ALLOWED_FUNCTIONS: ReadonlySet<string>` in `functions.ts`: aggregates (`COUNT`, `SUM`, `AVG`, `MIN`, `MAX`), `COALESCE`, `NVL`, `ISNULL`, `NULLIF`, `UPPER`, `LOWER`, `TRIM`, `LTRIM`, `RTRIM`, `SUBSTR`, `SUBSTRING`, `LENGTH`, `LEN`, `REPLACE`, `CONCAT`, `ROUND`, `TRUNC`, `FLOOR`, `CEIL`, `CEILING`, `ABS`, `MOD`, `CAST`, `CONVERT`, `TO_CHAR`, `TO_DATE`, `TO_NUMBER`, `SYSDATE`, `GETDATE`, `CURRENT_DATE`, `CURRENT_TIMESTAMP`, `EXTRACT`, `DATEADD`, `DATEDIFF`, `ADD_MONTHS`, `MONTHS_BETWEEN`, `LPAD`, `RPAD`, `DECODE`, `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `YEAR`, `MONTH`, `DAY`.

- [ ] **Step 1: Tests**
  - CTE plus subquery plus join plus CASE are parsed. The tables are `TGFPAR` and `TSICID`; the CTE name is excluded from `tables`.
  - A function not on the allowlist (`MY_PKG_FN(1)`) → `SQL_UNSUPPORTED` with the function name in the message.
  - A non-select AST (should the gate be bypassed) → `SQL_UNSUPPORTED`.
  - `UNION` is allowed and both sides' tables are collected.
  - Unparseable input → `SQL_PARSE_ERROR`.
  - Columns are collected from WHERE, ORDER BY, GROUP BY and HAVING.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement. Parse with `new Parser().astify(sql, { database: 'transactsql' })`, then do a recursive walk with an explicit node-type allowlist. Unknown node types → `SQL_UNSUPPORTED`.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(sql-engine): AST allowlist analyzer for Sankhya reads`.

### Task 4.3: Statement classifier and write AST

**Files:** `packages/sql-engine/src/classify.ts` + test

**Interfaces:**

- `classifyStatement(sql: string): Classified`, where `Classified` is one of:
  - `{ kind: 'SELECT' }`
  - `{ kind: 'INSERT' | 'UPDATE' | 'DELETE'; stmt: InsertStatement | UpdateStatement | DeleteStatement }`, reusing `ast.ts` through the existing parser conversion with a PostgreSQL grammar profile
  - `{ kind: 'CREATE_TABLE' | 'ALTER_TABLE' | 'DROP_TABLE'; table: string; temporary: boolean; ast: unknown }`
  - `{ kind: 'UNKNOWN'; reason: string }`
- It is AST-based. Multi-statement input → `UNKNOWN`.

- [ ] **Step 1: Tests**
  - `' DELETE FROM T WHERE A=1'` with leading whitespace and lower case → `DELETE`.
  - `/* x */ UPDATE T SET A=1 WHERE B=2` → UPDATE. Comments are allowed here because write SQL never reaches Sankhya as text.
  - `CREATE TEMPORARY TABLE tmp_x (a int)` → `CREATE_TABLE` with temporary true.
  - `CREATE TABLE AD_X (A INT)` → temporary false.
  - `DELETE FROM T; DROP TABLE T` → UNKNOWN.
  - `GRANT …` → UNKNOWN.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(sql-engine): AST-based statement classifier`.

## Stage 5 — Metadata and Sankhya read path (replaces Omie)

### Task 5.1: Metadata service

**Files:**

- `apps/api/src/services/metadata.ts` + `metadata.int.test.ts`
- schema: table `metadata_cache` (`connection_id`, `payload` jsonb, `fetched_at`)

**Interfaces:**

- `MetadataService`:
  - `get(connectionId: string, opts?: { refresh?: boolean }): Promise<Catalog>`
  - `Catalog = { tables: Array<{ name: string; description?: string; entityName?: string; columns: Array<{ name: string; type: string; description?: string; nullable?: boolean; pk: boolean }>; foreignKeys: Array<{ column: string; refTable: string; refColumn: string }> }>; fetchedAt: string; source: 'dictionary' }`
- Discovery reads, through `executeQuery`:
  - `SELECT NOMETAB, DESCRTAB FROM TDDTAB`
  - `SELECT NOMETAB, NOMECAMPO, DESCRCAMPO, TIPCAMPO FROM TDDCAM`
  - `SELECT NOMETAB, NOMEINSTANCIA FROM TDDINS`
- Unknown or missing columns degrade gracefully. The tables query failing → `SANKHYA_API_ERROR`. The fields query failing → tables with an empty column list. TTL is 1 h.

- [ ] **Step 1: Tests** (against the mock)
  - The catalog contains `TGFPAR` with `CODPARC` marked pk.
  - A second `get` within the TTL makes no gateway call.
  - `refresh: true` re-fetches.
  - A mock fault on the `TDDCAM` query → tables with no columns.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement. PK comes from the dictionary when available, otherwise from mock-provided `TDDCAM` flags. FK only when discovered.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(api): Sankhya data dictionary discovery and cache`.

### Task 5.2: Read executor and the new `/api/query` read path

**Files:**

- `apps/api/src/services/read-executor.ts` + test
- `apps/api/src/routes/query.ts`
- `apps/api/src/routes/system.ts`: `/api/schema?connectionId=`
- `apps/api/src/app.int.test.ts`

**Interfaces:**

- `executeRead(input: { runtime: SankhyaRuntime; catalog: Catalog; sql: string; maxRows: number; signal: AbortSignal; decide: (a: ReadAnalysis) => PolicyDecision }): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean; durationMs: number }>`
- Order: `tokenGate`, then `analyzeRead`, then resolve every table against the catalog (unknown table → `RESOURCE_NOT_FOUND`), then `decide`, then the row-cap wrapper, then `client.executeQuery`.
- Row-cap wrapper:
  - Oracle: `SELECT * FROM (<sql>) WHERE ROWNUM <= :n+1`
  - MSSQL: `SELECT TOP (<n+1>) * FROM (<sql>) AS dbx_q`. This is only applied when the outer query has no ORDER BY, because MSSQL forbids ORDER BY in a derived table without TOP. Otherwise the cap is client-side truncation and `truncated` is computed from `rows.length > n`.
- `POST /api/query` body gains `connectionId`.

- [ ] **Step 1: Tests**
  - A SELECT through the mock returns rows.
  - A gate refusal returns `SQL_FORBIDDEN` (400) and is audited as denied.
  - An unknown table → `RESOURCE_NOT_FOUND`.
  - A query returning more than `maxRows` sets `truncated: true` and returns `maxRows` rows.
  - Abort → `QUERY_CANCELLED`.
  - The response never contains a token. The history row contains the SQL but not the results.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement. Until Stage 9, the `decide` callback is `() => ({ effect: 'ALLOW', … })` from the RBAC map.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(api): Sankhya read path via executeQuery`.

### Task 5.3: Delete the Omie stack

**Files:**

- Delete: `packages/omie-client`, `packages/sql-engine/src/{planner.ts,registry/resources.ts,registry/types.ts}`, the Omie parts of `engine.ts` and `executor.ts` (keep the extracted local evaluator, see the next bullet), `apps/api/src/services/omie.ts`, `docs/omie-resources.md`, and all `OMIE_*` config, errors and UI strings.
- Move: `executor.ts` steps 3–8 go to `packages/sql-engine/src/local/evaluate.ts`, exported as `evaluateSelect(stmt: SelectStatement, sources: Record<string, LocalSource>, limits): QueryResult`. Keep the existing executor semantic tests by retargeting them to `evaluateSelect`.
- Migration: `0004_drop_omie_calls.sql` replaces the `audit_events.omie_calls` column with `gateway_calls` jsonb.
- Tests: delete the Omie-only tests and keep the semantic ones.

- [ ] **Step 1:** `rg -i omie --glob '!docs/migration-*' --glob '!pnpm-lock.yaml'` lists the residue.
- [ ] **Step 2:** Delete and move the files. Run `pnpm install` to drop the workspace package from the lockfile.
- [ ] **Step 3:** Run the full suite. Expect PASS. Then run `rg -i omie` with the same globs; expect no hits.
- [ ] **Step 4:** Commit: `refactor!: remove Omie integration`.

## Stage 6 — Scratch engine

### Task 6.1: Workspace manager

**Files:** `apps/api/src/services/scratch.ts` + `scratch.int.test.ts`

**Interfaces:**

- `ScratchManager`:
  - `constructor(opts: { maxWorkspaces: number; maxRows: number; maxTables: number; ttlMinutes: number; statementTimeoutMs: number; now?: () => number })`
  - `workspace(userId: string): Promise<ScratchWorkspace>`
  - `evictIdle(): Promise<number>`
  - `closeAll(): Promise<void>`
  - `stats(): { workspaces: number }`
- `ScratchWorkspace`:
  - `exec(sql: string, signal?: AbortSignal): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number; command: string }>`
  - `tables(): Promise<Array<{ name: string; rows: number }>>`
  - `importRows(table: string, columns: Array<{ name: string; type: 'text' | 'numeric' | 'timestamp' | 'boolean' }>, rows: unknown[][]): Promise<void>`
  - `transactionalDryRun(sql: string): Promise<{ before: …; after: …; rowCount: number }>`. It runs `BEGIN`, executes, captures the diff, then `ROLLBACK`.
- Each workspace is its own in-memory `PGlite`.
- Allowed scratch statements (classified by Task 4.3 with the PostgreSQL profile): SELECT, INSERT, UPDATE, DELETE, `CREATE TEMP|TABLE`, `ALTER TABLE`, `DROP TABLE`, all on tables named `tmp_*`.
- Function calls from a deny list are refused: `pg_*`, `dblink*`, `lo_*`, `copy`, `set_config`, `current_setting`. `COPY`, `DO`, `CREATE FUNCTION`, `CREATE EXTENSION` and `LISTEN`/`NOTIFY` are refused.

- [ ] **Step 1: Tests**
  - Two users' workspaces are isolated: user B cannot see A's `tmp_a`.
  - A table name without the `tmp_` prefix → `VALIDATION_ERROR`.
  - The quota on tables is enforced.
  - The idle workspace is evicted after the TTL with fake time.
  - `maxWorkspaces` reached → `RATE_LIMITED`.
  - `COPY` and `CREATE FUNCTION` are refused.
  - The transactional dry run leaves the data unchanged.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(api): isolated per-user scratch workspaces`.

### Task 6.2: Quotas, DoS limits and materialization

**Files:** `scratch.ts`, `scratch.int.test.ts`, `apps/api/src/services/materialize.ts` + test

**Interfaces:**

- `materialize(input: { runtime: SankhyaRuntime; workspace: ScratchWorkspace; sql: string; into: string /* tmp_* */; maxRows: number; decide; catalog; signal }): Promise<{ table: string; rows: number; truncated: boolean }>`. It goes through `executeRead`, then `importRows`.

- [ ] **Step 1: Tests**
  - Review Focus #5: `INSERT INTO tmp_a SELECT g FROM generate_series(1, 1000000000) g` fails with `QUERY_LIMIT_EXCEEDED` or `QUERY_TIMEOUT` within the statement timeout plus 2 s, and the workspace still answers `SELECT 1` afterwards.
  - The row quota is checked after each mutating statement (`SCRATCH_MAX_ROWS` exceeded → the statement is rolled back and `QUERY_LIMIT_EXCEEDED` returned).
  - Materializing `TGFPAR` produces `tmp_par` with rows.
  - Materialization above `MATERIALIZE_MAX_ROWS` → truncated is reported.
  - A hybrid join `SELECT … FROM tmp_par p JOIN tmp_x x ON …` works.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement. Every mutating statement runs inside an explicit transaction with `SET LOCAL statement_timeout` and a row-count check before commit. If PGlite ignores `statement_timeout`, enforce it with `Promise.race`, then close and recreate the workspace and report `QUERY_TIMEOUT`.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(api): scratch quotas and Sankhya materialization`.

## Stage 7 — Authentication hardening

### Task 7.1: Bootstrap without default passwords

**Files:**

- `apps/api/src/cli/admin.ts`: subcommands `bootstrap --email <e>` and `reset-password --email <e>`. Each prints a one-time password and sets `mustChangePassword`.
- `apps/api/package.json`: script `admin`.
- `apps/api/src/services/bootstrap.ts`: one-time bootstrap token.
- `routes/auth.ts`: `POST /api/auth/bootstrap`.
- Tests.

**Behaviour:**

- On boot, with an empty `users` table and no `BOOTSTRAP_ADMIN_EMAIL`, generate a 32-byte token. Store its sha256 with an expiry. Log it **once** at warn level as `bootstrap token: <token>` (marked as a one-time secret).
- `POST /api/auth/bootstrap { token, email, password }` creates the first admin, then deletes the token.
- Remove `BOOTSTRAP_ADMIN_PASSWORD`. Keep `BOOTSTRAP_ADMIN_EMAIL` for the CLI path only.

- [ ] **Step 1: Tests**
  - A token is accepted once, the second use → `CONFIRMATION_USED`.
  - An expired token → 410.
  - The endpoint returns 404 once any user exists.
  - A weak password is rejected.
  - The CLI on a non-empty table without `--force-additional` refuses.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(api): one-time bootstrap token and admin CLI`.

### Task 7.2: OIDC readiness

**Files:** `apps/api/src/services/identity.ts`, `docs/security.md` (section).

**Interfaces:**

- `interface IdentityProvider { id: 'local' | string; authenticate(input: unknown): Promise<{ externalId: string; email: string } | null> }`
- The local provider wraps the existing password check. `users.identity_provider` gets default `'local'`.
- No OIDC implementation. This task only sets the extension point and documents it.

- [ ] **Step 1: Test** `local provider authenticates via existing path`.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Run the full suite. Expect PASS.
- [ ] **Step 4:** Commit: `refactor(api): identity provider abstraction for future OIDC`.

## Stage 8 — RBAC: permissions, roles, groups

### Task 8.1: Permission catalog and schema

**Files:**

- `packages/shared/src/permissions.ts` (replaces `rbac.ts`) + test
- schema: `roles`, `role_permissions`, `groups`, `group_members`, `user_roles`, `group_roles`
- migration `0003_rbac.sql`: seeds the roles VIEWER, OPERATOR and ADMIN, and maps existing `users.role` to `user_roles`

**Interfaces:**

- `PERMISSIONS = ['QUERY.SELECT','TEMP.CREATE','TEMP.WRITE','TEMP.DROP','TEMP.MATERIALIZE','DATA.INSERT','DATA.UPDATE','DATA.DELETE','DDL.CUSTOM.GENERATE','SANKHYA.BUSINESS_ACTION.EXECUTE','APPROVAL.DECIDE','AUDIT.READ','ADMIN.USERS','ADMIN.GROUPS','ADMIN.ROLES','ADMIN.POLICIES','ADMIN.CONNECTIONS','ADMIN.SECURITY'] as const`
- `type Permission = typeof PERMISSIONS[number]`
- Seeds:
  - VIEWER = `QUERY.SELECT`, `TEMP.*`
  - OPERATOR = VIEWER + `DATA.INSERT`, `DATA.UPDATE`
  - ADMIN = all `ADMIN.*` + `AUDIT.READ` + `APPROVAL.DECIDE` + `QUERY.SELECT` + `TEMP.*`. ADMIN does **not** get `DATA.*`, `DDL.*` or `SANKHYA.*` by default.
- `AuthzService.effectivePermissions(userId): Promise<Set<Permission>>` is the union over the user's roles and the roles of their groups.

- [ ] **Step 1: Tests**
  - The migration maps a legacy OPERATOR user to the OPERATOR role.
  - Effective permissions combine user and group roles.
  - ADMIN lacks `DATA.UPDATE`.
  - A disabled group grants nothing.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement. Replace `requireStatement` and `requireRole` with `requirePermission(p: Permission)` in `http.ts`.
- [ ] **Step 4:** Run the tests. Expect PASS, including the updated integration tests.
- [ ] **Step 5:** Commit: `feat: granular permissions with roles and groups`.

## Stage 9 — Policy engine

### Task 9.1: Policy model and evaluator

**Files:**

- `packages/shared/src/policy.ts`: pure evaluator + `policy.test.ts`
- schema: table `policies`
- `apps/api/src/services/policy.ts`: loads and caches policies and computes `policyVersion`

**Table `policies`:**

- `id`, `name`
- `effect` with check `ALLOW`/`DENY`
- `subject_type` with check `user`/`group`/`everyone`, plus `subject_id`
- `environments` text[] (empty = all)
- `connection_ids` uuid[]
- `actions` text[] (permissions)
- `entities` text[] (glob, `*` allowed)
- `columns` text[]
- `limits` jsonb
- `override_where_required` bool, default false
- `enabled`, `updated_at`

**Interfaces:**

- `evaluatePolicy(req: PolicyRequest, policies: PolicyRule[], permissions: Set<Permission>): PolicyDecision`
- `PolicyRequest = { userId: string; groupIds: string[]; action: Permission; environment: Environment; connectionId: string; entities: string[]; columns: Array<{ table: string; name: string }>; hasWhere: boolean }`
- `PolicyDecision = { effect: 'ALLOW' | 'DENY'; reasons: string[]; matchedRuleIds: string[]; limits: EffectiveLimits; policyVersion: string }`
- `EffectiveLimits = { maxReadRows: number; maxWriteRows: number; requireWhere: boolean; requirePreview: boolean; requireConfirmation: boolean; requireStrongConfirmation: boolean; requireApproval: boolean }`

**Rules:**

1. A missing permission → DENY ("permission missing").
2. Any matching DENY rule → DENY. **DENY wins.**
3. Write actions additionally require at least one matching ALLOW rule. Default-deny for `DATA.*`, `DDL.*` and `SANKHYA.*`. `QUERY.SELECT` and `TEMP.*` are allowed by permission alone unless denied.
4. Limits combine across matched rules to the most restrictive: min for row limits, OR for the `require*` flags.
5. In PRODUCTION, `requireConfirmation` is forced true for writes, and so is `requireStrongConfirmation`.
6. `hasWhere === false` on UPDATE/DELETE → DENY, unless a matched ALLOW rule has `override_where_required`. In that case `requireStrongConfirmation` and `requireApproval` are forced true.
7. Defaults: `maxReadRows` 1000, `maxWriteRows` 50, `requirePreview` true, `requireConfirmation` true.

- [ ] **Step 1: Tests** (table-driven)
  - Permission missing → DENY.
  - DENY on group beats ALLOW on user.
  - A column-level DENY on `TGFPAR.EMAIL` denies `SELECT EMAIL` but allows `SELECT NOMEPARC`.
  - An entity glob `TGF*` matches `TGFPAR`.
  - The environment filter is respected.
  - The most restrictive limit wins.
  - A write without an ALLOW rule → DENY even for a user with `DATA.UPDATE`.
  - An admin user with all `ADMIN.*` and no `DATA.UPDATE` → DENY on UPDATE (no hidden bypass).
  - `hasWhere: false` → DENY. With the override → ALLOW, with strong confirmation and approval required.
  - Production forces strong confirmation.
  - `policyVersion` changes when any rule changes.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement. `policyVersion` = sha256 of the sorted rule JSON.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat: policy engine with deny-wins and least-privilege limits`.

### Task 9.2: Wire the policy into reads and scratch

**Files:** `routes/query.ts`, `read-executor.ts`, `scratch` routes (`routes/scratch.ts`: `POST /api/scratch/exec`, `POST /api/scratch/materialize`, `GET /api/scratch/tables`), integration tests.

- [ ] **Step 1: Tests**
  - A column DENY on `TGFPAR.EMAIL` → `SELECT * FROM TGFPAR` is refused with `FORBIDDEN`. `*` is expanded from the catalog, so the denied column is detected.
  - `SELECT NOMEPARC` succeeds.
  - `maxReadRows` from the policy caps the rows.
  - A user without `TEMP.CREATE` cannot create `tmp_x`.
  - Materialization requires both `QUERY.SELECT` on the source and `TEMP.MATERIALIZE`.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(api): enforce policies on reads and scratch`.

## Stage 10 — Capability resolver and planner

### Task 10.1: Capability resolution

**Files:** `packages/sql-engine/src/capability.ts` + test

**Interfaces:**

- `resolveCapability(c: Classified, ctx: { catalog: Catalog; customPrefixes: string[]; scratchTables: string[] }): Capability`
- `Capability = { class: 'SUPPORTED' | 'SUPPORTED_VIA_GENERATED_ARTIFACT' | 'SCRATCH_ONLY' | 'UNSUPPORTED'; route: 'SANKHYA_READ' | 'SANKHYA_SAVE' | 'SCRATCH' | 'HYBRID' | 'DDL_ARTIFACT' | 'NONE'; reason: string; action: Permission | null }`
- The matrix follows audit §6 exactly.

- [ ] **Step 1: Tests** (one per row of audit §6)
  - DELETE on `TGFPAR` → UNSUPPORTED with a reason mentioning that no documented generic service exists.
  - `UPDATE TGFPAR … WHERE` → SUPPORTED, `SANKHYA_SAVE`, `DATA.UPDATE`.
  - `CREATE TABLE AD_X` → `SUPPORTED_VIA_GENERATED_ARTIFACT`.
  - `CREATE TABLE TGFX` (not a custom prefix) → UNSUPPORTED with a "native DDL forbidden" reason.
  - `ALTER TABLE TGFPAR` → UNSUPPORTED.
  - `CREATE TEMP TABLE tmp_a` → `SCRATCH_ONLY`.
  - `UPDATE tmp_a` → `SCRATCH_ONLY`.
  - A SELECT referencing `tmp_*` and a Sankhya table → `HYBRID`.
  - UNKNOWN → UNSUPPORTED.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(sql-engine): capability resolver`.

## Stage 11 — Mutation lifecycle: preview, plans, execution, verification

### Task 11.1: Immutable plans

**Files:**

- schema: `plans` replaces `write_previews`, migration `0007_plans.sql`
- `apps/api/src/services/plans.ts` replaces `confirmations.ts` + test

**Table `plans`:**

- `id`, `user_id`, `session_id`, `connection_id`, `environment`
- `sql`, `sql_hash`, `params_hash`
- `capability` jsonb, `decision` jsonb, `policy_version`
- `targets` jsonb (before snapshot, keys plus values), `targets_hash`
- `preview` jsonb, `preview_kind`
- `plan_hash`
- `requires_approval`, `strong_confirmation_phrase`
- `status` with check `PENDING`/`APPROVED`/`CONSUMED`/`EXPIRED`/`INVALIDATED`
- `expires_at`, `created_at`, `consumed_at`

**Interfaces:**

- `PlansService`:
  - `create(input: NewPlan): Promise<{ id: string; token: string; planHash: string; expiresAt: Date }>`
  - `consume(input: { id: string; token: string; userId: string; sessionId: string; strongConfirmation?: string; idempotencyKey?: string }): Promise<PlanRow>`
  - `invalidateForConnection(connectionId: string): Promise<number>`
- `planHash = sha256(canonicalJSON({ sqlHash, paramsHash, userId, connectionId, environment, policyVersion, targetsHash, capability }))`
- `token = id + '.' + hmac(SESSION_SECRET, 'plan|' + id + '|' + planHash + '|' + sessionId)`
- `consume` is atomic: `UPDATE … WHERE status IN ('PENDING','APPROVED') RETURNING`. The idempotency key maps to the same result on retry.
- `strongConfirmation` must equal `strong_confirmation_phrase`: `"<ENVIRONMENT> <ACTION> <N> <ENTITY>"`, for example `PRODUCTION UPDATE 3 TGFPAR`.

- [ ] **Step 1: Tests**
  - Token bound to the session: a different session → `CONFIRMATION_INVALID`.
  - Expired after `PLAN_TTL_SECONDS` → `CONFIRMATION_EXPIRED`.
  - A second consume → `CONFIRMATION_USED`.
  - A changed environment or connection (connection rotated → `invalidateForConnection`) → `CONFIRMATION_INVALID`.
  - A wrong strong phrase → `CONFIRMATION_INVALID`.
  - The same idempotency key on a retry returns the original consumed plan and does not error.
  - A plan requiring approval cannot be consumed while PENDING.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(api): immutable hashed execution plans`.

### Task 11.2: Mutation orchestrator

**Files:**

- `apps/api/src/services/mutations.ts` + `mutations.int.test.ts`
- `apps/api/src/services/verification.ts`
- `routes/query.ts`: `POST /api/query` returns a plan for writes; `POST /api/query/execute { planId, token, strongConfirmation?, idempotencyKey }`

**Interfaces:**

- `MutationService`:
  - `prepare(ctx: { auth: AuthState; connectionId: string; sql: string }): Promise<PreparedMutation>`. It performs PARSE→VALIDATE→AUTHORIZE→PLAN→PREVIEW→IMPACT and returns `{ planId, token, expiresAt, capability, previewKind, preview: { targets: Array<{ key; before; after }>; affected: number }, impact: { entities: string[]; rows: number; environment }, requires: { strongConfirmation: string | null; approval: boolean } }`.
  - `execute(ctx: { auth; planId; token; strongConfirmation?; idempotencyKey? }): Promise<ExecutionReport>`. It performs CONFIRM→RE-AUTHORIZE (policy evaluated again; `policyVersion` and effective permissions must still allow)→re-resolve targets (`targetsHash` must match, otherwise `TARGETS_CHANGED`)→global switches→EXECUTE→VERIFY→AUDIT.
  - `ExecutionReport = { status: 'success' | 'partial' | 'failed'; verification: 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'UNVERIFIED' | 'FAILED'; steps: Array<{ key; outcome: 'ok' | 'error' | 'not_attempted' | 'unknown'; errorCode?; verified?: boolean }> }`
- Global switches are evaluated at **execute** time, in this order:
  1. `GLOBAL_WRITE_ENABLED` (env **and** runtime toggle)
  2. `WRITE_TO_SANKHYA`
  3. `SAFE_MODE`, which forbids writes on PRODUCTION connections

  A switch that is off → `READ_ONLY_MODE`.

- Preview kinds:
  - Sankhya UPDATE: `IMPACT_ANALYSIS` (targets with before values from SELECT) plus simulated after values (`SIMULATED_PREVIEW`). The response contains both labels.
  - Scratch: `TRANSACTIONAL_DRY_RUN`.
- Execution for UPDATE: one `save` per target with `pk`, sequentially. It stops at the first error, and the remaining targets are `not_attempted`.
- Verification uses `loadRecords` by pk and compares the changed fields: all match → `VERIFIED`; some → `PARTIALLY_VERIFIED`; the read failed → `UNVERIFIED`; mismatch → `FAILED`.

- [ ] **Step 1: Tests** (mock Sankhya, writes enabled in the test config)
  - A first submit of an UPDATE never writes: the mock row is unchanged after `prepare`.
  - The happy path ends with `VERIFIED` and the mock row changed.
  - Review Focus #4: the mock row is changed between prepare and execute → `TARGETS_CHANGED`, mock save calls = 0.
  - Review Focus #3: `DATA.UPDATE` is removed between prepare and execute → `FORBIDDEN`, save calls = 0, a denied audit event exists.
  - The policy changes between the two → `CONFIRMATION_INVALID` (policyVersion).
  - `GLOBAL_WRITE_ENABLED=false` → `READ_ONLY_MODE` at execute, even with a valid plan.
  - A PRODUCTION connection with `SAFE_MODE=true` → `READ_ONLY_MODE`.
  - UPDATE without WHERE → `WHERE_REQUIRED` at prepare.
  - DELETE on Sankhya → `OPERATION_NOT_SUPPORTED` with the capability reason.
  - A mock fault on the 2nd save → status `partial`, step 3 `not_attempted`.
  - A mock fault "verification read fails" → `UNVERIFIED`.
  - A mock that silently ignores the value → `FAILED`.
  - A save timeout → step `unknown` and `WRITE_OUTCOME_UNKNOWN` in the report.
  - The same idempotency key twice → a single execution.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement, reusing `writes.ts` target resolution (now via `executeRead` with the PK columns from the catalog) and `targetsHashOf`.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(api): full mutation lifecycle with verification`.

### Task 11.3: INSERT and business actions

**Files:** `mutations.ts`, `apps/api/src/services/business-actions.ts` + tests, `routes/actions.ts`

**Interfaces:**

- INSERT → `save` without pk. Verification reads the generated pk.
- `BUSINESS_ACTIONS` registry: `{ id: 'CACSP.cancelarNota', module: 'mgecom', permission: 'SANKHYA.BUSINESS_ACTION.EXECUTE', input: zod schema, entity: 'TGFCAB' }`. Only actions in the registry exist.
- `POST /api/actions/:id/prepare` and `/execute` go through the same `PlansService` and policy (`entities` = the action's entity).
- The initial registry holds only `CACSP.cancelarNota`. Its zod input is `{ nunota: z.number().int().positive(), justificativa: z.string().min(15).max(255) }`. The documentation states that the body shape must be validated against the official docs before enabling it on a live connection, and the action is disabled for `live` connections unless `BUSINESS_ACTIONS_ENABLED=CACSP.cancelarNota`.

- [ ] **Step 1: Tests**
  - INSERT happy path → VERIFIED with the generated key.
  - An unknown action id → 404.
  - An action without permission → FORBIDDEN.
  - An action on a live connection without enablement → `OPERATION_NOT_SUPPORTED`.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(api): inserts and typed business actions through plans`.

## Stage 12 — Custom DDL artifacts

### Task 12.1: Artifact generator and structural diff

**Files:** `packages/sql-engine/src/ddl/{model.ts,diff.ts,autoddl.ts,dbscript.ts}` + tests, `routes/ddl.ts` (`POST /api/ddl/artifact`)

**Interfaces:**

- `tableFromCreate(ast): TableModel`, where `TableModel = { name; primaryKey: string[]; fields: Array<{ name; dataType: 'TEXTO' | 'INTEIRO' | 'DECIMAL' | 'DATA' | 'DATA_HORA' | 'HORA' | 'CHECKBOX' | 'CAIXA_TEXTO' | 'ARQUIVO'; size?; required: boolean; default? }> }`
- `diffTable(current: TableModel | null, desired: TableModel): { changes: Array<{ kind; field?; severity: 'SAFE' | 'CAUTION' | 'DESTRUCTIVE'; note }>; severity: 'SAFE' | 'CAUTION' | 'DESTRUCTIVE' }`
  - Add a nullable field: SAFE.
  - Add a required field, or widen a size: CAUTION.
  - Drop a field, narrow a size, change a type, rename: DESTRUCTIVE.
- `toAutoDdlXml(model): string`, in the format from audit §3.3.
- `toDbScriptXml(changes, model, opts: { version: number }): string`, with separate `<oracle>` and `<mssql>` bodies and no trailing `;`.
- The route requires `DDL.CUSTOM.GENERATE` and a policy ALLOW. The table name must start with a configured custom prefix. DESTRUCTIVE diffs need the typed confirmation `"DESTRUCTIVE <TABLE>"`. The response is a downloadable artifact; nothing is executed.

- [ ] **Step 1: Tests**
  - The XML for `AD_EXEMPLO` matches a snapshot.
  - The type mapping covers all 9 types.
  - Diff severities as listed above.
  - A native table name → UNSUPPORTED.
  - The XML escapes `<&"` in descriptions.
  - The generated dbscript bodies contain no `;`.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement. `CREATE TABLE` maps to the XML types: `VARCHAR(n)`→TEXTO, `INT`/`INTEGER`/`NUMBER(p,0)`→INTEIRO, `DECIMAL`/`NUMBER(p,s)`→DECIMAL, `DATE`→DATA, `TIMESTAMP`/`DATETIME`→DATA_HORA, `CHAR(1)`→CHECKBOX, `CLOB`/`TEXT`→CAIXA_TEXTO, `BLOB`/`VARBINARY`→ARQUIVO. Anything else → `SQL_UNSUPPORTED`.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat: generate Add-on Studio DDL artifacts with structural diff`.

## Stage 13 — Audit and assisted rollback

### Task 13.1: Audit model

**Files:** schema + migration `0008_audit.sql`, `services/records.ts` (AuditService), `routes/admin.ts` audit search, tests.

**Changes:**

- `audit_events` gains `connection_id`, `environment`, `plan_id`, `plan_hash`, `capability`, `verification`, `approval_id`, `policy_decision` jsonb, `snapshot` jsonb.
- The snapshot holds before/after only when the policy limit `auditSnapshots` is true (default true, capped at 50 rows).
- Search filters: user, action, environment, connection, outcome, date range, plan id.

- [ ] **Step 1: Tests**
  - Every lifecycle step writes exactly the expected events: `PLAN_CREATED`, `PLAN_EXECUTED`, `PLAN_DENIED`, `VERIFICATION`.
  - Snapshots are redacted: a column named `SENHA` or `PASSWORD` is masked.
  - Searching by plan id works.
  - `AUDIT.READ` is required.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(api): searchable redacted audit with snapshots`.

### Task 13.2: Assisted rollback

**Files:** `services/rollback.ts` + test, `POST /api/audit/:id/rollback-plan`

**Interfaces:**

- `buildRollbackSql(event: AuditEventRow): string | null`. For a verified UPDATE with a snapshot, it returns `UPDATE <entity> SET <col> = <before> … WHERE <pk> = …`, one statement per target, joined for **display**. The endpoint returns the **first** statement only as a new `prepare`. Otherwise it returns null.
- The rollback goes through `MutationService.prepare` like any write. The response labels it "assisted rollback — requires new preview and confirmation". The current values are compared with the snapshot's "after", and a divergence is shown as a conflict.

- [ ] **Step 1: Tests**
  - A rollback plan for a verified update restores the before values after execution.
  - A row that changed after the original write → the preview shows a conflict, and execute → `TARGETS_CHANGED` if it changes again.
  - No snapshot → 409 with an explanation.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(api): assisted rollback through the mutation lifecycle`.

## Stage 14 — Approvals (four-eyes)

### Task 14.1: Approval workflow

**Files:** schema `approvals` (`id`, `plan_id`, `plan_hash`, `requested_by`, `decided_by`, `decision`, `reason`, `created_at`, `decided_at`, `expires_at`), `services/approvals.ts`, `routes/approvals.ts`, tests.

**Interfaces:**

- `ApprovalsService`:
  - `request(planId, userId)`
  - `decide(approvalId, deciderId, decision: 'APPROVE' | 'REJECT', reason)`
  - `listPending(forUserId)`
- Rules:
  - The decider must have `APPROVAL.DECIDE`, a policy ALLOW for the plan's action and entities, and `deciderId !== requested_by`.
  - The approval stores `plan_hash`. On execute, the plan's hash must equal the approval's.
  - An approval expires together with the plan. Plans requiring approval get a TTL of `APPROVAL_TTL_MINUTES` (default 60) instead of 5 min.

- [ ] **Step 1: Tests**
  - Self-approval → FORBIDDEN.
  - Approve, then execute → success.
  - Reject → execute fails with `FORBIDDEN`.
  - Plan invalidated (connection rotated) → the approval is unusable.
  - A decider lacking a policy for the entity → FORBIDDEN.
  - An approval reused for a different plan → `CONFIRMATION_INVALID`.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(api): four-eyes approvals bound to plan hash`.

## Stage 15 — Admin API and runtime kill switch

### Task 15.1: Admin endpoints

**Files:** `routes/admin/*.ts` (split `admin.ts` into `users.ts`, `groups.ts`, `roles.ts`, `policies.ts`, `connections.ts`, `security.ts`), tests.

**Endpoints:**

- CRUD for groups, roles (permissions), policies and connections. Connection endpoints are masked; `PUT /secrets` rotates, `POST /test` tests.
- `GET/PUT /api/admin/security { globalWriteEnabled }`, stored in table `settings`. The runtime toggle can only turn writes **off** relative to env: effective = env AND runtime. Every change is audited.
- Each route requires its `ADMIN.*` permission.

- [ ] **Step 1: Tests**
  - A user without `ADMIN.POLICIES` → 403.
  - Creating a policy changes `policyVersion`.
  - The connections list masks secrets.
  - The runtime kill switch blocks the next execute with `READ_ONLY_MODE`.
  - The runtime toggle cannot enable writes when the env is false: the effective value stays false and the API reports both values.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit: `feat(api): admin API for access control, connections and kill switch`.

## Stage 16 — Frontend

Each task: update the web unit tests (Vitest + jsdom) where logic exists, then extend `e2e/tests/*.spec.ts`. The UI stays in pt-BR. Commit per task.

### Task 16.1: Connection selector, environment banner and SQL IDE updates

**Files:**

- `apps/web/src/explorer/*`, `editor/monaco.ts`, `lib/completion.ts` (+ test), `components/Layout.tsx`
- new `components/EnvironmentBanner.tsx`, `explorer/ConnectionPicker.tsx`

**Changes:**

- The banner text is exactly `PRODUÇÃO`, `HOMOLOGAÇÃO` or `SANDBOX`, plus a color, and is always visible.
- Completion is fed by `/api/schema?connectionId`.
- The keyword set covers full SELECT (`WITH`, `CASE`, `UNION`, …).
- Results show timings and a "truncado" flag.
- Neutralise TSV copy in `lib/format.ts`, with a test: `toTsv([['=1+1']])` starts with `'`.
- The schema tree is grouped by table prefix.
- Add a scratch tab (`tmp_*` tables) and a materialize action.

### Task 16.2: Mutation flow UI

**Files:** `explorer/WritePreviewDialog.tsx` → `MutationDialog.tsx`, `explorer/runState.ts`

**Changes:**

- Show the capability badge, the preview-kind labels (`PRÉVIA SIMULADA`, `ANÁLISE DE IMPACTO`, `DRY RUN TRANSACIONAL`) and the before/after diff.
- Show the impact (environment, entity, rows) and the plan countdown.
- When required, a typed strong-confirmation input whose button stays disabled until the text matches.
- An approval-required state with a "solicitar aprovação" button.
- The execution report with the verification status.
- The first Ctrl+Enter never executes a write. This is covered by the e2e test `ctrl+enter on UPDATE opens preview and does not write`.

### Task 16.3: Admin panel

**Files:** `apps/web/src/admin/{Users,Groups,Roles,Policies,Connections,Approvals,Audit,Security}Page.tsx`

- Secrets render as `••••` / `definido`, with "substituir", "rotacionar" and "testar" actions only.
- Approvals show pending items that do not belong to me.
- Audit gets filters, plus a rollback-plan action.
- Security has the kill-switch toggle, showing the env and effective values.

### Task 16.4: E2E

**Files:** `e2e/tests/*.spec.ts`, `e2e/playwright.config.ts` (env `SANKHYA_MODE=mock`, `DEMO_MODE=true`).

Scenarios:

- bootstrap via token
- SELECT with CTE
- refused DELETE showing UNSUPPORTED
- UPDATE preview → strong confirm in PRODUCTION blocked by `SAFE_MODE`
- UPDATE on a SANDBOX connection → VERIFIED
- four-eyes with two users
- scratch create, insert, join with materialized data
- DDL artifact download
- audit shows the plan
- kill switch blocks execute

Regenerate the screenshots with `UPDATE_SCREENSHOTS=1`. Each is labelled DEMO and uses fictitious data only.

## Stage 17 — Production hardening

### Task 17.1: Runtime hardening

**Files:** `apps/api/src/app.ts`, `server.ts`, `routes/system.ts`, `Dockerfile`, `compose.yaml`, new `docker-compose.production.example.yml`, `.github/workflows/ci.yml`, tests.

- `/health/ready` checks the DB and the scratch manager. A Sankhya outage is reported on `/api/status` only.
- Graceful shutdown closes the scratch workspaces and aborts executions (test: `closeAll` called on SIGTERM via `app.close()`).
- CORS: same-origin only (no CORS plugin), with a test that a cross-origin preflight gets no ACAO header.
- CSP is unchanged (`'self'`).
- Optional `/metrics` behind `ADMIN.SECURITY`, using counters with labels limited to `route` template, `method`, `status_class`, `capability` and `environment`.
- The production compose example uses `read_only`, tmpfs, `cap_drop`, `no-new-privileges`, an internal DB network, `env_file: .env.production` (not committed), and resource limits.
- Bump `dompurify` and `esbuild` through `pnpm.overrides` to patched versions after checking the release ages. Run `pnpm audit` → 0 moderate+.
- CI: add an SBOM (`pnpm sbom` if available, otherwise skip with a note) and keep gitleaks.
- Commit: `chore: production hardening`.

## Stage 18 — Documentation and GitHub release

### Task 18.1: Docs

**Files:**

- `README.md` (en) and `README.pt-BR.md`
- `docs/{architecture,security,deployment,sankhya,permissions,development,operations,capabilities}.md`
- `docs/adr/0008-sankhya-gateway-only.md`, `0009-policy-engine.md`, `0010-immutable-plans.md`, `0011-scratch-pglite.md`, `0012-ddl-as-artifacts.md`, and mark 0001, 0002, 0004 and 0007 as superseded
- `SECURITY.md`, `CODEOWNERS`, `.env.example`

Content requirements:

- The independence notice.
- An "UNVERIFIED" box in `sankhya.md` for the executeQuery behaviour.
- Backup and restore in `operations.md` (pg_dump/pg_restore of the app DB; the master key is backed up separately; key loss = connection secrets must be re-entered).
- Permissions reference generated from `PERMISSIONS`.

Commit: `docs: DB-Sankhya documentation`.

### Task 18.2: Pre-push gate (STOP points)

- [ ] **Step 1:** Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build`. All must pass.
- [ ] **Step 2:** Run the authorship grep from the project brief over the tree (`git grep -ni`; the pattern is kept outside the repository so it never matches itself). Expect no hits. Review any technical "generated" hits manually.
- [ ] **Step 3:** Run the same pattern over `git log --format='%an <%ae>%n%B'`. Expect empty.
- [ ] **Step 4:** Run the secret scan: gitleaks (`gitleaks detect --source . --log-opts=--all`) if installed, otherwise the CI workflow on the first push plus a local grep for `BEGIN .*PRIVATE KEY`, `eyJ[A-Za-z0-9_-]{10,}\.`, `client_secret\s*[:=]\s*['"][^'"]{8,}`, and 32+ character hex or base64 values near secret keys.
- [ ] **Step 5:** Run the company-data scan: a CNPJ regex with **valid** check digits, real-looking e-mails outside `example`, IPv4 addresses outside 127/0/TEST-NET, and owner-provided private names. Expect no hits.
- [ ] **Step 6:** Check that `git ls-files` contains no `.env`, `*.pem`, `*.key`, dumps or logs.
- [ ] **Step 7:** `git remote -v` must show only `https://github.com/Gustavo-Ale07/db-sankhya.git`.
- [ ] **Step 8:** Run `git fetch origin`.
  - If `origin/main` moved since Stage 0, rebase `migration` onto it locally and re-run Step 1.
  - Then `git merge-base --is-ancestor origin/main migration` must succeed.
- [ ] **Step 9:** Fast-forward `main` to `migration` and push with `git push origin main`. This is a plain fast-forward, **never `--force`**. If the push is rejected as non-fast-forward, STOP, fetch, integrate and retry. Never overwrite the baseline.
