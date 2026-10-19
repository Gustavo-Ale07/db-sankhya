import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './secretbox';

const key = randomBytes(32);

function flip(part: string) {
  const bytes = Buffer.from(part, 'base64url');
  bytes[0] = bytes[0]! ^ 1;
  return bytes.toString('base64url');
}

describe('secret box', () => {
  it('round-trips and uses the documented format', () => {
    const sealed = encryptSecret(key, 'fictitious-secret', 'conn-1:clientSecret');
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain('fictitious');
    expect(decryptSecret(key, sealed, 'conn-1:clientSecret')).toBe('fictitious-secret');
  });

  it('two encryptions of the same plaintext differ', () => {
    expect(encryptSecret(key, 'x', 'a')).not.toBe(encryptSecret(key, 'x', 'a'));
  });

  it('a tampered tag or ciphertext throws', () => {
    const [v, iv, tag, ct] = encryptSecret(key, 'value', 'a').split('.') as [
      string,
      string,
      string,
      string,
    ];
    expect(() => decryptSecret(key, [v, iv, flip(tag), ct].join('.'), 'a')).toThrow();
    expect(() => decryptSecret(key, [v, iv, tag, flip(ct)].join('.'), 'a')).toThrow();
  });

  it('a wrong AAD or key throws', () => {
    const sealed = encryptSecret(key, 'value', 'conn-1:xToken');
    expect(() => decryptSecret(key, sealed, 'conn-2:xToken')).toThrow();
    expect(() => decryptSecret(randomBytes(32), sealed, 'conn-1:xToken')).toThrow();
  });

  it('refuses keys that are not 32 bytes and unknown formats', () => {
    expect(() => encryptSecret(randomBytes(16), 'x', 'a')).toThrow(/32 bytes/);
    expect(() => decryptSecret(key, 'v2.a.b.c', 'a')).toThrow();
  });
});
