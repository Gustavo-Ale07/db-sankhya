import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// Runs against the production build (`pnpm build`): the API serves the web bundle from
// STATIC_DIR, with the in-process mock Sankhya gateway (fictitious data) and a fresh PGlite
// directory. There is no default password: start-server.mjs creates the administrator with the
// admin CLI (dist/admin.mjs) and saves its one-time password for the tests.
// E2E_PORT lets two runs work side by side, three ports apart (bootstrap.spec.ts starts its own
// server on E2E_PORT + 1, and the CUT server below listens on E2E_PORT + 2); each port gets its
// own data directory.
const PORT = Number(process.env.E2E_PORT ?? 3199);
const root = (p: string) => fileURLToPath(new URL(p, import.meta.url));
// Same derivation as start-server.mjs (from PORT); keep the two in sync.
export const E2E_DIR = join(tmpdir(), `dbx-e2e-${PORT}`);
const PASSWORD_FILE = join(E2E_DIR, 'bootstrap-password.txt');
export const BASE_URL = `http://localhost:${PORT}`;

/**
 * A second server, two ports up, whose mock gateway cuts every result at 50 rows without
 * saying so, with 5000 fictitious dictionary rows ahead of the demo tables': the dictionary
 * outgrows the 100 pages a read may take, so its catalog is always incomplete
 * (`TDDCAM:truncated`) and lists no column of the demo tables. Only cut-dictionary.spec.ts uses it.
 */
const CUT_PORT = PORT + 2;
export const CUT = {
  baseURL: `http://localhost:${CUT_PORT}`,
  dir: join(tmpdir(), `dbx-e2e-${CUT_PORT}`),
};

export const BOOTSTRAP = {
  email: 'admin@example.com',
  /** One-time password printed by the admin CLI when the e2e server started. */
  get password(): string {
    return readFileSync(PASSWORD_FILE, 'utf8').trim();
  },
};

/**
 * A second user created by start-server.mjs with a seeded test-only role (QUERY.SELECT, TEMP.*,
 * DATA.DELETE, DDL.CUSTOM.GENERATE), which no administrator can grant through the API.
 */
export const SPECIALIST = {
  email: 'especialista@example.com',
  name: 'Especialista Demo',
  get password(): string {
    return readFileSync(join(E2E_DIR, 'specialist-password.txt'), 'utf8').trim();
  },
};

/**
 * An administrator created by start-server.mjs with the ADMIN role only. The bootstrap admin
 * also holds OPERATOR, and separation of duties refuses policy changes by anyone who can write.
 */
export const POLICY_ADMIN = {
  email: 'politicas@example.com',
  name: 'Admin Políticas',
  get password(): string {
    return readFileSync(join(E2E_DIR, 'policy-admin-password.txt'), 'utf8').trim();
  },
};

/** Test-only mock switches of the CUT server (refused outside mock mode and in production). */
const CUT_GATEWAY = {
  SANKHYA_MOCK_ROW_CAP: '50',
  SANKHYA_MOCK_SILENT_CUT: 'true',
  SANKHYA_MOCK_DICTIONARY_PADDING: '5000',
};

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
    baseURL: BASE_URL,
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
  webServer: [server(PORT), server(CUT_PORT, CUT_GATEWAY)],
});

function server(port: number, extra: Record<string, string> = {}) {
  return {
    command: `node "${root('./start-server.mjs')}"`,
    url: `http://localhost:${port}/health/live`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: 'test',
      PORT: String(port),
      APP_URL: `http://localhost:${port}`,
      STATIC_DIR: root('../apps/web/dist'),
      AUTH_SECRET: 'e2e-only-session-secret-0123456789abcdef',
      // Read by the admin CLI (the first administrator); no bootstrap token is issued.
      BOOTSTRAP_ADMIN_EMAIL: BOOTSTRAP.email,
      BOOTSTRAP_ADMIN_NAME: 'Admin Demo',
      // OPERATOR is kept on purpose: the refusal test proves writes are denied even for a
      // write-capable role, and the policies page shows separation of duties refusing this user.
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
      // Every page shows the DEMO banner: the data is the mock gateway's fictitious dataset.
      DEMO_MODE: 'true',
      // The write switches are on so the lifecycle can reach a VERIFIED write on a SANDBOX
      // connection (mock gateway only). SAFE_MODE is set on explicitly (a SAFE_MODE=false in the
      // developer's shell must not leak in), so PRODUCTION writes are still refused, and the
      // runtime kill switch can still turn every write off.
      GLOBAL_WRITE_ENABLED: 'true',
      WRITE_TO_SANKHYA: 'true',
      SAFE_MODE: 'true',
      ...extra,
    },
  };
}
