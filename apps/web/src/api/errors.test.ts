import { describe, expect, it } from 'vitest';
import { ApiError } from './client';
import { describeError, translateMessage } from './errors';

describe('translateMessage', () => {
  it.each([
    ['Result truncated to 500 rows.', 'Resultado limitado a 500 linhas.'],
    [
      'Result truncated by the gateway at 5000 rows.',
      'O gateway cortou o resultado em 5000 linhas.',
    ],
    [
      'Result truncated to 100 rows. Add filters or an explicit LIMIT/OFFSET to page through the data.',
      'Resultado limitado a 100 linhas. Adicione filtros ou um LIMIT/OFFSET explícito para paginar.',
    ],
    ['Table not found', 'Tabela não encontrada.'],
    [
      'Table TGFXYZ is not in the catalog of this connection',
      'A tabela TGFXYZ não está no catálogo desta conexão.',
    ],
    [
      'Table TGFXYZ is not in the catalog of this connection; the catalog is incomplete, refresh it and try again',
      'A tabela TGFXYZ não está no catálogo desta conexão; o catálogo está incompleto: recarregue-o e tente de novo.',
    ],
    [
      'Unknown table "TGFPRR". Did you mean "TGFPRO"?',
      'Tabela desconhecida "TGFPRR". Você quis dizer "TGFPRO"?',
    ],
    ['Unknown column "NOMEPAR".', 'Coluna desconhecida "NOMEPAR".'],
    ['Unknown table or alias "P".', 'Tabela ou alias desconhecido "P".'],
  ])('%s', (message, expected) => {
    expect(translateMessage(message)).toBe(expected);
  });

  it('keeps a message it does not know verbatim', () => {
    expect(translateMessage('Something else happened')).toBe('Something else happened');
  });
});

describe('describeError', () => {
  it('translates the server detail and keeps the code', () => {
    const e = describeError(
      new ApiError(400, { code: 'RESOURCE_NOT_FOUND', message: 'Table not found' }),
    );
    expect(e.code).toBe('RESOURCE_NOT_FOUND');
    expect(e.detail).toBe('Tabela não encontrada.');
  });
});
