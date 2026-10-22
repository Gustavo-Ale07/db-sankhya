import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { SPECIALIST } from '../playwright.config';
import {
  adminContext,
  call,
  Fixtures,
  nav,
  ok,
  openApp,
  refusal,
  select,
  shot,
  specialistContext,
} from './support';

// The scratch workspace (create, insert, join with data materialized from the mock gateway)
// and the custom-DDL artifact, which is generated for download and never executed.
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

const STAMP = Date.now().toString(36);
const REGIONS = `tmp_e2e_regioes_${STAMP}`;
const CITIES = `tmp_e2e_cidades_${STAMP}`;
// GO is left out on purpose: the inner join must drop those cities.
const REGION_OF: Record<string, string> = {
  SP: 'Sudeste',
  MG: 'Sudeste',
  PR: 'Sul',
  SC: 'Sul',
  RS: 'Sul',
};
const DDL_TABLE = `AD_E2EPEDIDO${STAMP.toUpperCase()}`.slice(0, 30);

let admin: BrowserContext;
let specialist: BrowserContext;
let fixtures: Fixtures;
let page: Page;

test.beforeAll(async ({ browser }) => {
  admin = await adminContext(browser);
  fixtures = new Fixtures(admin.request, browser);
  specialist = await specialistContext(browser);
  page = await openApp(specialist, SPECIALIST.name);
});

test.afterAll(async () => {
  await specialist?.close().catch(() => {});
  if (!admin) return;
  await fixtures?.cleanup();
  await admin.close().catch(() => {});
});

const byRow = (a: string[], b: string[]) => a.join('|').localeCompare(b.join('|'));

interface ExecResult {
  command: string;
  rowCount: number;
  columns: string[];
  rows: unknown[][];
}

async function runScratch(sql: string) {
  const response = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/scratch/exec',
  );
  await page.getByTestId('scratch-sql').fill(sql);
  await page.getByTestId('scratch-run').click();
  const res = await response;
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as ExecResult;
}

test('scratch: create a table, insert rows and join them with materialized Sankhya data', async () => {
  await nav(page, 'Scratch (avançado)').click();

  const created = await runScratch(
    `CREATE TABLE ${REGIONS} (uf varchar(2) PRIMARY KEY, regiao text)`,
  );
  expect(created.command).toBe('CREATE TABLE');
  await expect(page.getByTestId('scratch-tables')).toContainText(REGIONS);

  const values = Object.entries(REGION_OF)
    .map(([uf, regiao]) => `('${uf}', '${regiao}')`)
    .join(', ');
  const inserted = await runScratch(`INSERT INTO ${REGIONS} (uf, regiao) VALUES ${values}`);
  expect(inserted.rowCount).toBe(Object.keys(REGION_OF).length);
  await expect(page.getByTestId('scratch-result')).toContainText(
    `INSERT: ${Object.keys(REGION_OF).length} linha(s)`,
  );

  // A Sankhya read (mock gateway) copied into the workspace.
  await page.getByTestId('materialize-source').fill('SELECT CODCID, NOMECID, UF FROM TSICID');
  await page.getByTestId('materialize-into').fill(CITIES);
  await page.getByTestId('materialize-run').click();
  await expect(page.getByTestId('materialize-result')).toContainText(CITIES);
  await expect(page.getByTestId('scratch-tables')).toContainText(CITIES);

  const joined = await runScratch(
    `SELECT c.nomecid, c.uf, r.regiao FROM ${CITIES} c JOIN ${REGIONS} r ON r.uf = c.uf ` +
      'ORDER BY r.regiao, c.nomecid',
  );
  await expect(page.getByTestId('scratch-result')).toContainText('regiao');
  await shot(page, 'scratch-join');

  // The join holds exactly the Sankhya cities whose UF has a region, each with its region.
  const sankhya = await select(specialist.request, 'SELECT NOMECID, UF FROM TSICID');
  const expected = sankhya
    .filter(([, uf]) => String(uf) in REGION_OF)
    .map(([nome, uf]) => [String(nome), String(uf), REGION_OF[String(uf)] ?? ''])
    .sort(byRow);
  expect(expected.length).toBeGreaterThan(0);
  expect(joined.rowCount).toBe(expected.length);
  expect(joined.rows.map((r) => r.map(String)).sort(byRow)).toEqual(expected);
});

test('DDL: generates the custom-table artifacts for download and executes nothing', async () => {
  const testInfo = test.info();
  const sql =
    `CREATE TABLE ${DDL_TABLE} (CODPEDIDO INT PRIMARY KEY, ` +
    'DESCRICAO VARCHAR(100) NOT NULL, OBSERVACAO VARCHAR(200))';

  // Default deny: even with DDL.CUSTOM.GENERATE, no rule means no artifact.
  const denied = await call(specialist.request, 'POST', '/api/ddl/artifact', { sql });
  expect(denied.status()).toBe(403);
  expect((await refusal(denied)).code).toBe('FORBIDDEN');

  await fixtures.policy({
    name: `E2E artefato DDL ${STAMP}`,
    actions: ['DDL.CUSTOM.GENERATE'],
    entities: [DDL_TABLE],
  });

  const out = await ok<{
    table: string;
    severity: string;
    artifacts: { kind: string; filename: string; contentType: string; content: string }[];
  }>(specialist.request, 'POST', '/api/ddl/artifact', { sql, format: 'both' });
  expect(out.table).toBe(DDL_TABLE);
  expect(out.artifacts.map((a) => [a.kind, a.filename])).toEqual([
    ['autoddl', `${DDL_TABLE}.xml`],
    ['dbscript', 'V1.xml'],
  ]);
  for (const artifact of out.artifacts) {
    expect(artifact.contentType).toContain('xml');
    expect(artifact.content.startsWith('<?xml')).toBe(true);
    expect(artifact.content).toContain(DDL_TABLE);
    expect(artifact.content).toContain('DESCRICAO');
    // The download: each artifact is saved as the file it names and attached to the report.
    const path = testInfo.outputPath(artifact.filename);
    writeFileSync(path, artifact.content, 'utf8');
    await testInfo.attach(artifact.filename, { path, contentType: artifact.contentType });
  }

  // A native table is never a custom-DDL target, rule or not.
  const native = await call(specialist.request, 'POST', '/api/ddl/artifact', {
    sql: 'CREATE TABLE TGFPAR (ID INT PRIMARY KEY)',
  });
  // The native-table guard refuses it, before any policy is consulted (not a default-deny 403).
  expect(native.status()).toBe(400);
  const nativeErr = await refusal(native);
  expect(nativeErr.code).toBe('SQL_UNSUPPORTED');
  expect(nativeErr.message).toContain('Native DDL is forbidden');
  expect(nativeErr.details?.table).toBe('TGFPAR');

  // Only an artifact was produced: the table does not exist in the Sankhya catalog.
  const read = await call(specialist.request, 'POST', '/api/query', {
    sql: `SELECT * FROM ${DDL_TABLE}`,
  });
  expect((await refusal(read)).code).toBe('RESOURCE_NOT_FOUND');
  const { items } = await ok<{ items: { action: string; resource: string | null }[] }>(
    admin.request,
    'GET',
    `/api/audit?action=ddl.generate&limit=50`,
  );
  expect(items.some((i) => i.resource === DDL_TABLE)).toBe(true);
});
