# Writing to the base de testes (HOMOLOGATION)

How to let one user run `INSERT`/`UPDATE` (through `DatasetSP.save`) and the note business
actions on a connection labelled `HOMOLOGATION`, without opening anything on `PRODUCTION`.

Three layers must agree. If any one of them says no, nothing is written:

1. **Switches** (server `.env`): `GLOBAL_WRITE_ENABLED`, then `WRITE_TO_SANKHYA`, then
   `SAFE_MODE`. `SAFE_MODE=true` refuses only plans whose environment is `PRODUCTION`, so it stays
   `true`. Business actions also need their id in `BUSINESS_ACTIONS_ENABLED`.
2. **dbExplorer permissions and policy**: the role gives the permission, and an `ALLOW` rule for
   the user, environment `HOMOLOGATION` and the target tables decides it. `Administrador` (ADMIN)
   gets no write permission by default. A user who edits policies cannot hold one either
   (separation of duties), so the writer is a separate account.
3. **The Sankhya side**: the integration user/app behind `SANKHYA_CLIENT_ID` / `SANKHYA_X_TOKEN`
   must be allowed to call the write service. If it is not, the gateway answers "Não autorizado"
   (see [below](#when-the-gateway-answers-não-autorizado)).

> The environment is a **label** (`SANKHYA_ENVIRONMENT`, default `PRODUCTION`). It does not check
> where the credentials point. If the credentials are ever switched to production while the label
> stays `HOMOLOGATION`, `SAFE_MODE` would not stop a write. Change the label and the credentials
> together.

## 1. Server `.env`

```dotenv
SANKHYA_ENVIRONMENT=HOMOLOGATION   # only with credentials for the base de testes
SAFE_MODE=true                     # keep: still locks PRODUCTION
GLOBAL_WRITE_ENABLED=true
WRITE_TO_SANKHYA=true
# Only if the note actions will be used. Never SelecaoDocumentoSP.faturar (not implemented):
BUSINESS_ACTIONS_ENABLED=CACSP.cancelarNota,CACSP.incluirNota,CACSP.incluirAlterarItemNota,CACSP.excluirItemNota
```

`BUSINESS_ACTIONS_ENABLED` applies to every live connection, whatever its label, so on an
installation that also has a `PRODUCTION` connection the policy (step 2, environment
`HOMOLOGATION` only) is what keeps the actions off production. Restart the app after editing the
file.

## 2a. Seed (command line)

With the API stopped (the local PGlite is single-process) or inside the app container:

```sh
pnpm --filter @dbx/api admin grant-homolog-writes --email <writer e-mail> --entities AD_TABLE1,AD_TABLE2
# with the note actions:
pnpm --filter @dbx/api admin grant-homolog-writes --email <writer e-mail> --entities AD_TABLE1 --actions
```

It is idempotent and only adds:

- role `HOMOLOG_WRITER` (not a system role) with `QUERY.SELECT`, `DATA.PREVIEW`, `DATA.INSERT`,
  `DATA.UPDATE`; with `--actions` also `SANKHYA.BUSINESS_ACTION.EXECUTE` and every
  `SANKHYA.ACTION.*`; assigned to the user;
- rule `homologation writes: <e-mail>`: `ALLOW`, that user, environment `HOMOLOGATION`,
  `DATA.INSERT` + `DATA.UPDATE`, the listed tables (plain names only; `*`, `TGF*` and
  `schema.table` are refused);
- with `--actions`, rule `homologation business actions: <e-mail>`: `ALLOW`, that user,
  `HOMOLOGATION`, the action permissions, tables `TGFCAB` and `TGFITE`;
- an audit event `policy.homolog_grant`.

It refuses a user who holds `ADMIN.POLICIES`, gives no `DATA.DELETE`, no DDL, nothing for
`PRODUCTION` or `SANDBOX`, and does not touch any switch.

## 2b. The same in the UI (Papéis / Usuários / Políticas)

Done by a policy administrator, for a **different** user (the writer).

1. **Papéis → Novo papel.** Chave `HOMOLOG_WRITER`, a description, and the permissions
   `QUERY.SELECT`, `DATA.PREVIEW`, `DATA.INSERT`, `DATA.UPDATE`. For the note actions add
   `SANKHYA.BUSINESS_ACTION.EXECUTE` and the `SANKHYA.ACTION.*` needed (`CANCELAR_NOTA`,
   `INCLUIR_NOTA`, `INCLUIR_ALTERAR_ITEM_NOTA`, `EXCLUIR_ITEM_NOTA`). The `OPERATOR` system role
   already carries `DATA.INSERT`/`DATA.UPDATE` and can be used instead for plain writes.
2. **Usuários.** Open the writer, give them that role. Do not give them `ADMIN`; the API refuses a
   write permission for anyone who edits policies.
3. **Políticas → Nova política** (data writes):
   - Efeito: `ALLOW (permitir)`; Quem: `Um usuário` → the writer;
   - Ambientes: tick **only** `HOMOLOGATION` (none ticked means _all_, including production);
   - Ações (obrigatório): `DATA.INSERT`, `DATA.UPDATE`;
   - Tabelas (vírgula): the target tables, by name (for example `AD_MANIPULADADOS`);
   - Colunas: empty (all columns of those tables), or a list to narrow it;
   - Conexões: empty, or the HOMOLOGATION connection id.
4. **Políticas → Nova política** (note actions, only if used): same as above with Ações
   `SANKHYA.BUSINESS_ACTION.EXECUTE` + the `SANKHYA.ACTION.*` chosen, Tabelas `TGFCAB, TGFITE`.
   Both the action's own permission and `SANKHYA.BUSINESS_ACTION.EXECUTE` are decided by policy,
   on every table and column the action reads or writes.

A `DENY` anywhere still wins over these rules.

## 3. The write cycle

Editor → statement → **Prévia** (plan with ANTES × DEPOIS rows, immutable) → **Confirmar** →
execute (`DatasetSP.save`, sent once) → read-back → `VERIFIED` or `FAILED` → audit
(`PLAN_CREATED`, `PLAN_CONFIRMED`, `PLAN_EXECUTED`/`PLAN_FAILED`). `DELETE` and DDL on Sankhya
tables stay `OPERATION_NOT_SUPPORTED`: removing an item of a note is the action
`CACSP.excluirItemNota`, and "deleting" an ERP record is an `UPDATE … SET ATIVO = 'N'` where that
column exists.

## When the gateway answers "Não autorizado"

The gateway answers HTTP 200 with
`{"serviceName":"DatasetSP.save","status":"0",…,"statusMessage":"Não autorizado"}`. The API reports
`SANKHYA_WRITE_NOT_AUTHORIZED` (403) and the editor shows "Gravação via API não liberada para este
usuário no Gateway (DatasetSP.save)". The call is not repeated and nothing is changed in the ERP.

This is decided by Sankhya, not by dbExplorer. What it means:

- **Service:** `DatasetSP.save` (module `mge`); for actions, `CACSP.*` (module `mgecom`).
- **Who:** the integration user/app identified by the client id and X-Token in the `.env`
  (the ERP user the integration app runs as).
- **Entity:** the instance of the table being written (for example `AD_MANIPULADADOS`).

To release it, someone with admin access to that Sankhya environment:

1. In the **Sankhya Developer portal / Área do desenvolvedor**, on the integration app (the one
   whose client id is in the `.env`): check that the app is linked to this environment and that the
   services `DatasetSP.save` (and, for the actions, `CACSP.incluirNota`, `CACSP.incluirAlterarItemNota`,
   `CACSP.excluirItemNota`, `CACSP.cancelarNota`) are among the services it is allowed to call.
2. In the **ERP (Sankhya Om)**, on the user the integration runs as
   (Configurações → Usuários / Segurança → Controle de acesso): give it _inclusão_ and _alteração_
   on the screen/instance of the target table (for `AD_*` tables, the screen built on that
   instance), and for notes the access to the Central de Notas / portal de movimentação and the
   operation types (TOP) that will be used.
3. Run one write again through the editor and read the answer.

The menu names above are the usual ones and were **not verified** on this installation. Do not
change ERP security tables (users, access, permissions) with SQL, and do not try another service to
get around the refusal.

## Reading larger tables (`SANKHYA_MAX_ROWS`)

`SANKHYA_MAX_ROWS` (default 1000, accepted up to 100 000) caps the rows of one Sankhya read,
including the copy into a `tmp_` table. Raising it costs:

- gateway time and payload per read grow with the rows (each read is one `executeQuery` answer,
  serialized per connection, so a long read delays the next one);
- API memory: the whole answer is held and parsed before it is shown or copied;
- scratch (PGlite/Postgres) size and the browser grid for the copied rows;
- the ERP still caps an `executeQuery` answer with its own parameter `DBEXPMAXROW` (default 5000,
  **parâmetro a verificar no ERP**), so a value above it does not bring more rows unless the ERP
  parameter is raised too. The `CREATE TABLE tmp_… AS SELECT` preview warns when the copy hit the
  cap.

A value like 5000 (matching `DBEXPMAXROW`) is a reasonable step; going further needs the ERP
parameter changed and is better done in pages with `WHERE` ranges.
