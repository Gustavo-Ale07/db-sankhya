# 0007 — The AI assistant only suggests SQL

- Status: superseded — the AI assistant was removed during the migration to DB-Sankhya
  (see `docs/migration-plan.md`, Task 1.1).

## Context

Translating questions into the dialect is useful, but model output is untrusted, and ERP data
sent to a third party is a privacy concern. Customer names or product descriptions could also
contain text crafted as instructions (prompt injection).

## Decision

- The assistant is optional and disabled by default.
- It returns SQL and a short explanation; it never executes anything. The SQL is validated by the
  same parser and planner and shown to the user, who runs it explicitly. Writes still require
  preview and confirmation.
- Only the schema is sent by default. Result rows are sent only with `AI_SHARE_RESULT_DATA=true`,
  wrapped as untrusted data, with forged delimiters stripped.
- Every generation is audited.

## Consequences

The assistant cannot bypass permissions, flags or limits. Prompt injection hidden in ERP data
can, at worst, produce a bad suggestion that a human reviews before running.
