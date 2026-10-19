// Starts the e2e server without any default password: the admin CLI creates the first
// administrator (BOOTSTRAP_ADMIN_* from the environment) on a fresh PGlite directory and its
// one-time password is saved for the tests (E2E_PASSWORD_FILE). Then the API starts on the same
// database.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const api = (file) => fileURLToPath(new URL(`../apps/api/dist/${file}`, import.meta.url));
const { DATABASE_URL = '', E2E_PASSWORD_FILE } = process.env;
if (!DATABASE_URL.startsWith('pglite:') || !E2E_PASSWORD_FILE) {
  throw new Error('start-server.mjs needs DATABASE_URL=pglite:<dir> and E2E_PASSWORD_FILE');
}

const dataDir = DATABASE_URL.slice('pglite:'.length);
rmSync(dataDir, { recursive: true, force: true });
rmSync(E2E_PASSWORD_FILE, { force: true });
// PGlite creates its directory but not the parents.
mkdirSync(dirname(dataDir), { recursive: true });
const out = execFileSync(process.execPath, [api('admin.mjs'), 'bootstrap'], {
  env: process.env,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
const password = /^one-time password: (\S+)$/m.exec(out)?.[1];
if (!password) throw new Error('the admin CLI printed no one-time password');
mkdirSync(dirname(E2E_PASSWORD_FILE), { recursive: true });
writeFileSync(E2E_PASSWORD_FILE, password, { mode: 0o600 });

await import(pathToFileURL(api('server.mjs')).href);
