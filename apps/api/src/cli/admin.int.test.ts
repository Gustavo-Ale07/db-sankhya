import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { auditEvents, createDatabase } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { isWeakPassword, loadConfig } from '../config';
import type { AppConfig } from '../config';
import { AuthzService } from '../services/authz';
import { checkLocalPassword } from '../services/identity';
import { SessionsService } from '../services/sessions';
import { UsersService } from '../services/users';
import { runAdminCli } from './admin';

const STRONG = 'Some!Strong#Pass9';
let database: DatabaseHandle;
let users: UsersService;

beforeEach(async () => {
  database = await createDatabase('pglite:memory');
  await database.migrate();
  users = new UsersService(database.db, new AuthzService(database.db));
});

afterEach(async () => {
  await database.close();
});

async function cli(argv: string[], env: Record<string, string> = {}) {
  const config: AppConfig = loadConfig({
    NODE_ENV: 'test',
    BOOTSTRAP_ADMIN_NAME: 'Admin Demo',
    BOOTSTRAP_ADMIN_ROLES: 'ADMIN,OPERATOR',
    ...env,
  });
  let stdout = '';
  let stderr = '';
  const code = await runAdminCli(argv, {
    config,
    database,
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
  });
  const password = /^one-time password: (\S+)$/m.exec(stdout)?.[1];
  return { code, stdout, stderr, password };
}

describe('admin CLI', () => {
  it('bootstrap creates the first admin with a one-time password that must be changed', async () => {
    const r = await cli(['bootstrap', '--email', 'Boot@Example.com']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.password).toBeDefined();
    expect(isWeakPassword(r.password!)).toBe(false);
    const u = await users.findByEmail('boot@example.com');
    expect(u).toMatchObject({ name: 'Admin Demo', mustChangePassword: true, active: true });
    expect(await checkLocalPassword(u!, r.password!)).toBe(true);
    const audit = await database.db.select().from(auditEvents);
    expect(audit.map((a) => a.action)).toEqual(['user.bootstrap']);
    expect(JSON.stringify(audit)).not.toContain(r.password);
  });

  it('falls back to BOOTSTRAP_ADMIN_EMAIL and refuses without any e-mail', async () => {
    expect((await cli(['bootstrap'])).code).toBe(2);
    const r = await cli(['bootstrap'], { BOOTSTRAP_ADMIN_EMAIL: 'env@example.com' });
    expect(r.code, r.stderr).toBe(0);
    expect(await users.findByEmail('env@example.com')).toBeDefined();
  });

  it('refuses bootstrap on a non-empty users table without --force-additional', async () => {
    await users.create({ email: 'one@example.com', name: 'One', password: STRONG, roles: [] });
    const refused = await cli(['bootstrap', '--email', 'two@example.com']);
    expect(refused.code).toBe(1);
    expect(refused.password).toBeUndefined();
    expect(refused.stderr).toMatch(/--force-additional/);
    expect(await users.count()).toBe(1);

    const forced = await cli(['bootstrap', '--email', 'two@example.com', '--force-additional']);
    expect(forced.code, forced.stderr).toBe(0);
    expect(await users.count()).toBe(2);
    expect(
      (await cli(['bootstrap', '--email', 'two@example.com', '--force-additional'])).code,
    ).toBe(1);
  });

  it('reset-password sets a one-time password, unlocks and revokes sessions', async () => {
    const u = await users.create({
      email: 'ana@example.com',
      name: 'Ana',
      password: STRONG,
      roles: ['ADMIN'],
    });
    await users.recordLoginFailure(u.id, 1, 60);
    const sessions = new SessionsService(database.db, 12);
    const { token } = await sessions.create(u.id, { ip: '127.0.0.1' });

    const r = await cli(['reset-password', '--email', 'ANA@example.com']);
    expect(r.code, r.stderr).toBe(0);
    const after = await users.findByEmail('ana@example.com');
    expect(after).toMatchObject({ mustChangePassword: true, failedLogins: 0, lockedUntil: null });
    expect(await checkLocalPassword(after!, r.password!)).toBe(true);
    expect(await checkLocalPassword(after!, STRONG)).toBe(false);
    expect(await sessions.resolve(token)).toBeNull();
  });

  it('reset-password changes nothing when the audit write fails', async () => {
    const u = await users.create({
      email: 'bia@example.com',
      name: 'Bia',
      password: STRONG,
      roles: ['ADMIN'],
    });
    const sessions = new SessionsService(database.db, 12);
    const { token } = await sessions.create(u.id, { ip: '127.0.0.1' });
    await database.db.execute(sql`alter table audit_events rename to audit_events_off`);

    await expect(cli(['reset-password', '--email', 'bia@example.com'])).rejects.toThrow();
    const after = await users.findByEmail('bia@example.com');
    expect(after).toMatchObject({ mustChangePassword: false });
    expect(await checkLocalPassword(after!, STRONG)).toBe(true);
    expect(await sessions.resolve(token)).not.toBeNull();
  });

  it('reset-password fails for an unknown e-mail, and unknown commands print usage', async () => {
    const r = await cli(['reset-password', '--email', 'ghost@example.com']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not found/i);
    expect((await cli(['frobnicate'])).code).toBe(2);
    expect((await cli(['bootstrap', '--email', 'a@example.com', '--bogus'])).code).toBe(2);
    expect((await cli(['bootstrap', '--email', 'not-an-email'])).code).toBe(2);
  });
});
