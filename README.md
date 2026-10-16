# DB-Sankhya

DB-Sankhya is an independent, security-focused database exploration and administration interface designed to integrate with Sankhya ERP through supported APIs and platform mechanisms.

> **Status:** active development. The repository is currently being adapted from an existing database explorer foundation. Features documented here describe the intended direction unless explicitly marked as implemented.

## Goals

- Provide a modern SQL-like workspace for exploring Sankhya data.
- Respect Sankhya's supported APIs, permissions, business rules, and extension mechanisms.
- Keep read operations convenient while requiring preview, authorization, confirmation, verification, and audit for state-changing operations.
- Support application-level users, groups, roles, granular permissions, and approval workflows.
- Provide an isolated scratch workspace for temporary tables and local analysis without creating unsafe objects in the ERP.
- Be safe to publish as a generic open-source-style portfolio project while remaining deployable in private production environments through external configuration.

## Security principles

- No production credentials or customer/company data belong in this repository.
- Secrets must be injected at runtime and must never be committed.
- Mutating operations must be authorized server-side.
- Explicit deny rules take precedence over allow rules.
- Dangerous operations require stronger confirmation and may require independent approval.
- Native Sankhya database structures must not be treated as unrestricted SQL targets.
- The application must fail closed when a requested write cannot be parsed or mapped safely to a supported mechanism.

## Public code vs. private deployment

This repository contains the generic application code only. A private deployment may supply its own credentials, users, policies, URLs, databases, logs, backups, and environment-specific configuration outside Git.

```text
public repository
      |
      | generic application code
      v
private deployment
      |
      +-- runtime secrets
      +-- Sankhya credentials
      +-- users and policies
      +-- environment configuration
      +-- operational data
```

## Planned architecture

```text
SQL / UI action
      |
      v
Parser / Validator
      |
      v
Policy Engine
      |
      v
Planner / Capability Resolver
      |
      +--> Sankhya adapter
      |
      +--> Scratch workspace
      |
      v
Preview / Confirmation / Execution / Verification / Audit
```

## Development

Detailed setup instructions will be added as the Sankhya adaptation stabilizes. Until then, do not place real credentials, production dumps, company-specific fixtures, or private infrastructure details in the repository.

## Disclaimer

DB-Sankhya is an independent project and is not an official Sankhya product. Sankhya names and platform concepts may be referenced solely for compatibility and integration purposes.

## Maintainer

Maintained by [Gustavo-Ale07](https://github.com/Gustavo-Ale07).
