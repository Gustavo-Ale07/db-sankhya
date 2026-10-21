import { expect, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { adminContext, Fixtures, openApp, setSql } from './support';

// A result belongs to the connection it was read from: switching connections clears it, so rows
// of one environment are never shown under another (mock gateway, fictitious data).
// Named to run after explorer.spec.ts, which changes the bootstrap password through the UI.
test.setTimeout(90_000);

const STAMP = Date.now().toString(36);

let admin: BrowserContext;
let fixtures: Fixtures;

test.beforeAll(async ({ browser }) => {
  admin = await adminContext(browser);
  fixtures = new Fixtures(admin.request, browser);
});

test.afterAll(async () => {
  await fixtures?.cleanup();
  await admin?.close().catch(() => {});
});

test('switching the connection clears the result of the previous one', async () => {
  const sandboxId = await fixtures.connection(`E2E Troca ${STAMP}`, 'SANDBOX');
  const page = await openApp(admin, 'Admin Demo');
  const picker = page.getByTestId('connection-picker');
  await expect(picker).toContainText(/PRODU/);

  await setSql(page, 'SELECT CODPARC, NOMEPARC FROM TGFPAR WHERE CODPARC = 1');
  await page.getByTestId('run-query').click();
  const results = page.getByRole('region', { name: 'Resultados' });
  await expect(results.getByTestId('result-grid')).toBeVisible();

  await picker.selectOption(sandboxId);
  await expect(results.getByTestId('result-grid')).toHaveCount(0);
  // Nothing was cancelled by the user: the run is just gone.
  await expect(results).not.toContainText('QUERY_CANCELLED');
  await page.close();
});
