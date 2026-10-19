import { describe, expect, it } from 'vitest';
import { diffTable } from './diff';
import type { FieldModel, TableModel } from './model';

const CODIGO: FieldModel = { name: 'CODIGO', dataType: 'INTEIRO', required: true };
const NOME: FieldModel = { name: 'NOME', dataType: 'TEXTO', size: 40, required: false };

const current: TableModel = { name: 'AD_EXEMPLO', primaryKey: ['CODIGO'], fields: [CODIGO, NOME] };

function withFields(...fields: FieldModel[]): TableModel {
  return { ...current, fields };
}

describe('diffTable', () => {
  it('creating a new table is SAFE', () => {
    const d = diffTable(null, current);
    expect(d.severity).toBe('SAFE');
    expect(d.changes).toEqual([
      expect.objectContaining({ kind: 'CREATE_TABLE', severity: 'SAFE' }),
    ]);
  });

  it('an identical model has no changes and is SAFE', () => {
    expect(diffTable(current, current)).toEqual({ changes: [], severity: 'SAFE' });
  });

  it('adding a nullable field is SAFE', () => {
    const d = diffTable(
      current,
      withFields(CODIGO, NOME, { name: 'OBS', dataType: 'CAIXA_TEXTO', required: false }),
    );
    expect(d.severity).toBe('SAFE');
    expect(d.changes).toEqual([
      expect.objectContaining({ kind: 'ADD_FIELD', field: 'OBS', severity: 'SAFE' }),
    ]);
  });

  it('adding a required field is CAUTION', () => {
    const d = diffTable(
      current,
      withFields(CODIGO, NOME, { name: 'QTD', dataType: 'INTEIRO', required: true, default: '0' }),
    );
    expect(d.severity).toBe('CAUTION');
    expect(d.changes[0]).toMatchObject({ kind: 'ADD_FIELD', field: 'QTD', severity: 'CAUTION' });
  });

  it('widening a size is CAUTION', () => {
    const d = diffTable(current, withFields(CODIGO, { ...NOME, size: 80 }));
    expect(d.severity).toBe('CAUTION');
    expect(d.changes).toEqual([
      expect.objectContaining({ kind: 'WIDEN_SIZE', field: 'NOME', severity: 'CAUTION' }),
    ]);
  });

  it('narrowing a size is DESTRUCTIVE', () => {
    const d = diffTable(current, withFields(CODIGO, { ...NOME, size: 20 }));
    expect(d.severity).toBe('DESTRUCTIVE');
    expect(d.changes[0]).toMatchObject({ kind: 'NARROW_SIZE', field: 'NOME' });
  });

  it('narrowing a decimal scale is DESTRUCTIVE even when precision grows', () => {
    const a: FieldModel = { name: 'V', dataType: 'DECIMAL', size: 10, scale: 4, required: false };
    const d = diffTable(withFields(CODIGO, a), withFields(CODIGO, { ...a, size: 12, scale: 2 }));
    expect(d.changes[0]).toMatchObject({ kind: 'NARROW_SIZE', severity: 'DESTRUCTIVE' });
  });

  describe('numeric sizes compare integer digits and scale separately', () => {
    const num = (dataType: 'INTEIRO' | 'DECIMAL', size?: number, scale?: number): FieldModel => ({
      name: 'V',
      dataType,
      required: false,
      ...(size === undefined ? {} : { size }),
      ...(scale === undefined ? {} : { scale }),
    });
    const kindOf = (a: FieldModel, b: FieldModel): string | undefined =>
      diffTable(withFields(CODIGO, a), withFields(CODIGO, b)).changes[0]?.kind;

    it.each([
      ['(10,2) -> (10,4)', num('DECIMAL', 10, 2), num('DECIMAL', 10, 4), 'NARROW_SIZE'],
      ['(10,2) -> (10)', num('DECIMAL', 10, 2), num('DECIMAL', 10), 'NARROW_SIZE'],
      ['(10,2) -> unsized', num('DECIMAL', 10, 2), num('DECIMAL'), 'NARROW_SIZE'],
      ['(10,2) -> (12,2)', num('DECIMAL', 10, 2), num('DECIMAL', 12, 2), 'WIDEN_SIZE'],
      ['(10,2) -> (12,4)', num('DECIMAL', 10, 2), num('DECIMAL', 12, 4), 'WIDEN_SIZE'],
      ['(10,2) -> (11,3)', num('DECIMAL', 10, 2), num('DECIMAL', 11, 3), 'WIDEN_SIZE'],
      ['(10) -> (10,0)', num('DECIMAL', 10), num('DECIMAL', 10, 0), undefined],
      ['INTEIRO 8 -> unsized', num('INTEIRO', 8), num('INTEIRO'), 'NARROW_SIZE'],
      ['INTEIRO unsized -> 5', num('INTEIRO'), num('INTEIRO', 5), 'NARROW_SIZE'],
      ['INTEIRO unsized -> 12', num('INTEIRO'), num('INTEIRO', 12), 'WIDEN_SIZE'],
      ['INTEIRO 5 -> 8', num('INTEIRO', 5), num('INTEIRO', 8), 'WIDEN_SIZE'],
    ])('%s', (_label, a, b, kind) => {
      expect(kindOf(a, b)).toBe(kind);
    });
  });

  it('dropping a field is DESTRUCTIVE', () => {
    const d = diffTable(current, withFields(CODIGO));
    expect(d.severity).toBe('DESTRUCTIVE');
    expect(d.changes).toEqual([
      expect.objectContaining({ kind: 'DROP_FIELD', field: 'NOME', severity: 'DESTRUCTIVE' }),
    ]);
  });

  it('changing a type is DESTRUCTIVE', () => {
    const d = diffTable(
      current,
      withFields(CODIGO, { name: 'NOME', dataType: 'CAIXA_TEXTO', required: false }),
    );
    expect(d.severity).toBe('DESTRUCTIVE');
    expect(d.changes).toEqual([
      expect.objectContaining({ kind: 'CHANGE_TYPE', field: 'NOME', severity: 'DESTRUCTIVE' }),
    ]);
  });

  it('renaming a field is DESTRUCTIVE', () => {
    const d = diffTable(current, withFields(CODIGO, { ...NOME, name: 'DESCRICAO' }));
    expect(d.severity).toBe('DESTRUCTIVE');
    expect(d.changes).toEqual([
      expect.objectContaining({
        kind: 'RENAME_FIELD',
        field: 'DESCRICAO',
        from: 'NOME',
        severity: 'DESTRUCTIVE',
      }),
    ]);
  });

  it('an ambiguous rename is reported as DROP + ADD', () => {
    const a: FieldModel = { name: 'A1', dataType: 'DATA', required: false };
    const twoDropped = diffTable(
      withFields(CODIGO, a, { ...a, name: 'A2' }),
      withFields(CODIGO, { ...a, name: 'B1' }),
    );
    expect(twoDropped.changes.map((c) => c.kind).sort()).toEqual([
      'ADD_FIELD',
      'DROP_FIELD',
      'DROP_FIELD',
    ]);
    expect(twoDropped.severity).toBe('DESTRUCTIVE');
    const twoAdded = diffTable(
      withFields(CODIGO, a),
      withFields(CODIGO, { ...a, name: 'B1' }, { ...a, name: 'B2' }),
    );
    expect(twoAdded.changes.map((c) => c.kind).sort()).toEqual([
      'ADD_FIELD',
      'ADD_FIELD',
      'DROP_FIELD',
    ]);
    expect(twoAdded.severity).toBe('DESTRUCTIVE');
  });

  it('records the previous primary key, in desired names', () => {
    const d = diffTable(current, {
      ...current,
      primaryKey: ['ID', 'NOME'],
      fields: [{ ...CODIGO, name: 'ID' }, NOME],
    });
    expect(d.changes.find((c) => c.kind === 'CHANGE_PRIMARY_KEY')?.previousPrimaryKey).toEqual([
      'ID',
    ]);
    const none = diffTable({ ...current, primaryKey: [] }, current);
    expect(none.changes[0]).toMatchObject({ kind: 'CHANGE_PRIMARY_KEY', previousPrimaryKey: [] });
  });

  it('renaming the table is DESTRUCTIVE', () => {
    const d = diffTable(current, { ...current, name: 'AD_OUTRA' });
    expect(d.severity).toBe('DESTRUCTIVE');
    expect(d.changes[0]).toMatchObject({ kind: 'RENAME_TABLE', from: 'AD_EXEMPLO' });
  });

  it('changing the primary key is DESTRUCTIVE', () => {
    const d = diffTable(current, {
      ...current,
      primaryKey: ['CODIGO', 'NOME'],
      fields: [CODIGO, { ...NOME, required: true }],
    });
    expect(d.severity).toBe('DESTRUCTIVE');
    expect(d.changes.map((c) => c.kind)).toContain('CHANGE_PRIMARY_KEY');
  });

  it('nullability and default changes', () => {
    expect(
      diffTable(current, withFields(CODIGO, { ...NOME, required: true })).changes[0],
    ).toMatchObject({ kind: 'CHANGE_REQUIRED', severity: 'CAUTION' });
    expect(
      diffTable(withFields(CODIGO, { ...NOME, required: true }), current).changes[0],
    ).toMatchObject({ kind: 'CHANGE_REQUIRED', severity: 'SAFE' });
    expect(
      diffTable(current, withFields(CODIGO, { ...NOME, default: 'X' })).changes[0],
    ).toMatchObject({ kind: 'CHANGE_DEFAULT', severity: 'SAFE' });
  });

  it('overall severity is the worst change', () => {
    const d = diffTable(
      current,
      withFields(
        CODIGO,
        { ...NOME, size: 80 },
        { name: 'OBS', dataType: 'CAIXA_TEXTO', required: false },
      ),
    );
    expect(d.severity).toBe('CAUTION');
    expect(d.changes.map((c) => c.severity).sort()).toEqual(['CAUTION', 'SAFE']);
  });
});
