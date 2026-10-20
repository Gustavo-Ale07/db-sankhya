// Writes the permission reference in docs/permissions.md from packages/shared, so the table always
// matches the code. `node scripts/permissions-doc.mjs` rewrites it; `--check` only compares.
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// The shared sources import siblings without an extension (bundler style); add `.ts` for Node.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.')) return next(`${specifier}.ts`, context);
      throw err;
    }
  },
});

const { PERMISSIONS, SYSTEM_ROLES, SYSTEM_ROLE_PERMISSIONS } =
  await import('../packages/shared/src/permissions.ts');
const { POLICY_ACTION_CLASS } = await import('../packages/shared/src/policy.ts');

const rows = [
  ['Permission', 'Policy class', ...SYSTEM_ROLES],
  ...PERMISSIONS.map((p) => [
    `\`${p}\``,
    POLICY_ACTION_CLASS[p],
    ...SYSTEM_ROLES.map((r) => (SYSTEM_ROLE_PERMISSIONS[r].includes(p) ? 'yes' : '')),
  ]),
];
const widths = rows[0].map((_, i) => Math.max(3, ...rows.map((r) => r[i].length)));
const line = (cells) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
const table = [line(rows[0]), line(widths.map((w) => '-'.repeat(w))), ...rows.slice(1).map(line)];

const START = '<!-- permissions:start (written by scripts/permissions-doc.mjs) -->';
const END = '<!-- permissions:end -->';
const file = new URL('../docs/permissions.md', import.meta.url);
const doc = readFileSync(file, 'utf8');
const from = doc.indexOf(START);
const to = doc.indexOf(END);
if (from < 0 || to < from) throw new Error('docs/permissions.md has no permissions markers');
const next = `${doc.slice(0, from + START.length)}\n\n${table.join('\n')}\n\n${doc.slice(to)}`;

if (process.argv.includes('--check')) {
  if (next !== doc) {
    console.error('docs/permissions.md is out of date: run node scripts/permissions-doc.mjs');
    process.exit(1);
  }
  console.log('docs/permissions.md matches packages/shared');
} else {
  writeFileSync(file, next);
  console.log('docs/permissions.md updated');
}
