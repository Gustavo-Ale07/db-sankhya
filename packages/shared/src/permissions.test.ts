import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  POLICY_ADMIN_CONFLICTS,
  SYSTEM_ROLE_PERMISSIONS,
  isPermission,
  isWriteKind,
  statementPermission,
} from './permissions';

describe('permission catalog', () => {
  it('is exactly the catalog of the security model', () => {
    expect(PERMISSIONS).toEqual([
      'QUERY.SELECT',
      'TEMP.CREATE',
      'TEMP.WRITE',
      'TEMP.DROP',
      'TEMP.MATERIALIZE',
      'DATA.INSERT',
      'DATA.UPDATE',
      'DATA.DELETE',
      'DDL.CUSTOM.GENERATE',
      'SANKHYA.BUSINESS_ACTION.EXECUTE',
      'APPROVAL.DECIDE',
      'AUDIT.READ',
      'ADMIN.USERS',
      'ADMIN.GROUPS',
      'ADMIN.ROLES',
      'ADMIN.POLICIES',
      'ADMIN.CONNECTIONS',
      'ADMIN.SECURITY',
    ]);
  });

  it('recognises only catalog entries', () => {
    expect(isPermission('DATA.UPDATE')).toBe(true);
    expect(isPermission('DDL.NATIVE')).toBe(false);
    expect(isPermission('data.update')).toBe(false);
  });

  it('VIEWER reads and uses temporary tables', () => {
    expect([...SYSTEM_ROLE_PERMISSIONS.VIEWER].sort()).toEqual(
      ['QUERY.SELECT', 'TEMP.CREATE', 'TEMP.DROP', 'TEMP.MATERIALIZE', 'TEMP.WRITE'].sort(),
    );
  });

  it('OPERATOR is VIEWER plus insert and update, not delete', () => {
    expect([...SYSTEM_ROLE_PERMISSIONS.OPERATOR].sort()).toEqual(
      [...SYSTEM_ROLE_PERMISSIONS.VIEWER, 'DATA.INSERT', 'DATA.UPDATE'].sort(),
    );
    expect(SYSTEM_ROLE_PERMISSIONS.OPERATOR).not.toContain('DATA.DELETE');
  });

  it('ADMIN administers but lacks DATA.*, DDL.* and SANKHYA.* (no admin bypass)', () => {
    const admin = SYSTEM_ROLE_PERMISSIONS.ADMIN;
    for (const p of PERMISSIONS.filter((x) => x.startsWith('ADMIN.'))) expect(admin).toContain(p);
    for (const p of ['AUDIT.READ', 'APPROVAL.DECIDE', 'QUERY.SELECT', 'TEMP.MATERIALIZE'])
      expect(admin).toContain(p);
    expect(admin).not.toContain('DATA.UPDATE');
    for (const p of admin) expect(p).not.toMatch(/^(DATA|DDL|SANKHYA)\./);
  });

  it('separates policy administration from every write permission, and ADMIN holds none', () => {
    expect([...POLICY_ADMIN_CONFLICTS].sort()).toEqual(
      PERMISSIONS.filter((p) => /^(DATA|DDL|SANKHYA)\./.test(p)).sort(),
    );
    for (const p of POLICY_ADMIN_CONFLICTS) expect(SYSTEM_ROLE_PERMISSIONS.ADMIN).not.toContain(p);
  });

  it('seeded roles have no duplicates and only catalog permissions', () => {
    for (const perms of Object.values(SYSTEM_ROLE_PERMISSIONS)) {
      expect(new Set(perms).size).toBe(perms.length);
      for (const p of perms) expect(isPermission(p)).toBe(true);
    }
  });

  it('maps statements to permissions', () => {
    expect(statementPermission('SELECT')).toBe('QUERY.SELECT');
    expect(statementPermission('EXPLAIN')).toBe('QUERY.SELECT');
    expect(statementPermission('INSERT')).toBe('DATA.INSERT');
    expect(statementPermission('UPDATE')).toBe('DATA.UPDATE');
    expect(statementPermission('DELETE')).toBe('DATA.DELETE');
    expect(isWriteKind('UPDATE')).toBe(true);
    expect(isWriteKind('SHOW')).toBe(false);
  });
});
