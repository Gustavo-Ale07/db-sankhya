# 0003 — Writes need a preview and a single-use confirmation

- Status: superseded — the original ERP integration was removed.

## What it decided

Writes to the previous ERP API went through plan, preview with before/after values, a single-use confirmation token bound to user, session and statement hash, revalidation, sequential execution and audit.

## Why it no longer applies

That write path was removed with the integration it served. Mutations are not available yet and fail closed with `SQL_UNSUPPORTED`; the Sankhya write path will get its own decision record.
