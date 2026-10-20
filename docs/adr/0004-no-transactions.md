# 0004 — No transactions and no write retries

- Status: superseded by [0010](0010-immutable-plans.md).

## What it decided

The previous ERP API had no transactions and no idempotency keys, so writes ran one call per
record, stopped at the first failure and were never retried.

## Why it no longer applies

That write path was removed. The same constraints hold for the Sankhya gateway (`DatasetSP.save`
has no transaction across calls) and are handled by [0010](0010-immutable-plans.md): one call per
row, never retried, an unclear outcome reported as `WRITE_OUTCOME_UNKNOWN`, and every row read back
and labelled.
