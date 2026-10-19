import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, underTest, verifyPassword } from './crypto';

afterEach(() => vi.unstubAllEnvs());

describe('password hashing cost', () => {
  it('uses the cheap parameters only under the test runner', async () => {
    expect(underTest()).toBe(true);
    const cheap = await hashPassword('Str0ng!Passw0rd#x');
    expect(cheap).toContain('m=8,t=1');
    expect(await verifyPassword(cheap, 'Str0ng!Passw0rd#x')).toBe(true);
  });

  it('uses production parameters when APP_ENV=production, even under NODE_ENV=test', async () => {
    vi.stubEnv('APP_ENV', 'production');
    expect(underTest()).toBe(false);
    expect(await hashPassword('Str0ng!Passw0rd#x')).toContain('m=19456,t=2');
  });
});
