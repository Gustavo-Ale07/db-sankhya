import { createContext, useContext } from 'react';
import type { Meta, Permission, User } from '../api/types';

export interface SessionContextValue {
  user: User;
  meta: Meta | undefined;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionContext');
  return ctx;
}

interface HasPermissions {
  permissions: readonly Permission[];
}

/** UI gating only: the API enforces every permission again on each request. */
export const can = (who: HasPermissions, permission: Permission) =>
  who.permissions.includes(permission);

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Administrador',
  OPERATOR: 'Operador',
  VIEWER: 'Leitor',
};
/** Label of a role key; custom roles show their key. */
export const roleLabel = (key: string) => ROLE_LABEL[key] ?? key;
export const rolesLabel = (keys: readonly string[]) =>
  keys.length > 0 ? keys.map(roleLabel).join(', ') : 'Sem papel';
