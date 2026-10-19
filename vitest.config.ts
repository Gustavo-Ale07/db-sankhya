import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'apps/api/src/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'web',
          include: ['apps/web/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/*/src/**/*.int.test.ts', 'apps/api/src/**/*.int.test.ts'],
          environment: 'node',
          testTimeout: 30000,
          hookTimeout: 60000,
        },
      },
    ],
  },
});
