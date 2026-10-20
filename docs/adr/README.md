# Architecture decision records

| #                                    | Decision                                                           |
| ------------------------------------ | ------------------------------------------------------------------ |
| [0001](0001-virtual-sql-layer.md)    | A virtual SQL layer over a REST ERP API (superseded by 0008)       |
| [0002](0002-resource-registry.md)    | A declarative resource registry (superseded by 0008)               |
| [0003](0003-write-confirmation.md)   | Writes need a preview and a confirmation (superseded by 0010)      |
| [0004](0004-no-transactions.md)      | No transactions and no write retries (superseded by 0010)          |
| [0005](0005-single-origin-server.md) | One server process serves API and UI; credentials stay there       |
| [0006](0006-typescript-monorepo.md)  | TypeScript monorepo: Fastify, React, Drizzle, PostgreSQL           |
| [0007](0007-suggestions-only.md)     | SQL suggestions never execute (superseded: feature removed)        |
| [0008](0008-sankhya-gateway-only.md) | Sankhya through the gateway only                                   |
| [0009](0009-policy-engine.md)        | A policy engine on top of permissions; writes are default-deny     |
| [0010](0010-immutable-plans.md)      | Writes run as immutable, confirmed, verified plans                 |
| [0011](0011-scratch-pglite.md)       | A per-user scratch workspace in PGlite                             |
| [0012](0012-ddl-as-artifacts.md)     | Custom DDL is generated as Add-on Studio artifacts, never executed |
