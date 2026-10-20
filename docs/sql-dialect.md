# SQL dialect

Reads run on the Sankhya database behind the gateway, in that database's own SQL dialect
(`SANKHYA_DIALECT`: `oracle` or `mssql`). The server does not translate the statement; it checks
it and sends it as written. Table and column names are the ones shown in the schema tree, which
comes from the Sankhya data dictionary.

One statement runs at a time. In the editor, `Ctrl+Enter` runs the statement under the cursor
(statements are separated by `;`).

## What is accepted

Only a single `SELECT`. Before anything reaches the gateway the statement goes through two
fail-closed checks:

1. **Token gate** (`packages/sql-engine/src/gate.ts`). Refused with `SQL_FORBIDDEN`:
   - comments (`--`, `/* … */`) and more than one statement;
   - write, DDL, transaction and procedural keywords (`INSERT`, `UPDATE`, `DELETE`, `MERGE`,
     `INTO`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `EXEC`, `BEGIN`, `COMMIT`, `SET`, …);
   - package and system prefixes (`DBMS_`, `UTL_`, `XP_`, `SP_`, `SYS.`, …), sequences
     (`NEXTVAL`, `CURRVAL`), `OPENQUERY` / `OPENROWSET`, and `@` (db links, variables).
2. **Read analyzer** (`packages/sql-engine/src/read-analyzer.ts`). Parses the statement and
   walks every node. Any node type, clause or function it does not explicitly know is refused.
   Functions are checked against an allowlist (`packages/sql-engine/src/functions.ts`).

Every table the statement reads must exist in the connection's catalog. Words inside string
literals or quoted identifiers do not trip the gate (`WHERE NOMEPARC = 'DELETE'` is fine).

```sql
SELECT CODPARC, NOMEPARC, CODCID
FROM TGFPAR
WHERE ATIVO = 'S'
ORDER BY NOMEPARC;

SELECT P.CODPARC, P.NOMEPARC, C.NOMECID
FROM TGFPAR P
JOIN TSICID C ON C.CODCID = P.CODCID;
```

## Row cap

The server returns at most `SANKHYA_MAX_ROWS` rows (default 1000). When more rows exist the result says
`truncated: true` and the UI shows a message; the rows are never cut silently. When it is safe
the cap is applied by wrapping the statement; otherwise the server stops reading at the cap.

## Known refusals

The analyzer is deliberately narrow. Some constructs are refused even though the database accepts
them:

- `EXISTS (subquery)` is refused ("Function EXISTS is not allowed."). Rewrite it with
  `IN (subquery)` or a `JOIN`, which are accepted.
- Hexadecimal literals such as `0x1F` are refused by the gate.

## Writes

`POST /api/query` runs reads only. `INSERT` and `UPDATE` of Sankhya tables are written in the same
dialect but run as previewed plans through the write dialog (`POST /api/query/preview`, then
`/api/query/execute`); `DELETE` and native DDL are not supported on Sankhya tables. Each
`INSERT` needs an explicit column list and a single `VALUES` row. See
[capabilities.md](capabilities.md) and [architecture.md](architecture.md#writes).

Statements over `tmp_` tables run in the scratch workspace, which uses PostgreSQL syntax (PGlite),
not the ERP dialect.
