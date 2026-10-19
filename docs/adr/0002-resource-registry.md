# 0002 — A declarative resource registry

- Status: superseded — the original ERP integration was removed.

## What it decided

A hand-written registry declared every virtual table: endpoints, columns, JSON paths, pushdown filters and write operations. It was the allowlist of callable endpoints.

## Why it no longer applies

Tables and columns now come from the Sankhya data dictionary, discovered from the gateway and cached per connection.
