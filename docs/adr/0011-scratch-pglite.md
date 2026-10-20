# 0011 — A per-user scratch workspace in PGlite

- Status: accepted.

## Context

Users need temporary tables to stage, join and reshape data, but nothing temporary may be created
in the ERP, and the gateway runs one statement at a time.

## Decision

- Each user gets a private in-memory PostgreSQL (PGlite) in a worker thread. Only `tmp_` tables
  live there; a temporary table without that prefix is unsupported.
- Scratch statements use the `TEMP.*` permissions and the policy engine, evaluated as the pseudo
  connection `scratch` in the `SANDBOX` environment.
- Sankhya data enters scratch only through materialization (`TEMP.MATERIALIZE`, capped rows). A
  statement mixing Sankhya and scratch tables is never executed in one step.
- Workspaces are capped in number, tables, rows, size and statement time, and expire after
  `SCRATCH_TTL_MINUTES` of inactivity. A statement that exceeds its time limit terminates the
  worker, which resets the workspace.

## Consequences

- Scratch data is lost on restart, expiry or a timeout; it is never backed up.
- Scratch uses PostgreSQL syntax, not the ERP dialect.
- Nothing in scratch reaches the ERP.
