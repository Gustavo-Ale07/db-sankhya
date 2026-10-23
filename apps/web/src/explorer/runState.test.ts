import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import {
  PREVIEW_KIND_LABEL,
  confirmationMatches,
  isPreviewPointer,
  isApprovalPending,
  mergeOutcome,
  outcomeOf,
  previewLabelText,
  previewLabelsOf,
  remainingSeconds,
  formatCountdown,
} from './runState';

describe('preview labels', () => {
  it('maps every exact API label to its pt-BR text', () => {
    expect(PREVIEW_KIND_LABEL).toEqual({
      SIMULATED_PREVIEW: 'PRÉVIA SIMULADA',
      IMPACT_ANALYSIS: 'ANÁLISE DE IMPACTO',
      TRANSACTIONAL_DRY_RUN: 'DRY RUN TRANSACIONAL',
      SERVER_EXECUTION: 'EXECUÇÃO DIRETA',
    });
  });

  it('lists the primary label first, then the others, without duplicates', () => {
    expect(
      previewLabelsOf({
        previewKind: 'IMPACT_ANALYSIS',
        previewLabels: ['SIMULATED_PREVIEW', 'IMPACT_ANALYSIS'],
      }),
    ).toEqual(['IMPACT_ANALYSIS', 'SIMULATED_PREVIEW']);
    expect(previewLabelsOf({ previewKind: 'TRANSACTIONAL_DRY_RUN', previewLabels: [] })).toEqual([
      'TRANSACTIONAL_DRY_RUN',
    ]);
  });

  it('keeps a label the client does not know as its raw code', () => {
    const labels = previewLabelsOf({
      previewKind: 'SIMULATED_PREVIEW',
      previewLabels: ['SIMULATED_PREVIEW', 'SOMETHING_NEW' as never],
    });
    expect(labels).toEqual(['SIMULATED_PREVIEW', 'SOMETHING_NEW']);
    expect(labels.map(previewLabelText)).toEqual(['PRÉVIA SIMULADA', 'SOMETHING_NEW']);
  });
});

describe('strong confirmation', () => {
  it('matches only the exact phrase', () => {
    const phrase = 'PRODUCTION UPDATE 1 TGFPAR';
    expect(confirmationMatches(phrase, phrase)).toBe(true);
    expect(confirmationMatches('production update 1 tgfpar', phrase)).toBe(false);
    expect(confirmationMatches(` ${phrase}`, phrase)).toBe(false);
    expect(confirmationMatches('PRODUCTION UPDATE 1', phrase)).toBe(false);
    expect(confirmationMatches('', phrase)).toBe(false);
  });

  it('needs nothing when no phrase is required', () => {
    expect(confirmationMatches('', null)).toBe(true);
  });
});

describe('plan countdown', () => {
  const at = Date.parse('2026-01-01T10:00:00.000Z');
  it('counts whole seconds down to zero, never below', () => {
    expect(remainingSeconds('2026-01-01T10:05:00.000Z', at)).toBe(300);
    expect(remainingSeconds('2026-01-01T10:00:00.500Z', at)).toBe(1);
    expect(remainingSeconds('2026-01-01T09:59:00.000Z', at)).toBe(0);
  });
  it('treats an unreadable expiry as expired', () => {
    expect(remainingSeconds('not a date', at)).toBe(0);
  });
  it('formats as m:ss', () => {
    expect(formatCountdown(300)).toBe('5:00');
    expect(formatCountdown(61)).toBe('1:01');
    expect(formatCountdown(0)).toBe('0:00');
  });
});

describe('server classification', () => {
  it('recognizes the /api/query refusal that points to the preview', () => {
    const pointer = new ApiError(400, {
      code: 'SQL_UNSUPPORTED',
      message: 'Mutations are never executed here.',
      details: { preview: '/api/query/preview' },
    });
    expect(isPreviewPointer(pointer)).toBe(true);
  });
  it('ignores any other refusal', () => {
    expect(
      isPreviewPointer(new ApiError(400, { code: 'SQL_UNSUPPORTED', message: 'Not available.' })),
    ).toBe(false);
    expect(
      isPreviewPointer(
        new ApiError(400, {
          code: 'SQL_FORBIDDEN',
          message: 'x',
          details: { preview: '/api/query/preview' },
        }),
      ),
    ).toBe(false);
    expect(isPreviewPointer(new Error('x'))).toBe(false);
  });
});

describe('execute outcome', () => {
  const report = (outcome: 'ok' | 'unknown' | 'error') => ({
    type: 'execution' as const,
    planId: 'p',
    status: 'failed' as const,
    verification: 'UNVERIFIED' as const,
    steps: [{ key: { A: 1 }, outcome }],
  });
  const err = (status: number, code: string) => new ApiError(status, { code, message: 'x' });

  it('a report is known unless a step outcome is unknown', () => {
    expect(outcomeOf({ report: report('ok') }).unknown).toBe(false);
    expect(outcomeOf({ report: report('error') }).unknown).toBe(false);
    expect(outcomeOf({ report: report('unknown') }).unknown).toBe(true);
  });

  it.each([
    [502, 'WRITE_OUTCOME_UNKNOWN'],
    [0, 'NETWORK_ERROR'],
    [500, 'INTERNAL_ERROR'],
    [504, 'HTTP_ERROR'],
    [409, 'CONFLICT'],
  ])('%s %s is an unknown outcome', (status, code) => {
    expect(outcomeOf({ error: err(status, code) })).toEqual({
      sent: true,
      unknown: true,
      errorCode: code,
    });
  });

  it.each([
    [403, 'READ_ONLY_MODE'],
    [403, 'FORBIDDEN'],
    [409, 'TARGETS_CHANGED'],
    [410, 'CONFIRMATION_EXPIRED'],
    [409, 'CONFIRMATION_USED'],
  ])('%s %s is a definite refusal', (status, code) => {
    expect(outcomeOf({ error: err(status, code) }).unknown).toBe(false);
  });

  it('anything that is not an API answer is unknown', () => {
    expect(outcomeOf({ error: new Error('boom') }).unknown).toBe(true);
  });

  it('recognizes the pending-approval refusal', () => {
    expect(
      isApprovalPending(
        new ApiError(403, {
          code: 'FORBIDDEN',
          message: 'x',
          details: { reason: 'approval_pending' },
        }),
      ),
    ).toBe(true);
    expect(isApprovalPending(err(403, 'FORBIDDEN'))).toBe(false);
  });
});

describe('outcome across retries of one plan', () => {
  const err = (status: number, code: string) =>
    outcomeOf({ error: new ApiError(status, { code, message: 'x' }) });
  const lost = err(0, 'NETWORK_ERROR');

  it.each([
    [429, 'RATE_LIMITED'],
    [400, 'CONFIRMATION_INVALID'],
    [403, 'FORBIDDEN'],
  ])('stays unknown when NETWORK_ERROR is followed by %s %s', (status, code) => {
    expect(mergeOutcome(lost, err(status, code))).toEqual({
      sent: true,
      unknown: true,
      errorCode: 'NETWORK_ERROR',
    });
  });

  it('is cleared by a replayed report', () => {
    const report = {
      type: 'execution' as const,
      planId: 'p',
      status: 'success' as const,
      verification: 'VERIFIED' as const,
      steps: [{ key: { A: 1 }, outcome: 'ok' as const }],
    };
    const merged = mergeOutcome(err(502, 'HTTP_ERROR'), outcomeOf({ report }));
    expect(merged).toEqual({ sent: true, unknown: false, report });
  });

  it('a known answer after a known one is just the latest', () => {
    expect(mergeOutcome(err(403, 'READ_ONLY_MODE'), err(403, 'FORBIDDEN')).errorCode).toBe(
      'FORBIDDEN',
    );
  });
});
