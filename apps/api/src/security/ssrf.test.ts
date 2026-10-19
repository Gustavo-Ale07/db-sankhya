import { describe, expect, it } from 'vitest';
import { isAppError } from '@dbx/shared';
import { assertSafeGatewayUrl, isBlockedAddress } from './ssrf';

const allowHosts = ['api.sankhya.com.br', 'api.sandbox.sankhya.com.br'];
const resolvingTo =
  (...addresses: string[]) =>
  () =>
    Promise.resolve(addresses);

async function expectRejected(url: string, resolve = resolvingTo('203.0.113.10')) {
  const err = await assertSafeGatewayUrl(url, { allowHosts, resolve }).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isAppError(err) && err.code, url).toBe('VALIDATION_ERROR');
}

describe('assertSafeGatewayUrl', () => {
  it('rejects unsafe URLs', async () => {
    await expectRejected('http://api.sankhya.com.br');
    await expectRejected('https://user:pw@api.sankhya.com.br');
    await expectRejected('https://api.sankhya.com.br:8443');
    await expectRejected('https://evil.example');
    await expectRejected('not a url');
  });

  it('rejects an allowed host that resolves to a private or local address', async () => {
    const unsafe = [
      '127.0.0.1',
      '10.0.0.5',
      '169.254.169.254',
      '::1',
      '192.168.1.1',
      '172.16.0.1',
      '100.64.0.1',
      '0.0.0.0',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ];
    for (const address of unsafe) {
      await expectRejected('https://api.sankhya.com.br', resolvingTo(address));
    }
    await expectRejected('https://api.sankhya.com.br', resolvingTo('203.0.113.10', '10.0.0.1'));
    await expectRejected('https://api.sankhya.com.br', resolvingTo());
    await expectRejected('https://api.sankhya.com.br', () =>
      Promise.reject(new Error('ENOTFOUND')),
    );
  });

  it('accepts an allowed host resolving to a public address', async () => {
    const url = await assertSafeGatewayUrl('https://API.Sankhya.com.br:443', {
      allowHosts,
      resolve: resolvingTo('203.0.113.10'),
    });
    expect(url.hostname).toBe('api.sankhya.com.br');
  });
});

describe('isBlockedAddress', () => {
  it('blocks anything that is not an IP address', () => {
    expect(isBlockedAddress('nonsense')).toBe(true);
    expect(isBlockedAddress('203.0.113.10')).toBe(false);
  });
});
