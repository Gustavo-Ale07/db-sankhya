# 0001 — A virtual SQL layer over a REST ERP API

- Status: superseded by [0008](0008-sankhya-gateway-only.md).

## What it decided

Statements were translated at query time into calls to a REST ERP API that had no SQL access, with
a planner, pushdown and API-call limits.

## Why it no longer applies

Reads now run on the Sankhya database through the gateway, in its own SQL dialect, after a
fail-closed gate and AST allowlist; writes run as plans through the gateway's save service (see
[0008](0008-sankhya-gateway-only.md) and [architecture.md](../architecture.md)).
