import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { BOOTSTRAP } from '../playwright.config';

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
 * rule only lets the plan be previewed; the write switches (SAFE_MODE, GLOBAL_WRITE_ENABLED)
 * still refuse the execute.
 */
async function allowUpdate(page: Page): Promise<() => Promise<void>> {
  const origin = new URL(page.url()).origin;
  const res = await page.request.post('/api/admin/policies', {
    headers: { origin },
    data: {
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
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { item } = (await res.json()) as { item: { id: string } };
  return async () => {
    const del = await page.request.delete(`/api/admin/policies/${item.id}`, {
      headers: { origin },
    });
    expect(del.ok()).toBe(true);
  };
}

test('ctrl+enter on UPDATE opens preview and does not write', async ({ page }) => {
  await login(page);
  const removePolicy = await allowUpdate(page);
  try {
    await previewAndRefuse(page);
  } finally {
    await removePolicy();
  }
});

async function previewAndRefuse(page: Page) {
  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.startsWith('/api/query'))
      calls.push(new URL(r.url()).pathname);
  });

  await setSql(page, `UPDATE TGFPAR SET NOMEPARC = '${NEW_NAME}' WHERE CODPARC = 1`);
  await page.keyboard.press('ControlOrMeta+Enter');

  // The server classified it as a mutation; the client asked for the preview, nothing else.
  const dialog = page.getByRole('dialog', { name: 'Prévia da alteração' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('preview-label').first()).toHaveText('ANÁLISE DE IMPACTO');
  await expect(dialog.getByTestId('mutation-labels')).toContainText('PRÉVIA SIMULADA');
  await expect(dialog.getByTestId('capability-badge')).toBeVisible();
  await expect(dialog.getByTestId('impact-environment')).toHaveText('PRODUCTION');
  await expect(dialog.getByTestId('mutation-diff')).toContainText(NEW_NAME);
  expect(calls).toEqual(['/api/query', '/api/query/preview']);

  // PRODUCTION needs the typed phrase; execute stays disabled until it matches exactly.
  const execute = dialog.getByTestId('mutation-execute');
  await expect(execute).toBeDisabled();
  const phrase = (await dialog.getByTestId('confirmation-phrase').textContent()) ?? '';
  expect(phrase).toMatch(/^PRODUCTION UPDATE 1 TGFPAR$/);
  await dialog.getByTestId('confirmation-input').fill(phrase.toLowerCase());
  await expect(execute).toBeDisabled();
  await dialog.getByTestId('confirmation-input').fill(phrase);
  await expect(execute).toBeEnabled();

  // e2e defaults (SAFE_MODE=true, GLOBAL_WRITE_ENABLED=false): the server refuses the write.
  await execute.click();
  const refusal = dialog.getByTestId('mutation-error');
  await expect(refusal).toContainText('READ_ONLY_MODE');
  await expect(refusal).toContainText('somente leitura');
  await expect(execute).toBeDisabled();
  expect(calls.filter((c) => c === '/api/query/execute')).toHaveLength(1);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Nothing was written: the row still has its old name.
  await setSql(page, 'SELECT NOMEPARC FROM TGFPAR WHERE CODPARC = 1');
  await page.getByTestId('run-query').click();
  const grid = page.getByTestId('result-grid');
  await expect(grid).toContainText('NOMEPARC');
  await expect(grid).not.toContainText(NEW_NAME);
}
