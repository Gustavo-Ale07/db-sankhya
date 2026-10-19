export * from './schema';
export * as tables from './schema';
export { createDatabase, defaultMigrationsDir } from './client';
export type { Database, DatabaseHandle, DatabaseOptions, Schema } from './client';
