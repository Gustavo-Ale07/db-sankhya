import { describe, expect, it } from 'vitest';
import { isAppError } from '@dbx/shared';
import { escapeXml, toAutoDdlXml } from './autoddl';
import { DDL_DATA_TYPES, type TableModel } from './model';

const AD_EXEMPLO: TableModel = {
  name: 'AD_EXEMPLO',
  description: 'Tabela de exemplo',
  primaryKey: ['CODIGO'],
  fields: [
    { name: 'CODIGO', description: 'Código', dataType: 'INTEIRO', required: true },
    { name: 'NOME', description: 'Nome', dataType: 'TEXTO', size: 40, required: true },
    { name: 'VALOR', dataType: 'DECIMAL', size: 10, scale: 2, required: false, default: '0' },
    { name: 'ATIVO', dataType: 'CHECKBOX', required: true, default: 'S' },
    { name: 'DTCAD', dataType: 'DATA', required: false },
  ],
};

describe('toAutoDdlXml', () => {
  it('renders AD_EXEMPLO', () => {
    expect(toAutoDdlXml(AD_EXEMPLO)).toMatchSnapshot();
  });

  it('covers all 9 data types', () => {
    const xml = toAutoDdlXml({
      name: 'AD_TIPOS',
      primaryKey: ['F_INTEIRO'],
      fields: DDL_DATA_TYPES.map((t) => ({
        name: `F_${t}`,
        dataType: t,
        required: t === 'INTEIRO',
        ...(t === 'TEXTO' ? { size: 10 } : {}),
      })),
    });
    expect(DDL_DATA_TYPES).toHaveLength(9);
    for (const t of DDL_DATA_TYPES) expect(xml).toContain(`dataType="${t}"`);
  });

  it('escapes < & " and \' in descriptions', () => {
    const xml = toAutoDdlXml({
      ...AD_EXEMPLO,
      description: `A <b> & "c" 'd'`,
      fields: [{ ...AD_EXEMPLO.fields[0]!, description: '<script>&"' }],
    });
    expect(xml).toContain('description="A &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos;"');
    expect(xml).toContain('description="&lt;script&gt;&amp;&quot;"');
    expect(xml).not.toContain('<script>');
  });

  it('escapeXml escapes all five characters', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });

  it('refuses a native table', () => {
    try {
      toAutoDdlXml({ ...AD_EXEMPLO, name: 'TGFPRO' });
      expect.unreachable();
    } catch (err) {
      expect(isAppError(err) && err.code).toBe('SQL_UNSUPPORTED');
    }
  });
});
