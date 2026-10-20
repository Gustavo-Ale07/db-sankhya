# 0012 — Custom DDL is generated as artifacts, never executed

- Status: accepted.

## Context

Custom tables in a Sankhya installation are deployed through the ERP's own tooling, which also
registers them in the data dictionary. Running DDL through the gateway would bypass that and could
damage native tables.

## Decision

- DDL on native tables is unsupported for every role.
- `CREATE`, `ALTER` and `DROP` of a table whose name starts with a `CUSTOM_TABLE_PREFIXES` prefix
  (default `AD_`) are turned into Add-on Studio files (AutoDDL `<TABLE>.xml` and/or dbscript
  `V<n>.xml`) by `POST /api/ddl/artifact`, with `DDL.CUSTOM.GENERATE` and a policy `ALLOW`.
- The server never executes them. An administrator reviews and deploys them.
- A change the dictionary cannot prove safe is destructive and needs the typed confirmation
  `DESTRUCTIVE <TABLE>`. Every generation and refusal is audited.

## Consequences

- The capability is `SUPPORTED_VIA_GENERATED_ARTIFACT`, not `SUPPORTED`.
- The dbscript format has not been validated against a real importer; review the files before
  deploying them.
