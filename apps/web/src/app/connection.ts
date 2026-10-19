import type { ConnectionOption } from '../api/types';

const STORAGE_KEY = 'dbx.connection';

/** Selected connection id, remembered per browser. Storage may be unavailable: never throws. */
export function loadSelectedConnection(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveSelectedConnection(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Not persisted: the choice still holds for this page load.
  }
}

/**
 * The connection to use: the remembered one while it is still listed, else the first one.
 * Undefined while nothing is available, in which case calls omit `connectionId` and the API
 * falls back to its default connection (or refuses).
 */
export function resolveConnection(
  list: readonly ConnectionOption[] | undefined,
  wanted: string | null,
): ConnectionOption | undefined {
  if (!list || list.length === 0) return undefined;
  return list.find((c) => c.id === wanted) ?? list[0];
}
