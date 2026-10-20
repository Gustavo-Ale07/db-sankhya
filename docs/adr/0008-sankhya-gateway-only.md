# 0008 — Sankhya through the gateway only

- Status: accepted. Supersedes [0001](0001-virtual-sql-layer.md) and
  [0002](0002-resource-registry.md).

## Context

The tool replaces an integration with another ERP. The Sankhya ERP can be reached through its HTTP
gateway with OAuth2 client credentials. A direct database connection would bypass the ERP's own
rules and need network access to the database and credentials that are much harder to scope.

## Decision

- The server talks to Sankhya **only through the gateway**, never to the ERP database.
- Reads use `DbExplorerSP.executeQuery`, after a fail-closed lexical gate and an AST allowlist, and
  only over tables present in the data dictionary.
- Writes use `DatasetSP.save` (`INSERT` / `UPDATE`) through immutable plans
  ([0010](0010-immutable-plans.md)). There is no `DELETE`: the gateway documents no generic delete
  service.
- Other gateway services are called only through a typed business-action registry: one entry per
  service, with its module, permission, entity, input schema, key and expected effect. There is no
  generic "call any service" endpoint.
- Credentials stay on the server, encrypted at rest for registered connections, and are redacted
  from every output.

## Consequences

- What the gateway does not offer is `UNSUPPORTED`, not emulated (see
  [capabilities.md](../capabilities.md)).
- `executeQuery` has no documented read-only guarantee; the app does not rely on one, and the
  integration user must have the least access it needs (see [sankhya.md](../sankhya.md)).
- Gateway limits (rate, serialized queries, row ceiling) shape the client: a request budget, a
  serial query lane, a circuit breaker and retries for idempotent calls only.
