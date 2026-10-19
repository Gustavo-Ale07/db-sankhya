import { describe, expect, it } from 'vitest';
import { isAppError } from '@dbx/shared';
import { diffTable, type DdlChange } from './diff';
import { toDbScriptXml } from './dbscript';
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

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

/** The SQL bodies, XML-decoded (the file escapes `'` as `&apos;`). */
function bodies(xml: string): string[] {
  return [...xml.matchAll(/<(oracle|mssql)>([\s\S]*?)<\/\1>/g)].map((m) =>
    (m[2] ?? '').replace(/&(amp|lt|gt|quot|apos);/g, (e) => ENTITIES[e] ?? e),
  );
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return isAppError(err) ? err.code : `non-app:${String(err)}`;
  }
  return undefined;
}

describe('toDbScriptXml', () => {
  it('renders CREATE TABLE for both dialects', () => {
    const { changes } = diffTable(null, AD_EXEMPLO);
    const xml = toDbScriptXml(changes, AD_EXEMPLO, { version: 1 });
    expect(xml).toMatchSnapshot();
    expect(xml).toContain('executar="SE_NAO_EXISTIR"');
    expect(bodies(xml)).toHaveLength(2);
  });

  it('renders every change kind with no ";" in any body', () => {
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
    const { changes } = diffTable(current, desired);
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
    const xml = toDbScriptXml(changes, desired, { version: 7 });
    expect(xml).toMatchSnapshot();
    const all = bodies(xml);
    expect(all.length).toBeGreaterThan(10);
    for (const b of all) {
      expect(b).not.toContain(';');
      expect(b.trim()).not.toBe('');
    }
    // The only ';' in the file terminate XML entities.
    expect(xml.replace(/&(amp|lt|gt|quot|apos);/g, '')).not.toContain(';');
  });

  it('numbers the <sql> elements in order', () => {
    const desired: TableModel = {
      ...AD_EXEMPLO,
      fields: [CODIGO, NOME, { name: 'B', dataType: 'DATA', required: false }],
    };
    const { changes } = diffTable({ ...AD_EXEMPLO, fields: [CODIGO] }, desired);
    const xml = toDbScriptXml(changes, desired, { version: 2 });
    expect([...xml.matchAll(/ordem="(\d+)"/g)].map((m) => m[1])).toEqual(['1', '2']);
    expect(xml).toContain('<scripts version="2">');
  });

  it('refuses a field change that the model does not describe', () => {
    const bad: DdlChange[] = [{ kind: 'ADD_FIELD', field: 'FANTASMA', severity: 'SAFE', note: '' }];
    expect(codeOf(() => toDbScriptXml(bad, AD_EXEMPLO, { version: 1 }))).toBe('VALIDATION_ERROR');
  });

  it('refuses unsafe identifiers smuggled through the change list', () => {
    const bad: DdlChange[] = [
      { kind: 'DROP_FIELD', field: 'A;DROP TABLE X', severity: 'DESTRUCTIVE', note: '' },
    ];
    expect(codeOf(() => toDbScriptXml(bad, AD_EXEMPLO, { version: 1 }))).toBe('VALIDATION_ERROR');
    const bad2: DdlChange[] = [
      { kind: 'RENAME_TABLE', from: "X'--", severity: 'DESTRUCTIVE', note: '' },
    ];
    expect(codeOf(() => toDbScriptXml(bad2, AD_EXEMPLO, { version: 1 }))).toBe('VALIDATION_ERROR');
  });

  it('refuses unsafe defaults and invalid versions', () => {
    const model: TableModel = {
      ...AD_EXEMPLO,
      fields: [CODIGO, { ...NOME, default: "x'; DROP TABLE Y --" }],
    };
    const { changes } = diffTable(null, AD_EXEMPLO);
    expect(codeOf(() => toDbScriptXml(changes, model, { version: 1 }))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => toDbScriptXml(changes, AD_EXEMPLO, { version: 0 }))).toBe(
      'VALIDATION_ERROR',
    );
    expect(codeOf(() => toDbScriptXml(changes, AD_EXEMPLO, { version: 1.5 }))).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('refuses a native table and an empty change list', () => {
    const { changes } = diffTable(null, AD_EXEMPLO);
    expect(
      codeOf(() => toDbScriptXml(changes, { ...AD_EXEMPLO, name: 'TGFCAB' }, { version: 1 })),
    ).toBe('SQL_UNSUPPORTED');
    expect(codeOf(() => toDbScriptXml([], AD_EXEMPLO, { version: 1 }))).toBe('VALIDATION_ERROR');
  });
});
