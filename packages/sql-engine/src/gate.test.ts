import { describe, expect, it } from 'vitest';
import { tokenGate } from './gate';
import { tokenize } from './tokenizer';

describe('tokenGate', () => {
  it.each([
    "SELECT 'DELETE' FROM TGFPAR",
    'SELECT "INTO" FROM TGFPAR',
    'WITH x AS (SELECT 1 A FROM DUAL) SELECT * FROM x',
    'SELECT [NOME PARC] FROM TGFPAR WHERE CODPARC = 1',
    "SELECT N'São Paulo' FROM DUAL",
    "SELECT 'it''s' FROM DUAL",
    "SELECT 'a\\' FROM DUAL",
    'SELECT CODPARC FROM TGFPAR;',
    "SELECT Q, NQ FROM T WHERE Q = 'x'",
    'SELECT "NEXT_VAL", [SEQ] FROM T',
    'SELECT UPDATED_AT, INTO_X, USER_SET FROM T',
  ])('allows %s', (sql) => {
    expect(tokenGate(sql)).toEqual({ ok: true });
  });

  it.each([
    'SELECT 1 FROM DUAL; SELECT 2 FROM DUAL',
    'SELECT 1 FROM DUAL;;',
    'SELECT 1 FROM DUAL -- hi',
    'SELECT /* x */ 1 FROM DUAL',
    'SELECT * INTO T2 FROM T',
    'select * InTo T2 from T',
    'SELECT * FROM T FOR UPDATE',
    'SELECT * FROM T@lnk',
    'SELECT S.NEXTVAL FROM DUAL',
    'SELECT S.CURRVAL FROM DUAL',
    'SELECT DBMS_RANDOM.VALUE FROM DUAL',
    'SELECT "DBMS_RANDOM".VALUE FROM DUAL',
    'SELECT UTL_HTTP.REQUEST(1) FROM DUAL',
    'SELECT * FROM SYS.OBJECTS',
    'SELECT * FROM "SYS"."USER$"',
    "SELECT * FROM OPENQUERY(x,'y')",
    'EXEC sp_who',
    'SELECT * FROM sp_x',
    'BEGIN NULL; END',
    'MERGE INTO T USING S ON (1=1)',
    "WAITFOR DELAY '0:0:5'",
    "SELECT 'abc FROM DUAL",
    'SELECT "abc FROM DUAL',
    'SELECT [abc FROM DUAL',
    'SET ROWCOUNT 1',
    "SELECT q'[DELETE]' FROM T",
    "SELECT Q'{x}' FROM T",
    "SELECT nq'{x}' FROM T",
    "SELECT NQ'!it's!' FROM T",
    'SELECT "NEXTVAL"(1) FROM DUAL',
    'SELECT SEQ."NEXTVAL" FROM DUAL',
    'SELECT SEQ."currval" FROM DUAL',
    'SELECT * FROM [OPENQUERY](x, 1)',
    'SELECT * FROM "OPENROWSET"(1)',
    'USE master',
    '',
    '   ;',
  ])('refuses %s', (sql) => {
    const r = tokenGate(sql);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('SQL_FORBIDDEN');
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it('names the offending keyword', () => {
    const r = tokenGate('select * InTo T2 from T');
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('INTO') });
  });
});

describe('tokenize (ansi)', () => {
  it('lexes brackets and double quotes as identifiers and N strings as strings', () => {
    const types = tokenize(`[A B] "C" N'x' #t`, { ansi: true })
      .filter((t) => t.type !== 'space')
      .map((t) => t.type);
    expect(types).toEqual(['quotedIdent', 'quotedIdent', 'string', 'symbol', 'word']);
  });

  it('keeps the default (MySQL) behaviour unchanged', () => {
    const types = tokenize(`"C" # c`)
      .filter((t) => t.type !== 'space')
      .map((t) => t.type);
    expect(types).toEqual(['string', 'comment']);
  });

  it.each([
    'SELECT 0x1INTO T2 FROM TGFCAB',
    'SELECT 1EXEC',
    "SELECT 1EXECUTE('SELECT 1')",
    "SELECT 0x1WAITFOR DELAY '0:0:5'",
    'SELECT 1DELETE FROM TGFCAB',
  ])('refuses a word glued to a number: %s', (sql) => {
    expect(tokenGate(sql).ok).toBe(false);
  });

  it.each(['SELECT 1 FROM TGFCAB', 'SELECT 1.5E3, .5, 10 FROM TGFCAB WHERE A = 2'])(
    'accepts plain numbers: %s',
    (sql) => {
      expect(tokenGate(sql)).toEqual({ ok: true });
    },
  );
});
