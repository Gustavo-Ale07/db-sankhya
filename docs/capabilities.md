# Capabilities

Before a statement is planned, the engine resolves its **capability**: whether DB-Sankhya can
carry it out, and by which route (`resolveCapability` in `packages/sql-engine/src/capability.ts`).
Anything it cannot map to a supported mechanism is `UNSUPPORTED` and fails closed. The SQL is never
passed through to the ERP as is.

## Classes

| Class                              | Meaning                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `SUPPORTED`                        | Runs against Sankhya through a gateway service (`executeQuery` for reads, `DatasetSP.save` for writes). |
| `SUPPORTED_VIA_GENERATED_ARTIFACT` | Never executed. The server generates a file (Add-on Studio AutoDDL or dbscript XML) to deploy by hand.  |
| `SCRATCH_ONLY`                     | Runs only in the user's local scratch workspace (`tmp_` tables in PGlite). Nothing reaches the ERP.     |
| `UNSUPPORTED`                      | Refused with the reason (for example `OPERATION_NOT_SUPPORTED` at preview). Nothing is planned or sent. |

## Routes

| Route            | Used for                                                                                |
| ---------------- | --------------------------------------------------------------------------------------- |
| `SANKHYA_READ`   | A `SELECT` over Sankhya tables, sent to `DbExplorerSP.executeQuery`.                    |
| `SANKHYA_SAVE`   | `INSERT` / `UPDATE` of a Sankhya table, sent to `DatasetSP.save` as a plan.             |
| `SANKHYA_ACTION` | A registered business action (see [architecture.md](architecture.md#business-actions)). |
| `SCRATCH`        | Statements over `tmp_` tables only.                                                     |
| `HYBRID`         | Sankhya rows copied into scratch first (materialization), then used locally.            |
| `DDL_ARTIFACT`   | `CREATE` / `ALTER` / `DROP` of a custom-prefix table, turned into Add-on Studio files.  |

## Matrix

"Sankhya table" means a table in the connection's catalog. "Custom table" means a name that starts
with one of `CUSTOM_TABLE_PREFIXES` (default `AD_`). "Scratch table" means a `tmp_` table in the
user's workspace.

| Statement                                              | Class                              | Route          | Permissions                                       |
| ------------------------------------------------------ | ---------------------------------- | -------------- | ------------------------------------------------- |
| `SELECT` on Sankhya tables                             | `SUPPORTED`                        | `SANKHYA_READ` | `QUERY.SELECT`                                    |
| `SELECT` on scratch tables only                        | `SCRATCH_ONLY`                     | `SCRATCH`      | `QUERY.SELECT`                                    |
| `SELECT` joining Sankhya and scratch tables            | `SUPPORTED`                        | `HYBRID`       | `QUERY.SELECT`, `TEMP.MATERIALIZE`                |
| `INSERT` into a Sankhya table (one `VALUES` row)       | `SUPPORTED`                        | `SANKHYA_SAVE` | `DATA.INSERT` + policy `ALLOW`                    |
| `UPDATE` of a Sankhya table with `WHERE`               | `SUPPORTED`                        | `SANKHYA_SAVE` | `DATA.UPDATE` + policy `ALLOW`                    |
| `DELETE` on a Sankhya table                            | `UNSUPPORTED`                      | none           | no documented generic delete service              |
| `INSERT` / `UPDATE` / `DELETE` on a scratch table      | `SCRATCH_ONLY`                     | `SCRATCH`      | `TEMP.WRITE`                                      |
| … on a scratch table, reading Sankhya tables           | `SCRATCH_ONLY`                     | `HYBRID`       | `TEMP.WRITE`, `TEMP.MATERIALIZE`, `QUERY.SELECT`  |
| `CREATE [TEMPORARY] TABLE tmp_…`                       | `SCRATCH_ONLY`                     | `SCRATCH`      | `TEMP.CREATE`                                     |
| `CREATE [TEMPORARY] TABLE tmp_… AS SELECT` (Sankhya)   | `SCRATCH_ONLY`                     | `HYBRID`       | `TEMP.CREATE`, `TEMP.MATERIALIZE`, `QUERY.SELECT` |
| `ALTER` / `DROP` of a scratch table                    | `SCRATCH_ONLY`                     | `SCRATCH`      | `TEMP.CREATE` / `TEMP.DROP` in scratch            |
| `CREATE` / `ALTER` / `DROP` of a custom table          | `SUPPORTED_VIA_GENERATED_ARTIFACT` | `DDL_ARTIFACT` | `DDL.CUSTOM.GENERATE` + policy `ALLOW`            |
| `CREATE TABLE AD_… AS SELECT`, renames of custom table | `UNSUPPORTED`                      | none           | cannot be expressed as an Add-on Studio artifact  |
| A temporary table without the `tmp_` prefix            | `UNSUPPORTED`                      | none           | temporary tables must use `tmp_`                  |
| DDL on any native (non-custom) table                   | `UNSUPPORTED`                      | none           | refused for every role                            |
| Custom or scratch DDL that references other tables     | `UNSUPPORTED`                      | none           | may not reference foreign tables                  |
| Anything unrecognised                                  | `UNSUPPORTED`                      | none           |                                                   |

`UPDATE` or `DELETE` without `WHERE` is additionally **blocked** (`MISSING_WHERE`). For a Sankhya
`UPDATE` the policy can lift that block only with an `ALLOW` rule whose `overrideWhereRequired`
covers the table on its own. The override then forces strong confirmation and approval.

## How each class is served

- **Reads** (`SANKHYA_READ`) go through `POST /api/query`.
- **Sankhya writes** (`SANKHYA_SAVE`) go through `POST /api/query/preview` and then
  `POST /api/query/execute`. `POST /api/query` never runs a mutation: it answers `SQL_UNSUPPORTED`
  with a pointer to the preview.
- **Business actions** (`SANKHYA_ACTION`) go through `POST /api/actions/:id/prepare` and
  `/execute`.
- **Scratch reads** (`SELECT` over `tmp_` tables only) run from the SQL editor through
  `POST /api/query`, in the caller's own workspace (`source: 'scratch'`); the gateway is not called.
- **Scratch commands from the editor.** `INSERT` / `UPDATE` / `DELETE` / `CREATE` / `ALTER` /
  `DROP` of a `tmp_` table sent to `POST /api/query` are answered with a pointer to the preview,
  and the editor opens the same dialog as a Sankhya write: `POST /api/query/preview` runs the
  statement in a transaction that is rolled back (`TRANSACTIONAL_DRY_RUN`), shows the rows
  BEFORE/AFTER (DML) or the table structure BEFORE/AFTER (DDL, with "N linhas serão perdidas" for
  a `DROP`), and `POST /api/query/execute` runs it once, re-reads the structure or rows and reports
  `VERIFIED` or `FAILED`. These plans need `GLOBAL_WRITE_ENABLED` and the `TEMP.*` permissions
  and policy; they never need `WRITE_TO_SANKHYA`, because nothing reaches the ERP. A scratch
  `UPDATE` or `DELETE` needs a `WHERE` that restricts rows, with no override (`WHERE_REQUIRED`).
- **`CREATE TABLE tmp_… AS SELECT` reading Sankhya** (A3). The preview reads each Sankhya part
  through the read path (`QUERY.SELECT` and `TEMP.MATERIALIZE` on the source, column policy
  included, capped at min(`SANKHYA_MAX_ROWS`, `MATERIALIZE_MAX_ROWS`, policy)), copies it into an
  ephemeral scratch table, dry-runs the `CREATE`, and drops the copies. It shows the columns and
  types, the row count, each Sankhya part read and a warning when a part was cut. "Confirmar
  criação" reads Sankhya again; rows that changed since the preview refuse the plan
  (`TARGETS_CHANGED`).
- **Hybrid reads** (`SELECT` joining `tmp_` and Sankhya tables) run in one step through
  `POST /api/query` (`source: 'hybrid'`, `hybrid.parts` with each part's tables, rows and cut
  flag; the results grid shows the origin and the parts). Each Sankhya part must be a `WITH` or a
  subquery that reads Sankhya tables only; it is read once, copied into an ephemeral scratch table
  that is always dropped, and the statement runs in scratch. A statement whose Sankhya part cannot
  be separated is refused (`SQL_UNSUPPORTED`).
- **The Scratch page** (`Scratch (avançado)`, after **Status** in the menu) still runs scratch
  statements directly with `POST /api/scratch/exec`, without the preview dialog, and copies a
  Sankhya read with `POST /api/scratch/materialize`. Whether that direct path stays is a pending
  decision (see below).
- **Custom DDL** (`DDL_ARTIFACT`) goes through `POST /api/ddl/artifact`. It returns AutoDDL
  (`<TABLE>.xml`) and/or dbscript (`V<n>.xml`) files and never executes anything. A change the
  dictionary cannot prove safe is treated as destructive. It is generated only with the typed
  confirmation `DESTRUCTIVE <TABLE>`.

## Preview kinds

Each plan carries the kind of preview it was built from. Each label states exactly how much the
preview proves:

| Label                   | Used for                                           | What it proves                                                      |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| `TRANSACTIONAL_DRY_RUN` | scratch writes and scratch DDL                     | The statement really ran inside a transaction that was rolled back. |
| `IMPACT_ANALYSIS`       | Sankhya `UPDATE`, business actions                 | The real target rows were read, by key, with their current values.  |
| `SIMULATED_PREVIEW`     | Sankhya `INSERT`, the "after" of any Sankhya write | The new values were computed locally. Nothing was run on the ERP.   |

A Sankhya `UPDATE` carries both labels: the rows are real (`IMPACT_ANALYSIS`), the values after the
change are computed (`SIMULATED_PREVIEW`). Sankhya has no transaction the app could roll back, so
a Sankhya write is never shown as a dry run.

## Where each command was proven

"mock" means the bundled mock gateway with PGlite (unit, integration and end-to-end tests).
"base de testes" means the company's Sankhya test environment, through the local API. Production
was never used for any of this, read or write.

| Command                                     | `tmp_*` (scratch)      | Sankhya `AD_*`                                                       | Sankhya native                            |
| ------------------------------------------- | ---------------------- | -------------------------------------------------------------------- | ----------------------------------------- |
| `SELECT`                                    | mock                   | mock; base de testes (read only)                                     | mock; base de testes (read only)          |
| Hybrid `SELECT` (`tmp_` × Sankhya)          | mock (E2E with TGFPAR) | same path as native; not tested separately                           | mock (E2E with TGFPAR)                    |
| `CREATE TABLE tmp_… AS SELECT` from Sankhya | mock (integration)     | n/a                                                                  | n/a                                       |
| `INSERT` / `UPDATE` / `DELETE`              | mock (E2E: `INSERT`)   | `INSERT` / `UPDATE`: mock; base de testes **refused by the gateway** | `UPDATE`: mock; base de testes: not tried |
| `CREATE` / `ALTER` / `DROP`                 | mock (E2E)             | artifact only (mock); execution **não verificado** (Trilha B)        | refused everywhere                        |
| `DELETE` on Sankhya                         | n/a                    | refused (`UNSUPPORTED`)                                              | refused (`UNSUPPORTED`)                   |
| Production                                  | never                  | never                                                                | never                                     |

The base de testes refusal is the single Fase 0.6 attempt: `DatasetSP.save` answered
`"status":"0"`, `"statusMessage":"Não autorizado"`, and the read-back showed the value unchanged
(see [sankhya.md](sankhya.md#what-the-gateway-does-observed)). Every gateway call of the E2E
`e2e/tests/editor-tmp.spec.ts` is logged by service name (`SANKHYA_MOCK_CALL_LOG`), and the test
asserts the log holds read services only.

## Pending decisions

_Decisão pendente_ until the owner decides; each fails closed today.

- **Native DDL** (Trilha B1): refused for every role and environment. A route for non-production
  environments under policy, with four-eyes approval, is not built.
- **Registering custom tables in the official dictionary**: only the Add-on Studio artifact is
  generated; nothing is registered.
- **`DatasetSP.save` × `CRUDServiceProvider.saveRecord`** (Trilha B3): writes use
  `DatasetSP.save`, which the official gateway page does not list; `saveRecord` is listed. Not
  switched until the base de testes proves either one.
- **Plan retention** (`PLAN_REDACT_HOURS`, `PLAN_RETENTION_DAYS`): defaults 24 hours and 30 days.
- **`POST /api/scratch/exec`** runs `tmp_` statements without the preview dialog (Scratch page).
  Options: keep it as the advanced path, or limit it to `SELECT`.
