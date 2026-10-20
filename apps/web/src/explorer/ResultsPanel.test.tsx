import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MutationStatus } from './ResultsPanel';

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
});
