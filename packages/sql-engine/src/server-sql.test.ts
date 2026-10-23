import { describe, expect, it } from 'vitest';
import { AppError } from '@dbx/shared';
import {
  assertServerSqlAllowed,
  classifyServerSql,
  serverSqlTarget,
  serverSqlWhere,
  serverSqlSources,
  wrapServerSql,
  SERVER_SQL_CATEGORIES,
  type ServerSqlGate,
} from './server-sql';

const ON: ServerSqlGate = {
  serverSqlEnabled: true,
  globalWriteEnabled: true,
  writeToSankhya: true,
  safeMode: true,
  productionOptIn: false,
};
const codeOf = (fn: () => void): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.code : 'NOT_APP_ERROR';
  }
  return 'NO_THROW';
};

describe('assertServerSqlAllowed', () => {
  it('allows HOMOLOGATION and SANDBOX when every switch is on', () => {
    expect(() => assertServerSqlAllowed(ON, 'HOMOLOGATION')).not.toThrow();
    expect(() => assertServerSqlAllowed(ON, 'SANDBOX')).not.toThrow();
  });

  it('is off by the master switch first of all', () => {
    expect(
      codeOf(() => assertServerSqlAllowed({ ...ON, serverSqlEnabled: false }, 'HOMOLOGATION')),
    ).toBe('SERVER_SQL_DISABLED');
  });

  it('respects GLOBAL_WRITE_ENABLED and WRITE_TO_SANKHYA', () => {
    expect(
      codeOf(() => assertServerSqlAllowed({ ...ON, globalWriteEnabled: false }, 'HOMOLOGATION')),
    ).toBe('READ_ONLY_MODE');
    expect(
      codeOf(() => assertServerSqlAllowed({ ...ON, writeToSankhya: false }, 'HOMOLOGATION')),
    ).toBe('READ_ONLY_MODE');
  });

  it('blocks PRODUCTION unless opted in, and even then not under SAFE_MODE', () => {
    expect(codeOf(() => assertServerSqlAllowed(ON, 'PRODUCTION'))).toBe(
      'SERVER_SQL_PRODUCTION_BLOCKED',
    );
    expect(
      codeOf(() =>
        assertServerSqlAllowed({ ...ON, productionOptIn: true, safeMode: true }, 'PRODUCTION'),
      ),
    ).toBe('SERVER_SQL_PRODUCTION_BLOCKED');
    expect(() =>
      assertServerSqlAllowed({ ...ON, productionOptIn: true, safeMode: false }, 'PRODUCTION'),
    ).not.toThrow();
  });
});

describe('classifyServerSql', () => {
  it('routes DDL verbs on any object to DDL', () => {
    for (const sql of [
      'CREATE INDEX ix ON TGFCAB (NUNOTA)',
      'ALTER TABLE AD_X MODIFY (NOME VARCHAR2(10))',
      'DROP VIEW V_X',
      'TRUNCATE TABLE AD_X',
      "COMMENT ON COLUMN AD_X.NOME IS 'x'",
      'CREATE OR REPLACE VIEW V AS SELECT 1 FROM DUAL',
    ]) {
      expect(classifyServerSql(sql).category, sql).toBe('DDL');
    }
  });

  it('routes RENAME to DDL', () => {
    expect(classifyServerSql('RENAME AD_OLD TO AD_NEW').category).toBe('DDL');
    expect(classifyServerSql('ALTER TABLE AD_X RENAME TO AD_Y').category).toBe('DDL');
  });

  it('routes a generic DELETE to DELETE', () => {
    expect(classifyServerSql('DELETE FROM TGFCAB WHERE NUNOTA = 1').category).toBe('DELETE');
  });

  it('routes MERGE, INSERT…SELECT and expression UPDATE to DML_RAW', () => {
    expect(
      classifyServerSql('MERGE INTO A USING B ON (A.ID=B.ID) WHEN MATCHED THEN UPDATE SET A.N=B.N')
        .category,
    ).toBe('DML_RAW');
    expect(classifyServerSql('INSERT INTO A (ID) SELECT ID FROM B').category).toBe('DML_RAW');
    expect(classifyServerSql('UPDATE A SET N = N + 1 WHERE ID = 1').category).toBe('DML_RAW');
  });

  it('routes GRANT/REVOKE to DCL', () => {
    expect(classifyServerSql('GRANT SELECT ON TGFCAB TO PLACFESTASTST').category).toBe('DCL');
    expect(classifyServerSql('REVOKE SELECT ON TGFCAB FROM PLACFESTASTST').category).toBe('DCL');
  });

  it('routes PL/SQL blocks and procedure calls to PLSQL', () => {
    for (const sql of [
      'BEGIN NULL; END;',
      'DECLARE x NUMBER; BEGIN x := 1; END;',
      'CALL MY_PROC(1)',
      'EXEC MY_PROC(1)',
      'EXECUTE MY_PROC(1)',
    ]) {
      expect(classifyServerSql(sql).category, sql).toBe('PLSQL');
    }
  });

  it('never claims a SELECT or an empty/garbage statement', () => {
    expect(classifyServerSql('SELECT 1 FROM DUAL').category).toBe('UNSUPPORTED');
    expect(classifyServerSql('   ').category).toBe('UNSUPPORTED');
    expect(classifyServerSql('-- just a comment').category).toBe('UNSUPPORTED');
  });

  it('keyword match ignores a leading comment and is case-insensitive', () => {
    expect(classifyServerSql('/* c */ delete from a where id=1').category).toBe('DELETE');
  });

  it('every category is one of the declared set', () => {
    const c = classifyServerSql('DROP TABLE AD_X').category;
    expect(SERVER_SQL_CATEGORIES).toContain(c);
  });
});

describe('wrapServerSql', () => {
  it('runs raw DML through EXECUTE IMMEDIATE so Oracle executes exactly one statement', () => {
    const block = wrapServerSql('DELETE FROM TGFCAB WHERE NUNOTA = 1', 'DELETE');
    expect(block).toBe("BEGIN\nEXECUTE IMMEDIATE q'[DELETE FROM TGFCAB WHERE NUNOTA = 1]';\nEND;");
  });

  it('strips a trailing semicolon from the DML before wrapping it in EXECUTE IMMEDIATE', () => {
    const block = wrapServerSql('UPDATE A SET N = 1 WHERE ID = 2;', 'DML_RAW');
    expect(block).toBe("BEGIN\nEXECUTE IMMEDIATE q'[UPDATE A SET N = 1 WHERE ID = 2]';\nEND;");
  });

  it('wraps a raw-DML payload holding an Oracle q-quote literal without corrupting it', () => {
    // The ansi lexer cannot reason about q'[…]'; EXECUTE IMMEDIATE + a non-colliding delimiter makes
    // Oracle parse the whole payload as one dynamic statement, so a `;` inside the q-quote is inert.
    const block = wrapServerSql("DELETE FROM T WHERE C = q'[a;b]'", 'DELETE');
    expect(block).toContain('EXECUTE IMMEDIATE q');
    expect(block.startsWith('BEGIN\nEXECUTE IMMEDIATE q')).toBe(true);
    // The chosen outer delimiter's closing sequence must not appear inside the payload.
    const m = /EXECUTE IMMEDIATE q'(.)/.exec(block);
    const open = m?.[1] as string;
    const close =
      ({ '[': ']', '{': '}', '<': '>', '(': ')' } as Record<string, string>)[open] ?? open;
    const payload = block.slice(block.indexOf(`q'${open}`) + 3, block.lastIndexOf(`${close}'`));
    expect(payload.includes(`${close}'`)).toBe(false);
  });

  it('wraps DDL in EXECUTE IMMEDIATE with q-quoting and no trailing semicolon inside', () => {
    const block = wrapServerSql('ALTER TABLE AD_X MODIFY (NOME VARCHAR2(10));', 'DDL');
    expect(block).toBe(
      "BEGIN\nEXECUTE IMMEDIATE q'[ALTER TABLE AD_X MODIFY (NOME VARCHAR2(10))]';\nEND;",
    );
  });

  it('wraps DCL like DDL, via EXECUTE IMMEDIATE', () => {
    const block = wrapServerSql('GRANT SELECT ON TGFCAB TO U', 'DCL');
    expect(block).toBe("BEGIN\nEXECUTE IMMEDIATE q'[GRANT SELECT ON TGFCAB TO U]';\nEND;");
  });

  it('picks an alternative q-delimiter when the SQL contains the closing sequence', () => {
    // Contains `]'` which would close q'[ … ]'. Must switch delimiter, not corrupt the block.
    const block = wrapServerSql("CREATE INDEX ix ON A (x) /* ]' */", 'DDL');
    expect(block).toContain('EXECUTE IMMEDIATE q');
    // The chosen delimiter's closing sequence must not appear inside the payload.
    const m = /EXECUTE IMMEDIATE q'(.)/.exec(block);
    const open = m?.[1] as string;
    const close =
      ({ '[': ']', '{': '}', '<': '>', '(': ')' } as Record<string, string>)[open] ?? open;
    const payload = block.slice(block.indexOf(`q'${open}`) + 3, block.lastIndexOf(`${close}'`));
    expect(payload.includes(`${close}'`)).toBe(false);
  });

  it('passes an existing PL/SQL block through unchanged except for trimming', () => {
    expect(wrapServerSql('  BEGIN NULL; END;  ', 'PLSQL')).toBe('BEGIN NULL; END;');
  });

  it('wraps a bare procedure call as a BEGIN/END block', () => {
    expect(wrapServerSql('MY_PROC(1)', 'PLSQL')).toBe('BEGIN\nMY_PROC(1);\nEND;');
    expect(wrapServerSql('CALL MY_PROC(1)', 'PLSQL')).toBe('BEGIN\nCALL MY_PROC(1);\nEND;');
  });

  it('refuses to wrap an UNSUPPORTED statement', () => {
    expect(() => wrapServerSql('SELECT 1', 'UNSUPPORTED')).toThrow();
  });

  it('refuses a second statement smuggled behind a single-statement category (category confusion)', () => {
    // A DROP riding behind a DELETE would otherwise run under DELETE's permission/policy decision.
    expect(
      codeOf(() => wrapServerSql('DELETE FROM AD_X WHERE ID = 1; DROP TABLE AD_Y', 'DELETE')),
    ).toBe('SERVER_SQL_UNSUPPORTED');
    expect(codeOf(() => wrapServerSql('UPDATE A SET N = 1; DELETE FROM B', 'DML_RAW'))).toBe(
      'SERVER_SQL_UNSUPPORTED',
    );
    expect(codeOf(() => wrapServerSql('DROP TABLE AD_X; DROP TABLE AD_Y', 'DDL'))).toBe(
      'SERVER_SQL_UNSUPPORTED',
    );
    expect(
      codeOf(() => wrapServerSql('GRANT SELECT ON A TO U; GRANT SELECT ON B TO U', 'DCL')),
    ).toBe('SERVER_SQL_UNSUPPORTED');
  });

  it('still accepts a single statement with a trailing terminator, or a semicolon inside a literal', () => {
    expect(() => wrapServerSql('DELETE FROM AD_X WHERE ID = 1;', 'DELETE')).not.toThrow();
    // A semicolon inside a string literal is not a statement boundary.
    expect(() => wrapServerSql("UPDATE A SET NOTE = 'a; b' WHERE ID = 1", 'DML_RAW')).not.toThrow();
    expect(() => wrapServerSql("COMMENT ON TABLE A IS 'one; two'", 'DDL')).not.toThrow();
  });

  it('does not apply the single-statement rule to PL/SQL, which holds many statements', () => {
    expect(() =>
      wrapServerSql('BEGIN INSERT INTO A VALUES (1); UPDATE B SET N = 2; END;', 'PLSQL'),
    ).not.toThrow();
  });

  it('refuses DDL whose text closes every available q-delimiter', () => {
    const nasty = "x ]' }' >' )'";
    expect(() => wrapServerSql(`CREATE INDEX ix ON A (${nasty})`, 'DDL')).toThrow();
  });
});

describe('serverSqlTarget', () => {
  it('reads the object after each supported verb', () => {
    expect(serverSqlTarget('CREATE TABLE FOO (ID NUMBER)')).toBe('FOO');
    expect(serverSqlTarget('ALTER TABLE foo ADD X NUMBER')).toBe('FOO');
    expect(serverSqlTarget('DROP TABLE foo')).toBe('FOO');
    expect(serverSqlTarget('DROP VIEW IF EXISTS v1')).toBe('V1');
    expect(serverSqlTarget('TRUNCATE TABLE foo')).toBe('FOO');
    expect(serverSqlTarget('DELETE FROM tgfpar WHERE codparc = 1')).toBe('TGFPAR');
    expect(serverSqlTarget('UPDATE tgfpar SET x = 1 WHERE id = 2')).toBe('TGFPAR');
    expect(serverSqlTarget('MERGE INTO tgfpar t USING src s ON (t.id = s.id)')).toBe('TGFPAR');
    expect(serverSqlTarget('INSERT INTO tgfpar (id) SELECT id FROM src')).toBe('TGFPAR');
    expect(serverSqlTarget('RENAME old TO new')).toBe('OLD');
  });

  it('takes the object (last) segment of a schema-qualified name', () => {
    expect(serverSqlTarget('DELETE FROM sankhya.tgfpar WHERE id = 1')).toBe('TGFPAR');
    expect(serverSqlTarget('ALTER TABLE sankhya.tgfpar ADD x NUMBER')).toBe('TGFPAR');
    expect(serverSqlTarget('DROP TABLE sankhya.tgfpar')).toBe('TGFPAR');
  });

  it('unquotes quoted identifiers', () => {
    expect(serverSqlTarget('DELETE FROM "TGFPAR" WHERE id = 1')).toBe('TGFPAR');
    expect(serverSqlTarget('ALTER TABLE "sankhya"."TGFPAR" ADD x NUMBER')).toBe('TGFPAR');
    expect(serverSqlTarget('DROP TABLE [TGFPAR]')).toBe('TGFPAR');
  });

  it('uses the table, not the index name, for CREATE INDEX … ON', () => {
    expect(serverSqlTarget('CREATE INDEX ix_par ON tgfpar (codparc)')).toBe('TGFPAR');
    expect(serverSqlTarget('CREATE UNIQUE INDEX ix_par ON sankhya.tgfpar (codparc)')).toBe(
      'TGFPAR',
    );
  });

  it('uses the object the grant/comment is ON', () => {
    expect(serverSqlTarget('GRANT SELECT ON tgfpar TO leitor')).toBe('TGFPAR');
    expect(serverSqlTarget('REVOKE SELECT ON sankhya.tgfpar FROM leitor')).toBe('TGFPAR');
    expect(serverSqlTarget("COMMENT ON TABLE tgfpar IS 'x'")).toBe('TGFPAR');
    expect(serverSqlTarget("COMMENT ON COLUMN tgfpar.codparc IS 'x'")).toBe('TGFPAR');
  });

  it('ignores comments and leading whitespace', () => {
    expect(serverSqlTarget('/* c */ DELETE FROM tgfpar WHERE id = 1')).toBe('TGFPAR');
    expect(serverSqlTarget('-- note\nDROP TABLE foo')).toBe('FOO');
  });

  it('fails closed on CREATE of an object that references others (view/synonym/trigger)', () => {
    expect(serverSqlTarget('CREATE VIEW v AS SELECT * FROM tgfpar')).toBeNull();
    expect(serverSqlTarget('CREATE OR REPLACE VIEW v AS SELECT * FROM tgfpar')).toBeNull();
    expect(serverSqlTarget('CREATE SYNONYM s FOR tgfpar')).toBeNull();
    expect(
      serverSqlTarget('CREATE TRIGGER trg BEFORE INSERT ON tgfpar BEGIN NULL; END;'),
    ).toBeNull();
  });

  it('still resolves ALTER/DROP of a view or sequence to the named object itself', () => {
    expect(serverSqlTarget('DROP VIEW v')).toBe('V');
    expect(serverSqlTarget('ALTER VIEW v COMPILE')).toBe('V');
    expect(serverSqlTarget('CREATE SEQUENCE seq_par')).toBe('SEQ_PAR');
    expect(serverSqlTarget('DROP SEQUENCE seq_par')).toBe('SEQ_PAR');
  });

  it('returns null when the target cannot be determined', () => {
    expect(serverSqlTarget('BEGIN NULL; END;')).toBeNull();
    expect(serverSqlTarget('DECLARE x NUMBER; BEGIN NULL; END;')).toBeNull();
    expect(serverSqlTarget('GRANT CONNECT TO leitor')).toBeNull();
    expect(serverSqlTarget('CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;')).toBeNull();
    expect(serverSqlTarget('')).toBeNull();
    expect(serverSqlTarget('SELECT 1 FROM dual')).toBeNull();
  });
});

describe('serverSqlWhere', () => {
  it('reports a top-level WHERE on an UPDATE/DELETE via the real tokenizer', () => {
    expect(serverSqlWhere('DELETE FROM TGFCAB WHERE NUNOTA = 1')).toEqual({
      required: true,
      present: true,
    });
    expect(serverSqlWhere('UPDATE A SET N = 1 WHERE ID = 2')).toEqual({
      required: true,
      present: true,
    });
  });

  it('fails closed: an unqualified UPDATE/DELETE is required-but-absent', () => {
    expect(serverSqlWhere('DELETE FROM TGFCAB')).toEqual({ required: true, present: false });
    expect(serverSqlWhere('UPDATE A SET N = 1')).toEqual({ required: true, present: false });
  });

  it('does not count a WHERE that lives only inside a subquery', () => {
    expect(serverSqlWhere('DELETE FROM A WHERE ID IN (SELECT ID FROM B WHERE X = 1)')).toEqual({
      required: true,
      present: true,
    });
    expect(serverSqlWhere('UPDATE A SET N = (SELECT N FROM B WHERE B.ID = A.ID)')).toEqual({
      required: true,
      present: false,
    });
  });

  it('does not require a WHERE for non UPDATE/DELETE verbs', () => {
    expect(
      serverSqlWhere('MERGE INTO A USING B ON (A.ID = B.ID) WHEN MATCHED THEN UPDATE SET A.N = 1'),
    ).toEqual({
      required: false,
      present: true,
    });
    expect(serverSqlWhere('DROP TABLE AD_X')).toEqual({ required: false, present: true });
    expect(serverSqlWhere('INSERT INTO A SELECT * FROM B')).toEqual({
      required: false,
      present: true,
    });
  });
});

describe('serverSqlSources', () => {
  it('collects FROM/JOIN read sources at any nesting (INSERT ... SELECT)', () => {
    expect(serverSqlSources('INSERT INTO OK SELECT * FROM SECRET')).toEqual(new Set(['SECRET']));
    expect(serverSqlSources('INSERT INTO OK SELECT * FROM A JOIN B ON A.ID = B.ID')).toEqual(
      new Set(['A', 'B']),
    );
  });

  it('collects EVERY table of a comma-separated FROM list (old-style join), not just the first', () => {
    expect(serverSqlSources('INSERT INTO OK SELECT * FROM A, SECRET')).toEqual(
      new Set(['A', 'SECRET']),
    );
    // With aliases (AS and bare) and a trailing clause.
    expect(
      serverSqlSources(
        'DELETE FROM OK WHERE ID IN (SELECT X FROM A a1, SCHEMA.SECRET AS s2 WHERE a1.id = s2.id)',
      ),
    ).toEqual(new Set(['OK', 'A', 'SECRET']));
    // A derived table between two real siblings must not hide the sibling after it.
    expect(
      serverSqlSources('INSERT INTO OK SELECT * FROM A, (SELECT ID FROM MID) d, SECRET'),
    ).toEqual(new Set(['A', 'MID', 'SECRET']));
  });

  it('skips an Oracle partition suffix but still reads the table and its siblings', () => {
    expect(serverSqlSources('DELETE FROM OK PARTITION (P1) WHERE ID = 1')).toEqual(new Set(['OK']));
    expect(serverSqlSources('INSERT INTO OK SELECT * FROM A PARTITION (P1), SECRET')).toEqual(
      new Set(['A', 'SECRET']),
    );
  });

  it('fails closed on a remote @dblink source', () => {
    expect(serverSqlSources('INSERT INTO OK SELECT * FROM SECRET@REMOTE')).toBeNull();
  });

  it('collects a MERGE ... USING source, schema-qualified to its last segment', () => {
    expect(
      serverSqlSources(
        'MERGE INTO OK USING SANKHYA.SECRET ON (1=1) WHEN MATCHED THEN UPDATE SET N=1',
      ),
    ).toEqual(new Set(['SECRET']));
  });

  it('collects a source read inside a DELETE/UPDATE WHERE subquery', () => {
    expect(serverSqlSources('DELETE FROM OK WHERE ID IN (SELECT ID FROM SECRET)')).toEqual(
      new Set(['OK', 'SECRET']),
    );
  });

  it('reaches into derived tables without adding the subquery paren', () => {
    expect(serverSqlSources('INSERT INTO OK SELECT * FROM (SELECT ID FROM SECRET) S')).toEqual(
      new Set(['SECRET']),
    );
  });

  it('ignores DUAL and a JOIN ... USING column list', () => {
    expect(serverSqlSources('INSERT INTO OK SELECT SEQ.NEXTVAL FROM DUAL')).toEqual(new Set());
    expect(serverSqlSources('INSERT INTO OK SELECT * FROM A JOIN B USING (ID)')).toEqual(
      new Set(['A', 'B']),
    );
  });

  it('treats USING as a source only in MERGE, not a DDL storage clause', () => {
    // ALTER ... USING INDEX must not be read as a source named INDEX.
    expect(
      serverSqlSources('ALTER TABLE A ADD CONSTRAINT PK PRIMARY KEY (ID) USING INDEX'),
    ).toEqual(new Set());
  });

  it('fails closed (null) when a read source is a function call or otherwise undeterminable', () => {
    expect(serverSqlSources('INSERT INTO OK SELECT * FROM TABLE(SOME_FUNC(1))')).toBeNull();
    expect(serverSqlSources('INSERT INTO OK SELECT * FROM PKG.FUNC(1)')).toBeNull();
  });

  it('returns an empty set for a statement that reads nothing', () => {
    expect(serverSqlSources('DELETE FROM OK WHERE ID = 1')).toEqual(new Set(['OK']));
    expect(serverSqlSources('DROP TABLE AD_X')).toEqual(new Set());
  });
});
