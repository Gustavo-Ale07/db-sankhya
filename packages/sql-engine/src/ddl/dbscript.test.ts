import { describe, expect, it } from 'vitest';
import { isAppError } from '@dbx/shared';
import { cdata, toDbScriptXml } from './dbscript';
import type { FieldModel, TableModel } from './model';

const CODIGO: FieldModel = { name: 'CODIGO', dataType: 'INTEIRO', required: true };
const NOME: FieldModel = { name: 'NOME', dataType: 'TEXTO', size: 40, required: false };
const AD_EXEMPLO: TableModel = {
  name: 'AD_EXEMPLO',
  primaryKey: ['CODIGO'],
  fields: [
    CODIGO,
    NOME,
    { name: 'VALOR', dataType: 'DECIMAL', size: 10, scale: 2, required: false, default: '0' },
    { name: 'ATIVO', dataType: 'CHECKBOX', required: true, default: 'S' },
    { name: 'DTCAD', dataType: 'DATA_HORA', required: false },
    { name: 'OBS', dataType: 'CAIXA_TEXTO', required: false },
    { name: 'ARQ', dataType: 'ARQUIVO', required: false },
  ],
};

interface Sql {
  attrs: string;
  oracle: string;
  mssql: string;
}

/** The `<sql>` elements, with the bodies taken out of their CDATA sections. */
function statements(xml: string): Sql[] {
  const re =
    /<sql ([^>]*)>\s*<oracle><!\[CDATA\[([\s\S]*?)\]\]><\/oracle>\s*<mssql><!\[CDATA\[([\s\S]*?)\]\]><\/mssql>\s*<\/sql>/g;
  return [...xml.matchAll(re)].map((m) => ({
    attrs: m[1] ?? '',
    oracle: m[2] ?? '',
    mssql: m[3] ?? '',
  }));
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return isAppError(err) ? err.code : `non-app:${String(err)}`;
  }
  return undefined;
}

/** No dynamic SQL that calls a function inside EXEC('…'), which T-SQL rejects. */
const EXEC_WITH_CALL = /EXEC\('[^)]*\+\s*\w+\(/;

describe('toDbScriptXml', () => {
  it('renders CREATE TABLE for both dialects', () => {
    const { xml, severity, changes } = toDbScriptXml(null, AD_EXEMPLO, { version: 1 });
    expect(xml).toMatchSnapshot();
    expect(severity).toBe('SAFE');
    expect(changes.map((c) => c.kind)).toEqual(['CREATE_TABLE']);
    const [s] = statements(xml);
    expect(statements(xml)).toHaveLength(1);
    expect(s?.attrs).toContain('executar="SE_NAO_EXISTIR"');
    expect(s?.oracle).toBe(
      'CREATE TABLE AD_EXEMPLO (CODIGO NUMBER(10) NOT NULL, NOME VARCHAR2(40), ' +
        "VALOR NUMBER(10,2) DEFAULT 0, ATIVO CHAR(1) DEFAULT 'S' NOT NULL, DTCAD DATE, " +
        'OBS CLOB, ARQ BLOB, PRIMARY KEY (CODIGO))',
    );
    expect(s?.mssql).toBe(
      'CREATE TABLE AD_EXEMPLO (CODIGO INT NOT NULL, NOME VARCHAR(40), ' +
        "VALOR DECIMAL(10,2) DEFAULT 0, ATIVO CHAR(1) DEFAULT 'S' NOT NULL, DTCAD DATETIME, " +
        'OBS VARCHAR(MAX), ARQ VARBINARY(MAX), PRIMARY KEY (CODIGO))',
    );
  });

  it('renders every change kind, in a safe order, with no ";" anywhere in the file', () => {
    const current: TableModel = {
      name: 'AD_ANTIGA',
      primaryKey: ['CODIGO'],
      fields: [
        CODIGO,
        NOME,
        { name: 'VELHO', dataType: 'DATA', required: false },
        { name: 'REMOVER', dataType: 'INTEIRO', required: false },
        { name: 'QTD', dataType: 'INTEIRO', required: false },
        { name: 'CURTO', dataType: 'TEXTO', size: 80, required: false },
      ],
    };
    const desired: TableModel = {
      name: 'AD_EXEMPLO',
      primaryKey: ['CODIGO', 'NOME'],
      fields: [
        CODIGO,
        { ...NOME, size: 60, required: true, default: 'X' },
        { name: 'NOVO', dataType: 'DATA', required: false },
        { name: 'QTD', dataType: 'DECIMAL', size: 12, scale: 2, required: false },
        { name: 'CURTO', dataType: 'TEXTO', size: 20, required: false },
        { name: 'EXTRA', dataType: 'TEXTO', size: 5, required: true, default: 'N' },
      ],
    };
    const { xml, severity, changes } = toDbScriptXml(current, desired, { version: 7 });
    expect(severity).toBe('DESTRUCTIVE');
    expect(new Set(changes.map((c) => c.kind))).toEqual(
      new Set([
        'RENAME_TABLE',
        'WIDEN_SIZE',
        'CHANGE_REQUIRED',
        'CHANGE_DEFAULT',
        'RENAME_FIELD',
        'DROP_FIELD',
        'CHANGE_TYPE',
        'NARROW_SIZE',
        'ADD_FIELD',
        'CHANGE_PRIMARY_KEY',
      ]),
    );
    expect(xml).toMatchSnapshot();
    expect(xml).not.toContain(';');

    const all = statements(xml);
    const oracle = all.map((s) => s.oracle);
    const mssql = all.map((s) => s.mssql);
    const indexOf = (bodies: string[], needle: string | RegExp): number =>
      bodies.findIndex((b) => (typeof needle === 'string' ? b.includes(needle) : needle.test(b)));
    const expectBoth = (o: string | RegExp, m: string | RegExp): void => {
      expect(indexOf(oracle, o), String(o)).toBeGreaterThanOrEqual(0);
      expect(indexOf(mssql, m), String(m)).toBeGreaterThanOrEqual(0);
    };

    // RENAME_TABLE
    expect(oracle[0]).toBe('ALTER TABLE AD_ANTIGA RENAME TO AD_EXEMPLO');
    expect(mssql[0]).toBe("EXEC sp_rename 'AD_ANTIGA', 'AD_EXEMPLO'");
    expect(all[0]?.attrs).toContain('nomeTabela="AD_ANTIGA"');
    // RENAME_FIELD
    expectBoth(
      'ALTER TABLE AD_EXEMPLO RENAME COLUMN VELHO TO NOVO',
      "EXEC sp_rename 'AD_EXEMPLO.VELHO', 'NOVO', 'COLUMN'",
    );
    // CHANGE_PRIMARY_KEY (drop, then add last)
    expectBoth(
      'ALTER TABLE AD_EXEMPLO DROP PRIMARY KEY',
      "SET @sql = N'ALTER TABLE AD_EXEMPLO DROP CONSTRAINT ' + QUOTENAME(@pk) EXEC(@sql)",
    );
    expect(oracle.at(-1)).toBe('ALTER TABLE AD_EXEMPLO ADD PRIMARY KEY (CODIGO, NOME)');
    expect(mssql.at(-1)).toBe('ALTER TABLE AD_EXEMPLO ADD PRIMARY KEY (CODIGO, NOME)');
    // DROP_FIELD (MSSQL drops the column's default constraint first)
    expect(indexOf(oracle, /^ALTER TABLE AD_EXEMPLO DROP COLUMN REMOVER$/)).toBeGreaterThan(
      indexOf(oracle, 'DROP PRIMARY KEY'),
    );
    expectBoth(
      'ALTER TABLE AD_EXEMPLO DROP COLUMN REMOVER',
      /^DECLARE @df SYSNAME, @sql NVARCHAR\(400\) SELECT @df = dc\.name FROM sys\.default_constraints .*c\.name = 'REMOVER' IF @df IS NOT NULL BEGIN SET @sql = N'ALTER TABLE AD_EXEMPLO DROP CONSTRAINT ' \+ QUOTENAME\(@df\) EXEC\(@sql\) END ALTER TABLE AD_EXEMPLO DROP COLUMN REMOVER$/,
    );
    // ADD_FIELD
    expectBoth(
      "ALTER TABLE AD_EXEMPLO ADD (EXTRA VARCHAR2(5) DEFAULT 'N' NOT NULL)",
      "ALTER TABLE AD_EXEMPLO ADD EXTRA VARCHAR(5) DEFAULT 'N' NOT NULL",
    );
    // CHANGE_TYPE
    expectBoth(
      'ALTER TABLE AD_EXEMPLO MODIFY (QTD NUMBER(12,2))',
      'ALTER TABLE AD_EXEMPLO ALTER COLUMN QTD DECIMAL(12,2) NULL',
    );
    // WIDEN_SIZE (the MSSQL ALTER COLUMN restates the desired nullability)
    expectBoth(
      'ALTER TABLE AD_EXEMPLO MODIFY (NOME VARCHAR2(60))',
      'ALTER TABLE AD_EXEMPLO ALTER COLUMN NOME VARCHAR(60) NOT NULL',
    );
    // NARROW_SIZE
    expectBoth(
      'ALTER TABLE AD_EXEMPLO MODIFY (CURTO VARCHAR2(20))',
      'ALTER TABLE AD_EXEMPLO ALTER COLUMN CURTO VARCHAR(20) NULL',
    );
    // CHANGE_REQUIRED
    expect(indexOf(oracle, 'ALTER TABLE AD_EXEMPLO MODIFY (NOME NOT NULL)')).toBeGreaterThan(0);
    // CHANGE_DEFAULT
    expectBoth(
      "ALTER TABLE AD_EXEMPLO MODIFY (NOME DEFAULT 'X')",
      /c\.name = 'NOME' .* EXEC\(@sql\) END ALTER TABLE AD_EXEMPLO ADD DEFAULT 'X' FOR NOME$/,
    );

    for (const b of [...oracle, ...mssql]) {
      expect(b.trim()).not.toBe('');
      expect(b).not.toMatch(EXEC_WITH_CALL);
    }
    expect([...xml.matchAll(/ordem="(\d+)"/g)].map((m) => Number(m[1]))).toEqual(
      all.map((_, i) => i + 1),
    );
  });

  it('numbers the <sql> elements in order', () => {
    const desired: TableModel = {
      ...AD_EXEMPLO,
      fields: [CODIGO, NOME, { name: 'B', dataType: 'DATA', required: false }],
    };
    const { xml, severity } = toDbScriptXml({ ...AD_EXEMPLO, fields: [CODIGO] }, desired, {
      version: 2,
    });
    expect(severity).toBe('SAFE');
    expect([...xml.matchAll(/ordem="(\d+)"/g)].map((m) => m[1])).toEqual(['1', '2']);
    expect(xml).toContain('<scripts version="2">');
  });

  it('drops the primary key only when there is one, and adds it only when wanted', () => {
    const noPk = toDbScriptXml({ ...AD_EXEMPLO, primaryKey: [] }, AD_EXEMPLO, { version: 1 });
    expect(noPk.xml).not.toContain('DROP PRIMARY KEY');
    expect(noPk.xml).not.toContain('sys.key_constraints');
    expect(statements(noPk.xml).map((s) => s.oracle)).toEqual([
      'ALTER TABLE AD_EXEMPLO ADD PRIMARY KEY (CODIGO)',
    ]);
    const dropPk = toDbScriptXml(AD_EXEMPLO, { ...AD_EXEMPLO, primaryKey: [] }, { version: 1 });
    expect(statements(dropPk.xml).map((s) => s.oracle)).toEqual([
      'ALTER TABLE AD_EXEMPLO DROP PRIMARY KEY',
    ]);
  });

  it('refuses an MSSQL type change on a column with a default', () => {
    const qtd = (f: Partial<FieldModel>): TableModel => ({
      ...AD_EXEMPLO,
      fields: [CODIGO, { name: 'QTD', dataType: 'INTEIRO', required: false, ...f }],
    });
    const decimal = { dataType: 'DECIMAL', size: 12, scale: 2 } as const;
    expect(codeOf(() => toDbScriptXml(qtd({ default: '0' }), qtd(decimal), { version: 1 }))).toBe(
      'SQL_UNSUPPORTED',
    );
    expect(
      codeOf(() => toDbScriptXml(qtd({}), qtd({ ...decimal, default: '0' }), { version: 1 })),
    ).toBe('SQL_UNSUPPORTED');
    expect(codeOf(() => toDbScriptXml(qtd({}), qtd(decimal), { version: 1 }))).toBeUndefined();
  });

  it('refuses an MSSQL ALTER COLUMN on a primary-key column unless the key is rebuilt', () => {
    const wide: TableModel = { ...AD_EXEMPLO, fields: [{ ...CODIGO, size: 12 }, NOME] };
    const narrow: TableModel = { ...AD_EXEMPLO, fields: [CODIGO, NOME] };
    expect(codeOf(() => toDbScriptXml(narrow, wide, { version: 1 }))).toBe('SQL_UNSUPPORTED');
    expect(
      codeOf(() =>
        toDbScriptXml(
          { ...narrow, fields: [CODIGO, { ...NOME, required: false }] },
          {
            ...narrow,
            fields: [CODIGO, { ...NOME, required: true }],
            primaryKey: ['CODIGO', 'NOME'],
          },
          { version: 1 },
        ),
      ),
    ).toBeUndefined();
    const rebuilt = toDbScriptXml(
      narrow,
      {
        ...wide,
        fields: [
          { ...CODIGO, size: 12 },
          { ...NOME, required: true },
        ],
        primaryKey: ['CODIGO', 'NOME'],
      },
      { version: 1 },
    );
    const oracle = statements(rebuilt.xml).map((s) => s.oracle);
    expect(oracle.indexOf('ALTER TABLE AD_EXEMPLO DROP PRIMARY KEY')).toBeLessThan(
      oracle.indexOf('ALTER TABLE AD_EXEMPLO MODIFY (CODIGO NUMBER(12))'),
    );
    expect(oracle.at(-1)).toBe('ALTER TABLE AD_EXEMPLO ADD PRIMARY KEY (CODIGO, NOME)');
  });

  it('refuses an Oracle type change to or from CLOB/BLOB', () => {
    const with2 = (f: FieldModel): TableModel => ({ ...AD_EXEMPLO, fields: [CODIGO, f] });
    const text: FieldModel = { name: 'T', dataType: 'TEXTO', size: 40, required: false };
    const clob: FieldModel = { name: 'T', dataType: 'CAIXA_TEXTO', required: false };
    const blob: FieldModel = { name: 'T', dataType: 'ARQUIVO', required: false };
    for (const [a, b] of [
      [text, clob],
      [clob, text],
      [blob, text],
      [clob, blob],
    ] as const) {
      expect(codeOf(() => toDbScriptXml(with2(a), with2(b), { version: 1 }))).toBe(
        'SQL_UNSUPPORTED',
      );
    }
  });

  it('validates both models and never takes a change list from the caller', () => {
    expect(
      codeOf(() =>
        toDbScriptXml(
          { ...AD_EXEMPLO, fields: [CODIGO, { ...NOME, name: 'A;DROP' }] },
          AD_EXEMPLO,
          {
            version: 1,
          },
        ),
      ),
    ).toBe('VALIDATION_ERROR');
    expect(
      codeOf(() => toDbScriptXml({ ...AD_EXEMPLO, name: "X'--" }, AD_EXEMPLO, { version: 1 })),
    ).toBe('VALIDATION_ERROR');
    expect(
      codeOf(() => toDbScriptXml({ ...AD_EXEMPLO, name: 'TGFCAB' }, AD_EXEMPLO, { version: 1 })),
    ).toBe('SQL_UNSUPPORTED');
    expect(
      codeOf(() => toDbScriptXml(null, AD_EXEMPLO, { version: 1, customPrefixes: ['ad_'] })),
    ).toBe('VALIDATION_ERROR');
  });

  it('refuses unsafe defaults and invalid versions', () => {
    const model: TableModel = {
      ...AD_EXEMPLO,
      fields: [CODIGO, { ...NOME, default: "x'; DROP TABLE Y --" }],
    };
    expect(codeOf(() => toDbScriptXml(null, model, { version: 1 }))).toBe('VALIDATION_ERROR');
    const unicodeQuote: TableModel = {
      ...AD_EXEMPLO,
      fields: [CODIGO, { ...NOME, default: 'OʼK' }],
    };
    expect(codeOf(() => toDbScriptXml(null, unicodeQuote, { version: 1 }))).toBe(
      'VALIDATION_ERROR',
    );
    expect(codeOf(() => toDbScriptXml(null, AD_EXEMPLO, { version: 0 }))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => toDbScriptXml(null, AD_EXEMPLO, { version: 1.5 }))).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('refuses a native table and a model with nothing to script', () => {
    expect(
      codeOf(() => toDbScriptXml(null, { ...AD_EXEMPLO, name: 'TGFCAB' }, { version: 1 })),
    ).toBe('SQL_UNSUPPORTED');
    expect(codeOf(() => toDbScriptXml(AD_EXEMPLO, AD_EXEMPLO, { version: 1 }))).toBe(
      'VALIDATION_ERROR',
    );
    // A description-only change belongs to AutoDDL, not to a dbscript.
    expect(
      codeOf(() =>
        toDbScriptXml(AD_EXEMPLO, { ...AD_EXEMPLO, description: 'Exemplo' }, { version: 1 }),
      ),
    ).toBe('VALIDATION_ERROR');
  });
});

describe('cdata', () => {
  it('wraps a body and refuses one that would end the section or contains ";"', () => {
    expect(cdata("SELECT 'a' FROM X")).toBe("<![CDATA[SELECT 'a' FROM X]]>");
    expect(codeOf(() => cdata('a ]]> b'))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => cdata('a ; b'))).toBe('VALIDATION_ERROR');
  });
});
