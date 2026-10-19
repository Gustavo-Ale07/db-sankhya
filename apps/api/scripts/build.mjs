// Bundles the API (and the workspace packages it uses) into dist/server.mjs.
// Third-party dependencies stay external and are installed in production node_modules.
import { cp, rm } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

await rm(dist, { recursive: true, force: true });

await build({
  entryPoints: [resolve(root, 'src/server.ts')],
  outfile: resolve(dist, 'server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'external-npm-deps',
      setup(b) {
        // Inline our workspace packages (@dbx/*) and relative files; everything else is external.
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.kind === 'entry-point' || isAbsolute(args.path)) return undefined;
          if (args.path.startsWith('@dbx/') || args.path.startsWith('node:')) return undefined;
          return { path: args.path, external: true };
        });
      },
    },
  ],
});

// Versioned SQL migrations ship next to the bundle (applied on start).
await cp(resolve(root, '../../packages/database/migrations'), resolve(dist, 'migrations'), {
  recursive: true,
});
