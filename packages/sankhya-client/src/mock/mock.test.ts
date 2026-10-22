import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MOCK_CREDENTIALS, createMockSankhya, type MockSankhya } from './server';
import { MOCK_TABLES } from './dataset';
import { gateMockQuery } from './gate';

let mock: MockSankhya;
let token: string;

beforeAll(async () => {
  mock = await createMockSankhya({ seed: 7 });
  token = await authenticate();
}, 60_000);

afterAll(async () => {
  await mock.close();
});

async function authenticate(overrides: Partial<Record<string, string>> = {}): Promise<string> {
  const res = await authResponse(overrides);
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

function authResponse(overrides: Partial<Record<string, string>> = {}) {
  const form = new URLSearchParams({
    client_id: overrides.client_id ?? MOCK_CREDENTIALS.clientId,
    client_secret: overrides.client_secret ?? MOCK_CREDENTIALS.clientSecret,
    grant_type: 'client_credentials',
  });
  return mock.fetch(`${mock.baseUrl}/authenticate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-token': overrides.xToken ?? MOCK_CREDENTIALS.xToken,
    },
    body: form.toString(),
  });
}

async function call(
  serviceName: string,
  requestBody: unknown,
  module: 'mge' | 'mgecom' = 'mge',
  bearer = token,
) {
  const res = await mock.fetch(
    `${mock.baseUrl}/gateway/v1/${module}/service.sbr?serviceName=${serviceName}&outputType=json`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ serviceName, requestBody }),
    },
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const count = async (table: string) =>
  (await mock.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0]!.n;

describe('mock Sankhya gateway', () => {
  it('rejects wrong credentials with 401', async () => {
    expect((await authResponse({ client_secret: 'wrong' })).status).toBe(401);
    expect((await authResponse({ xToken: 'wrong' })).status).toBe(401);
  });

  it('issues a bearer token with expires_in', async () => {
    const res = await authResponse();
    expect(await res.json()).toMatchObject({
      token_type: 'Bearer',
      expires_in: 300,
      refresh_expires_in: 0,
    });
  });

  it('executeQuery returns fieldsMetadata and rows', async () => {
    const { status, body } = await call('DbExplorerSP.executeQuery', {
      sql: 'SELECT CODPARC, NOMEPARC FROM TGFPAR ORDER BY CODPARC',
    });
    expect(status).toBe(200);
    expect(body.status).toBe('1');
    expect(body.responseBody.fieldsMetadata.map((f: { name: string }) => f.name)).toEqual([
      'CODPARC',
      'NOMEPARC',
    ]);
    expect(body.responseBody.rows).toHaveLength(60);
    expect(body.responseBody.rows[0][0]).toBe(1);
  });

  it('executeQuery refuses writes and leaves the data unchanged', async () => {
    const before = await count('TGFPAR');
    for (const sql of [
      'DELETE FROM TGFPAR',
      'SELECT 1; DELETE FROM TGFPAR',
      'SELECT * INTO X FROM TGFPAR',
      'WITH d AS (DELETE FROM TGFPAR RETURNING *) SELECT * FROM d',
      'SELECT 1 -- x',
      'SELECT pg_sleep(1)',
      'SELECT "pg_sleep"(1)',
    ]) {
      const { body } = await call('DbExplorerSP.executeQuery', { sql });
      expect(body.status, sql).toBe('0');
    }
    expect(await count('TGFPAR')).toBe(before);
  });

  it('executeQuery emulates the Oracle and SQL Server row-cap wrappers (mock-only)', async () => {
    for (const sql of [
      'SELECT * FROM (SELECT CODPARC FROM TGFPAR ORDER BY CODPARC) WHERE ROWNUM <= 4',
      'SELECT TOP (4) * FROM (SELECT CODPARC FROM TGFPAR) AS dbx_q',
    ]) {
      const { body } = await call('DbExplorerSP.executeQuery', { sql });
      expect(body.status, sql).toBe('1');
      expect(body.responseBody.rows, sql).toHaveLength(4);
      expect(body.responseBody.fieldsMetadata.map((f: { name: string }) => f.name)).toEqual([
        'CODPARC',
      ]);
    }
  });

  it('executeQuery flags results cut at the row cap', async () => {
    const capped = await createMockSankhya({ queryRowCap: 5 });
    try {
      const res = await capped.handle({
        method: 'POST',
        url: '/authenticate',
        headers: { 'x-token': MOCK_CREDENTIALS.xToken },
        body: new URLSearchParams({
          client_id: MOCK_CREDENTIALS.clientId,
          client_secret: MOCK_CREDENTIALS.clientSecret,
          grant_type: 'client_credentials',
        }).toString(),
      });
      const t =
        res.kind === 'response' ? (JSON.parse(res.body) as { access_token: string }) : undefined;
      const out = await capped.handle({
        method: 'POST',
        url: '/gateway/v1/mge/service.sbr?serviceName=DbExplorerSP.executeQuery',
        headers: { authorization: `Bearer ${t!.access_token}` },
        body: JSON.stringify({ requestBody: { sql: 'SELECT CODPROD FROM TGFPRO' } }),
      });
      const body = out.kind === 'response' ? (JSON.parse(out.body) as any) : undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(body.responseBody.rows).toHaveLength(5);
      expect(body.responseBody.burstLimit).toBe(true);
    } finally {
      await capped.close();
    }
  }, 60_000);

  it('reports each gateway call by service name to onCall, never its body', async () => {
    const seen: string[][] = [];
    const logged = await createMockSankhya({ onCall: (...args) => void seen.push(args) });
    try {
      const auth = await logged.handle({
        method: 'POST',
        url: '/authenticate',
        headers: { 'x-token': MOCK_CREDENTIALS.xToken },
        body: new URLSearchParams({
          client_id: MOCK_CREDENTIALS.clientId,
          client_secret: MOCK_CREDENTIALS.clientSecret,
          grant_type: 'client_credentials',
        }).toString(),
      });
      const t =
        auth.kind === 'response' ? (JSON.parse(auth.body) as { access_token: string }) : undefined;
      await logged.handle({
        method: 'POST',
        url: '/gateway/v1/mge/service.sbr?serviceName=DbExplorerSP.executeQuery',
        headers: { authorization: `Bearer ${t!.access_token}` },
        body: JSON.stringify({ requestBody: { sql: 'SELECT CODPROD FROM TGFPRO' } }),
      });
      expect(seen).toEqual([['DbExplorerSP.executeQuery']]);
    } finally {
      await logged.close();
    }
  });

  it('executeQuery with silentCut cuts at the row cap without saying so', async () => {
    const capped = await createMockSankhya({ queryRowCap: 5, silentCut: true });
    try {
      const res = await capped.handle({
        method: 'POST',
        url: '/authenticate',
        headers: { 'x-token': MOCK_CREDENTIALS.xToken },
        body: new URLSearchParams({
          client_id: MOCK_CREDENTIALS.clientId,
          client_secret: MOCK_CREDENTIALS.clientSecret,
          grant_type: 'client_credentials',
        }).toString(),
      });
      const t =
        res.kind === 'response' ? (JSON.parse(res.body) as { access_token: string }) : undefined;
      const out = await capped.handle({
        method: 'POST',
        url: '/gateway/v1/mge/service.sbr?serviceName=DbExplorerSP.executeQuery',
        headers: { authorization: `Bearer ${t!.access_token}` },
        body: JSON.stringify({ requestBody: { sql: 'SELECT CODPROD FROM TGFPRO' } }),
      });
      const body = out.kind === 'response' ? (JSON.parse(out.body) as any) : undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(body.responseBody.rows).toHaveLength(5);
      expect(body.responseBody.burstLimit).toBe(false);
    } finally {
      await capped.close();
    }
  }, 60_000);

  it('loadRecords pages with criteria and f0..fn values', async () => {
    const { body } = await call('CRUDServiceProvider.loadRecords', {
      dataSet: {
        rootEntity: 'Parceiro',
        includePresentationFields: 'N',
        offsetPage: '0',
        criteria: { expression: { $: 'this.CODPARC = ?' }, parameter: [{ $: '3', type: 'I' }] },
        entity: { fieldset: { list: 'CODPARC,EMAIL' } },
      },
    });
    expect(body.status).toBe('1');
    expect(body.responseBody.entities.metadata.fields.field).toEqual([
      { name: 'CODPARC' },
      { name: 'EMAIL' },
    ]);
    expect(body.responseBody.entities.entity.f0).toEqual({ $: '3' });
    expect(body.responseBody.entities.hasMoreResult).toBe('false');
  });

  it('loadRecords refuses unknown fields and unsupported criteria', async () => {
    const base = { rootEntity: 'Parceiro', offsetPage: '0' };
    const bad = [
      { ...base, entity: { fieldset: { list: 'CODPARC,NOPE' } } },
      { ...base, criteria: { expression: { $: '1=1; DROP TABLE TGFPAR' }, parameter: [] } },
    ];
    for (const dataSet of bad) {
      expect((await call('CRUDServiceProvider.loadRecords', { dataSet })).body.status).toBe('0');
    }
  });

  it('save inserts and returns the generated pk', async () => {
    const before = await count('AD_EXEMPLO');
    const { body } = await call('DatasetSP.save', {
      entityName: 'AD_EXEMPLO',
      standAlone: false,
      fields: ['ID', 'DESCRICAO', 'VALOR'],
      records: [{ values: { '1': 'Novo registro', '2': 12.5 } }],
    });
    expect(body.status).toBe('1');
    expect(body.transactionId).toEqual(expect.any(String));
    expect(body.responseBody.result).toEqual([[String(before + 1), 'Novo registro', '12.50']]);
    expect(await count('AD_EXEMPLO')).toBe(before + 1);
  });

  it('save updates exactly the row named by pk', async () => {
    const snapshot = async () =>
      (
        await mock.db.query<{ codparc: number; nomeparc: string }>(
          'SELECT CODPARC, NOMEPARC FROM TGFPAR ORDER BY CODPARC',
        )
      ).rows;
    const before = await snapshot();
    const { body } = await call('DatasetSP.save', {
      entityName: 'Parceiro',
      standAlone: false,
      fields: ['NOMEPARC'],
      records: [{ pk: { CODPARC: 4 }, values: { '0': 'Parceiro Renomeado' } }],
    });
    expect(body.status).toBe('1');
    const after = await snapshot();
    const changed = after.filter((r, i) => r.nomeparc !== before[i]!.nomeparc);
    expect(changed).toEqual([{ codparc: 4, nomeparc: 'Parceiro Renomeado' }]);
  });

  it('save of a missing row is a business error', async () => {
    const { body } = await call('DatasetSP.save', {
      entityName: 'Parceiro',
      fields: ['NOMEPARC'],
      records: [{ pk: { CODPARC: 99_999 }, values: { '0': 'x' } }],
    });
    expect(body.status).toBe('0');
  });

  it('a MGECOM service called through mge is an error envelope', async () => {
    const { status, body } = await call('CACSP.cancelarNota', { nunota: 1 }, 'mge');
    expect(status).toBe(200);
    expect(body.status).toBe('0');
  });

  it('CACSP.cancelarNota through mgecom sets the cancel flag (mock-only)', async () => {
    const { body } = await call(
      'CACSP.cancelarNota',
      { notasCanceladas: { nunota: [{ $: '2' }] } },
      'mgecom',
    );
    expect(body.status).toBe('1');
    const row = await mock.db.query<{ statusnota: string }>(
      'SELECT STATUSNOTA FROM TGFCAB WHERE NUNOTA = 2',
    );
    expect(row.rows[0]!.statusnota).toBe('C');
  });

  describe('note services (bodies as documented; mock-only behaviour)', () => {
    const v = (x: string | number) => ({ $: String(x) });
    const items = (nunota: number) =>
      mock.db.query<{ sequencia: number; codprod: number; qtdneg: number; vlrunit: number }>(
        `SELECT SEQUENCIA AS sequencia, CODPROD AS codprod, QTDNEG AS qtdneg, VLRUNIT AS vlrunit
           FROM TGFITE WHERE NUNOTA = $1 ORDER BY SEQUENCIA`,
        [nunota],
      );
    const incluirNota = (informarPreco: boolean, item: Record<string, unknown>) =>
      call(
        'CACSP.incluirNota',
        {
          nota: {
            cabecalho: {
              NUNOTA: {},
              CODPARC: v(3),
              DTNEG: v('15/03/2026'),
              CODTIPOPER: v(1000),
              CODTIPVENDA: v(0),
              CODVEND: v(0),
              CODEMP: v(1),
              TIPMOV: v('P'),
            },
            itens: {
              INFORMARPRECO: informarPreco ? 'True' : 'False',
              item: [
                {
                  NUNOTA: {},
                  IGNOREDESCPROMOQTD: v('True'),
                  CODPROD: v(5),
                  QTDNEG: v(2),
                  CODLOCALORIG: v(0),
                  CODVOL: v('UN'),
                  ...item,
                },
              ],
            },
          },
        },
        'mgecom',
      );

    it('CACSP.incluirNota creates the note and its items and answers pk.NUNOTA', async () => {
      const { body } = await incluirNota(true, { VLRUNIT: v(12.5), PERCDESC: v(0) });
      expect(body.status).toBe('1');
      const nunota = Number(body.responseBody.pk.NUNOTA.$);
      const cab = await mock.db.query<{ codparc: number; tipmov: string; statusnota: string }>(
        'SELECT CODPARC AS codparc, TIPMOV AS tipmov, STATUSNOTA AS statusnota FROM TGFCAB WHERE NUNOTA = $1',
        [nunota],
      );
      expect(cab.rows).toEqual([{ codparc: 3, tipmov: 'P', statusnota: 'A' }]);
      const rows = (await items(nunota)).rows.map((r) => ({
        ...r,
        qtdneg: Number(r.qtdneg),
        vlrunit: Number(r.vlrunit),
      }));
      expect(rows).toEqual([{ sequencia: 1, codprod: 5, qtdneg: 2, vlrunit: 12.5 }]);
    });

    it('CACSP.incluirNota without INFORMARPRECO prices the item from the product', async () => {
      const { body } = await incluirNota(false, {});
      expect(body.status).toBe('1');
      const price = await mock.db.query<{ vlrvenda: number }>(
        'SELECT VLRVENDA AS vlrvenda FROM TGFPRO WHERE CODPROD = 5',
      );
      const [row] = (await items(Number(body.responseBody.pk.NUNOTA.$))).rows;
      expect(Number(row!.vlrunit)).toBe(Number(price.rows[0]!.vlrvenda));
    });

    it('CACSP.incluirNota refuses a body missing a documented field', async () => {
      const { body } = await incluirNota(true, { CODVOL: undefined, VLRUNIT: v(1) });
      expect(body.status).toBe('0');
    });

    it('CACSP.incluirAlterarItemNota adds, then changes an item; excluirItemNota removes it', async () => {
      const open = await mock.db.query<{ nunota: number }>(
        "SELECT NUNOTA AS nunota FROM TGFCAB WHERE STATUSNOTA <> 'C' ORDER BY NUNOTA DESC LIMIT 1",
      );
      const nunota = open.rows[0]!.nunota;
      const item = (sequencia: string | number, qtdneg: number) =>
        call(
          'CACSP.incluirAlterarItemNota',
          {
            nota: {
              NUNOTA: String(nunota),
              itens: {
                item: {
                  NUNOTA: v(nunota),
                  SEQUENCIA: v(sequencia),
                  CODPROD: v(7),
                  QTDNEG: v(qtdneg),
                  VLRUNIT: v(3),
                  VLRTOT: v(qtdneg * 3),
                  CODVOL: v('UN'),
                },
              },
            },
          },
          'mgecom',
        );
      const added = await item('', 4);
      expect(added.body.status).toBe('1');
      const sequencia = Number(added.body.responseBody.pk.SEQUENCIA.$);
      expect(Number(added.body.responseBody.pk.NUNOTA.$)).toBe(nunota);
      const find = async () =>
        (await items(nunota)).rows.find((r) => r.sequencia === sequencia)?.qtdneg;
      expect(Number(await find())).toBe(4);
      expect((await item(sequencia, 6)).body.status).toBe('1');
      expect(Number(await find())).toBe(6);
      expect((await item(9_999, 6)).body.status).toBe('0');

      const excluir = () =>
        call(
          'CACSP.excluirItemNota',
          { nota: { itens: { item: { NUNOTA: v(nunota), SEQUENCIA: v(sequencia) } } } },
          'mgecom',
        );
      const removed = await excluir();
      expect(removed.body.status).toBe('1');
      expect(await find()).toBeUndefined();
      expect((await excluir()).body.status).toBe('0');
    });
  });

  it('the expired-token fault answers 403 GTW3403', async () => {
    mock.inject({ type: 'tokenExpired' });
    const { status, body } = await call('DbExplorerSP.executeQuery', { sql: 'SELECT 1' });
    expect(status).toBe(403);
    expect(body.error.code).toBe('GTW3403');
  });

  it('a sqlIncludes fault only hits executeQuery calls whose SQL matches', async () => {
    mock.inject({ type: 'serverError', status: 500 }, { sqlIncludes: 'from tddcam' });
    const other = await call('DbExplorerSP.executeQuery', { sql: 'SELECT NOMETAB FROM TDDTAB' });
    expect(other.status).toBe(200);
    const hit = await call('DbExplorerSP.executeQuery', { sql: 'SELECT NOMETAB FROM TDDCAM' });
    expect(hit.status).toBe(500);
    const after = await call('DbExplorerSP.executeQuery', { sql: 'SELECT NOMETAB FROM TDDCAM' });
    expect(after.status).toBe(200);
  });

  describe('fault scenarios for save verification', () => {
    const saveName = (codparc: number, name: string) =>
      call('DatasetSP.save', {
        entityName: 'Parceiro',
        fields: ['NOMEPARC'],
        records: [{ pk: { CODPARC: codparc }, values: { '0': name } }],
      });
    const nameOf = async (codparc: number) =>
      (
        await mock.db.query<{ nomeparc: string }>(
          'SELECT NOMEPARC FROM TGFPAR WHERE CODPARC = $1',
          [codparc],
        )
      ).rows[0]!.nomeparc;
    const loadParceiro = (codparc: number) =>
      call('CRUDServiceProvider.loadRecords', {
        dataSet: {
          rootEntity: 'Parceiro',
          offsetPage: '0',
          entity: { fieldset: { list: 'NOMEPARC' } },
          criteria: {
            expression: { $: 'this.CODPARC = ?' },
            parameter: [{ $: String(codparc), type: 'I' }],
          },
        },
      });
    const saveCalls = () => mock.calls.filter((c) => c.serviceName === 'DatasetSP.save').length;

    it('after: N lets the first N matching calls through, then fires once', async () => {
      mock.inject({ type: 'serverError', status: 500 }, { service: 'DatasetSP.save', after: 1 });
      const before = saveCalls();
      expect((await saveName(5, 'Primeiro')).body.status).toBe('1');
      expect((await call('DbExplorerSP.executeQuery', { sql: 'SELECT 1' })).status).toBe(200);
      expect((await saveName(5, 'Segundo')).status).toBe(500);
      expect((await saveName(5, 'Terceiro')).body.status).toBe('1');
      expect(saveCalls()).toBe(before + 3);
      expect(await nameOf(5)).toBe('Terceiro');
    });

    it('a loadRecords read can be faulted while saves still work', async () => {
      mock.inject(
        { type: 'serverError', status: 503 },
        { service: 'CRUDServiceProvider.loadRecords' },
      );
      expect((await saveName(6, 'Gravado')).body.status).toBe('1');
      expect((await loadParceiro(6)).status).toBe(503);
      expect((await loadParceiro(6)).body.status).toBe('1');
    });

    it('ignoreWrite answers success with the requested value but does not persist it', async () => {
      const original = await nameOf(7);
      mock.inject({ type: 'ignoreWrite' }, { service: 'DatasetSP.save' });
      const { body } = await saveName(7, 'Nao Persistido');
      expect(body.status).toBe('1');
      expect(body.responseBody.result).toEqual([['Nao Persistido']]);
      expect(await nameOf(7)).toBe(original);
      expect(JSON.stringify((await loadParceiro(7)).body)).toContain(original);
      expect((await saveName(7, 'Persistido')).body.status).toBe('1');
      expect(await nameOf(7)).toBe('Persistido');
    });

    it('ignoreWrite on a business action answers success but rolls the change back', async () => {
      const open = await mock.db.query<{ nunota: number }>(
        "SELECT NUNOTA FROM TGFCAB WHERE STATUSNOTA <> 'C' ORDER BY NUNOTA LIMIT 1",
      );
      const nunota = String(open.rows[0]!.nunota);
      const status = async () =>
        (
          await mock.db.query<{ statusnota: string }>(
            'SELECT STATUSNOTA FROM TGFCAB WHERE NUNOTA = $1',
            [nunota],
          )
        ).rows[0]!.statusnota;
      const original = await status();
      expect(original).not.toBe('C');
      mock.inject({ type: 'ignoreWrite' }, { service: 'CACSP.cancelarNota' });
      const cancel = () =>
        call('CACSP.cancelarNota', { notasCanceladas: { nunota: [{ $: nunota }] } }, 'mgecom');
      const { body } = await cancel();
      expect(body.status).toBe('1');
      expect(await status()).toBe(original);
      expect((await cancel()).body.status).toBe('1');
      expect(await status()).toBe('C');
    });

    it('ignoreWrite with fields only drops the listed fields', async () => {
      mock.inject({ type: 'ignoreWrite', fields: ['NOMEPARC'] }, { service: 'DatasetSP.save' });
      const original = await nameOf(8);
      const { body } = await call('DatasetSP.save', {
        entityName: 'Parceiro',
        fields: ['NOMEPARC', 'ATIVO'],
        records: [{ pk: { CODPARC: 8 }, values: { '0': 'Ignorado', '1': 'N' } }],
      });
      expect(body.status).toBe('1');
      expect(await nameOf(8)).toBe(original);
      const after = await mock.db.query<{ ativo: string }>(
        'SELECT ATIVO FROM TGFPAR WHERE CODPARC = 8',
      );
      expect(after.rows[0]!.ativo).toBe('N');
    });

    it('responseLost applies the write and drops the answer', async () => {
      mock.inject({ type: 'responseLost' }, { service: 'DatasetSP.save' });
      const res = await mock.handle({
        method: 'POST',
        url: '/gateway/v1/mge/service.sbr?serviceName=DatasetSP.save',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          requestBody: {
            entityName: 'Parceiro',
            fields: ['NOMEPARC'],
            records: [{ pk: { CODPARC: 9 }, values: { '0': 'Aplicado Sem Resposta' } }],
          },
        }),
      });
      expect(res.kind).toBe('dropped');
      expect(await nameOf(9)).toBe('Aplicado Sem Resposta');
    });

    it('the dataset can be changed directly between calls, and calls record request bodies', async () => {
      await mock.db.query("UPDATE TGFPAR SET NOMEPARC = 'Alterado Fora' WHERE CODPARC = 10");
      const read = await loadParceiro(10);
      expect(JSON.stringify(read.body)).toContain('Alterado Fora');
      const last = mock.calls.at(-1)!;
      expect(last.serviceName).toBe('CRUDServiceProvider.loadRecords');
      expect(last.requestBody).toMatchObject({ dataSet: { rootEntity: 'Parceiro' } });
    });
  });

  it('answers the Oracle and SQL Server primary key catalog queries', async () => {
    const oracle = await call('DbExplorerSP.executeQuery', {
      sql: "SELECT c.TABLE_NAME, cc.COLUMN_NAME FROM ALL_CONSTRAINTS c JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME WHERE c.CONSTRAINT_TYPE = 'P' AND c.OWNER = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AND c.TABLE_NAME = 'TGFPAR'",
    });
    expect(oracle.body.responseBody.rows).toEqual([['TGFPAR', 'CODPARC']]);
    const mssql = await call('DbExplorerSP.executeQuery', {
      sql: "SELECT tc.TABLE_NAME, kcu.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND kcu.TABLE_NAME = tc.TABLE_NAME WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = SCHEMA_NAME() AND tc.TABLE_NAME = 'tgfpar'",
    });
    expect(mssql.body.responseBody.rows.map((r: string[]) => r[1]!.toUpperCase())).toEqual([
      'CODPARC',
    ]);
  });

  it('an unknown token answers 403 GTW3403', async () => {
    expect(
      (await call('DbExplorerSP.executeQuery', { sql: 'SELECT 1' }, 'mge', 'nope')).status,
    ).toBe(403);
  });

  it('the dataset contains no e-mail address outside .example', async () => {
    const res = await mock.db.query<{ email: string }>('SELECT EMAIL FROM TGFPAR');
    expect(res.rows.length).toBeGreaterThan(0);
    for (const { email } of res.rows) expect(email).toMatch(/@demo\.example$/);
    const all = JSON.stringify(
      await Promise.all(MOCK_TABLES.map((t) => mock.db.query(`SELECT * FROM ${t.table}`))),
    );
    for (const m of all.match(/[^\s"@]+@[^\s"]+/g) ?? []) expect(m).toMatch(/\.example$/);
  });

  it('the dictionary describes every demo table', async () => {
    const res = await mock.db.query<{ nometab: string }>(
      'SELECT NOMETAB FROM TDDTAB ORDER BY NOMETAB',
    );
    expect(res.rows.map((r) => r.nometab).sort()).toEqual(MOCK_TABLES.map((t) => t.table).sort());
  });
});

describe('gateMockQuery', () => {
  it('accepts plain reads and keywords inside literals', () => {
    expect(gateMockQuery("SELECT 'DELETE' AS X FROM TGFPAR").ok).toBe(true);
    expect(gateMockQuery('WITH a AS (SELECT 1 AS n) SELECT n FROM a;').ok).toBe(true);
  });

  it('refuses comments, multiple statements and write keywords', () => {
    for (const sql of [
      'SELECT 1 /* x */',
      'SELECT 1; SELECT 2',
      'UPDATE TGFPAR SET NOMEPARC = 1',
      'SELECT * FROM TGFPAR FOR UPDATE',
      "SELECT 'unterminated",
      'SELECT * FROM TGFPRO@remote',
    ]) {
      expect(gateMockQuery(sql).ok, sql).toBe(false);
    }
  });
});
