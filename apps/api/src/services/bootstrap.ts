import { randomBytes } from 'node:crypto';
import { and, count, eq, lte, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { auditEvents, bootstrapTokens, users } from '@dbx/database';
import type { Database, UserRow } from '@dbx/database';
import { AppError } from '@dbx/shared';
import { isWeakPassword } from '../config';
import type { AppConfig } from '../config';
import { hashPassword, randomToken, safeEqual, sha256Hex } from '../security/crypto';
import { GUARD_LOCK_KEY } from './authz';
import type { AuthzService } from './authz';
import { isUniqueViolation } from './users';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Random bytes behind each bootstrap token (sent as base64url). */
export const BOOTSTRAP_TOKEN_BYTES = 32;

export type IssueResult =
  /** A new token: the only moment it exists in clear text. */
  | { status: 'issued'; token: string; expiresAt: Date }
  /** A token issued on an earlier boot is still valid; it cannot be shown again. */
  | { status: 'pending'; expiresAt: Date }
  /** Users exist: there is nothing to bootstrap. */
  | { status: 'not_needed' };

export interface ConsumeInput {
  token: string;
  email: string;
  password: string;
}

export interface RequestContext {
  ip?: string | null;
  requestId?: string | null;
}

const ONE_TIME_PASSWORD_CHARS =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#%+-=?@^_';

/** A random password that meets the password policy, shown once by the admin CLI. */
export function generateOneTimePassword(length = 24): string {
  for (;;) {
    const bytes = randomBytes(length);
    let out = '';
    // 256 is not a multiple of the alphabet size; dropping the top bytes keeps it uniform.
    const limit = 256 - (256 % ONE_TIME_PASSWORD_CHARS.length);
    for (const b of bytes)
      if (b < limit) out += ONE_TIME_PASSWORD_CHARS[b % ONE_TIME_PASSWORD_CHARS.length];
    if (out.length >= 16 && !isWeakPassword(out)) return out;
  }
}

/**
 * The first administrator, created either with a one-time bootstrap token (HTTP) or with the
 * admin CLI. Both paths run under the advisory lock of guarded changes, so they cannot race.
 */
export class BootstrapService {
  constructor(
    private readonly db: Database,
    private readonly authz: AuthzService,
    private readonly options: {
      ttlMinutes: number;
      adminName: string;
      adminRoles: readonly string[];
    },
  ) {}

  /**
   * On an empty users table, makes sure a valid token exists. A new token is returned in clear
   * text exactly once; only its SHA-256 is stored.
   */
  async issueToken(now = new Date()): Promise<IssueResult> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${GUARD_LOCK_KEY})`);
      if ((await this.countUsers(tx)) > 0) {
        await tx.delete(bootstrapTokens);
        return { status: 'not_needed' } as const;
      }
      await tx.delete(bootstrapTokens).where(lte(bootstrapTokens.expiresAt, now));
      const [live] = await tx.select().from(bootstrapTokens).limit(1);
      if (live) return { status: 'pending', expiresAt: live.expiresAt } as const;
      const token = randomToken(BOOTSTRAP_TOKEN_BYTES);
      const expiresAt = new Date(now.getTime() + this.options.ttlMinutes * 60_000);
      await tx.insert(bootstrapTokens).values({ tokenHash: sha256Hex(token), expiresAt });
      return { status: 'issued', token, expiresAt } as const;
    });
  }

  /** Discards every pending token (the CLI path is configured). */
  async discardTokens(): Promise<void> {
    await this.db.delete(bootstrapTokens);
  }

  /**
   * Creates the first administrator with a bootstrap token. One transaction deletes the token
   * and creates the user, so parallel requests cannot create two administrators.
   */
  async consume(
    input: ConsumeInput,
    context: RequestContext & { passwordError: (password: string) => AppError | null },
    now = new Date(),
  ): Promise<UserRow> {
    const tokenHash = sha256Hex(input.token);
    return this.authz.guarded(async (tx) => {
      if ((await this.countUsers(tx)) > 0) {
        // The audit row of a token bootstrap keeps the hash of the consumed token.
        const [used] = await tx
          .select({ id: auditEvents.id })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.action, 'auth.bootstrap'),
              sql`${auditEvents.details} ->> 'tokenSha256' = ${tokenHash}`,
            ),
          )
          .limit(1);
        if (used) throw new AppError('CONFIRMATION_USED', 'This bootstrap token was already used');
        throw new AppError('NOT_FOUND', 'Route not found');
      }
      const rows = await tx.select().from(bootstrapTokens);
      // No token pending: answer like an unknown route, so the endpoint is not revealed.
      if (rows.length === 0) throw new AppError('NOT_FOUND', 'Route not found');
      // Every stored hash is compared in constant time; there is normally a single one.
      let match: typeof bootstrapTokens.$inferSelect | undefined;
      for (const row of rows) {
        if (safeEqual(row.tokenHash, tokenHash)) match = row;
      }
      if (!match) throw new AppError('CONFIRMATION_INVALID', 'Invalid bootstrap token');
      if (match.expiresAt.getTime() <= now.getTime()) {
        throw new AppError(
          'CONFIRMATION_EXPIRED',
          'The bootstrap token expired; restart the app to issue a new one',
        );
      }
      const weak = context.passwordError(input.password);
      if (weak) throw weak;

      await tx.delete(bootstrapTokens);
      const user = await this.insertAdmin(tx, {
        email: input.email,
        password: input.password,
        mustChangePassword: false,
      });
      await tx.insert(auditEvents).values({
        action: 'auth.bootstrap',
        status: 'success',
        userId: user.id,
        userEmail: user.email,
        ip: context.ip ?? null,
        requestId: context.requestId ?? null,
        details: { via: 'token', tokenSha256: tokenHash, roles: [...this.options.adminRoles] },
      });
      return user;
    });
  }

  /**
   * Admin CLI: creates an administrator with a one-time password that must be changed at first
   * login. Refused on a non-empty users table unless `forceAdditional` is set.
   */
  async createAdmin(input: {
    email: string;
    name?: string;
    forceAdditional: boolean;
  }): Promise<{ user: UserRow; password: string }> {
    const password = generateOneTimePassword();
    try {
      const user = await this.authz.guarded(async (tx) => {
        const existing = await this.countUsers(tx);
        if (existing > 0 && !input.forceAdditional) {
          throw new AppError(
            'CONFLICT',
            'The users table is not empty; pass --force-additional to add another administrator',
          );
        }
        await tx.delete(bootstrapTokens);
        const u = await this.insertAdmin(tx, {
          email: input.email,
          ...(input.name ? { name: input.name } : {}),
          password,
          mustChangePassword: true,
        });
        await tx.insert(auditEvents).values({
          action: 'user.bootstrap',
          status: 'success',
          userId: u.id,
          userEmail: u.email,
          details: { via: 'cli', additional: existing > 0, roles: [...this.options.adminRoles] },
        });
        return u;
      });
      return { user, password };
    } catch (err) {
      if (isUniqueViolation(err))
        throw new AppError('CONFLICT', 'A user with this e-mail already exists');
      throw err;
    }
  }

  private async countUsers(tx: Tx): Promise<number> {
    const [row] = await tx.select({ n: count() }).from(users);
    return row?.n ?? 0;
  }

  private async insertAdmin(
    tx: Tx,
    input: { email: string; name?: string; password: string; mustChangePassword: boolean },
  ): Promise<UserRow> {
    const [u] = await tx
      .insert(users)
      .values({
        email: input.email.trim().toLowerCase(),
        name: (input.name ?? this.options.adminName).trim(),
        passwordHash: await hashPassword(input.password),
        mustChangePassword: input.mustChangePassword,
      })
      .returning();
    await this.authz.assignUserRoles(u!.id, this.options.adminRoles, tx);
    return u as UserRow;
  }
}

export function createBootstrapService(
  db: Database,
  authz: AuthzService,
  config: AppConfig,
): BootstrapService {
  return new BootstrapService(db, authz, {
    ttlMinutes: config.bootstrapTokenTtlMinutes,
    adminName: config.bootstrapAdmin.name,
    adminRoles: config.bootstrapAdmin.roles,
  });
}

/**
 * Boot step. With an empty users table and no BOOTSTRAP_ADMIN_EMAIL, issues a bootstrap token
 * and logs it once at warn level. The message string is not run through the log redaction
 * (it only touches the merge object), so the token reaches the operator; it is never logged
 * again, because only its hash is kept.
 */
export async function announceBootstrap(
  services: {
    config: Pick<AppConfig, 'bootstrapAdmin' | 'appUrl'>;
    bootstrap: BootstrapService;
    users: { count(): Promise<number> };
  },
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>,
): Promise<IssueResult | { status: 'cli' }> {
  const email = services.config.bootstrapAdmin.email;
  if (email) {
    // With the CLI path selected, a token left by an earlier boot must not stay usable.
    await services.bootstrap.discardTokens();
    if ((await services.users.count()) === 0) {
      log.warn(
        { email },
        'no users yet: create the first administrator with the admin CLI (admin bootstrap --email <e-mail>)',
      );
    }
    return { status: 'cli' };
  }
  const result = await services.bootstrap.issueToken();
  if (result.status === 'issued') {
    log.warn(
      {
        oneTime: true,
        expiresAt: result.expiresAt.toISOString(),
        usage: `POST ${services.config.appUrl}/api/auth/bootstrap with {token, email, password}`,
      },
      `bootstrap token: ${result.token}`,
    );
  } else if (result.status === 'pending') {
    log.warn(
      { expiresAt: result.expiresAt.toISOString() },
      'a bootstrap token is still pending; it was shown once and is not logged again (restart after it expires, or use the admin CLI)',
    );
  }
  return result;
}
