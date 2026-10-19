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
