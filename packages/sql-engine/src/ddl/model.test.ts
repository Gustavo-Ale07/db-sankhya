import { describe, expect, it } from 'vitest';
import { isAppError } from '@dbx/shared';
import { classifyStatement } from '../classify';
import {
  assertCustomTable,
  mapDataType,
  tableFromCreate,
  tableFromCreateSql,
  validateTableModel,
  type TableModel,
} from './model';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return isAppError(err) ? err.code : `non-app:${String(err)}`;
  }
  return undefined;
}

describe('mapDataType', () => {
  it('maps every source type onto the 9 AutoDDL types', () => {
    expect(mapDataType({ dataType: 'VARCHAR', length: 40 })).toEqual({
      dataType: 'TEXTO',
      size: 40,
    });
    expect(mapDataType({ dataType: 'VARCHAR2', length: 10 })).toEqual({
      dataType: 'TEXTO',
      size: 10,
    });
    expect(mapDataType({ dataType: 'INT' })).toEqual({ dataType: 'INTEIRO' });
    expect(mapDataType({ dataType: 'INTEGER' })).toEqual({ dataType: 'INTEIRO' });
    expect(mapDataType({ dataType: 'NUMBER', length: 10, scale: 0 })).toEqual({
      dataType: 'INTEIRO',
      size: 10,
    });
    expect(mapDataType({ dataType: 'NUMBER', length: 8 })).toEqual({
      dataType: 'INTEIRO',
      size: 8,
    });
    expect(mapDataType({ dataType: 'NUMBER', length: 12, scale: 4 })).toEqual({
      dataType: 'DECIMAL',
      size: 12,
      scale: 4,
    });
    expect(mapDataType({ dataType: 'DECIMAL', length: 10, scale: 2 })).toEqual({
      dataType: 'DECIMAL',
      size: 10,
      scale: 2,
    });
    expect(mapDataType({ dataType: 'DECIMAL' })).toEqual({ dataType: 'DECIMAL' });
    expect(mapDataType({ dataType: 'DATE' })).toEqual({ dataType: 'DATA' });
    expect(mapDataType({ dataType: 'TIMESTAMP' })).toEqual({ dataType: 'DATA_HORA' });
    expect(mapDataType({ dataType: 'DATETIME' })).toEqual({ dataType: 'DATA_HORA' });
    expect(mapDataType({ dataType: 'TIME' })).toEqual({ dataType: 'HORA' });
    expect(mapDataType({ dataType: 'CHAR', length: 1 })).toEqual({ dataType: 'CHECKBOX' });
    expect(mapDataType({ dataType: 'CLOB' })).toEqual({ dataType: 'CAIXA_TEXTO' });
    expect(mapDataType({ dataType: 'TEXT' })).toEqual({ dataType: 'CAIXA_TEXTO' });
    expect(mapDataType({ dataType: 'BLOB' })).toEqual({ dataType: 'ARQUIVO' });
    expect(mapDataType({ dataType: 'VARBINARY', length: 100 })).toEqual({ dataType: 'ARQUIVO' });
  });

  it('maps any other type to SQL_UNSUPPORTED', () => {
    for (const def of [
      { dataType: 'BIGINT' },
      { dataType: 'FLOAT' },
      { dataType: 'BYTEA' },
      { dataType: 'CHAR', length: 2 },
      { dataType: 'VARCHAR' },
      { dataType: 'NUMBER' },
      { dataType: 'JSON' },
    ]) {
      expect(codeOf(() => mapDataType(def))).toBe('SQL_UNSUPPORTED');
    }
  });
});

describe('assertCustomTable', () => {
  it('accepts a custom-prefixed table', () => {
    expect(assertCustomTable('ad_exemplo')).toBe('AD_EXEMPLO');
    expect(assertCustomTable('XYZ_TAB', ['XYZ_'])).toBe('XYZ_TAB');
  });

  it('refuses a native table name as SQL_UNSUPPORTED', () => {
    expect(codeOf(() => assertCustomTable('TGFPRO'))).toBe('SQL_UNSUPPORTED');
    expect(codeOf(() => assertCustomTable('AD_'))).toBe('SQL_UNSUPPORTED');
    expect(codeOf(() => assertCustomTable('AD_X', ['XYZ_']))).toBe('SQL_UNSUPPORTED');
  });

  it('refuses names that are not plain identifiers', () => {
    expect(codeOf(() => assertCustomTable('AD_X;DROP'))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => assertCustomTable('AD X'))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => assertCustomTable('"AD_X"'))).toBe('VALIDATION_ERROR');
  });
});

describe('tableFromCreate', () => {
  const sql =
    "CREATE TABLE AD_EXEMPLO (CODIGO INT NOT NULL, NOME VARCHAR(40) NOT NULL COMMENT 'Nome <&\"', " +
    "VALOR DECIMAL(10,2) DEFAULT 1.5, ATIVO CHAR(1) DEFAULT 'S', DTCAD DATE, OBS TEXT, " +
    'PRIMARY KEY (CODIGO))';

  it('builds a TableModel from the classified AST', () => {
    const c = classifyStatement(sql);
    if (c.kind !== 'CREATE_TABLE') throw new Error('expected CREATE_TABLE');
    const model = tableFromCreate(c.ast);
    expect(model).toEqual<TableModel>({
      name: 'AD_EXEMPLO',
      primaryKey: ['CODIGO'],
      fields: [
        { name: 'CODIGO', dataType: 'INTEIRO', required: true },
        { name: 'NOME', description: 'Nome <&"', dataType: 'TEXTO', size: 40, required: true },
        { name: 'VALOR', dataType: 'DECIMAL', size: 10, scale: 2, required: false, default: '1.5' },
        { name: 'ATIVO', dataType: 'CHECKBOX', required: false, default: 'S' },
        { name: 'DTCAD', dataType: 'DATA', required: false },
        { name: 'OBS', dataType: 'CAIXA_TEXTO', required: false },
      ],
    });
  });

  it('accepts the SQL string and an inline primary key', () => {
    const model = tableFromCreateSql('CREATE TABLE ad_exemplo (codigo INT PRIMARY KEY, hr TIME)');
    expect(model.name).toBe('AD_EXEMPLO');
    expect(model.primaryKey).toEqual(['CODIGO']);
    expect(model.fields).toEqual([
      { name: 'CODIGO', dataType: 'INTEIRO', required: true },
      { name: 'HR', dataType: 'HORA', required: false },
    ]);
  });

  it('accepts BLOB / VARBINARY through the fallback grammars', () => {
    const model = tableFromCreateSql(
      'CREATE TABLE AD_ARQ (ID INT NOT NULL, A BLOB, B VARBINARY(200), PRIMARY KEY (ID))',
    );
    expect(model.fields.map((f) => f.dataType)).toEqual(['INTEIRO', 'ARQUIVO', 'ARQUIVO']);
  });

  it('refuses a native table name', () => {
    expect(codeOf(() => tableFromCreateSql('CREATE TABLE TGFPRO (A INT)'))).toBe('SQL_UNSUPPORTED');
    expect(
      codeOf(() => tableFromCreateSql('CREATE TABLE AD_X (A INT)', { customPrefixes: ['ZZ_'] })),
    ).toBe('SQL_UNSUPPORTED');
  });

  it('refuses unsupported types and constructs', () => {
    const bad = [
      'CREATE TABLE AD_X (A BIGINT)',
      'CREATE TABLE AD_X (A INT UNIQUE)',
      'CREATE TABLE AD_X (A INT REFERENCES AD_Y(B))',
      'CREATE TABLE AD_X (A INT CHECK (A > 0))',
      'CREATE TABLE AD_X (A INT, UNIQUE (A))',
      'CREATE TABLE AD_X AS SELECT 1 AS A',
      'CREATE TEMPORARY TABLE AD_X (A INT)',
      'CREATE TABLE AD_X (A DATE DEFAULT CURRENT_DATE)',
      'CREATE TABLE AD_X (A INT PRIMARY KEY, B INT, PRIMARY KEY (B))',
    ];
    for (const s of bad)
      expect(
        codeOf(() => tableFromCreateSql(s)),
        s,
      ).toBe('SQL_UNSUPPORTED');
  });

  it('refuses statements that are not CREATE TABLE', () => {
    expect(codeOf(() => tableFromCreateSql('SELECT 1'))).toBe('SQL_UNSUPPORTED');
    expect(codeOf(() => tableFromCreateSql('CREATE TABLE ('))).toBe('SQL_PARSE_ERROR');
  });

  it('refuses unsafe identifiers and defaults', () => {
    expect(codeOf(() => tableFromCreateSql('CREATE TABLE AD_X ("a b" INT)'))).toBe(
      'VALIDATION_ERROR',
    );
    expect(
      codeOf(() => tableFromCreateSql("CREATE TABLE AD_X (A VARCHAR(10) DEFAULT 'x;y')")),
    ).toBe('VALIDATION_ERROR');
    expect(
      codeOf(() => tableFromCreateSql("CREATE TABLE AD_X (A VARCHAR(10) DEFAULT 'O''K')")),
    ).toBe('VALIDATION_ERROR');
  });
});

describe('validateTableModel', () => {
  const base: TableModel = {
    name: 'AD_EXEMPLO',
    primaryKey: ['CODIGO'],
    fields: [
      { name: 'CODIGO', dataType: 'INTEIRO', required: true },
      { name: 'NOME', dataType: 'TEXTO', size: 40, required: false },
    ],
  };

  it('normalizes names to upper case', () => {
    const m = validateTableModel({
      ...base,
      name: 'ad_exemplo',
      primaryKey: ['codigo'],
      fields: [{ name: 'codigo', dataType: 'INTEIRO', required: true }],
    });
    expect(m.name).toBe('AD_EXEMPLO');
    expect(m.primaryKey).toEqual(['CODIGO']);
    expect(m.fields[0]?.name).toBe('CODIGO');
  });

  it('rejects malformed models', () => {
    const cases: TableModel[] = [
      { ...base, fields: [] },
      { ...base, primaryKey: ['NOPE'] },
      { ...base, fields: [...base.fields, { name: 'NOME', dataType: 'DATA', required: false }] },
      { ...base, fields: [base.fields[0]!, { name: 'NOME', dataType: 'TEXTO', required: false }] },
      {
        ...base,
        fields: [base.fields[0]!, { name: 'N', dataType: 'TEXTO', size: 0, required: false }],
      },
      {
        ...base,
        fields: [
          base.fields[0]!,
          { name: 'N', dataType: 'INTEIRO', required: false, default: 'abc' },
        ],
      },
      {
        ...base,
        fields: [
          base.fields[0]!,
          { name: 'N', dataType: 'TEXTO', size: 2, required: false, default: 'abc' },
        ],
      },
      {
        ...base,
        fields: [
          base.fields[0]!,
          { name: 'N', dataType: 'TEXTO', size: 4, required: false, description: 'a\u0000' },
        ],
      },
      {
        ...base,
        fields: [base.fields[0]!, { name: 'N', dataType: 'BOGUS' as never, required: false }],
      },
    ];
    for (const m of cases)
      expect(
        codeOf(() => validateTableModel(m)),
        JSON.stringify(m),
      ).toBe('VALIDATION_ERROR');
  });

  it('refuses defaults on date and binary types', () => {
    expect(
      codeOf(() =>
        validateTableModel({
          ...base,
          fields: [base.fields[0]!, { name: 'D', dataType: 'DATA', required: false, default: 'X' }],
        }),
      ),
    ).toBe('SQL_UNSUPPORTED');
  });
});
