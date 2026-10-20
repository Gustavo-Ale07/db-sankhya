# 0009 — A policy engine on top of permissions

- Status: accepted.

## Context

Roles answer "may this user attempt this kind of action". They cannot express "only these tables",
"never in production", "at most 20 rows" or "a second person must approve", and the earlier role
model let administrators do everything.

## Decision

- A fixed permission catalog (`packages/shared/src/permissions.ts`) and seeded roles `VIEWER`,
  `OPERATOR` and `ADMIN`. `ADMIN` administers the tool and holds no `DATA.*`, `DDL.*` or
  `SANKHYA.*` permission. There is no administrator bypass anywhere.
- A pure policy engine (`packages/shared/src/policy.ts`) evaluates stored rules after the
  permission check, for reads, writes, scratch, materialization, DDL artifacts and business
  actions. Rules target users, groups or everyone, and filter by environment, connection, action,
  entity and column.
- `DENY` always wins. Write actions are **default-deny**: each entity needs an explicit `ALLOW`.
  Limits combine to the most restrictive value. `PRODUCTION` writes always need strong
  confirmation. Writes without `WHERE` need an explicit override, which forces approval.
- The policy version is frozen into each plan and checked again at execution.

## Consequences

- A fresh installation cannot write anything until an administrator creates `ALLOW` rules, even
  for users with write permissions.
- Upgrading from the earlier role model removes `DATA.*` from legacy administrators.
- The permission reference is built from the code ([permissions.md](../permissions.md)).
