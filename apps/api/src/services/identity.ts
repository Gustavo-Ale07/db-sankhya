import type { UserRow } from '@dbx/database';
import { verifyPassword } from '../security/crypto';
import type { UsersService } from './users';

/**
 * Extension point for external identity providers (for example OIDC). A provider turns
 * provider-specific input into a verified external identity, or null when authentication fails.
 * Mapping that identity to a local account, sessions, lockout and audit stay in the login route.
 */
export interface IdentityProvider {
  id: 'local' | (string & {});
  authenticate(input: unknown): Promise<{ externalId: string; email: string } | null>;
}

export interface LocalCredentials {
  email: string;
  password: string;
}

function isLocalCredentials(input: unknown): input is LocalCredentials {
  const i = input as Partial<LocalCredentials> | null;
  return typeof i?.email === 'string' && typeof i.password === 'string';
}

/** The existing password check (Argon2id). Only accounts owned by the local provider qualify. */
export function checkLocalPassword(user: UserRow, password: string): Promise<boolean> {
  if (user.identityProvider !== 'local') return Promise.resolve(false);
  return verifyPassword(user.passwordHash, password);
}

/** Wraps the existing e-mail + password path; externalId is the local user id. */
export function createLocalProvider(users: Pick<UsersService, 'findByEmail'>): IdentityProvider {
  return {
    id: 'local',
    async authenticate(input) {
      if (!isLocalCredentials(input)) return null;
      const user = await users.findByEmail(input.email);
      if (!user || !(await checkLocalPassword(user, input.password))) return null;
      return { externalId: user.id, email: user.email };
    },
  };
}
