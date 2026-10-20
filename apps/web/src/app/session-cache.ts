import type { QueryClient } from '@tanstack/react-query';
import { clearPendingPlans } from '../explorer/pendingPlans';

const isSession = (queryKey: readonly unknown[]) => queryKey.length === 1 && queryKey[0] === 'me';

/**
 * Drops every cached query when the session ends (logout, expiry or any other 401), then marks
 * the user as signed out. Cached data is per user (the schema catalog is filtered by the user's
 * policies), so the next user signing in on the same tab must never be served it.
 *
 * The `['me']` query itself is kept and set to `null` rather than removed: the shell observes that
 * very query object, and removing it would cancel its fetch (on a first-load 401, the one still in
 * flight) and leave the shell watching a detached query, stuck on its last state.
 *
 * The mutation plans kept in memory for reopening (token, idempotency key) go too: they belong to
 * the session that ends.
 */
export function resetSessionCache(qc: QueryClient): void {
  clearPendingPlans();
  qc.removeQueries({ predicate: (query) => !isSession(query.queryKey) });
  qc.getMutationCache().clear();
  qc.setQueryData(['me'], null);
}
