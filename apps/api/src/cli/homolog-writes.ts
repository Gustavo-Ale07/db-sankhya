/**
 * `admin grant-homolog-writes`: lets one user write ERP data on HOMOLOGATION connections only.
 *
 * - Role `HOMOLOG_WRITER` (not a system role): QUERY.SELECT, DATA.PREVIEW, DATA.INSERT,
 *   DATA.UPDATE and, with `--actions`, SANKHYA.BUSINESS_ACTION.EXECUTE plus every
 *   SANKHYA.ACTION.*. Permissions are only ever added to it.
 * - An ALLOW rule for that user, environment HOMOLOGATION, on DATA.INSERT/DATA.UPDATE and the
 *   tables named in `--entities` (plain table names, no patterns). With `--actions`, a second
 *   ALLOW rule on the action permissions for TGFCAB and TGFITE.
 * - Nothing for PRODUCTION or SANDBOX, no DATA.DELETE, no DDL, no switch. The write switches
 *   (GLOBAL_WRITE_ENABLED, WRITE_TO_SANKHYA, BUSINESS_ACTIONS_ENABLED) stay where they are.
 *
 * Separation of duties: a user who administers policies is refused, since holding a write
 * permission would lock them out of policy changes (POLICY_ADMIN_CONFLICTS).
 * Running it again is harmless: it adds what is missing and changes nothing else.
 */
import { and, eq } from 'drizzle-orm';
import { rolePermissions, roles, userRoles } from '@dbx/database';
import type { Database } from '@dbx/database';
import { AppError, createRedactor } from '@dbx/shared';
import type { Permission } from '@dbx/shared';
import { secretValues } from '../config';
import type { AppConfig } from '../config';
import { AuthzService } from '../services/authz';
import { BUSINESS_ACTION_PERMISSION, listActions } from '../services/business-actions';
import { PolicyService } from '../services/policy';
import type { PolicyInput } from '../services/policy';
import { AuditService } from '../services/records';
import { UsersService } from '../services/users';

export const HOMOLOG_ROLE = 'HOMOLOG_WRITER';
const WRITE_PERMISSIONS: Permission[] = [
  'QUERY.SELECT',
  'DATA.PREVIEW',
  'DATA.INSERT',
  'DATA.UPDATE',
];
const ACTION_TABLES = ['TGFCAB', 'TGFITE'];
const TABLE = /^[A-Z][A-Z0-9_$#@]*$/;

export interface HomologGrant {
  email: string;
  entities: string[];
  actions: boolean;
}

export interface HomologGrantResult {
  role: string;
  permissions: Permission[];
  rules: string[];
}

/** Parses `--entities`: plain table names, upper-cased, at least one. */
export function parseEntities(raw: string | undefined): string[] {
  const names = [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (names.length === 0) throw new AppError('VALIDATION_ERROR', '--entities is required');
  const bad = names.filter((n) => !TABLE.test(n));
  if (bad.length > 0)
    throw new AppError('VALIDATION_ERROR', `Not a plain table name: ${bad.join(', ')}`);
  return names;
}

export async function grantHomologWrites(
  db: Database,
  config: AppConfig,
  grant: HomologGrant,
): Promise<HomologGrantResult> {
  const actionPermissions: Permission[] = grant.actions
    ? [BUSINESS_ACTION_PERMISSION, ...listActions().map((a) => a.permission)]
    : [];
  const wanted = [...WRITE_PERMISSIONS, ...actionPermissions];
  return db.transaction(async (tx) => {
    const authz = new AuthzService(tx);
    const user = await new UsersService(tx, authz).findByEmail(grant.email);
    if (!user) throw new AppError('NOT_FOUND', `User ${grant.email} not found`);
    if (!user.active) throw new AppError('CONFLICT', `User ${grant.email} is inactive`);
    if ((await authz.effectivePermissions(user.id)).has('ADMIN.POLICIES')) {
      throw new AppError(
        'CONFLICT',
        `${grant.email} administers policies; a write permission would lock them out of it ` +
          '(separation of duties). Use a separate account for writing.',
      );
    }

    // The role: created when missing, otherwise only the missing permissions are added.
    let [role] = await tx.select().from(roles).where(eq(roles.key, HOMOLOG_ROLE));
    if (role?.system) throw new AppError('CONFLICT', `${HOMOLOG_ROLE} is a system role`);
    if (!role) {
      [role] = await tx
        .insert(roles)
        .values({
          key: HOMOLOG_ROLE,
          name: 'Homologation writer',
          description: 'ERP writes on HOMOLOGATION connections only (see docs/homologation.md).',
          system: false,
        })
        .returning();
    }
    const held = new Set(
      (
        await tx
          .select({ p: rolePermissions.permission })
          .from(rolePermissions)
          .where(eq(rolePermissions.roleId, role!.id))
      ).map((r) => r.p),
    );
    const missing = wanted.filter((p) => !held.has(p));
    if (missing.length > 0)
      await tx
        .insert(rolePermissions)
        .values(missing.map((permission) => ({ roleId: role!.id, permission })));
    const [assigned] = await tx
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.userId, user.id), eq(userRoles.roleId, role!.id)));
    if (!assigned) await tx.insert(userRoles).values({ userId: user.id, roleId: role!.id });

    // The rules: one per purpose and user, found again by name; entities are only added.
    const policies = new PolicyService(tx, { error: () => {}, warn: () => {} });
    const existing = await policies.list();
    const upsert = async (name: string, actions: Permission[], entities: string[]) => {
      const found = existing.find((r) => r.name === name);
      const base: PolicyInput = {
        name,
        effect: 'ALLOW',
        subjectType: 'user',
        subjectId: user.id,
        environments: ['HOMOLOGATION'],
        connectionIds: [],
        actions,
        entities,
        columns: [],
        limits: {},
        overrideWhereRequired: false,
        enabled: true,
      };
      if (!found) return (await policies.create(base)).id;
      const covered =
        found.enabled &&
        found.effect === 'ALLOW' &&
        found.subjectId === user.id &&
        found.environments.length === 1 &&
        found.environments[0] === 'HOMOLOGATION' &&
        actions.every((a) => found.actions.includes(a)) &&
        entities.every((e) => found.entities.includes(e));
      if (covered) return found.id;
      await policies.update(found.id, {
        ...base,
        actions: [...new Set([...found.actions, ...actions])],
        entities: [...new Set([...found.entities, ...entities])],
      });
      return found.id;
    };
    const rules = [
      await upsert(
        `homologation writes: ${user.email}`,
        ['DATA.INSERT', 'DATA.UPDATE'],
        grant.entities,
      ),
    ];
    if (grant.actions)
      rules.push(
        await upsert(
          `homologation business actions: ${user.email}`,
          actionPermissions,
          ACTION_TABLES,
        ),
      );

    await new AuditService(tx, createRedactor(secretValues(config))).record({
      action: 'policy.homolog_grant',
      status: 'success',
      userId: user.id,
      userEmail: user.email,
      details: {
        via: 'cli',
        role: HOMOLOG_ROLE,
        addedPermissions: missing,
        environment: 'HOMOLOGATION',
        entities: grant.entities,
        actions: grant.actions,
        policyIds: rules,
      },
    });
    return { role: HOMOLOG_ROLE, permissions: wanted, rules };
  });
}
