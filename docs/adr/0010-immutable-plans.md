# 0010 — Writes run as immutable plans

- Status: accepted. Supersedes [0003](0003-write-confirmation.md) and
  [0004](0004-no-transactions.md).

## Context

`DatasetSP.save` changes one record per call, has no transaction across calls and no idempotency
key. A retried or replayed save can apply a change twice; a lost answer leaves the outcome unknown.
Between a preview and its execution, the rows, the rules or the switches can change.

## Decision

- A write is prepared first (`PARSE → VALIDATE → AUTHORIZE → PLAN → PREVIEW → IMPACT`) without
  writing anything, and stored as an immutable plan with a hash.
- The token is an HMAC over the plan id, its hash and the session, expires after
  `PLAN_TTL_SECONDS` and is consumed at most once. A repeat with the same idempotency key returns
  the stored result.
- Execution (`CONFIRM → RE-AUTHORIZE → EXECUTE → VERIFY → AUDIT`) checks again the permissions,
  the policy version, the capability, the target rows and the kill switches, and checks the
  switches and the policy version before every gateway call.
- Each save is sent exactly once and never retried. An unclear outcome is `WRITE_OUTCOME_UNKNOWN`.
- Every changed row is read back by key and the run is labelled `VERIFIED`, `PARTIALLY_VERIFIED`,
  `UNVERIFIED` or `FAILED`. Previews say what they prove: `SIMULATED_PREVIEW`,
  `TRANSACTIONAL_DRY_RUN` or `IMPACT_ANALYSIS`.
- Rules can require a typed confirmation phrase and a second person's approval, bound to the plan
  hash.
- Rollback is never automatic: an assisted rollback is a new plan built from the audit snapshots.

## Consequences

- A multi-row plan can stop part way; the report and the audit show exactly which rows were
  changed, not attempted or unknown.
- Operators must check the ERP before acting on an unknown outcome (see
  [operations.md](../operations.md#operator-notes)).
