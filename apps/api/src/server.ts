import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '@dbx/database';
import { ConfigError, loadConfig } from './config';
import { buildApp } from './app';
import { announceBootstrap } from './services/bootstrap';
import { createShutdown } from './shutdown';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Problems name variables, never their values.
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  // The production bundle ships migrations in dist/migrations; in dev the package default is used.
  const bundled = fileURLToPath(new URL('./migrations', import.meta.url));
  const migrationsDir = config.migrationsDir ?? (existsSync(bundled) ? bundled : undefined);
  const database = await createDatabase(config.databaseUrl, migrationsDir ? { migrationsDir } : {});
  // Versioned migrations are applied on start (never schema push).
  await database.migrate();

  const app = await buildApp({ config, database });
  // Empty users table: a one-time bootstrap token is logged once (or the admin CLI is pointed to).
  await announceBootstrap(app.services, app.log);

  const housekeeping = setInterval(() => {
    void app.services.sessions
      .purgeExpired()
      .catch((err: unknown) => app.log.warn({ err }, 'session purge failed'));
  }, 3600_000);
  housekeeping.unref();

  const drain = createShutdown({
    app: { close: () => app.close(), forceClose: () => app.server.closeAllConnections() },
    closeDatabase: () => database.close(),
    timeoutMs: 15_000,
    log: app.log,
    exit: (code) => process.exit(code),
  });
  const shutdown = (signal: string) => {
    clearInterval(housekeeping);
    return drain(signal);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      version: config.version,
      commit: config.commit,
      sankhyaMode: config.sankhya.mode,
      safeMode: config.safeMode,
      // Mutations fail closed until Stage 11, whatever the flags say (matches /api/status).
      writesAvailable: false,
      globalWriteEnabled: config.globalWriteEnabled,
      writeToSankhya: config.writeToSankhya,
      database: database.kind,
    },
    'DB-Sankhya API started',
  );
}

/** Messages of an error and its causes (driver errors are wrapped, e.g. by Drizzle). */
function describeError(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err; e instanceof Error && parts.length < 5; e = e.cause) {
    parts.push(e.message);
  }
  return parts.length > 0 ? parts.join(' — caused by: ') : 'unknown error';
}

main().catch((err: unknown) => {
  console.error('Fatal error during startup:', describeError(err));
  process.exit(1);
});
