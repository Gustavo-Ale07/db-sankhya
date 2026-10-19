import { describe, expect, it } from 'vitest';
import { resolveCapability, type CapabilityContext } from './capability';
import { classifyStatement } from './classify';
import * as engine from './index';

const ctx: CapabilityContext = {
  catalog: { tables: [{ name: 'TGFPAR' }, { name: 'TSICID' }, { name: 'AD_EXEMPLO' }] },
  customPrefixes: ['AD_'],
  scratchTables: ['tmp_a'],
};

const resolve = (sql: string) => resolveCapability(classifyStatement(sql), ctx);

describe('resolveCapability', () => {
  it('DELETE on a Sankhya table is UNSUPPORTED (no generic service)', () => {
    const c = resolve('DELETE FROM TGFPAR WHERE CODPARC = 1');
    expect(c).toMatchObject({ class: 'UNSUPPORTED', route: 'NONE', action: null });
    expect(c.reason).toMatch(/no documented generic delete service/);
    expect(resolve('DELETE FROM AD_EXEMPLO WHERE ID = 1').class).toBe('UNSUPPORTED');
  });

  it('UPDATE with WHERE on a catalog table goes to the save service', () => {
    expect(resolve("UPDATE TGFPAR SET NOMEPARC = 'X' WHERE CODPARC = 1")).toMatchObject({
      class: 'SUPPORTED',
      route: 'SANKHYA_SAVE',
      action: 'DATA.UPDATE',
    });
  });

  it('single-row INSERT on a catalog table goes to the save service', () => {
    expect(resolve('INSERT INTO TGFPAR (CODPARC) VALUES (1)')).toMatchObject({
      class: 'SUPPORTED',
      route: 'SANKHYA_SAVE',
      action: 'DATA.INSERT',
    });
  });

  it('flags UPDATE / DELETE without WHERE as blocked', () => {
    expect(resolve("UPDATE TGFPAR SET NOMEPARC = 'X'").blocked?.code).toBe('MISSING_WHERE');
    expect(resolve('DELETE FROM tmp_a').blocked?.code).toBe('MISSING_WHERE');
    expect(resolve('DELETE FROM tmp_a WHERE A = 1').blocked).toBeUndefined();
  });

  it('refuses writes to unknown tables and unsupported save shapes', () => {
    expect(resolve('UPDATE TGFXYZ SET A = 1 WHERE B = 1').class).toBe('UNSUPPORTED');
    expect(resolve('INSERT INTO TGFPAR (CODPARC) VALUES (1), (2)').class).toBe('UNSUPPORTED');
    expect(resolve('INSERT INTO TGFPAR (CODPARC) SELECT CODCID FROM TSICID').class).toBe(
      'UNSUPPORTED',
    );
  });

  it('CREATE TABLE AD_X is generated as an artifact', () => {
    expect(resolve('CREATE TABLE AD_X (A INT)')).toMatchObject({
      class: 'SUPPORTED_VIA_GENERATED_ARTIFACT',
      route: 'DDL_ARTIFACT',
      action: 'DDL.CUSTOM.GENERATE',
    });
    expect(resolve('ALTER TABLE ad_x ADD COLUMN B INT').class).toBe(
      'SUPPORTED_VIA_GENERATED_ARTIFACT',
    );
    expect(resolve('CREATE TABLE AD_X AS SELECT 1 A').class).toBe('UNSUPPORTED');
  });

  it.each([
    'CREATE TABLE TGFX (A INT)',
    'ALTER TABLE TGFPAR ADD COLUMN B INT',
    'DROP TABLE TGFPAR',
  ])('native DDL is forbidden: %s', (sql) => {
    const c = resolve(sql);
    expect(c.class).toBe('UNSUPPORTED');
    expect(c.reason).toMatch(/native DDL forbidden/);
  });

  it('scratch DDL and writes are SCRATCH_ONLY', () => {
    expect(resolve('CREATE TEMP TABLE tmp_a (a int)')).toMatchObject({
      class: 'SCRATCH_ONLY',
      route: 'SCRATCH',
      action: 'TEMP.CREATE',
    });
    expect(resolve('UPDATE tmp_a SET a = 1 WHERE a = 2')).toMatchObject({
      class: 'SCRATCH_ONLY',
      route: 'SCRATCH',
      action: 'TEMP.WRITE',
    });
    expect(resolve('DROP TABLE TMP_A')).toMatchObject({
      class: 'SCRATCH_ONLY',
      action: 'TEMP.DROP',
    });
  });

  it('mixing scratch and Sankhya tables is HYBRID', () => {
    expect(resolve('SELECT * FROM tmp_a JOIN TGFPAR ON 1 = 1')).toMatchObject({
      route: 'HYBRID',
      actions: ['QUERY.SELECT', 'TEMP.MATERIALIZE'],
    });
    expect(resolve('INSERT INTO tmp_a (a) SELECT CODPARC FROM TGFPAR')).toMatchObject({
      class: 'SCRATCH_ONLY',
      route: 'HYBRID',
    });
    expect(resolve('CREATE TEMP TABLE tmp_b AS SELECT CODPARC FROM TGFPAR').route).toBe('HYBRID');
  });

  it('plain reads route to Sankhya; scratch-only reads stay local', () => {
    expect(resolve('SELECT TOP 5 * FROM TGFPAR')).toMatchObject({
      class: 'SUPPORTED',
      route: 'SANKHYA_READ',
      action: 'QUERY.SELECT',
    });
    expect(resolve('SELECT * FROM tmp_a').route).toBe('SCRATCH');
  });

  it('UNKNOWN is UNSUPPORTED', () => {
    expect(resolve('GRANT SELECT ON T TO someone')).toMatchObject({
      class: 'UNSUPPORTED',
      route: 'NONE',
      action: null,
    });
  });

  it('a CTE shadowing a Sankhya table is UNSUPPORTED, never SCRATCH_ONLY', () => {
    expect(
      resolve('WITH TGFPAR AS (SELECT * FROM TGFPAR) SELECT * FROM TGFPAR JOIN tmp_a ON 1 = 1'),
    ).toMatchObject({ class: 'UNSUPPORTED', route: 'NONE' });
  });

  describe('scratch names never shadow Sankhya tables', () => {
    // A context where a native name leaked into the scratch list.
    const leaky: CapabilityContext = { ...ctx, scratchTables: ['tmp_a', 'TGFPAR', 'tmp_cat'] };
    const leakyCatalog: CapabilityContext = {
      ...leaky,
      catalog: { tables: [...ctx.catalog.tables, { name: 'TMP_CAT' }] },
    };
    const r = (sql: string, c: CapabilityContext = leaky) =>
      resolveCapability(classifyStatement(sql), c);

    it('CREATE [TEMP] TABLE of a native name is native DDL', () => {
      for (const sql of [
        'CREATE TEMP TABLE TGFPAR (A INT)',
        'CREATE TEMPORARY TABLE TGFX (A INT)',
      ]) {
        const c = r(sql);
        expect(c.class).toBe('UNSUPPORTED');
        expect(c.reason).toMatch(/native DDL forbidden/);
      }
    });

    it.each([
      'CREATE TEMP TABLE AD_X (A INT)',
      'CREATE TEMPORARY TABLE AD_X (A INT)',
      'CREATE TEMP TABLE TGFX (A INT)',
      'CREATE TEMPORARY TABLE TGFPAR (A INT)',
    ])('a temporary create outside the tmp_ prefix is never an artifact: %s', (sql) => {
      const c = r(sql);
      expect(c).toMatchObject({ class: 'UNSUPPORTED', route: 'NONE', actions: [] });
      expect(c.reason).toMatch(/temporary tables must use the tmp_ prefix/);
    });

    it('ALTER / UPDATE / SELECT on a native name never become SCRATCH_ONLY', () => {
      expect(r('ALTER TABLE TGFPAR ADD COLUMN B INT')).toMatchObject({ class: 'UNSUPPORTED' });
      expect(r('DROP TABLE TGFPAR')).toMatchObject({ class: 'UNSUPPORTED' });
      expect(r("UPDATE TGFPAR SET NOMEPARC = 'X' WHERE CODPARC = 1")).toMatchObject({
        route: 'SANKHYA_SAVE',
      });
      expect(r('SELECT * FROM TGFPAR').route).toBe('SANKHYA_READ');
      expect(r('SELECT * FROM TGFPAR JOIN tmp_a ON 1 = 1').route).toBe('HYBRID');
    });

    it('a tmp_ name that is also in the catalog is not scratch', () => {
      expect(r('UPDATE tmp_cat SET A = 1 WHERE B = 2', leakyCatalog).class).not.toBe(
        'SCRATCH_ONLY',
      );
      expect(r('DROP TABLE tmp_cat', leakyCatalog).class).toBe('UNSUPPORTED');
      expect(r('CREATE TEMP TABLE tmp_cat (A INT)', leakyCatalog).class).toBe('UNSUPPORTED');
    });

    it('renaming a scratch table onto a native name is UNSUPPORTED', () => {
      expect(r('ALTER TABLE tmp_a RENAME TO TGFPAR').class).toBe('UNSUPPORTED');
      expect(r('ALTER TABLE tmp_a RENAME TO tmp_b')).toMatchObject({ class: 'SCRATCH_ONLY' });
    });
  });

  describe('DDL checks every table it touches', () => {
    it.each([
      'ALTER TABLE AD_X RENAME TO TGFPAR',
      'ALTER TABLE AD_X RENAME TO AD_Y',
      'CREATE TABLE AD_X (A INT REFERENCES TGFPAR (CODPARC))',
      'ALTER TABLE AD_X ADD CONSTRAINT FK_X FOREIGN KEY (A) REFERENCES TGFPAR (CODPARC)',
      'CREATE TEMP TABLE tmp_b (A INT REFERENCES TGFPAR (CODPARC))',
    ])('%s is UNSUPPORTED', (sql) => {
      expect(resolve(sql)).toMatchObject({ class: 'UNSUPPORTED', route: 'NONE' });
    });
  });

  it('exports the capability API from the package index', () => {
    expect(engine.resolveCapability).toBe(resolveCapability);
    expect(engine.CAPABILITY_CLASSES).toContain('SCRATCH_ONLY');
    expect(engine.DEFAULT_CUSTOM_PREFIXES).toEqual(['AD_']);
    const opts: engine.ReadAnalysisOptions = { dialect: 'oracle' };
    const capability: engine.Capability | undefined = undefined;
    expect([opts.dialect, capability]).toEqual(['oracle', undefined]);
  });
});
