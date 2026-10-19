import { redact, type ErrorCode } from '@dbx/shared';
import type { GatewayEnvelope } from './types';

export type GatewayClassification =
  | { ok: true; envelope: GatewayEnvelope }
  | {
      ok: false;
      code: ErrorCode;
      /** Transient: the same request may succeed later. */
      retryable: boolean;
      /** The token was rejected: invalidate it and try once more. */
      reauth: boolean;
      /** The gateway answered with a status that is neither success nor error. */
      ambiguous?: boolean;
      message: string;
    };

const MAX_MESSAGE_CHARS = 1000;
const NOT_AUTHORIZED = /n[aã]o autorizado/i;
const GATEWAY_AUTH_CODES = /\bGTW3\d{3}\b/;

/**
 * Maps one gateway HTTP response to success or a typed failure. Only status "1" is success:
 * anything the classifier does not recognise is reported as a failure, never assumed to work.
 */
export function classifyGateway(httpStatus: number, body: unknown): GatewayClassification {
  const raw = messageOf(body);
  const message = clean(raw);

  if (httpStatus === 401 || (httpStatus === 403 && GATEWAY_AUTH_CODES.test(raw))) {
    return fail('SANKHYA_AUTH_ERROR', false, true, message || `Gateway HTTP ${httpStatus}`);
  }
  if (httpStatus === 429)
    return fail('SANKHYA_RATE_LIMITED', true, false, message || 'Rate limited');
  if (httpStatus === 504 || httpStatus === 408)
    return fail('SANKHYA_TIMEOUT', true, false, message || `Gateway HTTP ${httpStatus}`);
  if (httpStatus >= 500)
    return fail('SANKHYA_UNAVAILABLE', true, false, message || `Gateway HTTP ${httpStatus}`);
  if (httpStatus === 403) return fail('SANKHYA_AUTH_ERROR', false, false, message || 'Forbidden');
  if (httpStatus < 200 || httpStatus >= 300)
    return fail('SANKHYA_API_ERROR', false, false, message || `Gateway HTTP ${httpStatus}`);

  if (!isRecord(body) || typeof body.status !== 'string') {
    return fail('SANKHYA_BAD_RESPONSE', false, false, 'The gateway answered without an envelope.');
  }
  if (body.status === '1') {
    const envelope: GatewayEnvelope = { status: '1' };
    if (typeof body.statusMessage === 'string') envelope.statusMessage = body.statusMessage;
    if (typeof body.transactionId === 'string') envelope.transactionId = body.transactionId;
    if ('responseBody' in body) envelope.responseBody = body.responseBody;
    return { ok: true, envelope };
  }
  if (NOT_AUTHORIZED.test(raw)) {
    return fail('SANKHYA_AUTH_ERROR', false, true, message);
  }
  const result = fail('SANKHYA_API_ERROR', false, false, message || 'The service failed.');
  if (body.status !== '0') return { ...result, ambiguous: true };
  return result;
}

function fail(code: ErrorCode, retryable: boolean, reauth: boolean, message: string) {
  return { ok: false as const, code, retryable, reauth, message };
}

function messageOf(body: unknown): string {
  if (!isRecord(body)) return '';
  if (typeof body.statusMessage === 'string') return body.statusMessage;
  const error = body.error;
  if (isRecord(error)) {
    return [error.code, error.message].filter((v) => typeof v === 'string').join(' ');
  }
  if (typeof error === 'string') return error;
  if (typeof body.message === 'string') return body.message;
  return '';
}

function clean(message: string): string {
  const redacted = redact(message);
  const text = (typeof redacted === 'string' ? redacted : '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
