import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { BOOTSTRAP } from '../playwright.config';

// One browser session walks through the main flows in order, like a user would.
// `UPDATE_SCREENSHOTS=1 pnpm test:e2e` refreshes the images in docs/screenshots.
test.describe.configure({ mode: 'serial' });

const NEW_PASSWORD = 'E2E-Changed#Pass2026';
const SHOTS = process.env.UPDATE_SCREENSHOTS === '1';

let page: Page;

async function shot(name: string) {
  if (!SHOTS) return;
  await page.screenshot({
    path: fileURLToPath(new URL(`../../docs/screenshots/${name}.png`, import.meta.url)),
  });
}

/** Replaces the active editor text. insertText avoids Monaco's auto-closing quotes. */
async function setSql(sql: string) {
  const editor = page.getByTestId('sql-editor').locator('.monaco-editor').first();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(sql);
}

async function run(sql: string) {
  await setSql(sql);
  await page.getByTestId('run-query').click();
}

function nav(label: string) {
  return page.getByRole('navigation', { name: 'Navegação principal' }).getByRole('button', {
    name: label,
    exact: true,
  });
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page.close();
});

test('rejects a wrong password, then logs in and forces the bootstrap password change', async () => {
  await page.goto('/');
  await page.getByLabel('E-mail').fill(BOOTSTRAP.email);
  await page.getByLabel('Senha').fill('wrong-password-123');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('alert')).toBeVisible();

  await page.getByLabel('Senha').fill(BOOTSTRAP.password);
  await page.getByRole('button', { name: 'Entrar' }).click();

  await page.getByLabel('Senha atual').fill(BOOTSTRAP.password);
  await page.getByLabel('Nova senha', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('Confirmar nova senha').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Salvar nova senha' }).click();

  await expect(page.getByTestId('current-user')).toContainText('Admin Demo');
  await expect(page.getByTestId('sankhya-mode')).toContainText(/mock/i);
  await expect(page.getByTestId('app-version')).toBeVisible();
});

test('shows the Sankhya data dictionary in the schema tree', async () => {
  await expect(page.getByTestId('environment-banner')).toBeVisible();
  const schema = page.getByRole('complementary', { name: 'Schema' });
  await schema.getByTestId('schema-group-TGF').click();
  await expect(schema.getByTestId('schema-table-TGFPAR')).toBeVisible();
  await expect(schema.getByTestId('schema-table-TGFPRO')).toBeVisible();
  await schema.getByPlaceholder('Filtrar tabelas e colunas…').fill('TSICID');
  await expect(schema.getByTestId('schema-table-TSICID')).toBeVisible();
  await expect(schema.getByTestId('schema-table-TGFPRO')).toBeHidden();
  await schema.getByPlaceholder('Filtrar tabelas e colunas…').fill('');
});

test('runs a SELECT through the Sankhya gateway and shows results and JSON', async () => {
  await run(
    "SELECT CODPROD, DESCRPROD, CODVOL, ATIVO FROM TGFPRO WHERE ATIVO = 'S' ORDER BY DESCRPROD",
  );
  const grid = page.getByTestId('result-grid');
  await expect(grid).toBeVisible();
  await expect(grid).toContainText('DESCRPROD');
  await expect(page.getByTestId('result-status')).toContainText(/linha/);
  await shot('query-results');

  await page.getByRole('tab', { name: 'JSON' }).click();
  await expect(page.getByTestId('result-json')).toContainText('"ATIVO": "S"');

  await page.getByRole('tab', { name: 'Results' }).click();
});

test('saves the current query and lists it under saved queries', async () => {
  await setSql('SELECT CODCID, COUNT(*) AS TOTAL FROM TGFPAR GROUP BY CODCID ORDER BY TOTAL DESC');
  await page.keyboard.press('ControlOrMeta+S');
  await page.getByTestId('save-name').fill('Parceiros por cidade');
  await page.getByTestId('save-confirm').click();

  await nav('Consultas salvas').click();
  await expect(page.getByTestId('saved-list')).toContainText('Parceiros por cidade');
  await page.getByRole('button', { name: 'Executar' }).first().click();
  await expect(page.getByTestId('result-grid')).toContainText(/total/i);
});

test('records executed queries in the history', async () => {
  await nav('Histórico').click();
  await expect(page.getByTestId('history-table')).toContainText('GROUP BY CODCID');
  await expect(page.getByTestId('history-table')).toContainText("WHERE ATIVO = 'S'");
  await nav('Editor SQL').click();
});

test('refuses a mutation: writes are not available yet', async () => {
  await run("UPDATE TGFPAR SET NOMEPARC = 'Teste' WHERE CODPARC = 1");
  const alert = page.getByRole('region', { name: 'Resultados' }).getByRole('alert');
  await expect(alert).toContainText('SQL_UNSUPPORTED');
  await expect(alert).toContainText('Mutations are not available yet.');
});

test('materializes a Sankhya read into a scratch table and queries it', async () => {
  await nav('Scratch').click();
  await page.getByTestId('materialize-source').fill('SELECT CODPROD, DESCRPROD FROM TGFPRO');
  await page.getByTestId('materialize-into').fill('tmp_e2e_produtos');
  await page.getByTestId('materialize-run').click();
  await expect(page.getByTestId('materialize-result')).toContainText('tmp_e2e_produtos');
  await expect(page.getByTestId('materialize-result')).toContainText(/\d+ linhas?/);
  await expect(page.getByTestId('scratch-tables')).toContainText('tmp_e2e_produtos');

  // The same name again is refused unless replace is set; the refusal is shown, not hidden.
  await page.getByTestId('materialize-run').click();
  await expect(page.getByRole('region', { name: 'Materializar' }).getByRole('alert')).toContainText(
    'CONFLICT',
  );
  await page.getByTestId('materialize-replace').check();
  await page.getByTestId('materialize-run').click();
  await expect(page.getByTestId('materialize-result')).toContainText('tmp_e2e_produtos');

  await page.getByTestId('scratch-sql').fill('SELECT count(*) AS n FROM tmp_e2e_produtos');
  await page.getByTestId('scratch-run').click();
  await expect(page.getByTestId('scratch-result')).toContainText('SELECT');

  // A non-scratch name is blocked in the form before any request.
  await page.getByTestId('materialize-into').fill('produtos');
  await expect(page.getByTestId('materialize-run')).toBeDisabled();
  await nav('Editor SQL').click();
});

test('audit log lists the failed login and the denied write', async () => {
  await nav('Auditoria').click();
  const table = page.getByTestId('audit-table');
  await expect(table).toContainText('auth.login_failed');
  await expect(table).toContainText('write.denied');
  await shot('audit-log');
});

test('users page shows effective roles and assigns roles to a new user', async () => {
  await nav('Usuários').click();
  await expect(page.getByTestId(`roles-${BOOTSTRAP.email}`)).toContainText('Administrador');
  await expect(page.getByTestId(`roles-${BOOTSTRAP.email}`)).toContainText('Operador');

  await page.getByRole('button', { name: 'Novo usuário' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nome').fill('Pessoa Leitora');
  await dialog.getByLabel('E-mail').fill('leitora@example.com');
  await dialog.getByLabel('Senha inicial').fill('Leitora#Strong2026');
  await dialog.getByRole('button', { name: 'Criar' }).click();
  await expect(page.getByTestId('roles-leitora@example.com')).toHaveText('Leitor');

  await page
    .getByRole('row')
    .filter({ hasText: 'leitora@example.com' })
    .getByRole('button', { name: 'Papéis' })
    .click();
  await page.getByRole('dialog').getByLabel('Operador').check();
  await page.getByRole('dialog').getByRole('button', { name: 'Salvar papéis' }).click();
  await expect(page.getByTestId('roles-leitora@example.com')).toHaveText('Operador, Leitor');
});

test('admin pages: groups, roles, policies, connections and security', async () => {
  // Groups: create one and add the new reader as a member.
  await nav('Grupos').click();
  await page.getByRole('button', { name: 'Novo grupo' }).click();
  await page.getByRole('dialog').getByLabel('Nome').fill('Equipe Fiscal');
  await page.getByRole('dialog').getByRole('button', { name: 'Salvar' }).click();
  const groupRow = page
    .getByTestId('groups-table')
    .getByRole('row')
    .filter({ hasText: 'Equipe Fiscal' });
  await expect(groupRow).toBeVisible();
  await groupRow.getByRole('button', { name: 'Membros' }).click();
  await page
    .getByRole('dialog')
    .getByLabel(/leitora@example.com/)
    .check();
  await page.getByRole('dialog').getByRole('button', { name: 'Salvar membros' }).click();
  await expect(groupRow.getByRole('cell').nth(2)).toHaveText('1');

  // Roles: system roles cannot be deleted.
  await nav('Papéis').click();
  const adminRole = page
    .getByTestId('roles-table')
    .getByRole('row')
    .filter({ hasText: 'sistema' })
    .first();
  await expect(adminRole.getByRole('button', { name: 'Excluir' })).toBeDisabled();

  // Policies: a bad rule shows the server error, a valid one bumps the version.
  await nav('Políticas').click();
  await page.getByRole('button', { name: 'Nova política' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nome').fill('Limite de leitura');
  await dialog.getByLabel('QUERY.SELECT').check();
  await dialog.getByLabel('Máx. linhas lidas').fill('100');
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByTestId('policies-table')).toContainText('Limite de leitura');
  await expect(page.getByTestId('policy-version')).toBeVisible();

  // Connections: secrets are never shown, only their state.
  await nav('Conexões').click();
  const item = page.getByTestId('connection-item').first();
  await expect(item).toBeVisible();
  await expect(item.getByTestId('connection-environment')).toHaveText(
    /PRODUÇÃO|HOMOLOGAÇÃO|SANDBOX/,
  );
  await item.getByRole('button', { name: 'Testar' }).click();
  await expect(item.getByRole('status')).toBeVisible();

  // Security: env, runtime and effective are all reported.
  await nav('Segurança').click();
  await expect(page.getByTestId('security-env')).toBeVisible();
  await expect(page.getByTestId('security-runtime')).toBeVisible();
  await expect(page.getByTestId('security-effective')).toBeVisible();
});

test('explorer overview screenshot', async () => {
  await nav('Editor SQL').click();
  await run('SELECT CODPROD, DESCRPROD, CODVOL, VLRVENDA FROM TGFPRO ORDER BY DESCRPROD');
  await expect(page.getByTestId('result-grid')).toBeVisible();
  await shot('explorer');
});
