import { describe, expect, it } from 'vitest';
import {
  actionEnabled,
  actionStatement,
  actionEntities,
  findAction,
  findStub,
  listActions,
  parseActionStatement,
} from './business-actions';

const action = findAction('CACSP.cancelarNota')!;

describe('actionEnabled', () => {
  it('runs every registered action on a mock connection', () => {
    expect(actionEnabled(action, 'mock', [])).toBe(true);
  });

  it('runs an action on a live connection only when its exact id is listed', () => {
    expect(actionEnabled(action, 'live', [])).toBe(false);
    expect(actionEnabled(action, 'live', ['cacsp.cancelarnota'])).toBe(false);
    expect(actionEnabled(action, 'live', ['OTHER.action'])).toBe(false);
    expect(actionEnabled(action, 'live', ['CACSP.cancelarNota'])).toBe(true);
  });

  it('fails closed for any mode other than mock', () => {
    for (const mode of ['sandbox', 'replica', '', 'MOCK']) {
      expect(actionEnabled(action, mode, [])).toBe(false);
    }
    expect(actionEnabled(action, 'sandbox', ['CACSP.cancelarNota'])).toBe(true);
  });
});

describe('action statements', () => {
  it('round-trips a validated input and refuses anything else', () => {
    const input = { nunota: 7, justificativa: 'Nota emitida em duplicidade' };
    const sql = actionStatement(action, input);
    expect(parseActionStatement(sql)).toEqual({ action, input });
    expect(parseActionStatement(sql.replace('"nunota":7', '"nunota":-7'))).toBeUndefined();
    expect(parseActionStatement(sql.replace('cancelarNota', 'outraAcao'))).toBeUndefined();
    expect(parseActionStatement(`${sql} `)).toBeUndefined();
  });
});

describe('the note services (bodies as their documentation pages show)', () => {
  const incluir = findAction('CACSP.incluirNota')!;
  const item = findAction('CACSP.incluirAlterarItemNota')!;
  const excluir = findAction('CACSP.excluirItemNota')!;
  const nota = {
    codparc: 3,
    dtneg: '15/03/2026',
    codtipoper: 1000,
    codtipvenda: 0,
    codvend: 0,
    codemp: 1,
    tipmov: 'P',
    informarPreco: true,
    itens: [{ codprod: 5, qtdneg: 2, codlocalorig: 0, codvol: 'UN', vlrunit: 12.5, percdesc: 0 }],
  };

  it('every registered action has its own permission and a documentation page', () => {
    const ids = listActions().map((a) => a.id);
    expect(ids).toEqual([
      'CACSP.cancelarNota',
      'CACSP.incluirNota',
      'CACSP.incluirAlterarItemNota',
      'CACSP.excluirItemNota',
    ]);
    const permissions = listActions().map((a) => a.permission);
    expect(new Set(permissions).size).toBe(permissions.length);
    for (const a of listActions()) {
      expect(a.contract).toMatch(/^https:\/\/developer\.sankhya\.com\.br\/reference\//);
    }
  });

  it('a service whose contract is not confirmed is a stub, never a registered action', () => {
    expect(findAction('SelecaoDocumentoSP.faturar')).toBeUndefined();
    expect(findStub('SelecaoDocumentoSP.faturar')).toMatchObject({ module: 'mgecom' });
    expect(parseActionStatement('ACTION SelecaoDocumentoSP.faturar {"nunota":1}')).toBeUndefined();
  });

  it('incluirNota sends the cabecalho and items, and writes TGFCAB and TGFITE', () => {
    const input = incluir.input.parse(nota);
    expect(incluir.requestBody(input)).toEqual({
      nota: {
        cabecalho: {
          NUNOTA: {},
          CODPARC: { $: '3' },
          DTNEG: { $: '15/03/2026' },
          CODTIPOPER: { $: '1000' },
          CODTIPVENDA: { $: '0' },
          CODVEND: { $: '0' },
          CODEMP: { $: '1' },
          TIPMOV: { $: 'P' },
        },
        itens: {
          INFORMARPRECO: 'True',
          item: [
            {
              NUNOTA: {},
              IGNOREDESCPROMOQTD: { $: 'True' },
              CODPROD: { $: '5' },
              QTDNEG: { $: '2' },
              CODLOCALORIG: { $: '0' },
              CODVOL: { $: 'UN' },
              PERCDESC: { $: '0' },
              VLRUNIT: { $: '12.5' },
            },
          ],
        },
      },
    });
    expect(actionEntities(incluir)).toEqual(['TGFCAB', 'TGFITE']);
    expect(incluir.createdKey!({ pk: { NUNOTA: { $: '121' } } })).toEqual({ NUNOTA: 121 });
    expect(incluir.createdKey!({})).toBeUndefined();
  });

  it('incluirNota with informarPreco needs the price of every item', () => {
    const { vlrunit: _price, percdesc: _desc, ...unpriced } = nota.itens[0]!;
    expect(incluir.input.safeParse({ ...nota, itens: [unpriced] }).success).toBe(false);
    expect(
      incluir.input.safeParse({ ...nota, informarPreco: false, itens: [unpriced] }).success,
    ).toBe(true);
  });

  it('incluirAlterarItemNota creates without a sequence and changes with one', () => {
    const add = item.input.parse({ nunota: 9, codprod: 7, qtdneg: 4, vlrunit: 3, codvol: 'UN' });
    expect(item.kind(add)).toBe('create');
    expect(item.requestBody(add)).toMatchObject({
      nota: { NUNOTA: '9', itens: { item: { SEQUENCIA: { $: '' }, VLRTOT: { $: '12' } } } },
    });
    const change = item.input.parse({ ...add, sequencia: 2 });
    expect(item.kind(change)).toBe('update');
    expect(item.key(change)).toEqual({ NUNOTA: 9, SEQUENCIA: 2 });
    expect(item.createdKey!({ pk: { NUNOTA: { $: '9' }, SEQUENCIA: { $: '4' } } })).toEqual({
      NUNOTA: 9,
      SEQUENCIA: 4,
    });
  });

  it('excluirItemNota names the item by NUNOTA and SEQUENCIA only', () => {
    const input = excluir.input.parse({ nunota: 9, sequencia: 2 });
    expect(excluir.kind(input)).toBe('delete');
    expect(excluir.requestBody(input)).toEqual({
      nota: { itens: { item: { NUNOTA: { $: '9' }, SEQUENCIA: { $: '2' } } } },
    });
    expect(excluir.input.safeParse({ nunota: 9 }).success).toBe(false);
  });
});
