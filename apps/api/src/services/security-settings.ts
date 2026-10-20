import { eq } from 'drizzle-orm';
import { settings } from '@dbx/database';
import type { Database } from '@dbx/database';

/** Key of the runtime write kill switch in the `settings` table. */
export const GLOBAL_WRITE_SETTING = 'global_write_enabled';

/**
 * The global write switch. `env` is GLOBAL_WRITE_ENABLED, `runtime` the admin toggle (on until an
 * admin turns it off), and `effective = env AND runtime`: the runtime toggle can only turn writes
 * off, never on when the environment keeps them off.
 */
export interface GlobalWriteState {
  env: boolean;
  runtime: boolean;
  effective: boolean;
}

export interface SecuritySettingsLogger {
  error(obj: object, msg: string): void;
}

/**
 * Runtime security settings stored in `settings`. Values are read on every call (no cache), so a
 * change made through any instance applies to the very next request.
 */
export class SecuritySettingsService {
  constructor(
    private readonly db: Database,
    private readonly config: { globalWriteEnabled: boolean },
    private readonly logger: SecuritySettingsLogger,
  ) {}

  /**
   * The state the execute path must check before any write. Never throws: an unreadable table or
   * a stored value that is not a boolean counts as the switch turned off (fail closed).
   */
  async globalWriteState(): Promise<GlobalWriteState> {
    const env = this.config.globalWriteEnabled;
    let runtime: boolean;
    try {
      runtime = await this.readGlobalWrite();
    } catch (err) {
      try {
        this.logger.error({ err }, 'Write kill switch unreadable: treating writes as disabled');
      } catch {
        // Logging must never turn the fail-closed answer into a throw.
      }
      runtime = false;
    }
    return { env, runtime, effective: env && runtime };
  }

  /** Stores the runtime switch. Returns the value it replaced (as read before the write). */
  async setGlobalWrite(enabled: boolean, actorId: string | null): Promise<{ previous: boolean }> {
    const previous = (await this.globalWriteState()).runtime;
    await this.db
      .insert(settings)
      .values({ key: GLOBAL_WRITE_SETTING, value: enabled, updatedBy: actorId })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: enabled, updatedBy: actorId, updatedAt: new Date() },
      });
    return { previous };
  }

  private async readGlobalWrite(): Promise<boolean> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, GLOBAL_WRITE_SETTING));
    if (!row) return true;
    if (typeof row.value !== 'boolean') throw new Error('global_write_enabled is not a boolean');
    return row.value;
  }
}
