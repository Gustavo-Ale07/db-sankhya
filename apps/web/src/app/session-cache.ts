import type { QueryClient } from '@tanstack/react-query';

/**
 * Drops every cached query when the session ends (logout, expiry or any other 401), then marks
 * the user as signed out. Cached data is per user (the schema catalog is filtered by the user's
 * policies), so the next user signing in on the same tab must never be served it.
 */
export function resetSessionCache(qc: QueryClient): void {
  qc.clear();
  qc.setQueryData(['me'], null);
}
