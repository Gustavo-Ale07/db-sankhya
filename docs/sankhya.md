# Sankhya integration

DB-Sankhya is an independent project; it is not affiliated with or endorsed by Sankhya, and it is
not an official Sankhya product. Sankhya names and platform concepts are referenced only for
compatibility and integration.

This page describes how the server talks to the Sankhya gateway, what it relies on, and what has
**not** been verified against a real installation.

## Gateway only

The server never connects to the ERP database. Every call goes through the HTTP gateway with the
credentials of one connection ([ADR 0008](adr/0008-sankhya-gateway-only.md)). The browser never
sees those credentials.

| Need                | Gateway service                       | Module   | Retried?                          |
| ------------------- | ------------------------------------- | -------- | --------------------------------- |
| Reads (`SELECT`)    | `DbExplorerSP.executeQuery` `{ sql }` | `mge`    | yes, idempotent (up to 2 retries) |
| Reads by key        | `CRUDServiceProvider.loadRecords`     | `mge`    | yes, idempotent                   |
| `INSERT` / `UPDATE` | `DatasetSP.save`                      | `mge`    | **never**, sent exactly once      |
| Business actions    | one service per registry entry        | per item | **never**, sent exactly once      |
| Authentication      | `<base URL>/authenticate`             |          |                                   |

There is no generic "call any service" endpoint, and no `DELETE`: the gateway documents no generic
delete service, so a `DELETE` on a Sankhya table is `UNSUPPORTED`.

### Authentication

OAuth2 `client_credentials` against `<SANKHYA_BASE_URL>/authenticate`, with the per-installation
token in the `X-Token` header. The access token is cached, fetched once for any number of
concurrent callers, and refreshed 30 seconds before it expires. If the gateway rejects a token,
the call authenticates again once. A read is then repeated. A write is repeated only when it was
provably not sent: an HTTP 401, or an HTTP 403 with a token error. A "não autorizado" inside an
HTTP 200 answer comes from the service, so the write is treated as sent and never repeated.

### Transport limits

- Service URL: `<base>/gateway/v1/{mge|mgecom}/service.sbr?serviceName=<name>&outputType=json`.
  Redirects are refused and response size is capped.
- The base URL host must be listed in `SANKHYA_ALLOWED_HOSTS` (default
  `api.sankhya.com.br,api.sandbox.sankhya.com.br`).
- `executeQuery` calls are serialized per connection, one at a time.
- A request budget of `SANKHYA_RATE_PER_MINUTE` per minute (default 300, at most 1000).
- Idempotent calls retry on transient errors with backoff (base 500 ms, at most 5 s) and honour
  `Retry-After`. Writes and actions are never retried.
- A circuit breaker opens after 5 consecutive failures and tries again after 30 seconds.
- Each call times out after `SANKHYA_TIMEOUT_MS` (default 60000). Keep the reverse proxy's read
  timeout above it.

### Write outcomes

A write is one `DatasetSP.save` per row. If the gateway does not answer clearly (timeout, dropped
connection, unexpected answer), the result is `WRITE_OUTCOME_UNKNOWN`: the change may or may not
have been applied. The server does not repeat it. Check the row in the ERP before doing anything
else (see [operations.md](operations.md#operator-notes)).

`DatasetSP.save` has no transaction spanning several calls. A plan that changes several rows can
stop part way; the run's verification label is then `PARTIALLY_VERIFIED` or `UNVERIFIED`.
Per-step outcomes show which rows were saved.

## executeQuery

> **UNVERIFIED**
>
> `DbExplorerSP.executeQuery` is listed by the gateway, but its request and response bodies are
> **not documented**. The body DB-Sankhya sends (`{ sql }`) and the response shape it reads
> (`fieldsMetadata`, `rows`) come from community clients and are matched by the bundled mock,
> not by an official contract. The following has **not** been verified against a real
> installation:
>
> - **No read-only guarantee is documented.** Nothing on the Sankhya side is known to stop
>   `executeQuery` from running a statement that changes data.
> - The gateway is said to return at most about 1000 rows per call.
> - Two concurrent calls on the same session are said to be refused.
>
> DB-Sankhya therefore does not rely on the gateway to keep reads read-only:
>
> - every statement passes a lexical gate and an AST allowlist before it is sent (see
>   [architecture.md](architecture.md#read-path)); anything unrecognised is refused;
> - calls are serialized per connection, and `SANKHYA_MAX_ROWS` (default 1000) caps the rows;
>   `truncated` marks a result the gateway may have cut;
> - every read is audited (`read.executed` / `read.denied`).
>
> Give the integration user **only the access it needs** in the ERP. Treat its credentials as
> able to change data.

Other points not verified against a real installation:

- the gateway may reject an access token before its stated expiry (handled by the single
  re-authentication);
- the primary-key query of the dictionary (Oracle `ALL_CONSTRAINTS`, SQL Server
  `INFORMATION_SCHEMA`) has run only against the mock; when it fails, tables are shown without
  keys and writes to them are refused;
- the dbscript artifact format has not been loaded into a real importer.

## Data dictionary

The catalog is read from the ERP dictionary tables `TDDTAB` (tables), `TDDCAM` (fields) and
`TDDINS` (entity instances) through `executeQuery`, plus a primary-key query for the connection's
dialect (`SANKHYA_DIALECT`: `oracle` or `mssql`). It is cached for one hour; a catalog that loaded
only partly is cached for one minute. Every table a statement uses must exist in the catalog.
Column names of the dictionary vary between versions; the adapter tolerates missing optional
columns.

## Environments

Each connection declares the environment it points at. The environment drives the policy and the
confirmations; it does not change how the gateway is called.

| Environment    | Meaning                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------- |
| `PRODUCTION`   | Live company data. Writes need strong confirmation and are blocked while `SAFE_MODE` is on. |
| `HOMOLOGATION` | A test copy of the ERP. Use it to try plans and business actions before production.         |
| `SANDBOX`      | Disposable data. The scratch workspace is also treated as `SANDBOX`.                        |

The environment connection (`env-default`, from `SANKHYA_*`) uses `SANKHYA_ENVIRONMENT` (default
`PRODUCTION`). Connections created in **Conexões** choose their own.

## Business actions

The registry holds `CACSP.cancelarNota` (module `mgecom`): it cancels the note `nunota` of
`TGFCAB` with a `justificativa` of 15 to 255 characters, and expects `STATUSNOTA = 'C'` on the row
afterwards. On a `live` connection it runs only when its id is listed in
`BUSINESS_ACTIONS_ENABLED`.

- **The request body and the expected effect were validated only against the bundled mock.**
  Compare them with the official gateway documentation of your ERP version before enabling the
  action.
- **Test one cancellation in `HOMOLOGATION`** and check the note in the ERP before listing the id
  for a `PRODUCTION` connection. `BUSINESS_ACTIONS_ENABLED` applies to every live connection at
  once, so enable it first on an installation that has only homologation connections, or keep
  `SAFE_MODE` on while testing.
- If the real effect differs (for example the note is moved instead of updated), the read-back
  reports `FAILED` or `UNVERIFIED`, never `VERIFIED`, but the call has already happened.
- One permission, `SANKHYA.BUSINESS_ACTION.EXECUTE`, covers every registered action. Limit who can
  run them with policy rules on the action's entity.

## Mock gateway

`SANKHYA_MODE=mock` replaces the gateway with a bundled fake: authentication, `executeQuery` over
an in-memory database, `DatasetSP.save`, `CRUDServiceProvider.loadRecords` and a business-action
stub, with clearly fictitious data and dictionary tables. It is used in development, tests, the
end-to-end suite and demo mode. In production it is accepted only with `DEMO_MODE=true`.
