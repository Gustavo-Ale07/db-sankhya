import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// Runs against the production build (`pnpm build`): the API serves the web bundle from
// STATIC_DIR, with the in-process mock Sankhya gateway (fictitious data) and an in-memory
// database.
const PORT = 3199;
const root = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export const BOOTSTRAP = { email: 'admin@example.com', password: 'E2E-Bootstrap#2026' };

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: `node "${root('../apps/api/dist/server.mjs')}"`,
    url: `http://localhost:${PORT}/health/live`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: 'test',
      PORT: String(PORT),
      APP_URL: `http://localhost:${PORT}`,
      DATABASE_URL: 'pglite:memory',
      STATIC_DIR: root('../apps/web/dist'),
      AUTH_SECRET: 'e2e-only-session-secret-0123456789abcdef',
      BOOTSTRAP_ADMIN_EMAIL: BOOTSTRAP.email,
      BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP.password,
      BOOTSTRAP_ADMIN_NAME: 'Admin Demo',
      // OPERATOR is kept on purpose: the refusal test proves writes are denied even for a
      // write-capable role.
      BOOTSTRAP_ADMIN_ROLES: 'ADMIN,OPERATOR',
      // Reads go to the default SANKHYA_* connection, served by the in-process mock gateway.
      SANKHYA_MODE: 'mock',
      SANKHYA_BASE_URL: 'https://gateway.example.com',
      SANKHYA_ALLOWED_HOSTS: 'gateway.example.com',
      SANKHYA_CLIENT_ID: 'mock-client-id',
      SANKHYA_CLIENT_SECRET: 'mock-client-secret',
      SANKHYA_X_TOKEN: 'mock-x-token',
      SANKHYA_DIALECT: 'oracle',
      LOG_LEVEL: 'warn',
    },
  },
});
