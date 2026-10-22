import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { MOCK_CALL_LOG, SPECIALIST } from '../playwright.config';
import { openApp, setSql, shot, specialistContext } from './support';

// A tmp_ table lives in the SQL editor: created from Sankhya data, written, crossed with a
// Sankhya table, altered and dropped, each command through the same preview dialog. The mock
// gateway's call log proves the whole session only read from Sankhya.
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

const TABLE = `tmp_e2e_parc_${Date.now().toString(36)}`;
/** The gateway services that only read; anything else in the log is a write call. */
const READ_SERVICES = new Set([
  'DbExplorerSP.executeQuery',
  'CRUDServiceProvider.loadRecords',
  'DatasetSP.loadRecords',
]);

let specialist: BrowserContext;
let page: Page;
/** Lines of the call log written before this file started. */
let logStart = 0;

const logLines = () =>
  existsSync(MOCK_CALL_LOG) ? readFileSync(MOCK_CALL_LOG, 'utf8').split('\n').filter(Boolean) : [];

test.beforeAll(async ({ browser }) => {
  logStart = logLines().length;
  specialist = await specialistContext(browser);
  page = await openApp(specialist, SPECIALIST.name);
});

test.afterAll(async () => {
  await specialist?.close().catch(() => {});
});

/** Runs `sql` in the editor and waits for the preview dialog the server sends it to. */
async function previewOf(sql: string) {
  const preview = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/query/preview',
  );
  await setSql(page, sql);
  await page.keyboard.press('ControlOrMeta+Enter');
  const res = await preview;
  expect(res.status(), await res.text()).toBe(200);
  const dialog = page.getByTestId('mutation-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Confirms the open plan and waits for a VERIFIED report, then closes the dialog. */
async function confirm(dialog: ReturnType<Page['getByTestId']>, label: string) {
  const execute = dialog.getByTestId('mutation-execute');
  await expect(execute).toHaveText(label);
  await execute.click();
  await expect(dialog.getByTestId('verification-status')).toHaveText('VERIFIED');
  await dialog.getByRole('button', { name: 'Fechar', exact: true }).last().click();
  await expect(dialog).toBeHidden();
}

test('tmp_ table in the editor: create from Sankhya, insert, cross, alter, drop', async () => {
  const group = page.getByTestId('schema-group-scratch');
  await expect(group).toBeVisible();

  // CREATE TABLE tmp_… AS: the preview reads Sankhya (a read only) and shows the new structure.
  let dialog = await previewOf(
    `CREATE TABLE ${TABLE} AS SELECT CODPARC, NOMEPARC FROM TGFPAR WHERE CODPARC <= 5`,
  );
  await expect(dialog.getByTestId('mutation-operation')).toContainText('CREATE_TABLE');
  await expect(dialog.getByTestId('impact-rows')).toHaveText(
    `A tabela ${TABLE} será criada com 5 linhas`,
  );
  await expect(dialog.getByTestId('structure-after')).toContainText('nomeparc');
  await expect(dialog.getByTestId('structure-sankhya-parts')).toContainText('TGFPAR');
  await shot(page, 'editor-tmp-create');
  await confirm(dialog, 'Confirmar criação');
  // The tree lists it at once, with its rows.
  await expect(page.getByTestId(`schema-scratch-rows-${TABLE}`)).toHaveText('5 linhas');

  // INSERT: a transactional dry run in the caller's scratch.
  dialog = await previewOf(`INSERT INTO ${TABLE} (codparc, nomeparc) VALUES (9001, 'Extra E2E')`);
  await expect(dialog.getByTestId('mutation-operation')).toContainText('INSERT');
  await confirm(dialog, 'Confirmar alteração');
  await expect(page.getByTestId(`schema-scratch-rows-${TABLE}`)).toHaveText('6 linhas');

  // SELECT crossing the tmp_ table with TGFPAR: a hybrid result, with the Sankhya part shown.
  const query = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/query',
  );
  // The Sankhya part goes in a WITH: it is read once and copied into the scratch for the join.
  await setSql(
    page,
    `WITH p AS (SELECT CODPARC, NOMEPARC FROM TGFPAR) ` +
      `SELECT t.codparc, p.nomeparc FROM ${TABLE} t JOIN p ON p.codparc = t.codparc`,
  );
  await page.keyboard.press('ControlOrMeta+Enter');
  const queried = await query;
  expect(queried.status(), await queried.text()).toBe(200);
  await expect(page.getByTestId('result-origin')).toHaveText('híbrido');
  await expect(page.getByTestId('result-hybrid-parts')).toContainText('TGFPAR');
  await shot(page, 'editor-tmp-hybrid');

  // ALTER: the structure BEFORE and AFTER.
  dialog = await previewOf(`ALTER TABLE ${TABLE} ADD COLUMN obs text`);
  await expect(dialog.getByTestId('structure-before')).not.toContainText('obs');
  await expect(dialog.getByTestId('structure-after')).toContainText('obs');
  await confirm(dialog, 'Confirmar alteração');

  // DROP: the rows it loses, a danger button, then gone from the tree.
  dialog = await previewOf(`DROP TABLE ${TABLE}`);
  await expect(dialog.getByTestId('structure-lost-rows')).toHaveText('6 linhas serão perdidas');
  await expect(dialog.getByTestId('structure-after')).toContainText('tabela removida');
  await expect(dialog.getByTestId('mutation-execute')).toHaveClass(/btn-danger/);
  await confirm(dialog, 'Confirmar exclusão');
  await expect(page.getByTestId(`schema-scratch-rows-${TABLE}`)).toHaveCount(0);

  // The whole session reached the gateway only to read.
  const calls = logLines().slice(logStart);
  expect(calls).toContain('DbExplorerSP.executeQuery');
  expect(calls.filter((s) => !READ_SERVICES.has(s))).toEqual([]);
});
