# 0007 — SQL suggestions never execute

- Status: superseded — the natural-language SQL suggestion feature was removed during the migration
  to DB-Sankhya.

## What it decided

An earlier version had an optional, disabled-by-default feature that turned a question written in
plain language into a suggested SQL statement with a short explanation. It decided that a
suggestion is untrusted input: it was never executed, it was validated by the same parser and
planner as typed SQL, shown to the user and run only by them, writes still needed preview and
confirmation, only the schema was sent by default, and every request was audited.

## Why it no longer applies

The feature and its settings were removed. Every statement is now typed by a user and goes through
the same gate, capability resolution, policy and plan lifecycle (see
[architecture.md](../architecture.md)). The principle stays: nothing runs without an explicit,
checked request from an authorized user.
