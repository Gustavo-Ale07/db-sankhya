// Starts the e2e server without any default password: the admin CLI creates the first
// administrator (BOOTSTRAP_ADMIN_* from the environment) on a fresh PGlite directory and its
// one-time password is saved for the tests. Then the API starts on the same database.
// Everything lives in <tmpdir>/dbx-e2e-<PORT>, so runs on different ports do not clash; the
// derivation must match playwright.config.ts.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const api = (file) => fileURLToPath(new URL(`../apps/api/dist/${file}`, import.meta.url));
const { PORT } = process.env;
if (!PORT || !/^\d+$/.test(PORT)) throw new Error('start-server.mjs needs PORT');

const e2eDir = join(tmpdir(), `dbx-e2e-${PORT}`);
const dataDir = join(e2eDir, 'db');
const passwordFile = join(e2eDir, 'bootstrap-password.txt');
rmSync(e2eDir, { recursive: true, force: true });
// PGlite creates its directory but not the parents.
mkdirSync(e2eDir, { recursive: true });
process.env.DATABASE_URL = `pglite:${dataDir}`;
const out = execFileSync(process.execPath, [api('admin.mjs'), 'bootstrap'], {
  env: process.env,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
const password = /^one-time password: (\S+)$/m.exec(out)?.[1];
if (!password) throw new Error('the admin CLI printed no one-time password');
writeFileSync(passwordFile, password, { mode: 0o600 });

await import(pathToFileURL(api('server.mjs')).href);
