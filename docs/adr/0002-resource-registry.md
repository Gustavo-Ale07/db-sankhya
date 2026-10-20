# 0002 — A declarative resource registry

- Status: superseded by [0008](0008-sankhya-gateway-only.md).

## What it decided

A hand-written registry declared every virtual table: endpoints, columns, JSON paths, pushdown
filters and write operations. It was the allowlist of callable endpoints.

## Why it no longer applies

Tables and columns now come from the Sankhya data dictionary (`TDDTAB`, `TDDCAM`, `TDDINS`),
discovered from the gateway and cached per connection. The allowlist of callable gateway services
is fixed in code: `executeQuery`, `loadRecords`, `DatasetSP.save` and the typed business-action
registry ([0008](0008-sankhya-gateway-only.md)).
