import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { CUT } from '../playwright.config';
import { adminContext, Fixtures, ok, openApp, refusal, call, select, setSql } from './support';

// A gateway that cuts results silently (the CUT server of playwright.config.ts, mock gateway,
// fictitious data): the dictionary cannot be read whole, so the catalog is incomplete and lists
// no column of the demo tables. Tables, columns and plans are then read on their own, and a
// SELECT * that the catalog cannot expand is refused when a column is denied.
test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

const STAMP = Date.now().toString(36);
/** Never written: the UPDATE below is only previewed (see RESERVED_CODPARC in support.ts). */
const ROW = 41;

let admin: BrowserContext;
let fixtures: Fixtures;
let page: Page;

test.beforeAll(async ({ browser }) => {
  admin = await adminContext(browser, CUT);
  fixtures = new Fixtures(admin.request, browser, CUT);
  // Writes are default-deny: the UPDATE preview needs one rule.
  await fixtures.policy({
    name: `E2E corte UPDATE TGFPAR ${STAMP}`,
    actions: ['DATA.UPDATE'],
    entities: ['TGFPAR'],
  });
  page = await openApp(admin, 'Admin Demo');
});

test.afterAll(async () => {
  await fixtures?.cleanup();
  await admin?.close().catch(() => {});
});

test('says the catalog is incomplete and reads it again on demand', async () => {
  const { catalog } = await ok<{
    catalog: { degraded?: string[]; tables: { name: string; columns: unknown[] }[] };
  }>(admin.request, 'GET', '/api/schema');
  expect(catalog.degraded).toContain('TDDCAM:truncated');
  // The cut fell on the padding rows: the demo tables are listed without their columns.
  expect(catalog.tables.find((t) => t.name === 'TGFPAR')?.columns ?? []).toHaveLength(0);

  const schema = page.getByRole('complementary', { name: 'Schema' });
  const badge = schema.getByTestId('schema-degraded');
  await expect(badge).toHaveText('Catálogo incompleto');
  await expect(badge).toHaveAttribute('title', /TDDCAM:truncated/);

  const refresh = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/schema/refresh',
  );
  await schema.getByRole('button', { name: 'Recarregar catálogo' }).click();
  expect((await refresh).status()).toBe(200);
  // Read again, still cut: the indicator stays.
  await expect(badge).toBeVisible();
});

test('reads the columns of an expanded table on their own', async () => {
  const schema = page.getByRole('complementary', { name: 'Schema' });
  await schema.getByTestId('schema-group-TGF').click();
  await schema.getByTestId('schema-table-TGFPAR').click();
  await expect(schema.getByTestId('schema-columns-TGFPAR')).toContainText('NOMEPARC');
  // The filter names what it matches: columns only of the tables already open.
  await expect(schema.getByLabel('Filtrar tabelas')).toHaveAttribute(
    'placeholder',
    /colunas só das tabelas abertas/,
  );
});

test('suggests the columns of a table the catalog lists without them', async () => {
  await setSql(page, 'SELECT p. FROM TGFPAR p');
  // The cursor goes right after "p.".
  for (let i = 0; i < ' FROM TGFPAR p'.length; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.monaco-editor .suggest-widget')).toContainText('NOMEPARC');
  await page.keyboard.press('Escape');
});

test('previews an UPDATE of a column the catalog does not list, and writes nothing', async () => {
  const before = (
    await select(admin.request, `SELECT NOMEPARC FROM TGFPAR WHERE CODPARC = ${ROW}`)
  )[0]?.[0];
  expect(before).toBeTruthy();
  const preview = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/query/preview',
  );
  await setSql(page, `UPDATE TGFPAR SET NOMEPARC = 'Corte ${STAMP}' WHERE CODPARC = ${ROW}`);
  await page.keyboard.press('ControlOrMeta+Enter');
  const res = await preview;
  expect(res.status(), await res.text()).toBe(200);

  const dialog = page.getByRole('dialog', { name: 'Prévia da alteração' });
  const field = dialog
    .getByTestId('mutation-diff')
    .getByTestId('diff-field')
    .filter({ hasText: 'NOMEPARC' });
  await expect(field.getByTestId('diff-before')).toContainText(String(before));
  await expect(field.getByTestId('diff-after')).toContainText(`Corte ${STAMP}`);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  const after = (
    await select(admin.request, `SELECT NOMEPARC FROM TGFPAR WHERE CODPARC = ${ROW}`)
  )[0]?.[0];
  expect(after).toBe(before);
});

test('refuses SELECT * when a column is denied, and still reads the other columns', async () => {
  // Column DENY over-denies SELECT * (decisão pendente): the star is refused, never expanded
  // from a catalog that may have lost the denied column.
  await fixtures.policy({
    name: `E2E corte DENY EMAIL ${STAMP}`,
    effect: 'DENY',
    actions: ['QUERY.SELECT'],
    entities: [],
    columns: ['TGFPAR.EMAIL'],
  });
  const star = await call(admin.request, 'POST', '/api/query', { sql: 'SELECT * FROM TGFPAR' });
  expect(star.status()).toBe(403);
  expect((await refusal(star)).code).toBe('FORBIDDEN');

  const rows = await select(admin.request, `SELECT NOMEPARC FROM TGFPAR WHERE CODPARC = ${ROW}`);
  expect(rows).toHaveLength(1);
});
