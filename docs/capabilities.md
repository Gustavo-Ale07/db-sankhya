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
| `CREATE TEMPORARY TABLE tmp_…`                         | `SCRATCH_ONLY`                     | `SCRATCH`      | `TEMP.CREATE`                                     |
| `CREATE TEMPORARY TABLE tmp_… AS SELECT` from Sankhya  | `SCRATCH_ONLY`                     | `HYBRID`       | `TEMP.CREATE`, `TEMP.MATERIALIZE`, `QUERY.SELECT` |
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
- **Scratch statements** run directly with `POST /api/scratch/exec`. A scratch `INSERT` /
  `UPDATE` / `DELETE` can also be planned through `POST /api/query/preview`, which gives a
  `TRANSACTIONAL_DRY_RUN` preview. On both paths a scratch `UPDATE` or `DELETE` needs a `WHERE`
  that restricts rows, with no override (`WHERE_REQUIRED`).
- **Hybrid work** is done in two steps. `POST /api/scratch/materialize` copies the rows of a Sankhya
  read into a `tmp_` table, capped at `MATERIALIZE_MAX_ROWS` and the policy's `maxReadRows`. Scratch
  statements then use that table. The write planner accepts only the `SANKHYA_SAVE` and `SCRATCH`
  routes, so a hybrid statement is never executed as one step.
- **Custom DDL** (`DDL_ARTIFACT`) goes through `POST /api/ddl/artifact`. It returns AutoDDL
  (`<TABLE>.xml`) and/or dbscript (`V<n>.xml`) files and never executes anything. A change the
  dictionary cannot prove safe is treated as destructive. It is generated only with the typed
  confirmation `DESTRUCTIVE <TABLE>`.

## Preview kinds

Each plan carries the kind of preview it was built from. Each label states exactly how much the
preview proves:

| Label                   | Used for                                           | What it proves                                                      |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| `TRANSACTIONAL_DRY_RUN` | scratch writes                                     | The statement really ran inside a transaction that was rolled back. |
| `IMPACT_ANALYSIS`       | Sankhya `UPDATE`, business actions                 | The real target rows were read, by key, with their current values.  |
| `SIMULATED_PREVIEW`     | Sankhya `INSERT`, the "after" of any Sankhya write | The new values were computed locally. Nothing was run on the ERP.   |

A Sankhya `UPDATE` carries both labels: the rows are real (`IMPACT_ANALYSIS`), the values after the
change are computed (`SIMULATED_PREVIEW`). Sankhya has no transaction the app could roll back, so
a Sankhya write is never shown as a dry run.
