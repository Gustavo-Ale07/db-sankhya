import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { bootstrapTokens, createDatabase } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { loadConfig, secretValues } from '../config';
import { loggerOptions } from '../logger';
import { sha256Hex } from '../security/crypto';
import { announceBootstrap } from './bootstrap';

const ORIGIN = 'http://localhost:5173';
const STRONG = 'First!Admin#Pass9';
const BASE_ENV = {
  NODE_ENV: 'test',
  APP_URL: ORIGIN,
  DATABASE_URL: 'pglite:memory',
  SESSION_SECRET: 'bootstrap-test-secret-7Hq2Lm9Xc4Vb8Nz1Kp5Rt3Wy6',
  BOOTSTRAP_ADMIN_ROLES: 'ADMIN,OPERATOR',
  LOG_LEVEL: 'silent',
};

interface Harness {
  app: FastifyInstance;
  database: DatabaseHandle;
  issue(): Promise<string>;
  post(payload: unknown): Promise<Awaited<ReturnType<FastifyInstance['inject']>>>;
}

const open: Harness[] = [];

async function setup(env: Record<string, string> = {}): Promise<Harness> {
  const config = loadConfig({ ...BASE_ENV, ...env });
  const database = await createDatabase(config.databaseUrl);
  await database.migrate();
  const app = await buildApp({ config, database, logger: false });
  const h: Harness = {
    app,
    database,
    issue: async () => {
      const r = await app.services.bootstrap.issueToken();
      if (r.status !== 'issued') throw new Error(`expected a token, got ${r.status}`);
      return r.token;
    },
    post: (payload) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/bootstrap',
        headers: { origin: ORIGIN },
        payload: payload as Record<string, unknown>,
      }),
  };
  open.push(h);
  return h;
}

afterEach(async () => {
  while (open.length) {
    const h = open.pop()!;
    await h.app.close();
    await h.database.close();
  }
});

const codeOf = (res: { json(): unknown }) =>
  (res.json() as { error?: { code: string } }).error?.code;

describe('bootstrap token', () => {
  it('stores only the sha256 of the token, with an expiry', async () => {
    const h = await setup({ BOOTSTRAP_TOKEN_TTL_MINUTES: '30' });
    const before = Date.now();
    const token = await h.issue();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const rows = await h.database.db.select().from(bootstrapTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    const ttl = rows[0]!.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(29 * 60_000);
    expect(ttl).toBeLessThanOrEqual(30 * 60_000 + 5_000);
  });

  it('logs the token once at warn level through the redacting logger, never again', async () => {
    const h = await setup();
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const config = h.app.services.config;
    const log = pino(loggerOptions('info', secretValues(config)) as pino.LoggerOptions, stream);
    const first = await announceBootstrap(h.app.services, log);
    expect(first.status).toBe('issued');
    const token = first.status === 'issued' ? first.token : '';
    const tokenLines = lines.filter((l) => l.includes(token));
    expect(tokenLines).toHaveLength(1);
    const entry = JSON.parse(tokenLines[0]!) as { level: number; msg: string };
    expect(entry.level).toBe(40);
    expect(entry.msg).toBe(`bootstrap token: ${token}`);

    lines.length = 0;
    const second = await announceBootstrap(h.app.services, log);
    expect(second.status).toBe('pending');
    expect(lines.join('\n')).not.toContain(token);
    expect(lines.join('\n')).not.toMatch(/bootstrap token: /);
  });

  it('issues no token when BOOTSTRAP_ADMIN_EMAIL selects the CLI path or users exist', async () => {
    const cli = await setup({ BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com' });
    const silent = pino({ level: 'silent' });
    // A token left by an earlier boot without BOOTSTRAP_ADMIN_EMAIL is discarded.
    const stale = await cli.issue();
    expect((await announceBootstrap(cli.app.services, silent)).status).toBe('cli');
    expect(await cli.database.db.select().from(bootstrapTokens)).toHaveLength(0);
    const res = await cli.post({ token: stale, email: 'a@example.com', password: STRONG });
    expect(res.statusCode).toBe(404);

    const h = await setup();
    await h.app.services.users.create({
      email: 'someone@example.com',
      name: 'Someone',
      password: STRONG,
      roles: ['ADMIN'],
    });
    expect((await announceBootstrap(h.app.services, silent)).status).toBe('not_needed');
    expect(await h.database.db.select().from(bootstrapTokens)).toHaveLength(0);
  });

  it('creates the first admin once; the second use of the token is CONFIRMATION_USED', async () => {
    const h = await setup();
    const token = await h.issue();
    const res = await h.post({ token, email: 'First@Example.com', password: STRONG });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().user).toMatchObject({
      email: 'first@example.com',
      roles: ['ADMIN', 'OPERATOR'],
      mustChangePassword: false,
    });
    expect(await h.database.db.select().from(bootstrapTokens)).toHaveLength(0);

    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN },
      payload: { email: 'first@example.com', password: STRONG },
    });
    expect(login.statusCode, login.body).toBe(200);

    const again = await h.post({ token, email: 'second@example.com', password: STRONG });
    expect(again.statusCode).toBe(409);
    expect(codeOf(again)).toBe('CONFIRMATION_USED');
    expect(await h.app.services.users.count()).toBe(1);
  });

  it('lets only one of two parallel requests create an admin', async () => {
    const h = await setup();
    const token = await h.issue();
    const results = await Promise.all([
      h.post({ token, email: 'a@example.com', password: STRONG }),
      h.post({ token, email: 'b@example.com', password: STRONG }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(results.map(codeOf).filter(Boolean)).toEqual(['CONFIRMATION_USED']);
    expect(await h.app.services.users.count()).toBe(1);
  });

  it('answers 410 for an expired token', async () => {
    const h = await setup();
    const token = await h.issue();
    await h.database.db.update(bootstrapTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    const res = await h.post({ token, email: 'first@example.com', password: STRONG });
    expect(res.statusCode).toBe(410);
    expect(codeOf(res)).toBe('CONFIRMATION_EXPIRED');
    expect(await h.app.services.users.count()).toBe(0);
  });

  it('refuses a wrong token without consuming the real one', async () => {
    const h = await setup();
    const token = await h.issue();
    const wrong = await h.post({ token: `${token}x`, email: 'x@example.com', password: STRONG });
    expect(wrong.statusCode).toBe(400);
    expect(codeOf(wrong)).toBe('CONFIRMATION_INVALID');
    expect((await h.post({ token, email: 'x@example.com', password: STRONG })).statusCode).toBe(
      201,
    );
  });

  it('returns 404 while no token is pending, without revealing the route', async () => {
    const h = await setup();
    const res = await h.post({ token: 'anything', email: 'a@example.com', password: STRONG });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: 'NOT_FOUND', message: 'Route not found' });
    const unknown = await h.app.inject({
      method: 'POST',
      url: '/api/auth/nope',
      headers: { origin: ORIGIN },
      payload: {},
    });
    expect(res.json().error.message).toBe(unknown.json().error.message);
  });

  it('returns 404 once any user exists', async () => {
    const h = await setup();
    const token = await h.issue();
    await h.app.services.users.create({
      email: 'cli@example.com',
      name: 'Cli',
      password: STRONG,
      roles: ['ADMIN'],
    });
    const res = await h.post({ token, email: 'late@example.com', password: STRONG });
    expect(res.statusCode).toBe(404);
    expect(codeOf(res)).toBe('NOT_FOUND');
    expect(await h.app.services.users.count()).toBe(1);
  });

  it('rejects a weak password and keeps the token usable', async () => {
    const h = await setup();
    const token = await h.issue();
    for (const password of ['short', 'ChangeMe!2026', 'alllowercaseletters']) {
      const res = await h.post({ token, email: 'first@example.com', password });
      expect(res.statusCode, password).toBe(400);
      expect(codeOf(res)).toBe('VALIDATION_ERROR');
    }
    expect(await h.app.services.users.count()).toBe(0);
    const ok = await h.post({ token, email: 'first@example.com', password: STRONG });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it('rejects unknown fields and an invalid e-mail', async () => {
    const h = await setup();
    const token = await h.issue();
    const extra = await h.post({ token, email: 'a@example.com', password: STRONG, roles: ['X'] });
    expect(codeOf(extra)).toBe('VALIDATION_ERROR');
    const bad = await h.post({ token, email: 'not-an-email', password: STRONG });
    expect(codeOf(bad)).toBe('VALIDATION_ERROR');
  });

  it('is rate limited like login', async () => {
    const h = await setup();
    await h.issue();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push(
        (await h.post({ token: 'nope', email: 'a@example.com', password: STRONG })).statusCode,
      );
    }
    expect(codes.slice(0, 10).every((c) => c === 400)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});
