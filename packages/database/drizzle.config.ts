import { defineConfig } from 'drizzle-kit';

// Migration generation only needs the schema; no database connection is used.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
});
