# 0004 — No transactions and no write retries

- Status: superseded — the original ERP integration was removed.

## What it decided

The previous ERP API had no transactions and no idempotency keys, so writes ran one call per record, stopped at the first failure and were never retried.

## Why it no longer applies

That write path was removed. Only idempotent gateway calls are retried today; the Sankhya write path will get its own decision record.
