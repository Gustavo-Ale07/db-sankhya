import { describe, expect, it } from 'vitest';
import { AppError, ERROR_HTTP_STATUS, isAppError, toErrorPayload } from './errors';

describe('AppError', () => {
  it('carries code, message, details and http status', () => {
    const err = new AppError('WHERE_REQUIRED', 'UPDATE requires WHERE', { statement: 'UPDATE' });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('WHERE_REQUIRED');
    expect(err.status).toBe(400);
    expect(err.details).toEqual({ statement: 'UPDATE' });
    expect(isAppError(err)).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
  });

  it('maps every code to an http status', () => {
    expect(ERROR_HTTP_STATUS.AUTH_REQUIRED).toBe(401);
    expect(ERROR_HTTP_STATUS.FORBIDDEN).toBe(403);
    expect(ERROR_HTTP_STATUS.RESOURCE_NOT_FOUND).toBe(400);
    expect(ERROR_HTTP_STATUS.SANKHYA_RATE_LIMITED).toBe(429);
    expect(ERROR_HTTP_STATUS.SANKHYA_UNAVAILABLE).toBe(503);
    expect(ERROR_HTTP_STATUS.QUERY_TIMEOUT).toBe(504);
    for (const status of Object.values(ERROR_HTTP_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(400);
    }
  });

  it('serializes to a stable payload', () => {
    const p = toErrorPayload(new AppError('READ_ONLY_MODE', 'blocked'), 'req-1');
    expect(p).toEqual({
      error: { code: 'READ_ONLY_MODE', message: 'blocked', requestId: 'req-1' },
    });
  });

  it('hides internal error messages behind INTERNAL_ERROR', () => {
    const p = toErrorPayload(new Error('db password is hunter2'), 'req-2');
    expect(p.error.code).toBe('INTERNAL_ERROR');
    expect(p.error.message).not.toContain('hunter2');
  });
});
