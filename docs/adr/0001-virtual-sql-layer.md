# 0001 — A virtual SQL layer over a REST ERP API

- Status: superseded — the original ERP integration was removed.

## What it decided

Statements were translated at query time into calls to a REST ERP API that had no SQL access, with a planner, pushdown and API-call limits.

## Why it no longer applies

Reads now run on the Sankhya database through the gateway, in its own SQL dialect, after a fail-closed gate and AST allowlist (see [architecture.md](../architecture.md)).
