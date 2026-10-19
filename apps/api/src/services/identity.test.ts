import { describe, expect, it, vi } from 'vitest';
import type { UserRow } from '@dbx/database';
import * as crypto from '../security/crypto';
import { hashPassword } from '../security/crypto';
import { checkLocalPassword, createLocalProvider } from './identity';

vi.mock('../security/crypto', async (orig) => {
  const actual = await orig<typeof crypto>();
  return { ...actual, verifyDummy: vi.fn(actual.verifyDummy) };
});

describe('checkLocalPassword', () => {
  it('burns a dummy verification for non-local accounts (no timing side channel)', async () => {
    const passwordHash = await hashPassword('Correct-Horse-9!');
    const user = { id: 'u3', passwordHash, identityProvider: 'oidc' } as UserRow;
    vi.mocked(crypto.verifyDummy).mockClear();
    expect(await checkLocalPassword(user, 'Correct-Horse-9!')).toBe(false);
    expect(crypto.verifyDummy).toHaveBeenCalledWith('Correct-Horse-9!');
    vi.mocked(crypto.verifyDummy).mockClear();
    const local = { ...user, identityProvider: 'local' } as UserRow;
    expect(await checkLocalPassword(local, 'Correct-Horse-9!')).toBe(true);
    expect(crypto.verifyDummy).not.toHaveBeenCalled();
  });
});

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
