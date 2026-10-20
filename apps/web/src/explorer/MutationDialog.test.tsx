import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError } from '../api/client';
import { executePlan, requestApproval } from '../api/mutations';
import type { ExecutionReport, MutationPreview } from '../api/mutations';
import { MutationDialog } from './MutationDialog';

vi.mock('../api/mutations', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  executePlan: vi.fn(),
  requestApproval: vi.fn(),
}));

const NOW = Date.parse('2026-01-01T10:00:00.000Z');
const PHRASE = 'PRODUCTION UPDATE 1 TGFPAR';

function preview(over: Partial<MutationPreview> = {}): MutationPreview {
  return {
    type: 'preview',
    planId: '00000000-0000-4000-8000-000000000001',
    token: 'plan-token-secret',
    expiresAt: new Date(NOW + 300_000).toISOString(),
    capability: { class: 'SUPPORTED', route: 'SANKHYA_SAVE', reason: 'Native entity' },
    previewKind: 'IMPACT_ANALYSIS',
    previewLabels: ['IMPACT_ANALYSIS', 'SIMULATED_PREVIEW'],
    preview: {
      affected: 1,
      targets: [
        {
          key: { CODPARC: 1 },
          before: { CODPARC: 1, NOMEPARC: 'Antigo' },
          after: { CODPARC: 1, NOMEPARC: 'Novo' },
        },
      ],
    },
    impact: { entities: ['TGFPAR'], rows: 1, environment: 'PRODUCTION' },
    requires: { strongConfirmation: PHRASE, approval: false },
    execution: { available: true, safeMode: false, globalWriteEnabled: true, writeToSankhya: true },
    ...over,
  };
}

const report = (over: Partial<ExecutionReport> = {}): ExecutionReport => ({
  type: 'execution',
  planId: '00000000-0000-4000-8000-000000000001',
  status: 'success',
  verification: 'VERIFIED',
  steps: [{ key: { CODPARC: 1 }, outcome: 'ok', verified: true }],
  ...over,
});

const execButton = () => screen.getByTestId('mutation-execute') as HTMLButtonElement;
const type = (text: string) =>
  fireEvent.change(screen.getByTestId('confirmation-input'), { target: { value: text } });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('MutationDialog', () => {
  it('is a labelled dialog showing capability, exact labels, impact and the diff', () => {
    render(<MutationDialog preview={preview()} sql="UPDATE …" onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Prévia da alteração' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByTestId('capability-badge').textContent).toBe('SUPPORTED');
    expect(screen.getAllByTestId('preview-label').map((e) => e.textContent)).toEqual([
      'ANÁLISE DE IMPACTO',
      'PRÉVIA SIMULADA',
    ]);
    expect(screen.getByTestId('impact-environment').textContent).toBe('PRODUCTION');
    expect(screen.getByTestId('impact-rows').textContent).toBe('1');
    expect(screen.getByTestId('mutation-impact').textContent).toContain('TGFPAR');
    expect(screen.getByTestId('plan-countdown').textContent).toBe('5:00');
    const diff = screen.getByTestId('mutation-diff').textContent;
    expect(diff).toContain('NOMEPARC');
    expect(diff).toContain('Antigo');
    expect(diff).toContain('Novo');
    // The plan token is never rendered.
    expect(document.body.textContent).not.toContain('plan-token-secret');
  });

  it('shows the scratch dry-run label', () => {
    render(
      <MutationDialog
        preview={preview({
          previewKind: 'TRANSACTIONAL_DRY_RUN',
          previewLabels: ['TRANSACTIONAL_DRY_RUN'],
          requires: { strongConfirmation: null, approval: false },
        })}
        sql="UPDATE tmp_x SET a = 1 WHERE id = 1"
        onClose={() => {}}
      />,
    );
    expect(screen.getAllByTestId('preview-label').map((e) => e.textContent)).toEqual([
      'DRY RUN TRANSACIONAL',
    ]);
  });

  it('keeps execute disabled until the typed confirmation matches exactly', () => {
    render(<MutationDialog preview={preview()} sql="x" onClose={() => {}} />);
    expect(screen.getByTestId('confirmation-phrase').textContent).toBe(PHRASE);
    expect(execButton().disabled).toBe(true);
    type(PHRASE.toLowerCase());
    expect(execButton().disabled).toBe(true);
    type(`${PHRASE} `);
    expect(execButton().disabled).toBe(true);
    type(PHRASE);
    expect(execButton().disabled).toBe(false);
  });

  it('disables execute when the plan countdown expires', () => {
    render(
      <MutationDialog
        preview={preview({
          expiresAt: new Date(NOW + 2_000).toISOString(),
          requires: { strongConfirmation: null, approval: false },
        })}
        sql="x"
        onClose={() => {}}
      />,
    );
    expect(execButton().disabled).toBe(false);
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByTestId('plan-countdown').textContent).toContain('expirado');
    expect(execButton().disabled).toBe(true);
  });

  it('never calls execute on open; only the explicit click does, with the typed phrase', async () => {
    vi.mocked(executePlan).mockResolvedValue(report());
    const onExecuted = vi.fn();
    render(
      <MutationDialog
        preview={preview()}
        sql="x"
        onClose={() => {}}
        onExecuted={onExecuted}
        newKey={() => 'key-1'}
      />,
    );
    expect(executePlan).not.toHaveBeenCalled();
    type(PHRASE);
    fireEvent.click(execButton());
    await waitFor(() => expect(onExecuted).toHaveBeenCalled());
    expect(executePlan).toHaveBeenCalledWith({
      planId: '00000000-0000-4000-8000-000000000001',
      token: 'plan-token-secret',
      idempotencyKey: 'key-1',
      strongConfirmation: PHRASE,
    });
  });

  it('reuses the idempotency key on a retry click and ignores clicks while in flight', async () => {
    let fail!: (e: unknown) => void;
    vi.mocked(executePlan)
      .mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
      .mockResolvedValueOnce(report());
    const keys = vi.fn().mockReturnValueOnce('key-A').mockReturnValueOnce('key-B');
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: false } })}
        sql="x"
        onClose={() => {}}
        newKey={keys}
      />,
    );
    fireEvent.click(execButton());
    fireEvent.click(execButton());
    expect(executePlan).toHaveBeenCalledTimes(1);
    expect(execButton().disabled).toBe(true);
    await act(async () => fail(new ApiError(0, { code: 'NETWORK_ERROR', message: 'x' })));
    expect(screen.getByTestId('mutation-error').textContent).toContain('NETWORK_ERROR');
    expect(execButton().disabled).toBe(false);
    fireEvent.click(execButton());
    await screen.findByTestId('execution-report');
    expect(executePlan).toHaveBeenCalledTimes(2);
    const used = vi.mocked(executePlan).mock.calls.map((c) => c[0].idempotencyKey);
    expect(used).toEqual(['key-A', 'key-A']);
    expect(keys).toHaveBeenCalledTimes(1);
  });

  it('renders the execution report with the verification status and per-step outcomes', async () => {
    vi.mocked(executePlan).mockResolvedValue(
      report({
        status: 'partial',
        verification: 'PARTIALLY_VERIFIED',
        steps: [
          { key: { CODPARC: 1 }, outcome: 'ok', verified: true },
          { key: { CODPARC: 2 }, outcome: 'error', errorCode: 'SANKHYA_API_ERROR' },
          { key: { CODPARC: 3 }, outcome: 'not_attempted' },
        ],
      }),
    );
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: false } })}
        sql="x"
        onClose={() => {}}
      />,
    );
    fireEvent.click(execButton());
    await screen.findByTestId('execution-report');
    expect(screen.getByTestId('verification-status').textContent).toBe('PARTIALLY_VERIFIED');
    const steps = screen.getAllByTestId('execution-step').map((r) => r.textContent);
    expect(steps[0]).toContain('CODPARC=1');
    expect(steps[0]).toContain('gravado');
    expect(steps[0]).toContain('sim');
    expect(steps[1]).toContain('SANKHYA_API_ERROR');
    expect(steps[2]).toContain('não tentado');
    expect(screen.queryByTestId('mutation-execute')).toBeNull();
  });

  it('warns not to repeat on WRITE_OUTCOME_UNKNOWN and blocks another execute', async () => {
    vi.mocked(executePlan).mockRejectedValue(
      new ApiError(502, { code: 'WRITE_OUTCOME_UNKNOWN', message: 'do not repeat' }),
    );
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: false } })}
        sql="x"
        onClose={() => {}}
      />,
    );
    fireEvent.click(execButton());
    expect((await screen.findByTestId('outcome-unknown')).textContent).toContain('NÃO repita');
    expect(execButton().disabled).toBe(true);
  });

  it('shows a step with an unknown outcome in the report as do-not-repeat', async () => {
    vi.mocked(executePlan).mockResolvedValue(
      report({
        status: 'failed',
        verification: 'UNVERIFIED',
        steps: [{ key: { CODPARC: 1 }, outcome: 'unknown', errorCode: 'WRITE_OUTCOME_UNKNOWN' }],
      }),
    );
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: false } })}
        sql="x"
        onClose={() => {}}
      />,
    );
    fireEvent.click(execButton());
    await screen.findByTestId('execution-report');
    expect(screen.getByTestId('outcome-unknown')).toBeTruthy();
    expect(screen.getByTestId('verification-status').textContent).toBe('UNVERIFIED');
  });

  it.each([
    ['READ_ONLY_MODE', 'somente leitura'],
    ['FORBIDDEN', 'permissão'],
    ['TARGETS_CHANGED', 'mudaram'],
    ['CONFIRMATION_EXPIRED', 'expirou'],
  ])('shows the %s refusal in pt-BR with its code', async (code, text) => {
    vi.mocked(executePlan).mockRejectedValue(new ApiError(400, { code, message: 'x' }));
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: false } })}
        sql="x"
        onClose={() => {}}
      />,
    );
    fireEvent.click(execButton());
    const alert = await screen.findByTestId('mutation-error');
    expect(alert.textContent).toContain(`[${code}]`);
    expect(alert.textContent).toContain(text);
  });

  it('offers "Solicitar aprovação" when approval is required', async () => {
    vi.mocked(requestApproval).mockResolvedValue({ approval: { id: 'a1', expiresAt: 'x' } });
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: true } })}
        sql="x"
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('approval-required').textContent).toContain('exige aprovação');
    fireEvent.click(screen.getByRole('button', { name: 'Solicitar aprovação' }));
    expect(await screen.findByTestId('approval-requested')).toBeTruthy();
    expect(requestApproval).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
    expect(executePlan).not.toHaveBeenCalled();
  });

  it('closes on Escape when idle, but not while a write is in flight', async () => {
    const onClose = vi.fn();
    let finish!: (r: ExecutionReport) => void;
    vi.mocked(executePlan).mockImplementation(() => new Promise((r) => (finish = r)));
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: false } })}
        sql="x"
        onClose={onClose}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.click(execButton());
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish(report()));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
