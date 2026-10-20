import { expect, test } from '@playwright/test';
import type { BrowserContext, Page, Response } from '@playwright/test';
import {
  adminContext,
  call,
  Fixtures,
  nav,
  ok,
  openApp,
  refusal,
  select,
  setSql,
  shot,
  specialistContext,
} from './support';
import { SPECIALIST } from '../playwright.config';

// The mutation lifecycle on the mock gateway (fictitious data): a CTE read, a refused DELETE,
// a PRODUCTION UPDATE stopped by SAFE_MODE, a VERIFIED UPDATE on a SANDBOX connection, the plan
// in the audit log and the kill switch. One admin session walks through it in order.
// Each write uses its own partner row (see RESERVED_CODPARC in support.ts).
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

const STAMP = Date.now().toString(36);
const ROW = { refusedDelete: 7, production: 11, sandbox: 12, killSwitch: 13 };
const SANDBOX_NAME = `Parceiro Sandbox ${STAMP}`;

let admin: BrowserContext;
let fixtures: Fixtures;
let sandboxId: string;
let page: Page;
let sandboxPlanId: string | undefined;

const nameOf = async (codparc: number, connectionId?: string) =>
  (
    await select(
      admin.request,
      `SELECT NOMEPARC FROM TGFPAR WHERE CODPARC = ${codparc}`,
      connectionId,
    )
  )[0]?.[0];

test.beforeAll(async ({ browser }) => {
  admin = await adminContext(browser);
  fixtures = new Fixtures(admin.request, browser);
  sandboxId = await fixtures.connection(`E2E Sandbox ${STAMP}`, 'SANDBOX');
  // Writes are default-deny: one rule lets UPDATE on TGFPAR be planned anywhere. It is created
  // before any preview, since a plan is bound to the policy version it was made under.
  await fixtures.policy({
    name: `E2E ciclo UPDATE TGFPAR ${STAMP}`,
    actions: ['DATA.UPDATE'],
    entities: ['TGFPAR'],
  });
  page = await openApp(admin, 'Admin Demo');
});

test.afterAll(async () => {
  if (!admin) return;
  // The kill switch must never stay off for the next file, whatever happened above.
  await call(admin.request, 'PUT', '/api/admin/security', { globalWriteEnabled: true }).catch(
    () => {},
  );
  await fixtures?.cleanup();
  await admin.close().catch(() => {});
});

async function runInEditor(p: Page, sql: string) {
  await setSql(p, sql);
  await p.getByTestId('run-query').click();
}

/** Ctrl+Enter on a mutation: the server points to the preview, the dialog opens. */
async function openPreview(p: Page, sql: string) {
  const preview = p.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/query/preview',
  );
  await setSql(p, sql);
  await p.keyboard.press('ControlOrMeta+Enter');
  return preview;
}

const executeResponse = (p: Page) =>
  p.waitForResponse(
    (r: Response) =>
      r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/query/execute',
  );

test('runs a SELECT with a CTE', async () => {
  await runInEditor(
    page,
    "WITH ativos AS (SELECT CODPROD, DESCRPROD FROM TGFPRO WHERE ATIVO = 'S') " +
      'SELECT CODPROD, DESCRPROD FROM ativos ORDER BY CODPROD',
  );
  const grid = page.getByTestId('result-grid');
  await expect(grid).toContainText('DESCRPROD');
  await expect(page.getByTestId('result-status')).toContainText(/linha/);
  // A read runs straight away: no preview, no confirmation.
  await expect(page.getByRole('dialog', { name: 'Prévia da alteração' })).toHaveCount(0);
  // The CTE returns exactly the active products of the same read without it.
  const direct = await select(admin.request, "SELECT COUNT(*) FROM TGFPRO WHERE ATIVO = 'S'");
  const viaCte = await select(
    admin.request,
    "WITH ativos AS (SELECT CODPROD FROM TGFPRO WHERE ATIVO = 'S') SELECT COUNT(*) FROM ativos",
  );
  expect(Number(viaCte[0]?.[0])).toBeGreaterThan(0);
  expect(Number(viaCte[0]?.[0])).toBe(Number(direct[0]?.[0]));
  await shot(page, 'lifecycle-cte-select');
});

test('refuses a DELETE as UNSUPPORTED and deletes nothing', async ({ browser }) => {
  const before = await nameOf(ROW.refusedDelete);
  expect(before).toBeTruthy();

  // The specialist holds DATA.DELETE (no system role does), so the DELETE is not refused for a
  // missing permission: it reaches the capability check.
  const deleter = await specialistContext(browser);
  try {
    const p = await openApp(deleter, SPECIALIST.name);
    const preview = await openPreview(p, `DELETE FROM TGFPAR WHERE CODPARC = ${ROW.refusedDelete}`);
    // The server's verdict: the operation is classified UNSUPPORTED for this table.
    expect(preview.ok()).toBe(false);
    const err = await refusal(preview);
    expect(err.code).toBe('OPERATION_NOT_SUPPORTED');
    expect(err.details?.capability).toBe('UNSUPPORTED');

    const alert = p.getByRole('region', { name: 'Resultados' }).getByRole('alert');
    await expect(alert).toContainText('OPERATION_NOT_SUPPORTED');
    await expect(alert).toContainText('Esta operação não é suportada para a tabela.');
    // The capability label itself is on screen, verbatim.
    await expect(alert.getByTestId('capability-badge')).toHaveText('UNSUPPORTED');
    await expect(p.getByRole('dialog', { name: 'Prévia da alteração' })).toHaveCount(0);
    await shot(p, 'lifecycle-delete-unsupported');
  } finally {
    await deleter.close();
  }

  // Nothing was deleted.
  expect(await nameOf(ROW.refusedDelete)).toBe(before);
});

test('PRODUCTION UPDATE: strong confirmation, then SAFE_MODE blocks it and nothing changes', async () => {
  const before = await nameOf(ROW.production);
  const target = `Bloqueado SAFE_MODE ${STAMP}`;
  await expect(page.getByTestId('connection-picker')).toContainText(/PRODU/);

  const preview = await openPreview(
    page,
    `UPDATE TGFPAR SET NOMEPARC = '${target}' WHERE CODPARC = ${ROW.production}`,
  );
  expect(preview.status()).toBe(200);
  const plan = (await preview.json()) as { planId: string; token: string };
  const dialog = page.getByRole('dialog', { name: 'Prévia da alteração' });
  await expect(dialog.getByTestId('impact-environment')).toHaveText('PRODUCTION');
  await expect(dialog.getByTestId('production-band')).toBeVisible();
  await expect(dialog).toContainText('SAFE_MODE ativo');
  await expect(dialog).not.toContainText('GLOBAL_WRITE_ENABLED desligado');

  // The preview already says the write is unavailable: the button stays disabled even with the
  // exact phrase, so the UI sends nothing.
  const execute = dialog.getByTestId('mutation-execute');
  await expect(execute).toBeDisabled();
  const phrase = (await dialog.getByTestId('confirmation-phrase').textContent()) ?? '';
  expect(phrase).toBe('PRODUCTION UPDATE 1 TGFPAR');
  await dialog.getByTestId('confirmation-input').fill(phrase);
  await expect(execute).toBeDisabled();

  // The server refuses the plan on its own too, naming SAFE_MODE.
  const res = await call(page.request, 'POST', '/api/query/execute', {
    planId: plan.planId,
    token: plan.token,
    idempotencyKey: `e2e-safe-mode-${STAMP}`,
    strongConfirmation: phrase,
  });
  const err = await refusal(res);
  expect(err.code).toBe('READ_ONLY_MODE');
  expect(err.details?.switch).toBe('SAFE_MODE');
  await shot(page, 'lifecycle-production-safe-mode');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  const after = await nameOf(ROW.production);
  expect(after).toBe(before);
  expect(after).not.toBe(target);
});

test('SANDBOX UPDATE executes and is VERIFIED', async () => {
  const before = await nameOf(ROW.sandbox, sandboxId);
  expect(before).not.toBe(SANDBOX_NAME);
  await page.getByTestId('connection-picker').selectOption(sandboxId);

  const preview = await openPreview(
    page,
    `UPDATE TGFPAR SET NOMEPARC = '${SANDBOX_NAME}' WHERE CODPARC = ${ROW.sandbox}`,
  );
  expect(preview.status()).toBe(200);
  const plan = (await preview.json()) as {
    planId: string;
    execution: { available: boolean };
    requires: { strongConfirmation: string | null };
  };
  expect(plan.execution.available).toBe(true);
  const dialog = page.getByRole('dialog', { name: 'Prévia da alteração' });
  await expect(dialog.getByTestId('impact-environment')).toHaveText('SANDBOX');
  await expect(dialog.getByTestId('impact-rows')).toHaveText('1 registro será alterado');
  // The record card: ANTES is the row as read now, DEPOIS the value the UPDATE sets.
  const field = dialog
    .getByTestId('mutation-diff')
    .getByTestId('diff-field')
    .filter({ hasText: 'NOMEPARC' });
  await expect(field.getByTestId('diff-before')).toContainText(String(before));
  await expect(field.getByTestId('diff-after')).toContainText(SANDBOX_NAME);
  // The preview wrote nothing: the row still holds its old name.
  expect(await nameOf(ROW.sandbox, sandboxId)).toBe(before);
  if (plan.requires.strongConfirmation) {
    await dialog.getByTestId('confirmation-input').fill(plan.requires.strongConfirmation);
  }
  await expect(dialog.getByTestId('mutation-execute')).toHaveText('Confirmar alteração');

  const response = executeResponse(page);
  await dialog.getByTestId('mutation-execute').click();
  const report = (await (await response).json()) as { status: string; verification: string };
  expect(report.status).toBe('success');
  expect(report.verification).toBe('VERIFIED');
  await expect(dialog.getByTestId('report-title')).toHaveText('Alteração concluída');
  await expect(dialog.getByTestId('verification-status')).toHaveText('VERIFIED');
  await expect(dialog.getByTestId('execution-steps')).toContainText('sim');
  // AGORA is the value read back from the gateway after the write.
  await expect(dialog.getByTestId('step-now').filter({ hasText: SANDBOX_NAME })).toHaveCount(1);
  await shot(page, 'lifecycle-sandbox-verified');
  sandboxPlanId = plan.planId;
  await dialog.getByRole('button', { name: 'Fechar', exact: true }).last().click();
  await expect(dialog).toBeHidden();

  // The row really holds the new value now.
  expect(await nameOf(ROW.sandbox, sandboxId)).toBe(SANDBOX_NAME);
});

test('the audit log shows the executed plan', async () => {
  expect(sandboxPlanId).toBeTruthy();
  const { items } = await ok<{
    items: {
      action: string;
      planId: string | null;
      statement: string | null;
      details: { report?: { verification?: string } } | null;
    }[];
  }>(admin.request, 'GET', `/api/audit?planId=${sandboxPlanId}&limit=50`);
  const actions = items.map((i) => i.action);
  expect(actions).toEqual(
    expect.arrayContaining(['PLAN_CREATED', 'PLAN_EXECUTED', 'VERIFICATION']),
  );
  expect(items.every((i) => i.planId === sandboxPlanId)).toBe(true);
  const executed = items.find((i) => i.action === 'PLAN_EXECUTED');
  expect(executed?.statement).toContain(SANDBOX_NAME);
  expect(executed?.details?.report?.verification).toBe('VERIFIED');
  expect(JSON.stringify(items.find((i) => i.action === 'VERIFICATION'))).toContain('"VERIFIED"');

  await nav(page, 'Auditoria').click();
  const row = page
    .getByTestId('audit-row')
    .filter({ hasText: 'PLAN_EXECUTED' })
    .filter({ hasText: SANDBOX_NAME })
    .first();
  await expect(row).toBeVisible();
  await row.click();
  const detail = page.getByTestId('audit-detail');
  await expect(detail).toContainText(sandboxPlanId!);
  await expect(detail).toContainText('VERIFIED');
  await expect(detail).toContainText(sandboxId);
  await shot(page, 'lifecycle-audit-plan');
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
  await nav(page, 'Editor SQL').click();
});

test('the kill switch blocks the execute of a plan made while writes were on', async () => {
  const before = await nameOf(ROW.killSwitch, sandboxId);
  const target = `Bloqueado pela chave ${STAMP}`;
  await expect(page.getByTestId('connection-picker')).toHaveValue(sandboxId);

  const preview = await openPreview(
    page,
    `UPDATE TGFPAR SET NOMEPARC = '${target}' WHERE CODPARC = ${ROW.killSwitch}`,
  );
  const plan = (await preview.json()) as {
    execution: { available: boolean };
    requires: { strongConfirmation: string | null };
  };
  expect(plan.execution.available).toBe(true);
  const dialog = page.getByRole('dialog', { name: 'Prévia da alteração' });
  await expect(dialog.getByTestId('impact-environment')).toHaveText('SANDBOX');
  // Everything the execute needs is in place, so only the switch can refuse it.
  if (plan.requires.strongConfirmation) {
    await dialog.getByTestId('confirmation-input').fill(plan.requires.strongConfirmation);
  }
  await expect(dialog.getByTestId('mutation-execute')).toBeEnabled();

  // An administrator pulls the emergency switch from the Security page (another tab).
  const security = await admin.newPage();
  try {
    await security.goto('/');
    await nav(security, 'Segurança').click();
    await expect(security.getByTestId('security-effective')).toHaveText('LIGADO');
    security.once('dialog', (d) => void d.accept());
    await security
      .getByRole('button', { name: 'Desligar gravações (chave de emergência)' })
      .click();
    await expect(security.getByTestId('security-runtime')).toHaveText('DESLIGADO');
    await expect(security.getByTestId('security-effective')).toHaveText('DESLIGADO');
    await expect(security.getByTestId('security-env')).toHaveText('LIGADO');
    await shot(security, 'lifecycle-kill-switch');
  } finally {
    await security.close();
  }
  const state = await ok<{ globalWriteEnabled: { effective: boolean } }>(
    admin.request,
    'GET',
    '/api/admin/security',
  );
  expect(state.globalWriteEnabled.effective).toBe(false);

  const response = executeResponse(page);
  await dialog.getByTestId('mutation-execute').click();
  const err = await refusal(await response);
  expect(err.code).toBe('READ_ONLY_MODE');
  expect(err.details?.switch).toBe('GLOBAL_WRITE_ENABLED');
  await expect(dialog.getByTestId('mutation-error')).toContainText('READ_ONLY_MODE');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Nothing was written.
  const after = await nameOf(ROW.killSwitch, sandboxId);
  expect(after).toBe(before);
  expect(after).not.toBe(target);

  // Turning it back on is allowed (the environment keeps writes enabled).
  await ok(admin.request, 'PUT', '/api/admin/security', { globalWriteEnabled: true });
});
