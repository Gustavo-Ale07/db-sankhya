// Helpers shared by the lifecycle, four-eyes and scratch/DDL specs. Every file builds its own
// sessions and fixtures through the API and removes what would change other files (policies,
// connections, the kill switch); nothing here depends on explorer.spec.ts having run.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import type {
  APIRequestContext,
  APIResponse,
  Browser,
  BrowserContext,
  Page,
} from '@playwright/test';
import { BASE_URL, BOOTSTRAP, E2E_DIR, POLICY_ADMIN, SPECIALIST } from '../playwright.config';

/** An e2e server: its address and its data directory (see playwright.config.ts). */
export interface Server {
  baseURL: string;
  dir: string;
}
export const MAIN: Server = { baseURL: BASE_URL, dir: E2E_DIR };

/** The server a request context talks to; the CSRF check expects its address as the Origin. */
const origins = new WeakMap<APIRequestContext, string>();

/** A one-time password start-server.mjs saved in the server's directory. */
const saved = (server: Server, file: string) => readFileSync(join(server.dir, file), 'utf8').trim();

/**
 * Partner rows (TGFPAR.CODPARC) each file writes or refuses to write. All mock connections share
 * one dataset and renamed rows stay renamed for the rest of the run, so a new spec picks a free
 * value and adds it here.
 */
export const RESERVED_CODPARC = {
  'mutation.spec.ts': [1],
  'lifecycle.spec.ts': [7, 11, 12, 13],
  'four-eyes.spec.ts': [21],
  'preview.spec.ts': [31],
  // Previewed only, on the CUT server's own dataset.
  'cut-dictionary.spec.ts': [41],
} as const;

/** Role seeded by start-server.mjs: OPERATOR plus APPROVAL.DECIDE (keep the key in sync). */
export const APPROVER_ROLE = 'E2E_OPERADOR_APROVADOR';

/** Same value explorer.spec.ts and mutation.spec.ts use for the changed bootstrap password. */
export const CHANGED_PASSWORD = 'E2E-Changed#Pass2026';
export const SHOTS = process.env.UPDATE_SCREENSHOTS === '1';

/** Fictitious mock connection secrets: the in-process mock gateway accepts exactly these. */
const MOCK_SECRETS = {
  clientId: 'mock-client-id',
  clientSecret: 'mock-client-secret',
  xToken: 'mock-x-token',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * One API call with the Origin header the CSRF check expects. Login, bootstrap and the global
 * limit are rate limited per address and every spec shares localhost: a 429 waits for the
 * window the server names and tries again, so a long run never fails on the limiter alone.
 */
export async function call(
  req: APIRequestContext,
  method: Method,
  path: string,
  data?: unknown,
): Promise<APIResponse> {
  for (let attempt = 0; ; attempt++) {
    const res = await req.fetch(path, {
      method,
      headers: { origin: origins.get(req) ?? BASE_URL },
      ...(data !== undefined ? { data } : {}),
    });
    if (res.status() !== 429 || attempt >= 3) return res;
    const retry = Number(res.headers()['retry-after'] ?? '10');
    await sleep((Number.isFinite(retry) ? Math.min(retry, 65) : 10) * 1000 + 500);
  }
}

/** Calls and expects the status; returns the parsed body. */
export async function ok<T = Record<string, unknown>>(
  req: APIRequestContext,
  method: Method,
  path: string,
  data?: unknown,
  status = 200,
): Promise<T> {
  const res = await call(req, method, path, data);
  expect(res.status(), `${method} ${path}: ${await res.text()}`).toBe(status);
  return (await res.json()) as T;
}

/** The error code and details of a refused call. */
export async function refusal(res: { json(): Promise<unknown> }) {
  const body = (await res.json()) as {
    error?: { code?: string; message?: string; details?: Record<string, unknown> };
  };
  return { code: body.error?.code, message: body.error?.message, details: body.error?.details };
}

interface LoginBody {
  user: { email: string; name: string; mustChangePassword: boolean };
}

/**
 * Logs `email` in on `ctx` (its cookie jar is shared with the context's pages), trying each
 * password in turn. A user that must change the password gets `newPassword`.
 */
export async function apiLogin(
  ctx: BrowserContext,
  email: string,
  passwords: readonly string[],
  newPassword: string,
): Promise<void> {
  let current: string | undefined;
  let user: LoginBody['user'] | undefined;
  for (const password of passwords) {
    const res = await call(ctx.request, 'POST', '/api/auth/login', { email, password });
    if (res.ok()) {
      current = password;
      user = ((await res.json()) as LoginBody).user;
      break;
    }
  }
  if (!user || current === undefined) throw new Error(`could not log ${email} in`);
  if (user.mustChangePassword) {
    await ok(ctx.request, 'POST', '/api/auth/change-password', {
      currentPassword: current,
      newPassword,
    });
  }
}

export async function newContext(
  browser: Browser,
  storageState?: string,
  server: Server = MAIN,
): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    baseURL: server.baseURL,
    locale: 'pt-BR',
    ...(storageState ? { storageState } : {}),
  });
  origins.set(ctx.request, server.baseURL);
  return ctx;
}

/**
 * Login is limited to 10 attempts a minute per address, shared with explorer.spec.ts and
 * mutation.spec.ts, whose UI logins do not wait out a 429. So each user logs in once per run:
 * the session is kept next to the run's data (<tmpdir>/dbx-e2e-<PORT>, wiped at every server
 * start, never in the repository) and reused while the server still accepts it.
 */
async function sessionContext(
  browser: Browser,
  email: string,
  login: (ctx: BrowserContext) => Promise<void>,
  server: Server = MAIN,
): Promise<BrowserContext> {
  const file = join(server.dir, 'sessions', `${email}.json`);
  if (existsSync(file)) {
    const cached = await newContext(browser, file, server);
    const me = await call(cached.request, 'GET', '/api/auth/me');
    if (me.ok()) {
      const body = (await me.json()) as { user?: { mustChangePassword?: boolean } };
      if (body.user && !body.user.mustChangePassword) return cached;
    }
    await cached.close();
  }
  const ctx = await newContext(browser, undefined, server);
  await login(ctx);
  mkdirSync(join(server.dir, 'sessions'), { recursive: true });
  await ctx.storageState({ path: file });
  return ctx;
}

/** The bootstrap administrator: changed password first (a full run), one-time one otherwise. */
export function adminContext(browser: Browser, server: Server = MAIN): Promise<BrowserContext> {
  return sessionContext(
    browser,
    BOOTSTRAP.email,
    (ctx) =>
      apiLogin(
        ctx,
        BOOTSTRAP.email,
        [CHANGED_PASSWORD, saved(server, 'bootstrap-password.txt')],
        CHANGED_PASSWORD,
      ),
    server,
  );
}

/** Changed password of the specialist (seeded by start-server.mjs). */
export const SPECIALIST_PASSWORD = 'Especialista#Demo2026';

export function specialistContext(browser: Browser): Promise<BrowserContext> {
  return sessionContext(browser, SPECIALIST.email, (ctx) =>
    apiLogin(
      ctx,
      SPECIALIST.email,
      [SPECIALIST.password, SPECIALIST_PASSWORD],
      SPECIALIST_PASSWORD,
    ),
  );
}

/** Changed password of the policy administrator (seeded by start-server.mjs). */
export const POLICY_ADMIN_PASSWORD = 'Politicas#Demo2026';

/** The ADMIN-only administrator: separation of duties lets only it change policies. */
export function policyAdminContext(
  browser: Browser,
  server: Server = MAIN,
): Promise<BrowserContext> {
  return sessionContext(
    browser,
    POLICY_ADMIN.email,
    (ctx) =>
      apiLogin(
        ctx,
        POLICY_ADMIN.email,
        [saved(server, 'policy-admin-password.txt'), POLICY_ADMIN_PASSWORD],
        POLICY_ADMIN_PASSWORD,
      ),
    server,
  );
}

/** A user created by the admin, logged in on a fresh context (the first password is replaced). */
export function userContext(
  browser: Browser,
  email: string,
  initial: string,
  changed: string,
): Promise<BrowserContext> {
  return sessionContext(browser, email, (ctx) => apiLogin(ctx, email, [initial], changed));
}

/** Records the fixtures a file creates and removes them in reverse order. */
export class Fixtures {
  private readonly undo: { label: string; run: () => Promise<APIResponse> }[] = [];
  private policyAdmin: BrowserContext | undefined;

  /**
   * `admin` creates connections, roles and users. Policies go through the ADMIN-only policy
   * administrator, opened on `browser` when first needed: the bootstrap admin also holds
   * OPERATOR, and separation of duties refuses its policy changes.
   */
  constructor(
    private readonly admin: APIRequestContext,
    private readonly browser: Browser,
    private readonly server: Server = MAIN,
  ) {}

  async policy(body: Record<string, unknown>): Promise<string> {
    this.policyAdmin ??= await policyAdminContext(this.browser, this.server);
    const policies = this.policyAdmin.request;
    const { item } = await ok<{ item: { id: string } }>(
      policies,
      'POST',
      '/api/admin/policies',
      {
        subjectType: 'everyone',
        subjectId: null,
        environments: [],
        connectionIds: [],
        columns: [],
        limits: {},
        overrideWhereRequired: false,
        enabled: true,
        effect: 'ALLOW',
        ...body,
      },
      201,
    );
    this.undo.push({
      label: `policy ${item.id}`,
      run: () => call(policies, 'DELETE', `/api/admin/policies/${item.id}`),
    });
    return item.id;
  }

  /** A mock connection (fictitious secrets) in the given environment. */
  async connection(name: string, environment: 'SANDBOX' | 'PRODUCTION'): Promise<string> {
    const { item } = await ok<{ item: { id: string } }>(
      this.admin,
      'POST',
      '/api/admin/connections',
      {
        name,
        environment,
        mode: 'mock',
        baseUrl: 'mock://local',
        dialect: 'oracle',
        secrets: MOCK_SECRETS,
      },
      201,
    );
    this.undo.push({
      label: `connection ${item.id}`,
      run: () => call(this.admin, 'DELETE', `/api/admin/connections/${item.id}`),
    });
    return item.id;
  }

  async role(key: string, permissions: string[]): Promise<void> {
    await ok(this.admin, 'POST', '/api/admin/roles', { key, name: `E2E ${key}`, permissions }, 201);
  }

  /** Users are not deleted: the e2e database is discarded with the run. */
  async user(email: string, name: string, password: string, roles: string[]): Promise<void> {
    await ok(this.admin, 'POST', '/api/admin/users', { email, name, password, roles }, 201);
  }

  /** A failed removal is reported, never thrown: it must not hide the test's own result. */
  async cleanup(): Promise<void> {
    for (const step of this.undo.reverse()) {
      try {
        const res = await step.run();
        if (!res.ok()) console.warn(`E2E ${step.label} not removed: HTTP ${res.status()}`);
      } catch (err) {
        console.warn(`E2E ${step.label} not removed:`, err);
      }
    }
    this.undo.length = 0;
    await this.policyAdmin?.close().catch(() => {});
    this.policyAdmin = undefined;
  }
}

/** Rows of a read through the API (arrays in column order). */
export async function select(
  req: APIRequestContext,
  sql: string,
  connectionId?: string,
): Promise<unknown[][]> {
  const body = await ok<{ rows: unknown[][] }>(req, 'POST', '/api/query', {
    sql,
    ...(connectionId ? { connectionId } : {}),
  });
  return body.rows;
}

export async function setSql(page: Page, sql: string) {
  const editor = page.getByTestId('sql-editor').locator('.monaco-editor').first();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(sql);
}

export function nav(page: Page, label: string) {
  return page.getByRole('navigation', { name: 'Navegação principal' }).getByRole('button', {
    name: label,
    exact: true,
  });
}

/** Opens the app on an already logged-in context and waits for the shell. */
export async function openApp(ctx: BrowserContext, name: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByTestId('current-user')).toContainText(name);
  return page;
}

/**
 * `UPDATE_SCREENSHOTS=1` refreshes docs/screenshots/<name>.png. Only DEMO pages are captured:
 * the banner must be on screen, and every value comes from the mock's fictitious dataset.
 */
export async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await expect(page.getByTestId('demo-banner')).toBeVisible();
  await page.screenshot({
    path: fileURLToPath(new URL(`../../docs/screenshots/${name}.png`, import.meta.url)),
  });
}
