import { describe, expect, it } from 'vitest';
import { classifyGateway } from './classify';

const envelope = (status: string, statusMessage?: string) => ({
  serviceName: 'X.y',
  status,
  ...(statusMessage === undefined ? {} : { statusMessage }),
  responseBody: { a: 1 },
});

describe('classifyGateway', () => {
  it('status "1" is ok and keeps the envelope', () => {
    const c = classifyGateway(200, { ...envelope('1'), transactionId: 'T1' });
    expect(c).toEqual({
      ok: true,
      envelope: { status: '1', transactionId: 'T1', responseBody: { a: 1 } },
    });
  });

  it('status "0" on HTTP 200 is a non-retryable business error', () => {
    const c = classifyGateway(200, envelope('0', '[CORE_E01234] x'));
    expect(c).toMatchObject({ ok: false, code: 'SANKHYA_API_ERROR', retryable: false });
    expect(c.ok || c.message).toContain('[CORE_E01234] x');
  });

  it('an unknown status is not treated as success', () => {
    expect(classifyGateway(200, envelope('2', 'aviso'))).toMatchObject({
      ok: false,
      code: 'SANKHYA_API_ERROR',
      ambiguous: true,
    });
  });

  it('GTW3403 on HTTP 403 asks for re-authentication', () => {
    const c = classifyGateway(403, { error: { code: 'GTW3403', message: 'token expirado' } });
    expect(c).toMatchObject({ ok: false, code: 'SANKHYA_AUTH_ERROR', reauth: true });
  });

  it('HTTP 401 asks for re-authentication', () => {
    expect(classifyGateway(401, undefined)).toMatchObject({ ok: false, reauth: true });
  });

  it('"Não autorizado" in the message asks for re-authentication, accented or not', () => {
    for (const msg of ['Não autorizado.', 'Nao autorizado', 'NÃO AUTORIZADO']) {
      expect(classifyGateway(200, envelope('0', msg))).toMatchObject({
        ok: false,
        code: 'SANKHYA_AUTH_ERROR',
        reauth: true,
      });
    }
  });

  it('HTTP 429 is retryable rate limiting', () => {
    expect(classifyGateway(429, undefined)).toMatchObject({
      ok: false,
      code: 'SANKHYA_RATE_LIMITED',
      retryable: true,
    });
  });

  it('HTTP 504 is a retryable timeout; 502/503 are retryable unavailability', () => {
    expect(classifyGateway(504, undefined)).toMatchObject({
      code: 'SANKHYA_TIMEOUT',
      retryable: true,
    });
    for (const status of [500, 502, 503]) {
      expect(classifyGateway(status, undefined)).toMatchObject({
        code: 'SANKHYA_UNAVAILABLE',
        retryable: true,
      });
    }
  });

  it('a non-JSON or shapeless body is a bad response', () => {
    expect(classifyGateway(200, undefined)).toMatchObject({ code: 'SANKHYA_BAD_RESPONSE' });
    expect(classifyGateway(200, { hello: 'world' })).toMatchObject({
      code: 'SANKHYA_BAD_RESPONSE',
    });
    expect(classifyGateway(200, [1, 2])).toMatchObject({ code: 'SANKHYA_BAD_RESPONSE' });
  });

  it('other 4xx are non-retryable API errors', () => {
    expect(classifyGateway(404, undefined)).toMatchObject({
      code: 'SANKHYA_API_ERROR',
      retryable: false,
      reauth: false,
    });
  });

  it('redacts the message', () => {
    const c = classifyGateway(
      200,
      envelope('0', 'falhou com Bearer eyJabc.def.ghi e client_secret=abc'),
    );
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.message).not.toContain('eyJabc');
      expect(c.message.length).toBeLessThanOrEqual(1000);
    }
  });

  it('bounds very long messages', () => {
    const c = classifyGateway(200, envelope('0', 'x'.repeat(10_000)));
    expect(!c.ok && c.message.length).toBeLessThanOrEqual(1000);
  });
});
