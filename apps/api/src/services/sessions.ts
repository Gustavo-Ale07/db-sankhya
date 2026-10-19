import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { sessions, users } from '@dbx/database';
import type { Database, SessionRow, UserRow } from '@dbx/database';
import { randomToken, sha256Hex } from '../security/crypto';

export interface ResolvedSession {
  session: SessionRow;
  user: UserRow;
}

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class SessionsService {
  constructor(
    private readonly db: Database,
    private readonly hours: number,
  ) {}

  /** Issues a fresh opaque token. Only its SHA-256 is stored. */
  async create(
    userId: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<{ token: string; session: SessionRow }> {
    const token = randomToken(32);
    const [session] = await this.db
      .insert(sessions)
      .values({
        tokenHash: sha256Hex(token),
        userId,
        expiresAt: new Date(Date.now() + this.hours * 3600_000),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
      })
      .returning();
    return { token, session: session as SessionRow };
  }

  async resolve(token: string | undefined): Promise<ResolvedSession | null> {
    if (!token || !TOKEN_PATTERN.test(token)) return null;
    const [row] = await this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, sha256Hex(token)))
      .limit(1);
    if (!row) return null;
    const now = Date.now();
    if (row.session.revokedAt || row.session.expiresAt.getTime() <= now || !row.user.active)
      return null;
    // A password change invalidates sessions created before it.
    if (row.user.passwordChangedAt.getTime() > row.session.createdAt.getTime() + 1000) return null;
    if (now - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db
        .update(sessions)
        .set({ lastSeenAt: new Date() })
        .where(eq(sessions.id, row.session.id));
    }
    return row;
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
  }

  async purgeExpired(): Promise<void> {
    const cutoff = new Date(Date.now() - 7 * 24 * 3600_000);
    await this.db
      .delete(sessions)
      .where(or(lt(sessions.expiresAt, new Date()), lt(sessions.revokedAt, cutoff)));
  }
}
