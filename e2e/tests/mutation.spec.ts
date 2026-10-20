import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { BOOTSTRAP } from '../playwright.config';
import { call, policyAdminContext } from './support';

// Same value explorer.spec.ts sets when it changes the bootstrap password (that file runs
// first in a full run; this one also works alone, on the one-time password).
const CHANGED_PASSWORD = 'E2E-Changed#Pass2026';
const NEW_NAME = 'Nome alterado E2E';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('E-mail').fill(BOOTSTRAP.email);
  await page.getByLabel('Senha').fill(BOOTSTRAP.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  const changed = page.getByTestId('current-user');
  const mustChange = page.getByLabel('Senha atual');
  const refused = page.getByRole('alert');
  await expect(changed.or(mustChange).or(refused).first()).toBeVisible();
  if (await mustChange.isVisible()) {
    await mustChange.fill(BOOTSTRAP.password);
    await page.getByLabel('Nova senha', { exact: true }).fill(CHANGED_PASSWORD);
    await page.getByLabel('Confirmar nova senha').fill(CHANGED_PASSWORD);
    await page.getByRole('button', { name: 'Salvar nova senha' }).click();
  } else if (!(await changed.isVisible())) {
    // The bootstrap password was already changed by explorer.spec.ts.
    await page.getByLabel('Senha').fill(CHANGED_PASSWORD);
    await page.getByRole('button', { name: 'Entrar' }).click();
  }
  await expect(changed).toContainText('Admin Demo');
}

async function setSql(page: Page, sql: string) {
  const editor = page.getByTestId('sql-editor').locator('.monaco-editor').first();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(sql);
}

/**
 * Writes are default-deny by policy: without an ALLOW rule the preview itself is FORBIDDEN. The
 * rule only lets the plan be previewed; the write switches (SAFE_MODE on a PRODUCTION
 * connection) still refuse the execute. It is created once for this file on its own session and removed
 * afterwards; a failed removal is reported but never hides the test's own result.
 */
let admin: BrowserContext | undefined;
let policyId: string | undefined;

// Created by the ADMIN-only policy administrator: the bootstrap admin also holds OPERATOR, and
// separation of duties refuses its policy changes.
test.beforeAll(async ({ browser }) => {
  admin = await policyAdminContext(browser);
  const res = await call(admin.request, 'POST', '/api/admin/policies', {
    name: 'E2E prévia de UPDATE em TGFPAR',
    effect: 'ALLOW',
    subjectType: 'everyone',
    subjectId: null,
    environments: [],
    connectionIds: [],
    actions: ['DATA.UPDATE'],
    entities: ['TGFPAR'],
    columns: [],
    limits: {},
    overrideWhereRequired: false,
    enabled: true,
  });
  expect(res.status(), await res.text()).toBe(201);
  policyId = ((await res.json()) as { item: { id: string } }).item.id;
});

test.afterAll(async () => {
  if (!admin) return;
  try {
    if (policyId) {
      const del = await call(admin.request, 'DELETE', `/api/admin/policies/${policyId}`);
      if (!del.ok()) console.warn(`E2E policy ${policyId} not removed: HTTP ${del.status()}`);
    }
  } catch (err) {
    console.warn(`E2E policy ${policyId ?? '?'} not removed:`, err);
  } finally {
    await admin.close().catch(() => {});
  }
});

test('ctrl+enter on UPDATE opens preview and does not write', async ({ page }) => {
  await login(page);
  await previewAndRefuse(page);
});

async function previewAndRefuse(page: Page) {
  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.startsWith('/api/query'))
      calls.push(new URL(r.url()).pathname);
  });

  const previewRes = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/query/preview',
  );
  await setSql(page, `UPDATE TGFPAR SET NOMEPARC = '${NEW_NAME}' WHERE CODPARC = 1`);
  await page.keyboard.press('ControlOrMeta+Enter');
  const plan = (await (await previewRes).json()) as { planId: string; token: string };

  // The server classified it as a mutation; the client asked for the preview, nothing else.
  const dialog = page.getByRole('dialog', { name: 'Prévia da alteração' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('preview-label').first()).toHaveText('ANÁLISE DE IMPACTO');
  await expect(dialog.getByTestId('mutation-labels')).toContainText('PRÉVIA SIMULADA');
  await expect(dialog.getByTestId('capability-badge')).toBeVisible();
  await expect(dialog.getByTestId('impact-environment')).toHaveText('PRODUCTION');
  const diff = dialog.getByTestId('mutation-diff');
  await expect(diff).toContainText(NEW_NAME);
  await expect(dialog.getByTestId('impact-rows')).toHaveText('1 registro será alterado');
  await expect(dialog.getByTestId('production-band')).toBeVisible();
  // The record card lists the changed field with its ANTES and DEPOIS values.
  const field = diff.getByTestId('diff-field').filter({ hasText: 'NOMEPARC' });
  await expect(field.getByTestId('diff-after')).toContainText(NEW_NAME);
  const before = ((await field.getByTestId('diff-before').textContent()) ?? '').trim();
  expect(before).not.toBe('');
  expect(before).not.toBe(NEW_NAME);
  expect(calls).toEqual(['/api/query', '/api/query/preview']);

  // PRODUCTION needs the typed phrase. SAFE_MODE stays on in e2e, so the preview already says the
  // write is unavailable and "Confirmar alteração" stays disabled even with the exact phrase.
  const execute = dialog.getByTestId('mutation-execute');
  await expect(execute).toHaveText('Confirmar alteração');
  await expect(execute).toBeDisabled();
  await expect(dialog.getByRole('note')).toContainText('SAFE_MODE ativo');
  const phrase = (await dialog.getByTestId('confirmation-phrase').textContent()) ?? '';
  expect(phrase).toMatch(/^PRODUCTION UPDATE 1 TGFPAR$/);
  await dialog.getByTestId('confirmation-input').fill(phrase);
  // Enter in the confirmation input never executes.
  await dialog.getByTestId('confirmation-input').press('Enter');
  await expect(execute).toBeDisabled();
  expect(calls.filter((c) => c === '/api/query/execute')).toHaveLength(0);

  // The server refuses the PRODUCTION write itself, naming SAFE_MODE as the switch.
  const refused = await call(page.request, 'POST', '/api/query/execute', {
    planId: plan.planId,
    token: plan.token,
    idempotencyKey: `e2e-safe-mode-${Date.now()}`,
    strongConfirmation: phrase,
  });
  const body = (await refused.json()) as { error?: { code?: string; message?: string } };
  expect(body.error?.code).toBe('READ_ONLY_MODE');
  expect(body.error?.message).toContain('Writes are disabled (SAFE_MODE).');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Nothing was written: the row still has its old name.
  await setSql(page, 'SELECT NOMEPARC FROM TGFPAR WHERE CODPARC = 1');
  await page.getByTestId('run-query').click();
  const grid = page.getByTestId('result-grid');
  await expect(grid).toContainText('NOMEPARC');
  await expect(grid).not.toContainText(NEW_NAME);
  await expect(grid).toContainText(before);
}
