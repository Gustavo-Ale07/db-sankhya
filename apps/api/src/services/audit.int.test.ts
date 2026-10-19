import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { auditEvents, createDatabase } from '@dbx/database';
import type { AuditEventRow, DatabaseHandle } from '@dbx/database';
import { REDACTED, createRedactor } from '@dbx/shared';
import { AUDIT_LIFECYCLE_ACTIONS, AuditService } from './records';
import type { AuditLifecycleContext } from './records';

// Fictitious ids, used only by these tests.
const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002';
const CONN = '00000000-0000-4000-8000-0000000000aa';
const PLAN_ID = '00000000-0000-4000-8000-0000000000c1';
const OTHER_PLAN_ID = '00000000-0000-4000-8000-0000000000c2';
const APPROVAL_ID = '00000000-0000-4000-8000-0000000000ff';
const CONFIGURED_SECRET = 'configured-secret-value-1234';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup(): Promise<{ handle: DatabaseHandle; audit: AuditService }> {
  const handle = await createDatabase('pglite:memory');
  await handle.migrate();
  cleanup.push(() => handle.close());
  return { handle, audit: new AuditService(handle.db, createRedactor([CONFIGURED_SECRET])) };
}

const ctx = (over: Partial<AuditLifecycleContext> = {}): AuditLifecycleContext => ({
  userId: USER_ID,
  userEmail: 'writer@example.com',
  ip: '127.0.0.1',
  requestId: 'req-1',
  connectionId: CONN,
  environment: 'SANDBOX',
  planId: PLAN_ID,
  planHash: 'sha256:abc',
  capability: 'DATA.UPDATE',
  ...over,
});

const allRows = (handle: DatabaseHandle): Promise<AuditEventRow[]> =>
  handle.db.select().from(auditEvents);

describe('AuditService lifecycle events', () => {
  it('declares the four lifecycle event types', () => {
    expect([...AUDIT_LIFECYCLE_ACTIONS]).toEqual([
      'PLAN_CREATED',
      'PLAN_EXECUTED',
      'PLAN_DENIED',
      'VERIFICATION',
    ]);
  });

  it('PLAN_CREATED writes exactly one row with the plan columns', async () => {
    const { handle, audit } = await setup();
    await audit.recordPlanCreated(ctx(), {
      statement: 'UPDATE TGFPAR SET NOMEPARC = :n WHERE CODPARC = 1',
      policyDecision: { effect: 'ALLOW', matchedRuleIds: ['r1'] },
      before: [{ CODPARC: 1, NOMEPARC: 'old', SENHA: 'hunter22' }],
    });
    const rows = await allRows(handle);
    expect(rows).toHaveLength(1);
    const [row] = rows as [AuditEventRow];
    expect(row).toMatchObject({
      action: 'PLAN_CREATED',
      status: 'info',
      userId: USER_ID,
      userEmail: 'writer@example.com',
      requestId: 'req-1',
      connectionId: CONN,
      environment: 'SANDBOX',
      planId: PLAN_ID,
      planHash: 'sha256:abc',
      capability: 'DATA.UPDATE',
      approvalId: null,
      verification: null,
      policyDecision: { effect: 'ALLOW', matchedRuleIds: ['r1'] },
      statement: 'UPDATE TGFPAR SET NOMEPARC = :n WHERE CODPARC = 1',
      snapshot: {
        before: {
          rows: [{ CODPARC: 1, NOMEPARC: 'old', SENHA: REDACTED }],
          totalRows: 1,
          truncated: false,
        },
      },
    });
  });

  it('PLAN_EXECUTED writes one row with approval, outcome and before/after snapshot', async () => {
    const { handle, audit } = await setup();
    await audit.recordPlanExecuted(ctx({ approvalId: APPROVAL_ID }), {
      outcome: 'success',
      affectedRows: 1,
      durationMs: 42,
      policyDecision: { effect: 'ALLOW' },
      before: [{ CODPARC: 1, password: 'p1-secret', NOMEPARC: 'old' }],
      after: [{ CODPARC: 1, password: 'p2-secret', NOMEPARC: 'new' }],
    });
    const rows = await allRows(handle);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'PLAN_EXECUTED',
      status: 'success',
      planId: PLAN_ID,
      approvalId: APPROVAL_ID,
      durationMs: 42,
      details: { affectedRows: 1 },
      snapshot: {
        before: { rows: [{ CODPARC: 1, password: REDACTED, NOMEPARC: 'old' }] },
        after: { rows: [{ CODPARC: 1, password: REDACTED, NOMEPARC: 'new' }] },
      },
    });
    expect(JSON.stringify(rows[0])).not.toMatch(/p[12]-secret/);
  });

  it('PLAN_DENIED writes one denied row with the policy decision and error', async () => {
    const { handle, audit } = await setup();
    await audit.recordPlanDenied(ctx({ capability: 'DATA.DELETE' }), {
      policyDecision: { effect: 'DENY', reason: 'no rule allows DATA.DELETE' },
      errorCode: 'POLICY_DENIED',
      errorMessage: 'Denied by policy',
    });
    const rows = await allRows(handle);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'PLAN_DENIED',
      status: 'denied',
      capability: 'DATA.DELETE',
      planId: PLAN_ID,
      errorCode: 'POLICY_DENIED',
      errorMessage: 'Denied by policy',
      policyDecision: { effect: 'DENY', reason: 'no rule allows DATA.DELETE' },
      snapshot: null,
    });
  });

  it('VERIFICATION writes one row whose outcome follows the check', async () => {
    const { handle, audit } = await setup();
    await audit.recordVerification(ctx(), {
      passed: true,
      verification: { expectedRows: 1, actualRows: 1 },
    });
    await audit.recordVerification(ctx(), {
      passed: false,
      verification: { expectedRows: 1, actualRows: 0 },
      after: [{ CODPARC: 1, TOKEN: 'leak-me' }],
    });
    const rows = await allRows(handle);
    expect(rows).toHaveLength(2);
    const ok = rows.find((r) => r.status === 'success');
    const bad = rows.find((r) => r.status === 'failed');
    expect(ok).toMatchObject({
      action: 'VERIFICATION',
      verification: { passed: true, expectedRows: 1, actualRows: 1 },
    });
    expect(bad).toMatchObject({
      action: 'VERIFICATION',
      verification: { passed: false, expectedRows: 1, actualRows: 0 },
      snapshot: { after: { rows: [{ CODPARC: 1, TOKEN: REDACTED }] } },
    });
  });

  it('skips snapshots when the auditSnapshots limit is false and records that it did', async () => {
    const { handle, audit } = await setup();
    await audit.recordPlanExecuted(ctx(), {
      outcome: 'success',
      auditSnapshots: false,
      before: [{ CODPARC: 1 }],
      after: [{ CODPARC: 1 }],
    });
    const [row] = await allRows(handle);
    expect(row?.snapshot).toBeNull();
    expect(row?.details).toMatchObject({ snapshotsDisabled: true });
  });

  it('caps snapshots at 50 rows and records the truncation', async () => {
    const { handle, audit } = await setup();
    await audit.recordPlanExecuted(ctx(), {
      outcome: 'partial',
      before: Array.from({ length: 120 }, (_, i) => ({ ID: i })),
    });
    const [row] = await allRows(handle);
    const snap = row?.snapshot as {
      before: { rows: unknown[]; totalRows: number; truncated: boolean };
    };
    expect(snap.before.rows).toHaveLength(50);
    expect(snap.before).toMatchObject({ totalRows: 120, truncated: true });
  });

  it('runs configured secret values through the service redactor too', async () => {
    const { handle, audit } = await setup();
    await audit.recordPlanDenied(ctx(), {
      policyDecision: { reason: `bad ${CONFIGURED_SECRET}` },
      errorMessage: `upstream said ${CONFIGURED_SECRET}`,
    });
    expect(JSON.stringify(await allRows(handle))).not.toContain(CONFIGURED_SECRET);
  });

  it('masks mid-word sensitive keys at any depth in details, policyDecision and verification', async () => {
    const { handle, audit } = await setup();
    await audit.recordVerification(ctx(), {
      passed: true,
      verification: { rows: [{ CODPARC: 1, senhaAntiga: 'v1' }], authorizationHeader: 'v2' },
      policyDecision: { rules: [{ id: 'r1', client_secret_enc: 'v3' }], SessionCookie: 'v4' },
      details: { nested: { apiKeyValue: 'v5', list: [{ AD_COOKIE_WEB: 'v6' }] }, kept: 'ok' },
    });
    await audit.record({
      action: 'auth.login',
      status: 'success',
      details: { SESSION_KEY: 'v7', x_token_enc: 'v8', AUTHORIZATION_CODE: 'v9' },
    });
    const rows = await allRows(handle);
    const json = JSON.stringify(rows);
    for (let i = 1; i <= 9; i++) expect(json).not.toContain(`"v${i}"`);
    const verification = rows.find((r) => r.action === 'VERIFICATION')!;
    expect(verification.verification).toEqual({
      rows: [{ CODPARC: 1, senhaAntiga: REDACTED }],
      authorizationHeader: REDACTED,
      passed: true,
    });
    expect(verification.policyDecision).toEqual({
      rules: [{ id: 'r1', client_secret_enc: REDACTED }],
      SessionCookie: REDACTED,
    });
    expect(verification.details).toEqual({
      nested: { apiKeyValue: REDACTED, list: [{ AD_COOKIE_WEB: REDACTED }] },
      kept: 'ok',
    });
  });

  it('bounds the stored snapshot size', async () => {
    const { handle, audit } = await setup();
    await audit.recordPlanExecuted(ctx(), {
      outcome: 'success',
      before: Array.from({ length: 50 }, (_, i) => ({
        ID: i,
        ...Object.fromEntries(Array.from({ length: 10 }, (_, c) => [`C${c}`, 'x'.repeat(5000)])),
      })),
    });
    const [row] = await allRows(handle);
    const before = (row?.snapshot as { before: Record<string, unknown> }).before;
    expect(JSON.stringify(row?.snapshot).length).toBeLessThanOrEqual(256 * 1024 + 64);
    expect(before).toMatchObject({ truncated: true, totalRows: 50 });
    expect(before.truncatedBytes).toBeGreaterThan(0);
  });
});

describe('audit_events environment constraint', () => {
  it('accepts NULL and the three environments, and rejects anything else', async () => {
    const { handle } = await setup();
    for (const env of ['PRODUCTION', 'HOMOLOGATION', 'SANDBOX'])
      await handle.db.execute(
        sql`INSERT INTO audit_events (action, status, environment) VALUES ('x', 'info', ${env})`,
      );
    await handle.db.execute(sql`INSERT INTO audit_events (action, status) VALUES ('x', 'info')`);
    for (const env of ['LOCAL', 'sandbox', ''])
      await expect(
        handle.db.execute(
          sql`INSERT INTO audit_events (action, status, environment) VALUES ('x', 'info', ${env})`,
        ),
      ).rejects.toThrow();
    expect(await allRows(handle)).toHaveLength(4);
  });
});

describe('AuditService search', () => {
  it('pages in a stable order when timestamps tie (created_at desc, id desc)', async () => {
    const { handle, audit } = await setup();
    for (let i = 0; i < 7; i++)
      await handle.db.execute(
        sql`INSERT INTO audit_events (action, status, created_at) VALUES ('tie', 'info', '2026-01-01T00:00:00Z')`,
      );
    const all = await handle.db.select({ id: auditEvents.id }).from(auditEvents);
    const expected = all.map((r) => r.id).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    const paged: string[] = [];
    for (let offset = 0; offset < 7; offset += 2)
      paged.push(...(await audit.list({ action: 'tie', limit: 2, offset })).items.map((i) => i.id));
    expect(paged).toEqual(expected);
  });

  it('filters by plan id, user, environment, connection, outcome and date range', async () => {
    const { audit } = await setup();
    await audit.recordPlanCreated(ctx(), {});
    await audit.recordPlanExecuted(ctx(), { outcome: 'success' });
    await audit.recordPlanCreated(
      ctx({
        planId: OTHER_PLAN_ID,
        userId: OTHER_USER_ID,
        environment: 'PRODUCTION',
        connectionId: 'env',
      }),
      {},
    );

    const byPlan = await audit.list({ planId: PLAN_ID, limit: 50, offset: 0 });
    expect(byPlan.total).toBe(2);
    expect(byPlan.items.map((i) => i.action).sort()).toEqual(['PLAN_CREATED', 'PLAN_EXECUTED']);

    expect((await audit.list({ userId: OTHER_USER_ID, limit: 50, offset: 0 })).total).toBe(1);
    expect((await audit.list({ environment: 'PRODUCTION', limit: 50, offset: 0 })).total).toBe(1);
    expect((await audit.list({ connectionId: 'env', limit: 50, offset: 0 })).total).toBe(1);
    expect((await audit.list({ status: 'success', limit: 50, offset: 0 })).total).toBe(1);
    expect(
      (await audit.list({ action: 'PLAN_CREATED', planId: PLAN_ID, limit: 50, offset: 0 })).total,
    ).toBe(1);
    const future = new Date(Date.now() + 60_000);
    expect((await audit.list({ from: future, limit: 50, offset: 0 })).total).toBe(0);
    expect((await audit.list({ to: future, limit: 50, offset: 0 })).total).toBe(3);

    const page = await audit.list({ limit: 2, offset: 0 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
  });

  it('keeps rows written before the new columns existed readable', async () => {
    const { handle, audit } = await setup();
    await handle.db.execute(
      sql`INSERT INTO audit_events (action, status, user_email) VALUES ('auth.login', 'success', 'old@example.com')`,
    );
    const { items, total } = await audit.list({ action: 'auth.login', limit: 50, offset: 0 });
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({
      userEmail: 'old@example.com',
      planId: null,
      connectionId: null,
      environment: null,
      snapshot: null,
      policyDecision: null,
    });
  });
});
