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
      'DATA.PREVIEW',
      'DATA.INSERT',
      'DATA.UPDATE',
      'DATA.DELETE',
      'DDL.CUSTOM.GENERATE',
      'SANKHYA.BUSINESS_ACTION.EXECUTE',
      'SANKHYA.ACTION.CANCELAR_NOTA',
      'SANKHYA.ACTION.INCLUIR_NOTA',
      'SANKHYA.ACTION.INCLUIR_ALTERAR_ITEM_NOTA',
      'SANKHYA.ACTION.EXCLUIR_ITEM_NOTA',
      'SERVER.DDL',
      'SERVER.DELETE',
      'SERVER.DML_RAW',
      'SERVER.DCL',
      'SERVER.PLSQL',
      'APPROVAL.DECIDE',
      'AUDIT.READ',
      'ADMIN.USERS',
      'ADMIN.GROUPS',
      'ADMIN.ROLES',
      'ADMIN.POLICIES',
      'ADMIN.CONNECTIONS',
      'ADMIN.SECURITY',
      'SECURITY.SEGREGATION_OVERRIDE',
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

  it('OPERATOR is VIEWER plus preview, insert and update, not delete', () => {
    expect([...SYSTEM_ROLE_PERMISSIONS.OPERATOR].sort()).toEqual(
      [...SYSTEM_ROLE_PERMISSIONS.VIEWER, 'DATA.PREVIEW', 'DATA.INSERT', 'DATA.UPDATE'].sort(),
    );
    expect(SYSTEM_ROLE_PERMISSIONS.OPERATOR).not.toContain('DATA.DELETE');
  });

  it('ADMIN administers and previews but lacks every write DATA.*, DDL.* and SANKHYA.* (no admin bypass)', () => {
    const admin = SYSTEM_ROLE_PERMISSIONS.ADMIN;
    for (const p of PERMISSIONS.filter((x) => x.startsWith('ADMIN.'))) expect(admin).toContain(p);
    for (const p of ['AUDIT.READ', 'APPROVAL.DECIDE', 'QUERY.SELECT', 'TEMP.MATERIALIZE'])
      expect(admin).toContain(p);
    expect(admin).toContain('DATA.PREVIEW');
    for (const p of ['DATA.INSERT', 'DATA.UPDATE', 'DATA.DELETE']) expect(admin).not.toContain(p);
    // DATA.PREVIEW is the only DATA.* an administrator holds: it shows a plan, never executes one.
    for (const p of admin.filter((x) => x !== 'DATA.PREVIEW'))
      expect(p).not.toMatch(/^(DATA|DDL|SANKHYA)\./);
  });

  it('VIEWER cannot preview writes', () => {
    expect(SYSTEM_ROLE_PERMISSIONS.VIEWER).not.toContain('DATA.PREVIEW');
  });

  it('separates policy administration from every write permission, and ADMIN holds none', () => {
    // DATA.PREVIEW writes nothing, so it is the one DATA.* that does not conflict. SERVER.* are
    // writes (the server-side route), so they conflict too; SECURITY.* is a marker, not a write.
    expect([...POLICY_ADMIN_CONFLICTS].sort()).toEqual(
      PERMISSIONS.filter(
        (p) => /^(DATA|DDL|SANKHYA|SERVER)\./.test(p) && p !== 'DATA.PREVIEW',
      ).sort(),
    );
    expect(POLICY_ADMIN_CONFLICTS).not.toContain('DATA.PREVIEW');
    expect(POLICY_ADMIN_CONFLICTS).not.toContain('SECURITY.SEGREGATION_OVERRIDE');
    for (const p of POLICY_ADMIN_CONFLICTS) expect(SYSTEM_ROLE_PERMISSIONS.ADMIN).not.toContain(p);
  });

  it('SUPER_ADMIN holds the whole catalog: every command and administration, with the override', () => {
    const superAdmin = SYSTEM_ROLE_PERMISSIONS.SUPER_ADMIN;
    expect([...superAdmin].sort()).toEqual([...PERMISSIONS].sort());
    // It is exempt from separation of duties precisely because it carries the override marker.
    expect(superAdmin).toContain('SECURITY.SEGREGATION_OVERRIDE');
    for (const p of POLICY_ADMIN_CONFLICTS) expect(superAdmin).toContain(p);
  });

  it('server-side permissions and the override are held only by SUPER_ADMIN, not the other roles', () => {
    const serverSide = PERMISSIONS.filter((p) => p.startsWith('SERVER.'));
    expect(serverSide).toHaveLength(5);
    for (const role of ['VIEWER', 'OPERATOR', 'ADMIN'] as const) {
      for (const p of [...serverSide, 'SECURITY.SEGREGATION_OVERRIDE' as const])
        expect(SYSTEM_ROLE_PERMISSIONS[role], role).not.toContain(p);
    }
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
