import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { shot } from './support';

// First start without BOOTSTRAP_ADMIN_EMAIL: the server logs a one-time bootstrap token and the
// first administrator is created with it over HTTP. That needs an empty database, so this file
// starts its own server (same build, mock gateway, DEMO_MODE) on the next port and stops it.
test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

const PORT = Number(process.env.E2E_PORT ?? 3199) + 1;
const BASE = `http://localhost:${PORT}`;
const DIR = join(tmpdir(), `dbx-e2e-${PORT}-bootstrap`);
const ADMIN = { email: 'primeiro-admin@example.com', password: 'Primeiro#Admin2026' };

let server: ChildProcess | undefined;
let output = '';
let token = '';

const post = (path: string, data: unknown) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify(data),
  });

test.beforeAll(async () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('BOOTSTRAP_ADMIN_')) delete env[key];
  server = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../apps/api/dist/server.mjs', import.meta.url))],
    {
      env: {
        ...env,
        NODE_ENV: 'test',
        PORT: String(PORT),
        APP_URL: BASE,
        DATABASE_URL: `pglite:${join(DIR, 'db')}`,
        STATIC_DIR: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
        AUTH_SECRET: 'e2e-only-bootstrap-secret-0123456789abcdef',
        DEMO_MODE: 'true',
        SANKHYA_MODE: 'mock',
        SANKHYA_BASE_URL: 'https://gateway.example.com',
        SANKHYA_ALLOWED_HOSTS: 'gateway.example.com',
        SANKHYA_CLIENT_ID: 'mock-client-id',
        SANKHYA_CLIENT_SECRET: 'mock-client-secret',
        SANKHYA_X_TOKEN: 'mock-x-token',
        SANKHYA_DIALECT: 'oracle',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  server.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));

  await expect
    .poll(
      async () => {
        const live = await fetch(`${BASE}/health/live`).catch(() => null);
        return live?.ok === true && /bootstrap token: /.test(output);
      },
      { timeout: 60_000, intervals: [500] },
    )
    .toBe(true);
  token = /bootstrap token: ([A-Za-z0-9_-]+)/.exec(output)?.[1] ?? '';
  expect(token).not.toBe('');
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server!.once('exit', resolve));
    server.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  }
  rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

test('creates the first administrator with the one-time token, which cannot be reused', async () => {
  // Nobody can log in before the bootstrap.
  const before = await post('/api/auth/login', ADMIN);
  expect(before.status).toBe(401);

  const wrong = await post('/api/auth/bootstrap', { ...ADMIN, token: `${token}x` });
  expect(wrong.ok).toBe(false);
  expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe(
    'CONFIRMATION_INVALID',
  );

  const created = await post('/api/auth/bootstrap', { ...ADMIN, token });
  expect(created.status, await created.clone().text()).toBe(201);
  const { user } = (await created.json()) as {
    user: { email: string; roles: string[]; mustChangePassword: boolean };
  };
  expect(user.email).toBe(ADMIN.email);
  expect(user.roles).toContain('ADMIN');
  expect(user.mustChangePassword).toBe(false);

  // The same token again creates nobody.
  const reused = await post('/api/auth/bootstrap', {
    email: 'segundo-admin@example.com',
    password: 'Segundo#Admin2026',
    token,
  });
  expect(reused.ok).toBe(false);
  const second = await post('/api/auth/login', {
    email: 'segundo-admin@example.com',
    password: 'Segundo#Admin2026',
  });
  expect(second.status).toBe(401);
});

test('the new administrator logs in through the UI', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: BASE, locale: 'pt-BR' });
  try {
    const page = await ctx.newPage();
    await page.goto('/');
    await page.getByLabel('E-mail').fill(ADMIN.email);
    await page.getByLabel('Senha').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByTestId('current-user')).toBeVisible();
    await expect(page.getByTestId('demo-banner')).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Navegação principal' }).getByRole('button', {
        name: 'Usuários',
        exact: true,
      }),
    ).toBeVisible();
    // The schema tree has loaded from the mock gateway before the screenshot.
    await expect(page.getByTestId('schema-group-TGF')).toBeVisible();
    await expect(page.getByText('Carregando schema…')).toHaveCount(0);
    await shot(page, 'bootstrap-first-admin');
  } finally {
    await ctx.close();
  }
});
