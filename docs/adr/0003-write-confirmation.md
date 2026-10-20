# 0003 — Writes need a preview and a single-use confirmation

- Status: superseded by [0010](0010-immutable-plans.md).

## What it decided

Writes to the previous ERP API went through plan, preview with before/after values, a single-use
confirmation token bound to user, session and statement hash, revalidation, sequential execution
and audit.

## Why it no longer applies

That write path was removed with the integration it served. Its ideas carried over: Sankhya writes
run as immutable plans with a hashed, session-bound, single-use token, re-authorization and
verification, described in [0010](0010-immutable-plans.md).
