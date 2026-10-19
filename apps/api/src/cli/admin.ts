/**
 * Administration CLI. Creates administrators and resets passwords without any default password:
 * each command prints a one-time password that must be changed at the next login.
 *
 *   admin bootstrap --email <e-mail> [--name <name>] [--force-additional]
 *   admin reset-password --email <e-mail>
 *
 * Development: `pnpm --filter @dbx/api admin <command>`. Production bundle: `node dist/admin.mjs`.
 */
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createDatabase } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { createRedactor, isAppError } from '@dbx/shared';
import { ConfigError, loadConfig, secretValues } from '../config';
import type { AppConfig } from '../config';
import { AuthzService } from '../services/authz';
import { createBootstrapService, generateOneTimePassword } from '../services/bootstrap';
import { AuditService } from '../services/records';
import { UsersService } from '../services/users';

export interface AdminCliDeps {
  config: AppConfig;
  database: DatabaseHandle;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `Usage:
  admin bootstrap --email <e-mail> [--name <name>] [--force-additional]
  admin reset-password --email <e-mail>

bootstrap        creates an administrator (roles from BOOTSTRAP_ADMIN_ROLES). Refused when users
                 already exist, unless --force-additional is given.
reset-password   replaces a user's password, unlocks the account and revokes its sessions.

Both print a one-time password that must be changed at the next login.
--email defaults to BOOTSTRAP_ADMIN_EMAIL.
`;

const email = z.email().max(254);

/** Runs one command; returns the process exit code (0 ok, 1 refused/failed, 2 usage error). */
export async function runAdminCli(argv: readonly string[], deps: AdminCliDeps): Promise<number> {
  const { config, database, stdout, stderr } = deps;
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        email: { type: 'string' },
        name: { type: 'string' },
        'force-additional': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    stderr(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const command = positionals[0];
  if (values.help || positionals.length !== 1) {
    stderr(USAGE);
    return values.help ? 0 : 2;
  }
  if (command !== 'bootstrap' && command !== 'reset-password') {
    stderr(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  if (command === 'reset-password' && (values.name || values['force-additional'])) {
    stderr(`reset-password accepts only --email\n\n${USAGE}`);
    return 2;
  }
  const address = (values.email ?? config.bootstrapAdmin.email ?? '').trim().toLowerCase();
  if (!address) {
    stderr(`--email is required (or set BOOTSTRAP_ADMIN_EMAIL)\n\n${USAGE}`);
    return 2;
  }
  if (!email.safeParse(address).success) {
    stderr('--email is not a valid e-mail\n');
    return 2;
  }

  const authz = new AuthzService(database.db);
  const users = new UsersService(database.db, authz);
  try {
    if (command === 'bootstrap') {
      const bootstrap = createBootstrapService(database.db, authz, config);
      const { user, password } = await bootstrap.createAdmin({
        email: address,
        ...(values.name ? { name: values.name } : {}),
        forceAdditional: values['force-additional'],
      });
      stderr(
        `Administrator ${user.email} created with roles ${config.bootstrapAdmin.roles.join(', ')}.\n` +
          'The password below is shown only once and must be changed at the first login.\n',
      );
      stdout(`one-time password: ${password}\n`);
      return 0;
    }

    const user = await users.findByEmail(address);
    if (!user) {
      stderr(`User ${address} not found\n`);
      return 1;
    }
    if (user.identityProvider !== 'local') {
      stderr(`User ${address} signs in through ${user.identityProvider}; no local password\n`);
      return 1;
    }
    const password = generateOneTimePassword();
    // One transaction: a failed audit write leaves the old password and sessions untouched.
    await database.db.transaction(async (tx) => {
      const txUsers = new UsersService(tx, new AuthzService(tx));
      await txUsers.setPassword(user.id, password, true);
      await txUsers.revokeSessions(user.id);
      await new AuditService(tx, createRedactor(secretValues(config))).record({
        action: 'user.password_reset',
        status: 'success',
        userId: user.id,
        userEmail: user.email,
        details: { via: 'cli' },
      });
    });
    stderr(
      `Password of ${user.email} reset; its sessions were revoked.\n` +
        'The password below is shown only once and must be changed at the next login.\n',
    );
    stdout(`one-time password: ${password}\n`);
    return 0;
  } catch (err) {
    if (isAppError(err)) {
      stderr(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

async function main(): Promise<number> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
  // The production bundle ships migrations in dist/migrations; in dev the package default is used.
  const bundled = fileURLToPath(new URL('./migrations', import.meta.url));
  const migrationsDir = config.migrationsDir ?? (existsSync(bundled) ? bundled : undefined);
  const database = await createDatabase(config.databaseUrl, migrationsDir ? { migrationsDir } : {});
  try {
    await database.migrate();
    return await runAdminCli(process.argv.slice(2), {
      config,
      database,
      stdout: (s) => void process.stdout.write(s),
      stderr: (s) => void process.stderr.write(s),
    });
  } finally {
    await database.close();
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      pathToFileURL(realpathSync(entry)).href ===
      pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href
    );
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`admin: ${err instanceof Error ? err.message : 'unknown error'}\n`);
      process.exit(1);
    },
  );
}
