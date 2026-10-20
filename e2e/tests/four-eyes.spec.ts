import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import {
  adminContext,
  APPROVER_ROLE,
  call,
  Fixtures,
  nav,
  ok,
  openApp,
  refusal,
  select,
  setSql,
  shot,
  userContext,
} from './support';

// Four eyes: an operator plans an UPDATE that a policy marks as needing approval; it cannot run
// until another person (the administrator) approves it. SANDBOX mock connection, fictitious data.
// The operator holds APPROVAL.DECIDE too (test-only role seeded by start-server.mjs), so the
// refusal of their own approval comes from the self-approval rule, not a missing permission.
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

const STAMP = Date.now().toString(36);
const OPERATOR = {
  email: `e2e-operador-${STAMP}@example.com`,
  name: 'Pessoa Operadora Demo',
  initial: 'Operador#Inicial2026',
  changed: 'Operador#Trocado2026',
};
const CODPARC = 21;
const NEW_NAME = `Aprovado em dupla ${STAMP}`;

let admin: BrowserContext;
let operator: BrowserContext;
let fixtures: Fixtures;
let connectionId: string;
let operatorPage: Page;
let planId: string;
let planToken: string;

const currentName = async () =>
  (
    await select(
      admin.request,
      `SELECT NOMEPARC FROM TGFPAR WHERE CODPARC = ${CODPARC}`,
      connectionId,
    )
  )[0]?.[0];

test.beforeAll(async ({ browser }) => {
  admin = await adminContext(browser);
  fixtures = new Fixtures(admin.request);
  connectionId = await fixtures.connection(`E2E Quatro olhos ${STAMP}`, 'SANDBOX');
  // Only on this connection: UPDATE on TGFPAR is allowed but needs someone else's approval.
  await fixtures.policy({
    name: `E2E quatro olhos ${STAMP}`,
    actions: ['DATA.UPDATE'],
    entities: ['TGFPAR'],
    connectionIds: [connectionId],
    limits: { requireApproval: true },
  });
  await fixtures.user(OPERATOR.email, OPERATOR.name, OPERATOR.initial, [APPROVER_ROLE]);
  operator = await userContext(browser, OPERATOR.email, OPERATOR.initial, OPERATOR.changed);
  operatorPage = await openApp(operator, OPERATOR.name);
});

test.afterAll(async () => {
  await operator?.close().catch(() => {});
  if (!admin) return;
  await fixtures?.cleanup();
  await admin.close().catch(() => {});
});

const executeResponse = (p: Page) =>
  p.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/query/execute',
  );

test('the operator plans an UPDATE that needs approval; executing it first writes nothing', async () => {
  const before = await currentName();
  expect(before).not.toBe(NEW_NAME);
  const page = operatorPage;
  await page.getByTestId('connection-picker').selectOption(connectionId);

  const previewResponse = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/query/preview',
  );
  await setSql(page, `UPDATE TGFPAR SET NOMEPARC = '${NEW_NAME}' WHERE CODPARC = ${CODPARC}`);
  await page.keyboard.press('ControlOrMeta+Enter');
  const preview = (await (await previewResponse).json()) as {
    planId: string;
    token: string;
    requires: { approval: boolean };
  };
  expect(preview.requires.approval).toBe(true);
  planId = preview.planId;
  planToken = preview.token;

  const dialog = page.getByRole('dialog', { name: 'Prévia da alteração' });
  await expect(dialog.getByTestId('impact-environment')).toHaveText('SANDBOX');
  await expect(dialog.getByTestId('approval-required')).toBeVisible();

  // Execute before anyone approved: refused, and the row is untouched.
  const early = executeResponse(page);
  await dialog.getByTestId('mutation-execute').click();
  const err = await refusal(await early);
  expect(err.code).toBe('FORBIDDEN');
  expect(err.details?.reason).toBe('approval_pending');
  await expect(dialog.getByTestId('approval-pending')).toContainText('Nada foi gravado');
  expect(await currentName()).toBe(before);

  // The operator asks for approval.
  const requested = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/approvals',
  );
  await dialog.getByTestId('request-approval').click();
  const requestRes = await requested;
  expect(requestRes.status()).toBe(201);
  const { approval } = (await requestRes.json()) as { approval: { id: string } };
  await expect(dialog.getByTestId('approval-requested')).toBeVisible();
  await shot(page, 'four-eyes-requested');

  // They hold APPROVAL.DECIDE, yet cannot approve their own request.
  const own = await call(operator.request, 'POST', `/api/approvals/${approval.id}/decision`, {
    decision: 'APPROVE',
  });
  expect(own.status()).toBe(403);
  const ownErr = await refusal(own);
  expect(ownErr.code).toBe('FORBIDDEN');
  expect(ownErr.details?.reason).toBe('self_approval');
  expect(await currentName()).toBe(before);

  // The request is still pending: executing is still refused and writes nothing.
  const still = await call(operator.request, 'POST', '/api/query/execute', {
    planId,
    token: planToken,
    idempotencyKey: `e2e-still-pending-${STAMP}`,
  });
  const stillErr = await refusal(still);
  expect(stillErr.code).toBe('FORBIDDEN');
  expect(stillErr.details?.reason).toBe('approval_pending');
  expect(await currentName()).toBe(before);
});

test('another person approves it on the Approvals page', async () => {
  const page = await openApp(admin, 'Admin Demo');
  try {
    await nav(page, 'Aprovações').click();
    const item = page.getByTestId('approval-item').filter({ hasText: NEW_NAME });
    await expect(item).toBeVisible();
    await expect(item.getByTestId('approval-requester')).toContainText(OPERATOR.name);
    await expect(item.getByTestId('approval-sql')).toContainText(`CODPARC = ${CODPARC}`);
    await shot(page, 'four-eyes-approvals');
    await item.getByRole('button', { name: 'Aprovar' }).click();
    await item.getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByTestId('approval-message')).toBeVisible();
    await expect(page.getByTestId('approval-item').filter({ hasText: NEW_NAME })).toHaveCount(0);
  } finally {
    await page.close();
  }

  // Approving wrote nothing: only the operator's execute does.
  expect(await currentName()).not.toBe(NEW_NAME);
});

test('after the approval the operator executes it: VERIFIED and audited', async () => {
  const page = operatorPage;
  const dialog = page.getByRole('dialog', { name: 'Prévia da alteração' });
  const response = executeResponse(page);
  await dialog.getByTestId('mutation-execute').click();
  const report = (await (await response).json()) as { status: string; verification: string };
  expect(report.status).toBe('success');
  expect(report.verification).toBe('VERIFIED');
  await expect(dialog.getByTestId('verification-status')).toHaveText('VERIFIED');
  await shot(page, 'four-eyes-executed');

  expect(await currentName()).toBe(NEW_NAME);

  // The approval events carry the plan in their details; the plan events in their own column.
  type Event = {
    action: string;
    status: string;
    userEmail: string | null;
    planId: string | null;
    details: { planId?: string } | null;
  };
  const events = async (action: string) =>
    (
      await ok<{ items: Event[] }>(
        admin.request,
        'GET',
        `/api/audit?action=${encodeURIComponent(action)}&limit=200`,
      )
    ).items.filter((i) => i.status === 'success' && (i.planId ?? i.details?.planId) === planId);
  expect((await events('approval.request')).map((i) => i.userEmail)).toEqual([OPERATOR.email]);
  expect((await events('approval.decide')).map((i) => i.userEmail)).toEqual(['admin@example.com']);
  expect((await events('PLAN_EXECUTED')).map((i) => i.userEmail)).toEqual([OPERATOR.email]);
});
