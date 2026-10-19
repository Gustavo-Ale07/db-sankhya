import { describe, expect, it } from 'vitest';
import type { UserRow } from '@dbx/database';
import { hashPassword } from '../security/crypto';
import { createLocalProvider } from './identity';

describe('local identity provider', () => {
  it('local provider authenticates via existing path', async () => {
    const passwordHash = await hashPassword('Correct-Horse-9!');
    const user = { id: 'u1', email: 'a@b.co', passwordHash, identityProvider: 'local' } as UserRow;
    const provider = createLocalProvider({
      findByEmail: async (e) => (e === user.email ? user : undefined),
    });
    expect(provider.id).toBe('local');
    expect(await provider.authenticate({ email: 'a@b.co', password: 'Correct-Horse-9!' })).toEqual({
      externalId: 'u1',
      email: 'a@b.co',
    });
    expect(await provider.authenticate({ email: 'a@b.co', password: 'wrong' })).toBeNull();
    expect(
      await provider.authenticate({ email: 'x@b.co', password: 'Correct-Horse-9!' }),
    ).toBeNull();
    expect(await provider.authenticate({ nope: 1 })).toBeNull();
  });

  it('refuses password login for accounts owned by another provider', async () => {
    const passwordHash = await hashPassword('Correct-Horse-9!');
    const user = { id: 'u2', email: 'o@b.co', passwordHash, identityProvider: 'oidc' } as UserRow;
    const provider = createLocalProvider({ findByEmail: async () => user });
    expect(
      await provider.authenticate({ email: 'o@b.co', password: 'Correct-Horse-9!' }),
    ).toBeNull();
  });
});
