# Permissions

A permission says what a user may **attempt**. Holding it is never enough on its own: the policy
engine, the write switches, the plan confirmation and, when a rule asks for it, a second person's
approval can still refuse the request. See [security.md](security.md) for the policy rules and
[architecture.md](architecture.md#writes) for the write lifecycle.

## Reference

The table below is built from `PERMISSIONS`, `SYSTEM_ROLE_PERMISSIONS`
(`packages/shared/src/permissions.ts`) and `POLICY_ACTION_CLASS`
(`packages/shared/src/policy.ts`). Do not edit it by hand:

```bash
node scripts/permissions-doc.mjs           # rewrites the table
node scripts/permissions-doc.mjs --check   # fails when the table and the code differ
```

- **Policy class** `write`: default-deny. Every entity the request touches must be covered by an
  explicit policy `ALLOW` rule, on top of the permission.
- **Policy class** `permission-only`: allowed by the permission alone unless a `DENY` rule matches.
- **VIEWER / OPERATOR / ADMIN**: the seeded system roles. They cannot be deleted or edited.

<!-- permissions:start (written by scripts/permissions-doc.mjs) -->

| Permission                                 | Policy class    | VIEWER | OPERATOR | ADMIN | SUPER_ADMIN |
| ------------------------------------------ | --------------- | ------ | -------- | ----- | ----------- |
| `QUERY.SELECT`                             | permission-only | yes    | yes      | yes   | yes         |
| `TEMP.CREATE`                              | permission-only | yes    | yes      | yes   | yes         |
| `TEMP.WRITE`                               | permission-only | yes    | yes      | yes   | yes         |
| `TEMP.DROP`                                | permission-only | yes    | yes      | yes   | yes         |
| `TEMP.MATERIALIZE`                         | permission-only | yes    | yes      | yes   | yes         |
| `DATA.PREVIEW`                             | permission-only |        | yes      | yes   | yes         |
| `DATA.INSERT`                              | write           |        | yes      |       | yes         |
| `DATA.UPDATE`                              | write           |        | yes      |       | yes         |
| `DATA.DELETE`                              | write           |        |          |       | yes         |
| `DDL.CUSTOM.GENERATE`                      | write           |        |          |       | yes         |
| `SANKHYA.BUSINESS_ACTION.EXECUTE`          | write           |        |          |       | yes         |
| `SANKHYA.ACTION.CANCELAR_NOTA`             | write           |        |          |       | yes         |
| `SANKHYA.ACTION.INCLUIR_NOTA`              | write           |        |          |       | yes         |
| `SANKHYA.ACTION.INCLUIR_ALTERAR_ITEM_NOTA` | write           |        |          |       | yes         |
| `SANKHYA.ACTION.EXCLUIR_ITEM_NOTA`         | write           |        |          |       | yes         |
| `SERVER.DDL`                               | write           |        |          |       | yes         |
| `SERVER.DELETE`                            | write           |        |          |       | yes         |
| `SERVER.DML_RAW`                           | write           |        |          |       | yes         |
| `SERVER.DCL`                               | write           |        |          |       | yes         |
| `SERVER.PLSQL`                             | write           |        |          |       | yes         |
| `APPROVAL.DECIDE`                          | permission-only |        |          | yes   | yes         |
| `AUDIT.READ`                               | permission-only |        |          | yes   | yes         |
| `ADMIN.USERS`                              | permission-only |        |          | yes   | yes         |
| `ADMIN.GROUPS`                             | permission-only |        |          | yes   | yes         |
| `ADMIN.ROLES`                              | permission-only |        |          | yes   | yes         |
| `ADMIN.POLICIES`                           | permission-only |        |          | yes   | yes         |
| `ADMIN.CONNECTIONS`                        | permission-only |        |          | yes   | yes         |
| `ADMIN.SECURITY`                           | permission-only |        |          | yes   | yes         |
| `SECURITY.SEGREGATION_OVERRIDE`            | permission-only |        |          |       | yes         |

<!-- permissions:end -->

Notes:

- `ADMIN` administers the tool. It has no write `DATA.*` permission (`DATA.INSERT`, `DATA.UPDATE`,
  `DATA.DELETE`) and no `DDL.*` or `SANKHYA.*` permission, and there is no administrator bypass
  anywhere. Its only `DATA.*` permission is `DATA.PREVIEW`. An administrator who must also write ERP data needs a second
  role.
- No seeded role holds `DATA.DELETE`, `DDL.CUSTOM.GENERATE`, `SANKHYA.BUSINESS_ACTION.EXECUTE` or
  any `SANKHYA.ACTION.*` permission.
  Grant them through a custom role. `DATA.DELETE` has no effect on Sankhya tables today: a `DELETE`
  on a Sankhya table is `UNSUPPORTED` (see [capabilities.md](capabilities.md)). It applies to
  nothing else either, since scratch deletes use `TEMP.WRITE`.
- `DATA.PREVIEW` lets a user **see the preview** of an `INSERT` / `UPDATE` / `DELETE` plan on a
  Sankhya table without the statement permission, through `POST /api/query/preview` only (rollback
  plans and business actions still need their own permission). It never lets anyone execute: `execute` re-checks
  the statement permission (`DATA.INSERT` / `DATA.UPDATE` / `DATA.DELETE`) with fresh grants and
  refuses with `FORBIDDEN`, whatever the write switches say. Everything else still applies to the
  preview: the policy rules are evaluated for the **statement** action (so the entity still needs an
  explicit `ALLOW` for that action, and column / row `DENY` rules refuse it), the snapshot read is
  checked as `QUERY.SELECT`, and the `WHERE` rules hold. The preview response reports
  `operation` and `execution.permitted` (whether the caller holds the permission to execute it).
  A plan the owner may not execute cannot be submitted for approval either. `DATA.PREVIEW` is not a
  policy action and does not conflict with `ADMIN.POLICIES`.
- No permission allows DDL on native ERP tables. It is refused for every role.
- Permission strings outside the catalog are ignored when roles are resolved.

## Where each permission is checked

| Permission                        | Routes and behaviour                                                                                                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QUERY.SELECT`                    | `POST /api/query` (Sankhya reads), `GET /api/schema`, `GET /api/connections`, `GET /api/scratch/tables`, scratch `SELECT` in `POST /api/scratch/exec`, materialization                                                       |
| `TEMP.CREATE`                     | scratch `CREATE TABLE` / `ALTER TABLE` of a `tmp_` table (`POST /api/scratch/exec`)                                                                                                                                          |
| `TEMP.WRITE`                      | scratch `INSERT` / `UPDATE` / `DELETE` (`POST /api/scratch/exec`, and plans for `tmp_` tables through `POST /api/query/preview`)                                                                                             |
| `TEMP.DROP`                       | scratch `DROP TABLE` (`POST /api/scratch/exec`)                                                                                                                                                                              |
| `TEMP.MATERIALIZE`                | `POST /api/scratch/materialize` (with `QUERY.SELECT`), evaluated on both the scratch side and the Sankhya source side                                                                                                        |
| `DATA.PREVIEW`                    | `POST /api/query/preview` for Sankhya `INSERT` / `UPDATE` / `DELETE` without the statement permission; never `execute`; policy evaluated on the statement action                                                             |
| `DATA.INSERT`                     | `INSERT` plans on Sankhya tables (`POST /api/query/preview`, `POST /api/query/execute`)                                                                                                                                      |
| `DATA.UPDATE`                     | `UPDATE` plans on Sankhya tables, including assisted rollback plans                                                                                                                                                          |
| `DATA.DELETE`                     | checked for `DELETE` statements; a Sankhya `DELETE` is still refused as unsupported                                                                                                                                          |
| `DDL.CUSTOM.GENERATE`             | `POST /api/ddl/artifact`: generates Add-on Studio files for custom-prefix tables, never executes DDL                                                                                                                         |
| `SANKHYA.BUSINESS_ACTION.EXECUTE` | `POST /api/actions/:id/prepare` and `/execute`: needed for every business action, together with the action's own permission                                                                                                  |
| `SANKHYA.ACTION.*`                | the one action it names (`CANCELAR_NOTA`, `INCLUIR_NOTA`, `INCLUIR_ALTERAR_ITEM_NOTA`, `EXCLUIR_ITEM_NOTA`); the policy decides on it and on `SANKHYA.BUSINESS_ACTION.EXECUTE`, with every table and column the action sends |
| `APPROVAL.DECIDE`                 | `GET /api/approvals/pending`, `POST /api/approvals/:id/decision`, the **Aprovações** page                                                                                                                                    |
| `AUDIT.READ`                      | `GET /api/audit`, `POST /api/audit/:id/rollback-plan`, the **Auditoria** page                                                                                                                                                |
| `ADMIN.USERS`                     | `/api/admin/users` (assigning roles also needs `ADMIN.ROLES`)                                                                                                                                                                |
| `ADMIN.GROUPS`                    | `/api/admin/groups` (granting roles to a group also needs `ADMIN.ROLES`)                                                                                                                                                     |
| `ADMIN.ROLES`                     | `/api/admin/roles`                                                                                                                                                                                                           |
| `ADMIN.POLICIES`                  | `/api/admin/policies` (changing a rule is refused to an account that also holds a write `DATA.*`, `DDL.*` or `SANKHYA.*` permission)                                                                                         |
| `ADMIN.CONNECTIONS`               | `/api/admin/connections` (create, edit, replace secrets, test, delete)                                                                                                                                                       |
| `ADMIN.SECURITY`                  | `GET` / `PUT /api/admin/security` (the runtime write kill switch), cancelling another user's running query                                                                                                                   |

Authenticated routes that need no specific permission: `GET /api/status`, `GET /api/auth/me`,
logout, password change, history, saved queries, `POST /api/query/cancel` for one's own
executions, and `POST /api/approvals` (the plan owner asks for approval; the owner must hold the permissions
the plan needs to execute). `GET /health/live`,
`GET /health/ready` and `GET /api/meta` are public.

## Upgrading from an earlier version

The permission catalog replaced the earlier role model. When the RBAC migration runs:

- a legacy `ADMIN` keeps administering the tool but **loses every `DATA.*` permission**. An
  administrator who also wrote data needs the `OPERATOR` role (or a custom role) added;
- nobody holds `DATA.DELETE` afterwards;
- migration `0012` grants `DATA.PREVIEW` to `ADMIN` and `OPERATOR` (it grants it again if an
  administrator removed it before upgrading);
- write permissions alone change nothing: writes are default-deny until an administrator creates
  matching `ALLOW` policy rules (**Políticas**).
