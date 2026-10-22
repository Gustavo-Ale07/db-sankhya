import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApiError } from '../api/client';
import { mergeOutcome, outcomeOf } from './runState';
import type { QueryResult } from '../api/types';
import { MutationStatus, ResultsPanel } from './ResultsPanel';

afterEach(cleanup);

const report = {
  type: 'execution' as const,
  planId: 'p',
  status: 'success' as const,
  verification: 'VERIFIED' as const,
  steps: [{ key: { CODPARC: 1 }, outcome: 'ok' as const, verified: true }],
};

describe('MutationStatus', () => {
  it('before any execute says nothing is written without confirmation', () => {
    render(<MutationStatus />);
    expect(document.body.textContent).toContain('Nada é gravado sem a confirmação');
    expect(screen.queryByTestId('mutation-outcome-unknown')).toBeNull();
  });

  it('keeps a do-not-repeat banner for an unknown outcome and drops the "nothing written" text', () => {
    render(<MutationStatus outcome={{ sent: true, unknown: true, errorCode: 'NETWORK_ERROR' }} />);
    const banner = screen.getByTestId('mutation-outcome-unknown');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('NÃO repita');
    expect(banner.textContent).toContain('[NETWORK_ERROR]');
    expect(document.body.textContent).not.toContain('Nada é gravado');
    expect(document.body.textContent).not.toContain('Nada foi gravado');
  });

  it('shows the banner next to a report with an unknown step', () => {
    render(
      <MutationStatus
        outcome={{
          sent: true,
          unknown: true,
          report: { ...report, status: 'failed', steps: [{ key: {}, outcome: 'unknown' }] },
        }}
      />,
    );
    expect(screen.getByTestId('mutation-outcome-unknown')).toBeTruthy();
    expect(document.body.textContent).toContain('Alteração executada (falhou)');
  });

  it('a confirmed report shows the pt-BR status and verification without a banner', () => {
    render(<MutationStatus outcome={{ sent: true, unknown: false, report }} />);
    expect(document.body.textContent).toContain('Alteração executada (concluída)');
    expect(document.body.textContent).toContain('VERIFIED');
    expect(screen.queryByTestId('mutation-outcome-unknown')).toBeNull();
  });

  it('a definite refusal says nothing was written, with its code', () => {
    render(
      <MutationStatus outcome={{ sent: true, unknown: false, errorCode: 'READ_ONLY_MODE' }} />,
    );
    expect(document.body.textContent).toContain('Execução recusada pelo servidor [READ_ONLY_MODE]');
    expect(document.body.textContent).toContain('Nada foi gravado');
  });

  it.each([
    [429, 'RATE_LIMITED'],
    [400, 'CONFIRMATION_INVALID'],
    [403, 'FORBIDDEN'],
  ])('keeps the banner when NETWORK_ERROR is followed by %s %s', (status, code) => {
    const lost = outcomeOf({ error: new ApiError(0, { code: 'NETWORK_ERROR', message: 'x' }) });
    const later = outcomeOf({ error: new ApiError(status, { code, message: 'x' }) });
    render(<MutationStatus outcome={mergeOutcome(lost, later)} />);
    expect(screen.getByTestId('mutation-outcome-unknown').textContent).toContain('NÃO repita');
    expect(document.body.textContent).not.toContain('Nada foi gravado');
  });

  it('clears the banner when a 5xx is followed by a replayed report', () => {
    const lost = outcomeOf({ error: new ApiError(502, { code: 'HTTP_ERROR', message: 'x' }) });
    render(<MutationStatus outcome={mergeOutcome(lost, outcomeOf({ report }))} />);
    expect(screen.queryByTestId('mutation-outcome-unknown')).toBeNull();
    expect(document.body.textContent).toContain('Alteração executada (concluída)');
  });

  it('offers to reopen a plan still held in memory', () => {
    const onReopen = vi.fn();
    render(
      <MutationStatus
        outcome={{ sent: true, unknown: true, errorCode: 'NETWORK_ERROR' }}
        reopen={{ onReopen }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reabrir prévia' }));
    expect(onReopen).toHaveBeenCalledTimes(1);
  });

  it('blocks the reopen while another connection is selected, and says why', () => {
    const onReopen = vi.fn();
    render(<MutationStatus reopen={{ onReopen, blockedReason: 'outra conexão' }} />);
    const button = screen.getByRole('button', { name: 'Reabrir prévia' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId('mutation-reopen-blocked').textContent).toContain('outra conexão');
  });

  it('has no reopen button without a plan in memory', () => {
    render(<MutationStatus outcome={{ sent: true, unknown: false, report }} />);
    expect(screen.queryByRole('button', { name: 'Reabrir prévia' })).toBeNull();
  });
});

describe('ResultsPanel origin', () => {
  const base: QueryResult = {
    type: 'result',
    executionId: 'e',
    connectionId: 'env',
    kind: 'SELECT',
    resource: null,
    columns: [{ name: 'N', type: 'integer' }],
    rows: [[1]],
    rowCount: 1,
    truncated: false,
    apiCalls: 0,
    durationMs: 5,
    messages: [],
  };
  const show = (result: QueryResult, connectionName?: string) =>
    render(
      <ResultsPanel
        run={{ status: 'result', sql: 'SELECT 1', result }}
        tab="results"
        onTab={() => {}}
        {...(connectionName ? { connectionName } : {})}
      />,
    );

  it('marks a Sankhya read with its connection', () => {
    show({ ...base, source: 'sankhya', apiCalls: 1 }, 'Homologação');
    expect(screen.getByTestId('result-origin').textContent).toBe('Sankhya');
    expect(screen.getByTestId('result-connection').textContent).toContain('Homologação');
    expect(screen.queryByTestId('result-hybrid-parts')).toBeNull();
  });

  it('marks a read of tmp_ tables as temporary, without a Sankhya connection', () => {
    show({ ...base, source: 'scratch' }, 'Homologação');
    expect(screen.getByTestId('result-origin').textContent).toBe('temporária');
    expect(screen.queryByTestId('result-connection')).toBeNull();
  });

  it('lists the Sankhya parts a hybrid read copied, with the cut ones flagged', () => {
    show(
      {
        ...base,
        source: 'hybrid',
        apiCalls: 2,
        hybrid: {
          parts: [
            { tables: ['TGFPAR'], rows: 60, truncated: false },
            { tables: ['TGFPRO', 'TGFGRU'], rows: 2, truncated: true },
          ],
        },
      },
      'Homologação',
    );
    expect(screen.getByTestId('result-origin').textContent).toBe('híbrido');
    expect(screen.getByTestId('result-connection').textContent).toContain('Homologação');
    const parts = screen.getByTestId('result-hybrid-parts').textContent;
    expect(parts).toContain('TGFPAR: 60 linha(s)');
    expect(parts).toContain('TGFPRO, TGFGRU: 2 linha(s) (cortado)');
  });

  it('shows no origin for a result of an older server without source', () => {
    show(base);
    expect(screen.queryByTestId('result-origin')).toBeNull();
  });
});
