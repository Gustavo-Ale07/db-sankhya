// Starts the e2e server without any default password: the admin CLI creates the first
// administrator (BOOTSTRAP_ADMIN_* from the environment) on a fresh PGlite directory and its
// one-time password is saved for the tests. Then the API starts on the same database.
// Everything lives in <tmpdir>/dbx-e2e-<PORT>, so runs on different ports do not clash; the
// derivation must match playwright.config.ts.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const api = (file) => fileURLToPath(new URL(`../apps/api/dist/${file}`, import.meta.url));
const { PORT } = process.env;
if (!PORT || !/^\d+$/.test(PORT)) throw new Error('start-server.mjs needs PORT');

const e2eDir = join(tmpdir(), `dbx-e2e-${PORT}`);
const dataDir = join(e2eDir, 'db');
const passwordFile = join(e2eDir, 'bootstrap-password.txt');
const specialistFile = join(e2eDir, 'specialist-password.txt');
// Keep in sync with SPECIALIST in playwright.config.ts.
const SPECIALIST_EMAIL = 'especialista@example.com';
const SPECIALIST_ROLE = 'E2E_ESPECIALISTA';
rmSync(e2eDir, { recursive: true, force: true });
// PGlite creates its directory but not the parents.
mkdirSync(e2eDir, { recursive: true });
process.env.DATABASE_URL = `pglite:${dataDir}`;
/** Runs `admin bootstrap` and returns the one-time password it printed. */
function bootstrapUser(args, env) {
  const out = execFileSync(process.execPath, [api('admin.mjs'), 'bootstrap', ...args], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const password = /^one-time password: (\S+)$/m.exec(out)?.[1];
  if (!password) throw new Error('the admin CLI printed no one-time password');
  return password;
}

writeFileSync(passwordFile, bootstrapUser([], process.env), { mode: 0o600 });

// Test-only fixture: DATA.DELETE and DDL.CUSTOM.GENERATE are held by no system role, and nobody
// may grant a permission they do not hold, so no API call can create a user with them. Like the
// API integration tests, the role is seeded directly in the database, before the server starts;
// the admin CLI then adds one user holding only that role (a refused DELETE must reach the
// capability check, and the DDL artifact needs the permission).
const pgliteEntry = createRequire(api('../package.json')).resolve('@electric-sql/pglite');
const { PGlite } = await import(pathToFileURL(pgliteEntry).href);
const db = new PGlite(dataDir);
try {
  const role = await db.query(
    `INSERT INTO roles (key, name, description, system) VALUES ($1, $2, $3, false) RETURNING id`,
    [
      SPECIALIST_ROLE,
      'Especialista E2E',
      'Fixture of the e2e run only: DELETE (refused as UNSUPPORTED) and custom DDL artifacts.',
    ],
  );
  const roleId = role.rows[0].id;
  for (const permission of [
    'QUERY.SELECT',
    'TEMP.CREATE',
    'TEMP.WRITE',
    'TEMP.DROP',
    'TEMP.MATERIALIZE',
    'DATA.DELETE',
    'DDL.CUSTOM.GENERATE',
  ]) {
    await db.query(`INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`, [
      roleId,
      permission,
    ]);
  }
} finally {
  await db.close();
}
writeFileSync(
  specialistFile,
  bootstrapUser(
    ['--email', SPECIALIST_EMAIL, '--name', 'Especialista Demo', '--force-additional'],
    {
      ...process.env,
      BOOTSTRAP_ADMIN_ROLES: SPECIALIST_ROLE,
    },
  ),
  { mode: 0o600 },
);

await import(pathToFileURL(api('server.mjs')).href);
