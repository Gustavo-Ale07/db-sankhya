import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, settings } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { GLOBAL_WRITE_SETTING, SecuritySettingsService } from './security-settings';

const open: DatabaseHandle[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
});

async function make(env: boolean) {
  const database = await createDatabase('pglite:memory');
  open.push(database);
  await database.migrate();
  const errors: unknown[] = [];
  const service = new SecuritySettingsService(
    database.db,
    { globalWriteEnabled: env },
    { error: (obj) => errors.push(obj) },
  );
  return { database, service, errors };
}

describe('SecuritySettingsService.globalWriteState', () => {
  it('defaults the runtime switch to on, so the env value alone decides', async () => {
    expect(await (await make(false)).service.globalWriteState()).toEqual({
      env: false,
      runtime: true,
      effective: false,
    });
    expect(await (await make(true)).service.globalWriteState()).toEqual({
      env: true,
      runtime: true,
      effective: true,
    });
  });

  it('is env AND runtime: the runtime switch can only turn writes off', async () => {
    const off = await make(false);
    await off.service.setGlobalWrite(true, null);
    expect(await off.service.globalWriteState()).toEqual({
      env: false,
      runtime: true,
      effective: false,
    });

    const on = await make(true);
    await on.service.setGlobalWrite(false, null);
    expect(await on.service.globalWriteState()).toEqual({
      env: true,
      runtime: false,
      effective: false,
    });
    await on.service.setGlobalWrite(true, null);
    expect((await on.service.globalWriteState()).effective).toBe(true);
  });

  it('is read on every call, so a change by another instance applies to the next execute', async () => {
    const h = await make(true);
    expect((await h.service.globalWriteState()).effective).toBe(true);
    await h.database.db
      .insert(settings)
      .values({ key: GLOBAL_WRITE_SETTING, value: false })
      .onConflictDoUpdate({ target: settings.key, set: { value: false } });
    expect((await h.service.globalWriteState()).effective).toBe(false);
  });

  it('fails closed on a corrupt stored value or an unreadable table', async () => {
    const h = await make(true);
    await h.database.db.insert(settings).values({ key: GLOBAL_WRITE_SETTING, value: 'yes' });
    expect(await h.service.globalWriteState()).toEqual({
      env: true,
      runtime: false,
      effective: false,
    });
    await h.database.db.execute(sql`drop table settings`);
    expect(await h.service.globalWriteState()).toEqual({
      env: true,
      runtime: false,
      effective: false,
    });
    expect(h.errors.length).toBeGreaterThan(0);
  });
});
