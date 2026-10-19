import { defineConfig } from 'vitest/config';

// Used only when vitest runs from apps/api; the root config (with its unit / integration
// projects) is the one `pnpm test` uses. Integration tests start a fresh PGlite database and hash
// passwords, which takes 2-5 s per test, so they need the same limits as the root
// "integration" project instead of vitest's 5 s default.
export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
