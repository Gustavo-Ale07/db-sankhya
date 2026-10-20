import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import {
  adminContext,
  call,
  Fixtures,
  ok,
  openApp,
  refusal,
  select,
  setSql,
  shot,
  userContext,
} from './support';

// What the preview dialog shows to someone who may only look (DATA.PREVIEW without DATA.UPDATE),
// and how it presents an INSERT and a DELETE (scratch tmp_* table: a Sankhya DELETE is refused
// before any preview). Mock gateway and the run's own scratch workspace, fictitious data only.
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

const STAMP = Date.now().toString(36);
const CODPARC = 31;
const TARGET_NAME = `Somente prévia ${STAMP}`;
const ROLE = `E2E_PREVIA_${STAMP.toUpperCase()}`.slice(0, 40);
const VIEWER = {
  email: `e2e-previa-${STAMP}@example.com`,
  name: 'Pessoa Prévia Demo',
  initial: 'Previa#Inicial2026',
  changed: 'Previa#Trocada2026',
};
const SCRATCH = `tmp_e2e_previa_${STAMP}`;

let admin: BrowserContext;
let viewer: BrowserContext;
let fixtures: Fixtures;
let connectionId: string;

const nameOf = async () =>
  (
    await select(
      admin.request,
      `SELECT NOMEPARC FROM TGFPAR WHERE CODPARC = ${CODPARC}`,
      connectionId,
    )
  )[0]?.[0];

test.beforeAll(async ({ browser }) => {
  admin = await adminContext(browser);
  fixtures = new Fixtures(admin.request, browser);
  connectionId = await fixtures.connection(`E2E Prévia ${STAMP}`, 'SANDBOX');
  // The rule a writer would need: the preview-only user is evaluated against it too. Created by
  // the policy administrator (separation of duties), only for this connection.
  await fixtures.policy({
    name: `E2E prévia UPDATE TGFPAR ${STAMP}`,
    actions: ['DATA.UPDATE'],
    entities: ['TGFPAR'],
    connectionIds: [connectionId],
  });
  // Reads and previews writes, never runs one.
  await fixtures.role(ROLE, ['QUERY.SELECT', 'DATA.PREVIEW']);
  await fixtures.user(VIEWER.email, VIEWER.name, VIEWER.initial, [ROLE]);
  viewer = await userContext(browser, VIEWER.email, VIEWER.initial, VIEWER.changed);
});

test.afterAll(async () => {
  await viewer?.close().catch(() => {});
  if (!admin) return;
  await call(admin.request, 'POST', '/api/scratch/exec', { sql: `DROP TABLE ${SCRATCH}` }).catch(
    () => {},
  );
  await fixtures?.cleanup();
  await admin.close().catch(() => {});
});

/** Ctrl+Enter on a mutation: the server points to the preview, the dialog opens. */
async function openPreview(p: Page, sql: string) {
  const preview = p.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/query/preview',
  );
  await setSql(p, sql);
  await p.keyboard.press('ControlOrMeta+Enter');
  return preview;
}

test('a preview-only user sees the plan but cannot confirm it, and the API refuses it', async () => {
  const before = await nameOf();
  expect(before).toBeTruthy();
  expect(before).not.toBe(TARGET_NAME);

  const page = await openApp(viewer, VIEWER.name);
  await page.getByTestId('connection-picker').selectOption(connectionId);
  const preview = await openPreview(
    page,
    `UPDATE TGFPAR SET NOMEPARC = '${TARGET_NAME}' WHERE CODPARC = ${CODPARC}`,
  );
  expect(preview.status(), await preview.text()).toBe(200);
  const plan = (await preview.json()) as {
    planId: string;
    token: string;
    operation?: string;
    execution: { available: boolean; permitted?: boolean };
    requires: { strongConfirmation: string | null };
  };
  expect(plan.operation).toBe('UPDATE');
  // Writes are on for this SANDBOX connection: only the missing permission holds the plan back.
  expect(plan.execution.available).toBe(true);
  expect(plan.execution.permitted).toBe(false);

  const dialog = page.getByRole('dialog', { name: 'Prévia da alteração' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('impact-environment')).toHaveText('SANDBOX');
  await expect(dialog.getByTestId('impact-rows')).toHaveText('1 registro será alterado');
  const field = dialog.getByTestId('diff-field').filter({ hasText: 'NOMEPARC' });
  await expect(field.getByTestId('diff-before')).toContainText(String(before));
  await expect(field.getByTestId('diff-after')).toContainText(TARGET_NAME);
  await expect(dialog.getByTestId('preview-only-note')).toBeVisible();
  if (plan.requires.strongConfirmation) {
    await dialog.getByTestId('confirmation-input').fill(plan.requires.strongConfirmation);
  }
  await expect(dialog.getByTestId('mutation-execute')).toHaveText('Confirmar alteração');
  await expect(dialog.getByTestId('mutation-execute')).toBeDisabled();
  await shot(page, 'preview-only');

  // The server refuses the plan as well: DATA.PREVIEW never stands in for DATA.UPDATE there.
  const refused = await call(viewer.request, 'POST', '/api/query/execute', {
    planId: plan.planId,
    token: plan.token,
    idempotencyKey: `e2e-preview-only-${STAMP}`,
    ...(plan.requires.strongConfirmation
      ? { strongConfirmation: plan.requires.strongConfirmation }
      : {}),
  });
  expect(refused.ok()).toBe(false);
  expect((await refusal(refused)).code).toBe('FORBIDDEN');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.close();

  // Nothing was written.
  expect(await nameOf()).toBe(before);
});

test('scratch INSERT and DELETE previews: a new record and a record to be removed', async () => {
  // The administrator holds TEMP.*; its own workspace gets a small table through the API.
  await ok(admin.request, 'POST', '/api/scratch/exec', {
    sql: `CREATE TABLE ${SCRATCH} (id int PRIMARY KEY, nome text)`,
  });
  await ok(admin.request, 'POST', '/api/scratch/exec', {
    sql: `INSERT INTO ${SCRATCH} (id, nome) VALUES (1, 'Linha um'), (2, 'Linha dois')`,
  });

  const page = await openApp(admin, 'Admin Demo');
  const dialog = page.getByRole('dialog', { name: 'Prévia da alteração' });

  // INSERT: the card says the record is new, the sentence counts what will be created.
  const insert = await openPreview(
    page,
    `INSERT INTO ${SCRATCH} (id, nome) VALUES (3, 'Linha três')`,
  );
  expect(insert.status(), await insert.text()).toBe(200);
  expect(((await insert.json()) as { operation?: string }).operation).toBe('INSERT');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('mutation-operation')).toContainText('INSERT');
  await expect(dialog.getByTestId('impact-rows')).toHaveText('1 novo registro será criado');
  const added = dialog.getByTestId('diff-card');
  await expect(added).toHaveCount(1);
  await expect(added).toContainText('(novo registro)');
  await expect(added).toContainText('Linha três');
  await shot(page, 'preview-insert');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // DELETE: the card marks the row as going away and shows its current values, never NULLs.
  const remove = await openPreview(page, `DELETE FROM ${SCRATCH} WHERE id = 2`);
  expect(remove.status(), await remove.text()).toBe(200);
  expect(((await remove.json()) as { operation?: string }).operation).toBe('DELETE');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('impact-rows')).toHaveText('1 registro será removido');
  const removed = dialog.getByTestId('diff-card');
  await expect(removed).toHaveCount(1);
  await expect(removed).toContainText('REGISTRO SERÁ REMOVIDO');
  await expect(removed).toContainText('Linha dois');
  await expect(removed).not.toContainText('NULL');
  await shot(page, 'preview-delete');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Both were previews only: the table still holds exactly its two rows.
  const rows = await ok<{ rows: unknown[][] }>(admin.request, 'POST', '/api/scratch/exec', {
    sql: `SELECT id, nome FROM ${SCRATCH} ORDER BY id`,
  });
  expect(rows.rows.map((r) => r.map(String))).toEqual([
    ['1', 'Linha um'],
    ['2', 'Linha dois'],
  ]);
  await page.close();
});
