import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import {
  PREVIEW_KIND_LABEL,
  confirmationMatches,
  isPreviewPointer,
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

  it('drops a label the client does not know instead of inventing a text', () => {
    expect(
      previewLabelsOf({
        previewKind: 'SIMULATED_PREVIEW',
        previewLabels: ['SIMULATED_PREVIEW', 'SOMETHING_NEW' as never],
      }),
    ).toEqual(['SIMULATED_PREVIEW']);
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
