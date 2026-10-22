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
stop part way; the run's verification label is then `PARTIALLY_VERIFIED` or `UNVERIFIED` (`FAILED`
if an earlier row's read-back did not match). Per-step outcomes show which rows were saved.

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

### What the gateway does (observed)

Raw answers of the base de testes (the company's Sankhya test environment) through the local API,
on 21 and 22/10/2026. Credentials, tokens and company data are left out; the transaction id is
replaced by `<id>`. Production was never called.

| Call                                                                                                                  | HTTP | Raw answer                                                                                                                        | Conclusion                                                     |
| --------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `DbExplorerSP.executeQuery` (`SELECT`, dictionary and data)                                                           | 200  | `"status":"1"`                                                                                                                    | Reads work.                                                    |
| `CRUDServiceProvider.loadRecords` (`Parceiro`, TGFPAR)                                                                | 200  | `"status":"1"`, 50 records                                                                                                        | The same credential reads through CRUD.                        |
| `DatasetSP.save` (one column of one row of a small `AD_*` table)                                                      | 200  | `{"serviceName":"DatasetSP.save","status":"0","pendingPrinting":"false","transactionId":"<id>","statusMessage":"Não autorizado"}` | Refused; the read-back showed the value unchanged.             |
| B0 probe (`UPDATE … WHERE 1=0`, `CREATE`/DML/`ALTER`/`DROP` of `AD_DBX_PROBE`, `saveRecord`, dictionary registration) | n/a  | not run                                                                                                                           | **Não verificado**: waits for write permission on the sandbox. |

The client maps that `"Não autorizado"` to `SANKHYA_AUTH_ERROR`; the write was sent once and not
repeated. Authentication and reads work with the same credential, so the refusal is about the
service: the integration user or app of those credentials needs permission for `DatasetSP.save`
(writing through the entity of that table) in the Sankhya portal. How to verify once it is
granted: run the Fase 0.6 mark again (one row, one column of an `AD_*` table, base de testes only)
and confirm `VERIFIED` and the read-back.

Dictionary of the base de testes (read only): `TDDTAB` 3271 rows, `TDDCAM` 44043, `TDDINS` 3875;
the first `GET /api/schema` took about 6.7 s, and the catalog came back degraded `PK:truncated`
before the primary keys were paged. Whether it is complete after this release is **não
verificado** (read `GET /api/status` or `/api/schema` once against the base de testes).

`DBEXPMAXROW` (default 5000) is the ERP parameter believed to cap an `executeQuery` result:
**parâmetro a verificar no ERP**. The dictionary reads are paged and counted so a lower cap only
degrades the catalog, never silently shortens it.

The official gateway page lists `DatasetSP.loadRecords`, `CRUDServiceProvider.saveRecord` /
`loadRecords`, `DbExplorerSP.executeQuery` (mge) and `CACSP.IncluirNota` /
`incluirAlterarItemNota` / `excluirItemNota` / `cancelarNota`, `SelecaoDocumentoSP.faturar`
(mgecom). It does not list `DatasetSP.save`, and documents no DDL or `DELETE` service.

## Data dictionary

The catalog is read from the ERP dictionary tables `TDDTAB` (tables), `TDDCAM` (fields) and
`TDDINS` (entity instances) through `executeQuery`, plus a primary-key query for the connection's
dialect (`SANKHYA_DIALECT`: `oracle` or `mssql`). A whole catalog is cached for one hour, in memory
and in the database. Every table a statement uses must exist in the catalog. Column names of the
dictionary vary between versions; the adapter tolerates missing optional columns.

`TDDTAB` and `TDDCAM` can hold more rows than the gateway returns for one query. They are read in
pages (`TDDTAB` by `NOMETAB`, `TDDCAM` by `NUCAMPO`, the primary keys by `TABLE_NAME`,
`COLUMN_NAME`, each page starting after the last key of the
one before), up to `METADATA_MAX_PAGES` pages (default 100, 1 to 1000). **Every dictionary read is checked against its own count**
(`SELECT COUNT(*) AS TOTAL FROM ...`; the primary-key query is counted as a subquery), because a
gateway may cut a result at its row cap without flagging it: a page that comes back short is
followed by the next one until the rows add up. A page that fails or repeats a key, a count that
differs or cannot be read, or the page limit marks the catalog degraded, for example
`TDDCAM:truncated`, `TDDINS:truncated` or `PK:failed`. A gateway that refuses the paged query falls
back to one checked unpaged read. A first `TDDTAB` read that fails fails the catalog.

**A degraded catalog** is never stored in the database. It is kept in memory for
`METADATA_DEGRADED_TTL_SECONDS` (default 600, 10 minutes). After that it is still answered at once
while one discovery reads the dictionary again behind it, until it is one hour old; an older one is
read again before answering. `POST /api/schema/refresh?connectionId=...` reads it again now: it
needs `QUERY.SELECT` and access to the connection, answers the catalog filtered like
`GET /api/schema`, is limited to 6 calls per minute and is audited as `schema.refresh` (operation
`SCHEMA`, with the `degraded` list). Updating a connection, replacing its secrets or deleting it
drops its catalog and the tables read on their own; a discovery that was running at that moment
answers its caller but is not kept.

When the table list itself is degraded (`TDDTAB:truncated`, or `TDDTAB:failed` on a later page), a
read of a table missing from it looks the table up on its own before refusing it. A table the user
may not see is not looked up and gets the same `RESOURCE_NOT_FOUND` as a table that does not
exist; a lookup that fails refuses too.

**Entity instances (`TDDINS`).** A Sankhya write saves through the entity instance the dictionary
names for the table. The instance is frozen in the plan when it is previewed (it is part of the
preview, and so of the hash the user confirms); at execution the dictionary is read again and a
different instance refuses the plan (`CONFIRMATION_INVALID`, audited as a denied plan). A table
`TDDINS` lists with more than one instance is refused at preview until the instance to use can be
configured (_decisão pendente_). Plans previewed before this release carry no instance and are
refused at execution; preview them again.

When the catalog is partial, nothing that needs every column of a table trusts it. Mutation
previews, `SELECT *` expansion, DDL generation, the schema tree and editor autocomplete read the
table on its own (`FROM TDDCAM WHERE NOMETAB = '<table>'`, through
`GET /api/schema/tables/:name`); that read is cached per connection and dropped when the catalog is
refreshed. If it fails too, the request fails with `SANKHYA_API_ERROR` (502) instead of using
partial columns. A column that is in neither read does not exist and is refused.

The first catalog load reads several pages and one count per read (8 gateway queries for a
dictionary where each read fits in one page); on a large dictionary it takes longer than the old
single read. Whether the real gateway accepts `COUNT(*)` on the dictionary and the counted
primary-key subquery has not been verified: if it does not, the catalog is always degraded
(fail closed) and the tables read on their own still work. Watch the duration of the first `GET /api/schema` after a deploy, and the reverse
proxy's read timeout (the load continues and is cached even if the browser gives up).

### Testing a cut dictionary with the mock

The bundled mock gateway can imitate a gateway that cuts results. These switches are refused at
start unless `SANKHYA_MODE=mock` and `NODE_ENV` is not `production`:

| Variable                          | Effect                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `SANKHYA_MOCK_ROW_CAP`            | Rows the mock returns for one query (1 to 100000).                              |
| `SANKHYA_MOCK_SILENT_CUT`         | `true`: cut at the row cap without flagging the result as cut.                  |
| `SANKHYA_MOCK_DICTIONARY_PADDING` | Extra `TDDCAM` rows of fictitious tables (0 to 100000), to outgrow the row cap. |
| `SANKHYA_MOCK_CALL_LOG`           | File the mock appends each call's service name to (never its body); E2E only.   |

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

Business actions are the native note services of the gateway (module `mgecom`). Each request body
follows the official documentation page named in the registry (`contract`), and nothing else.
Every prepare answer carries that link and the warning **"validado só no mock; testar em
HOMOLOGAÇÃO antes de produção"**. On a `live` connection an action runs only when its exact id is
listed in `BUSINESS_ACTIONS_ENABLED` (empty by default), and the write switches (`SAFE_MODE`,
`GLOBAL_WRITE_ENABLED`, `WRITE_TO_SANKHYA`) gate it like any other write.

| Action                         | Permission                                 | Writes             | Expected effect, read back                                                                                                                 | Contract page              |
| ------------------------------ | ------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| `CACSP.cancelarNota`           | `SANKHYA.ACTION.CANCELAR_NOTA`             | `TGFCAB`           | `STATUSNOTA = 'C'` on the note (`justificativa` of 15 to 255 characters)                                                                   | `post_cancelamovimento`    |
| `CACSP.incluirNota`            | `SANKHYA.ACTION.INCLUIR_NOTA`              | `TGFCAB`, `TGFITE` | the note (`CODPARC`, `TIPMOV`) under the `NUNOTA` the gateway answers, and each item (`CODPROD`, `QTDNEG`; `VLRUNIT` with `informarPreco`) | `post_incluimovimentos`    |
| `CACSP.incluirAlterarItemNota` | `SANKHYA.ACTION.INCLUIR_ALTERAR_ITEM_NOTA` | `TGFITE`           | the item (`CODPROD`, `QTDNEG`, `VLRUNIT`); without `sequencia` it adds one, with it it changes that item                                   | `post_incaltitemmovimento` |
| `CACSP.excluirItemNota`        | `SANKHYA.ACTION.EXCLUIR_ITEM_NOTA`         | `TGFITE`           | the item `NUNOTA` + `SEQUENCIA` is gone                                                                                                    | `post_excluiitemmovimento` |
| `SelecaoDocumentoSP.faturar`   | none (stub)                                | none               | **not enabled**: the page does not say which fields are required; prepare answers `OPERATION_NOT_SUPPORTED`                                | `post_faturamovimento`     |

- **Both permissions are needed**: `SANKHYA.BUSINESS_ACTION.EXECUTE` and the action's own. The
  policy decides on the action's own permission with every table it writes, so `incluirNota` needs
  an `ALLOW` that covers `TGFCAB` and `TGFITE`. An approver needs both as well.
- **Validated only against the bundled mock.** The mock implements each service from the same
  documentation page; it is not the ERP. Test each action in `HOMOLOGATION` and check the note in
  the ERP before listing its id for a `PRODUCTION` connection. `BUSINESS_ACTIONS_ENABLED` applies
  to every live connection at once, so enable it first on an installation that has only
  homologation connections, or keep `SAFE_MODE` on while testing.
- **Read-back.** A create is verified under the key the gateway answers (`pk`); when the answer
  has no key the result is `UNVERIFIED`, never `VERIFIED`. The items of `incluirNota` are matched
  among the rows of the new note. A delete is verified by the row's absence. If the real effect
  differs, the result is `FAILED` or `UNVERIFIED`, but the call has already happened (it is never
  retried).
- **What the documentation leaves open (não verificado):** the `incluirNota` page is titled
  "IncluirNota" while its example calls `incluirNota` (the example's casing is used);
  `incluirAlterarItemNota` lists `CODLOCALORIG` as required but leaves it out of its example (sent
  only when given); `VLRTOT` is sent as `QTDNEG × VLRUNIT` but not checked, since the ERP may
  recompute it; the answer of `incluirAlterarItemNota` is not shown beyond `pk`; whether these
  services need the `mgeSession` of the login is not verified. How to verify: one call of each in
  `HOMOLOGATION`, with the read-back.
- **"Não autorizado".** When the gateway answers `"status":"0"` with `"statusMessage":"Não
autorizado"` (as `DatasetSP.save` did in the base de testes), the step fails with
  `SANKHYA_WRITE_NOT_AUTHORIZED` and the editor shows "Gravação via API não liberada para este
  usuário no Gateway (DatasetSP.save)" instead of the raw error. The call is not repeated.

## Mock gateway

`SANKHYA_MODE=mock` replaces the gateway with a bundled fake: authentication, `executeQuery` over
an in-memory database, `DatasetSP.save`, `CRUDServiceProvider.loadRecords` and a business-action
stub, with clearly fictitious data and dictionary tables. It is used in development, tests, the
end-to-end suite and demo mode. In production it is accepted only with `DEMO_MODE=true`.
