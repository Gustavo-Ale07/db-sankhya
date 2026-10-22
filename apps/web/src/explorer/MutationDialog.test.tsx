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
    expect(screen.getByTestId('impact-rows').textContent).toBe('1 registro será alterado');
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
    expect(screen.getByTestId('plan-countdown').parentElement!.textContent).toMatch(
      /^Plano expirado/,
    );
    expect(execButton().disabled).toBe(true);
  });

  it('never calls execute on open; only the explicit click does, with the typed phrase', async () => {
    vi.mocked(executePlan).mockResolvedValue(report());
    const onOutcome = vi.fn();
    render(
      <MutationDialog
        preview={preview()}
        sql="x"
        onClose={() => {}}
        onOutcome={onOutcome}
        newKey={() => 'key-1'}
      />,
    );
    expect(executePlan).not.toHaveBeenCalled();
    type(PHRASE);
    fireEvent.click(execButton());
    await waitFor(() =>
      expect(onOutcome).toHaveBeenCalledWith({ sent: true, unknown: false, report: report() }),
    );
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
    // A lost answer is an unknown outcome: warn, and only offer the same-key replay.
    expect(screen.getByTestId('outcome-unknown').textContent).toContain('mesma chave');
    expect(execButton().disabled).toBe(false);
    expect(execButton().textContent).toBe('Consultar resultado');
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
    expect(screen.getByTestId('plan-countdown').parentElement!.textContent).toBe('Plano utilizado');
    const steps = screen.getAllByTestId('execution-step').map((r) => r.textContent);
    expect(steps[0]).toContain('CODPARC = 1');
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
    const onOutcome = vi.fn();
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: false } })}
        sql="x"
        onClose={() => {}}
        onOutcome={onOutcome}
      />,
    );
    fireEvent.click(execButton());
    const warning = await screen.findByTestId('outcome-unknown');
    expect(warning.textContent).toContain('RESULTADO DESCONHECIDO');
    expect(warning.textContent).toContain(
      'A alteração pode ter sido executada. Não repita a operação antes de conferir o registro.',
    );
    expect(execButton().disabled).toBe(true);
    expect(onOutcome).toHaveBeenCalledWith({
      sent: true,
      unknown: true,
      errorCode: 'WRITE_OUTCOME_UNKNOWN',
    });
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

  it('reports a definite refusal as a known outcome', async () => {
    vi.mocked(executePlan).mockRejectedValue(
      new ApiError(403, { code: 'READ_ONLY_MODE', message: 'x' }),
    );
    const onOutcome = vi.fn();
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: false } })}
        sql="x"
        onClose={() => {}}
        onOutcome={onOutcome}
      />,
    );
    fireEvent.click(execButton());
    await screen.findByTestId('mutation-error');
    expect(onOutcome).toHaveBeenCalledWith({
      sent: true,
      unknown: false,
      errorCode: 'READ_ONLY_MODE',
    });
    expect(screen.queryByTestId('outcome-unknown')).toBeNull();
  });

  it('shows "aguardando aprovação" instead of a permission refusal while approval is pending', async () => {
    vi.mocked(executePlan).mockRejectedValue(
      new ApiError(403, {
        code: 'FORBIDDEN',
        message: 'x',
        details: { reason: 'approval_pending' },
      }),
    );
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: true } })}
        sql="x"
        onClose={() => {}}
      />,
    );
    fireEvent.click(execButton());
    const pending = await screen.findByTestId('approval-pending');
    expect(pending.textContent).toContain('Aguardando aprovação');
    expect(pending.textContent).toContain('[FORBIDDEN]');
    expect(screen.queryByTestId('mutation-error')).toBeNull();
    // The plan was not consumed: executing again after the approval stays possible.
    expect(execButton().disabled).toBe(false);
  });

  it('shows a deleted row as removed, not as NULL values', () => {
    render(
      <MutationDialog
        preview={preview({
          preview: {
            affected: 1,
            targets: [
              { key: { CODPARC: 1 }, before: { CODPARC: 1, NOMEPARC: 'Antigo' }, after: {} },
            ],
          },
        })}
        sql="x"
        onClose={() => {}}
      />,
    );
    const diff = screen.getByTestId('mutation-diff').textContent ?? '';
    expect(diff).toContain('Antigo');
    expect(diff).toContain('REGISTRO SERÁ REMOVIDO');
    expect(diff).not.toContain('∅');
    expect(diff).not.toContain('NULL');
  });

  it('shows an unknown preview label as its raw code', () => {
    render(
      <MutationDialog
        preview={preview({ previewLabels: ['IMPACT_ANALYSIS', 'NEW_KIND' as never] })}
        sql="x"
        onClose={() => {}}
      />,
    );
    const labels = screen.getAllByTestId('preview-label').map((l) => l.textContent);
    expect(labels).toEqual(['ANÁLISE DE IMPACTO', 'NEW_KIND']);
  });

  it.each([
    ['READ_ONLY_MODE', 'somente leitura'],
    ['FORBIDDEN', 'permissão'],
    [
      'TARGETS_CHANGED',
      'Os dados mudaram desde a prévia. Gere uma nova prévia antes de continuar.',
    ],
    ['CONFIRMATION_EXPIRED', 'Execute novamente para gerar uma nova prévia'],
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
    const ask = screen.getByRole('button', { name: 'Solicitar aprovação' });
    // Two clicks in the same tick send one request.
    fireEvent.click(ask);
    fireEvent.click(ask);
    expect(await screen.findByTestId('approval-requested')).toBeTruthy();
    expect(requestApproval).toHaveBeenCalledTimes(1);
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

  it('keeps Tab inside the dialog when focus sits on the dialog container', () => {
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: false } })}
        sql="x"
        onClose={() => {}}
      />,
    );
    const dialog = screen.getByRole('dialog');
    const items = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled])')];
    dialog.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(items[items.length - 1]);
    dialog.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(items[0]);
  });

  it.each([
    [429, 'RATE_LIMITED'],
    [400, 'CONFIRMATION_INVALID'],
    [403, 'FORBIDDEN'],
  ])('keeps the outcome unknown when NETWORK_ERROR is followed by %s %s', async (status, code) => {
    vi.mocked(executePlan)
      .mockRejectedValueOnce(new ApiError(0, { code: 'NETWORK_ERROR', message: 'x' }))
      .mockRejectedValueOnce(new ApiError(status, { code, message: 'x' }));
    const onOutcome = vi.fn();
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: false } })}
        sql="x"
        onClose={() => {}}
        onOutcome={onOutcome}
      />,
    );
    fireEvent.click(execButton());
    await waitFor(() => expect(onOutcome).toHaveBeenCalledTimes(1));
    fireEvent.click(execButton());
    await waitFor(() => expect(onOutcome).toHaveBeenCalledTimes(2));
    expect(onOutcome).toHaveBeenLastCalledWith({
      sent: true,
      unknown: true,
      errorCode: 'NETWORK_ERROR',
    });
    expect(screen.getByTestId('outcome-unknown').textContent).toContain('Não repita');
  });

  it('clears the unknown outcome when a 5xx is followed by a replayed report', async () => {
    vi.mocked(executePlan)
      .mockRejectedValueOnce(new ApiError(502, { code: 'HTTP_ERROR', message: 'x' }))
      .mockResolvedValueOnce(report());
    const onOutcome = vi.fn();
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: false } })}
        sql="x"
        onClose={() => {}}
        onOutcome={onOutcome}
      />,
    );
    fireEvent.click(execButton());
    await screen.findByTestId('outcome-unknown');
    fireEvent.click(execButton());
    await screen.findByTestId('execution-report');
    expect(onOutcome).toHaveBeenLastCalledWith({ sent: true, unknown: false, report: report() });
    expect(screen.queryByTestId('outcome-unknown')).toBeNull();
  });

  it('keeps the same-key resend available after the countdown once the outcome is unknown', async () => {
    vi.mocked(executePlan).mockRejectedValueOnce(
      new ApiError(0, { code: 'NETWORK_ERROR', message: 'x' }),
    );
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
    fireEvent.click(execButton());
    await screen.findByTestId('outcome-unknown');
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByTestId('plan-countdown').textContent).toContain('expirado');
    expect(execButton().textContent).toBe('Consultar resultado');
    expect(execButton().disabled).toBe(false);
    expect(screen.getByTestId('outcome-unknown').textContent).toContain('uma única vez');
  });

  it('uses the idempotency key it is given, so a reopened plan resends with the same key', async () => {
    vi.mocked(executePlan).mockResolvedValue(report());
    const newKey = vi.fn(() => 'fresh-key');
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: false } })}
        sql="x"
        onClose={() => {}}
        idempotencyKey="kept-key"
        newKey={newKey}
      />,
    );
    fireEvent.click(execButton());
    await screen.findByTestId('execution-report');
    expect(vi.mocked(executePlan).mock.calls[0]![0].idempotencyKey).toBe('kept-key');
    expect(newKey).not.toHaveBeenCalled();
  });

  it('reopens on an unknown outcome with the warning and the same-key "Consultar resultado"', () => {
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: false } })}
        sql="x"
        onClose={() => {}}
        idempotencyKey="kept-key"
        initialOutcome={{ sent: true, unknown: true, errorCode: 'NETWORK_ERROR' }}
      />,
    );
    expect(screen.getByTestId('outcome-unknown').textContent).toContain('Não repita');
    expect(execButton().textContent).toBe('Consultar resultado');
    expect(execButton().disabled).toBe(false);
  });

  it('reopens a plan whose approval was already requested without offering the request again', () => {
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: true } })}
        sql="x"
        onClose={() => {}}
        approvalRequested
      />,
    );
    expect(screen.getByTestId('approval-requested')).toBeTruthy();
    expect(screen.queryByTestId('request-approval')).toBeNull();
  });

  it('tells the caller when the approval was requested', async () => {
    vi.mocked(requestApproval).mockResolvedValue({ approval: { id: 'a1', expiresAt: 'x' } });
    const onApprovalRequested = vi.fn();
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: true } })}
        sql="x"
        onClose={() => {}}
        onApprovalRequested={onApprovalRequested}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Solicitar aprovação' }));
    await screen.findByTestId('approval-requested');
    expect(onApprovalRequested).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a report', () => vi.mocked(executePlan).mockResolvedValue(report())],
    [
      'a plan-dead refusal',
      () =>
        vi
          .mocked(executePlan)
          .mockRejectedValue(new ApiError(400, { code: 'CONFIRMATION_USED', message: 'x' })),
    ],
    [
      'a rejected approval',
      () =>
        vi.mocked(executePlan).mockRejectedValue(
          new ApiError(403, {
            code: 'FORBIDDEN',
            message: 'x',
            details: { reason: 'approval_rejected' },
          }),
        ),
    ],
  ])('settles the plan after %s', async (_name, arrange) => {
    arrange();
    const onSettled = vi.fn();
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: false } })}
        sql="x"
        onClose={() => {}}
        onSettled={onSettled}
      />,
    );
    fireEvent.click(execButton());
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
  });

  it.each([
    ['a lost answer', new ApiError(0, { code: 'NETWORK_ERROR', message: 'x' })],
    [
      'a pending approval',
      new ApiError(403, {
        code: 'FORBIDDEN',
        message: 'x',
        details: { reason: 'approval_pending' },
      }),
    ],
  ])('does not settle the plan after %s', async (_name, err) => {
    vi.mocked(executePlan).mockRejectedValue(err);
    const onSettled = vi.fn();
    const onOutcome = vi.fn();
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: false } })}
        sql="x"
        onClose={() => {}}
        onOutcome={onOutcome}
        onSettled={onSettled}
      />,
    );
    fireEvent.click(execButton());
    await waitFor(() => expect(onOutcome).toHaveBeenCalled());
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('treats a rejected approval as plan-dead: no more execute', async () => {
    vi.mocked(executePlan).mockRejectedValue(
      new ApiError(403, {
        code: 'FORBIDDEN',
        message: 'x',
        details: { reason: 'approval_rejected' },
      }),
    );
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: true } })}
        sql="x"
        onClose={() => {}}
      />,
    );
    fireEvent.click(execButton());
    await screen.findByTestId('mutation-error');
    expect(execButton().disabled).toBe(true);
    expect(screen.getByText('Este plano não pode mais ser executado.')).toBeTruthy();
  });

  it('shows the capability label and the request id of a refusal', async () => {
    vi.mocked(executePlan).mockRejectedValue(
      new ApiError(403, {
        code: 'OPERATION_NOT_SUPPORTED',
        message: 'x',
        requestId: 'req-42',
        details: { capability: 'UNSUPPORTED' },
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
    const alert = await screen.findByTestId('mutation-error');
    expect(alert.textContent).toContain('UNSUPPORTED');
    expect(alert.textContent).toContain('req-42');
  });

  it('does not tell the user to generate a new preview next to the do-not-repeat warning', async () => {
    vi.mocked(executePlan)
      .mockRejectedValueOnce(new ApiError(0, { code: 'NETWORK_ERROR', message: 'x' }))
      .mockRejectedValueOnce(new ApiError(400, { code: 'CONFIRMATION_EXPIRED', message: 'x' }));
    render(
      <MutationDialog
        preview={preview({ requires: { strongConfirmation: null, approval: false } })}
        sql="x"
        onClose={() => {}}
      />,
    );
    fireEvent.click(execButton());
    await screen.findByTestId('outcome-unknown');
    fireEvent.click(execButton());
    await waitFor(() =>
      expect(screen.getByTestId('mutation-error').textContent).toContain('[CONFIRMATION_EXPIRED]'),
    );
    expect(screen.getByTestId('outcome-unknown')).toBeTruthy();
    expect(screen.getByRole('dialog').textContent).not.toMatch(/gere um novo preview|nova prévia/i);
  });

  it('shows the verification the server recorded with WRITE_OUTCOME_UNKNOWN', async () => {
    vi.mocked(executePlan).mockRejectedValue(
      new ApiError(502, {
        code: 'WRITE_OUTCOME_UNKNOWN',
        message: 'x',
        details: { planId: 'p', status: 'success', verification: 'VERIFIED' },
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
    const warning = await screen.findByTestId('outcome-unknown');
    expect(warning.textContent).toContain('VERIFIED');
  });

  it('lists only the write switches that apply to the plan', () => {
    const off = {
      available: false,
      safeMode: true,
      globalWriteEnabled: true,
      writeToSankhya: false,
    };
    render(
      <MutationDialog
        preview={preview({
          capability: { class: 'SUPPORTED', route: 'SCRATCH', reason: 'x' },
          impact: { entities: ['T'], rows: 1, environment: 'SCRATCH' },
          execution: { ...off, globalWriteEnabled: false },
        })}
        sql="x"
        onClose={() => {}}
      />,
    );
    let note = screen.getByRole('note').textContent;
    expect(note).toContain('GLOBAL_WRITE_ENABLED');
    expect(note).not.toContain('SAFE_MODE');
    expect(note).not.toContain('WRITE_TO_SANKHYA');
    cleanup();
    render(
      <MutationDialog
        preview={preview({
          impact: { entities: ['T'], rows: 1, environment: 'SANDBOX' },
          execution: off,
        })}
        sql="x"
        onClose={() => {}}
      />,
    );
    note = screen.getByRole('note').textContent;
    expect(note).not.toContain('SAFE_MODE');
    expect(note).toContain('WRITE_TO_SANKHYA');
    cleanup();
    render(<MutationDialog preview={preview({ execution: off })} sql="x" onClose={() => {}} />);
    note = screen.getByRole('note').textContent;
    expect(note).toContain('SAFE_MODE');
    expect(note).toContain('WRITE_TO_SANKHYA');
  });

  it('opens a server-prepared plan that carries no write-switch summary', () => {
    const { type: _type, execution: _execution, ...prepared } = preview();
    render(<MutationDialog preview={prepared} sql="x" onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Prévia da alteração' })).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
  });
});

const noPhrase = { strongConfirmation: null, approval: false };

function rows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    key: { CODPARC: i + 1 },
    before: { CODPARC: i + 1, NOMEPARC: `Antigo ${i + 1}`, CODCID: 10 },
    after: { CODPARC: i + 1, NOMEPARC: `Novo ${i + 1}`, CODCID: 10 },
  }));
}

describe('MutationDialog preview redesign', () => {
  it('shows the operation and the entities, a count sentence and only the changed fields', () => {
    render(
      <MutationDialog
        preview={preview({
          operation: 'UPDATE',
          preview: {
            affected: 1,
            targets: [
              {
                key: { CODPARC: 123 },
                before: { CODPARC: 123, NOMEPARC: 'Antigo', CODCID: 7 },
                after: { CODPARC: 123, NOMEPARC: 'Novo', CODCID: 7 },
              },
            ],
          },
        })}
        sql="x"
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('mutation-operation').textContent).toBe('UPDATE • TGFPAR');
    expect(screen.getByTestId('impact-rows').textContent).toBe('1 registro será alterado');
    const diff = screen.getByTestId('mutation-diff');
    expect(diff.textContent).toContain('Registro CODPARC = 123');
    expect(diff.textContent).toContain('ANTES');
    expect(diff.textContent).toContain('DEPOIS');
    expect(screen.getAllByTestId('diff-field').map((f) => f.getAttribute('data-field'))).toEqual([
      'NOMEPARC',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar todos os campos' }));
    expect(screen.getAllByTestId('diff-field').map((f) => f.getAttribute('data-field'))).toEqual([
      'CODPARC',
      'NOMEPARC',
      'CODCID',
    ]);
  });

  it('pluralises the UPDATE count from the server numbers', () => {
    render(
      <MutationDialog
        preview={preview({
          operation: 'UPDATE',
          preview: { affected: 3, targets: rows(3) },
          impact: { entities: ['TGFPAR'], rows: 3, environment: 'SANDBOX' },
        })}
        sql="x"
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('impact-rows').textContent).toBe('3 registros serão alterados');
  });

  it.each([
    [1, '1 novo registro será criado'],
    [2, '2 novos registros serão criados'],
  ])('shows an INSERT of %i as new records', (n, sentence) => {
    const targets = Array.from({ length: n }, (_, i) => ({
      key: { ID: i + 1 },
      before: null,
      after: { ID: i + 1, NOME: `Novo ${i + 1}` },
    }));
    render(
      <MutationDialog
        preview={preview({
          operation: 'INSERT',
          preview: { affected: n, targets },
          impact: { entities: ['TMP_X'], rows: n, environment: 'SCRATCH' },
        })}
        sql="x"
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('mutation-operation').textContent).toBe('INSERT • TMP_X');
    expect(screen.getByTestId('impact-rows').textContent).toBe(sentence);
    const diff = screen.getByTestId('mutation-diff').textContent ?? '';
    expect(diff).toContain('(novo registro)');
    expect(diff).toContain('Novo 1');
  });

  it('derives the operation of an older plan without `operation`', () => {
    render(
      <MutationDialog
        preview={preview({
          preview: { affected: 1, targets: [{ key: { ID: 1 }, before: null, after: { ID: 1 } }] },
        })}
        sql="x"
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('mutation-operation').textContent).toBe('INSERT • TGFPAR');
  });

  it('shows a DELETE as the full existing row and "REGISTRO SERÁ REMOVIDO", never NULLs', () => {
    render(
      <MutationDialog
        preview={preview({
          operation: 'DELETE',
          preview: {
            affected: 2,
            targets: [
              { key: { ID: 1 }, before: { ID: 1, NOME: 'Linha um', VALOR: 10 }, after: {} },
              { key: { ID: 2 }, before: { ID: 2, NOME: 'Linha dois', VALOR: 20 }, after: {} },
            ],
          },
          impact: { entities: ['TMP_X'], rows: 2, environment: 'SCRATCH' },
        })}
        sql="x"
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('mutation-operation').textContent).toBe('DELETE • TMP_X');
    expect(screen.getByTestId('impact-rows').textContent).toBe('2 registros serão removidos');
    const diff = screen.getByTestId('mutation-diff').textContent ?? '';
    expect(diff).toContain('Linha um');
    expect(diff).toContain('VALOR');
    expect(diff).toContain('REGISTRO SERÁ REMOVIDO');
    expect(diff).not.toContain('NULL');
    expect(diff).not.toContain('∅');
  });

  it('shows the PRODUÇÃO band only for production', () => {
    render(<MutationDialog preview={preview()} sql="x" onClose={() => {}} />);
    expect(screen.getByTestId('production-band').textContent).toContain(
      'PRODUÇÃO — Você está prestes a alterar dados do ambiente de produção.',
    );
    cleanup();
    render(
      <MutationDialog
        preview={preview({ impact: { entities: ['TGFPAR'], rows: 1, environment: 'SANDBOX' } })}
        sql="x"
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId('production-band')).toBeNull();
  });

  it('collapses the cards when there are more than 5 targets, except the first', () => {
    render(
      <MutationDialog
        preview={preview({ preview: { affected: 6, targets: rows(6) } })}
        sql="x"
        onClose={() => {}}
      />,
    );
    const toggles = screen.getAllByTestId('diff-card-toggle');
    expect(toggles.map((t) => t.getAttribute('aria-expanded'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'false',
      'false',
    ]);
    fireEvent.click(toggles[1]!);
    expect(toggles[1]!.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggles[0]!);
    expect(toggles[0]!.getAttribute('aria-expanded')).toBe('false');
  });

  it('paginates 1000 targets: never more than 20 cards, with the total and page controls', () => {
    render(
      <MutationDialog
        preview={preview({
          operation: 'UPDATE',
          preview: { affected: 1000, targets: rows(1000) },
          impact: { entities: ['TGFPAR'], rows: 1000, environment: 'SANDBOX' },
        })}
        sql="x"
        onClose={() => {}}
      />,
    );
    expect(screen.getAllByTestId('diff-card')).toHaveLength(20);
    expect(screen.getByTestId('impact-rows').textContent).toBe('1000 registros serão alterados');
    expect(screen.getByTestId('mutation-diff').textContent).toContain('1000 registros no total');
    expect(screen.getByTestId('diff-page').textContent).toBe('Página 1 de 50');
    const prev = screen.getByRole('button', { name: 'Anterior' }) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(screen.getByTestId('diff-page').textContent).toBe('Página 2 de 50');
    expect(screen.getAllByTestId('diff-card')).toHaveLength(20);
    const headers = screen.getAllByTestId('diff-card-toggle').map((t) => t.textContent);
    expect(headers[0]).toContain('Registro CODPARC = 21');
    expect(headers.some((h) => h?.includes('Registro CODPARC = 1 '))).toBe(false);
  });

  it('labels the buttons "Confirmar alteração" and "Cancelar"', () => {
    render(<MutationDialog preview={preview()} sql="x" onClose={() => {}} />);
    expect(execButton().textContent).toBe('Confirmar alteração');
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeTruthy();
  });

  it('disables the confirmation for a preview-only caller, with a note', () => {
    render(
      <MutationDialog
        preview={preview({
          requires: noPhrase,
          execution: {
            available: true,
            permitted: false,
            safeMode: false,
            globalWriteEnabled: true,
            writeToSankhya: true,
          },
        })}
        sql="x"
        onClose={() => {}}
      />,
    );
    expect(execButton().disabled).toBe(true);
    expect(screen.getByTestId('preview-only-note').textContent).toBe(
      'Você pode ver a prévia, mas não tem permissão para executar esta alteração.',
    );
    fireEvent.click(execButton());
    expect(executePlan).not.toHaveBeenCalled();
  });

  it('does not offer an approval request to a preview-only caller', () => {
    render(
      <MutationDialog
        preview={preview({
          requires: { strongConfirmation: null, approval: true },
          execution: {
            available: true,
            permitted: false,
            safeMode: false,
            globalWriteEnabled: true,
            writeToSankhya: true,
          },
        })}
        sql="x"
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId('request-approval')).toBeNull();
    expect(screen.getByTestId('preview-only-note')).toBeTruthy();
  });

  it('disables the confirmation while the write switches are unavailable', () => {
    render(
      <MutationDialog
        preview={preview({
          requires: noPhrase,
          execution: {
            available: false,
            safeMode: true,
            globalWriteEnabled: true,
            writeToSankhya: true,
          },
        })}
        sql="x"
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('note').textContent).toContain('SAFE_MODE');
    expect(execButton().disabled).toBe(true);
  });

  it('never executes on Enter, neither in the confirmation input nor anywhere in the dialog', () => {
    vi.mocked(executePlan).mockResolvedValue(report());
    render(<MutationDialog preview={preview()} sql="x" onClose={() => {}} />);
    type(PHRASE);
    const input = screen.getByTestId('confirmation-input');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyPress(input, { key: 'Enter', charCode: 13 });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    // Default prevented on the button: the browser does not turn the Enter into a click.
    expect(fireEvent.keyDown(execButton(), { key: 'Enter' })).toBe(false);
    expect(executePlan).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('sends exactly one execute on a double click', async () => {
    vi.mocked(executePlan).mockResolvedValue(report());
    render(<MutationDialog preview={preview({ requires: noPhrase })} sql="x" onClose={() => {}} />);
    fireEvent.click(execButton());
    fireEvent.click(execButton());
    await screen.findByTestId('execution-report');
    expect(executePlan).toHaveBeenCalledTimes(1);
  });

  it('does not execute an expired plan and says to run again for a new preview', () => {
    render(
      <MutationDialog
        preview={preview({ expiresAt: new Date(NOW - 1_000).toISOString(), requires: noPhrase })}
        sql="x"
        onClose={() => {}}
      />,
    );
    expect(execButton().disabled).toBe(true);
    fireEvent.click(execButton());
    expect(executePlan).not.toHaveBeenCalled();
    expect(screen.getByTestId('plan-countdown').textContent).toContain(
      'execute novamente para gerar uma nova prévia',
    );
  });
});

describe('MutationDialog execution report', () => {
  async function run(r: ExecutionReport) {
    vi.mocked(executePlan).mockResolvedValue(r);
    render(<MutationDialog preview={preview({ requires: noPhrase })} sql="x" onClose={() => {}} />);
    fireEvent.click(execButton());
    return screen.findByTestId('execution-report');
  }

  it('shows "Alteração concluída" and ANTES × AGORA from the read-back when VERIFIED', async () => {
    const el = await run(
      report({
        steps: [
          {
            key: { CODPARC: 1 },
            outcome: 'ok',
            verified: true,
            before: { NOMEPARC: 'Antigo' },
            expected: { NOMEPARC: 'Novo' },
            observed: { NOMEPARC: 'Lido de volta' },
          },
        ],
      }),
    );
    expect(screen.getByTestId('report-title').textContent).toBe('Alteração concluída');
    expect(el.textContent).toContain('Os valores foram lidos novamente no Sankhya e conferem.');
    const step = screen.getByTestId('execution-step');
    expect(step.textContent).toContain('ANTES');
    expect(step.textContent).toContain('AGORA');
    expect(step.textContent).toContain('Antigo');
    expect(screen.getByTestId('step-now').textContent).toContain('Lido de volta');
    expect(step.textContent).not.toContain('ESPERADO');
  });

  it('shows ESPERADO × OBSERVADO in danger and never "Alteração concluída" when FAILED', async () => {
    await run(
      report({
        status: 'success',
        verification: 'FAILED',
        steps: [
          {
            key: { CODPARC: 1 },
            outcome: 'ok',
            verified: false,
            before: { NOMEPARC: 'Antigo' },
            expected: { NOMEPARC: 'Novo' },
            observed: { NOMEPARC: 'Outro' },
          },
        ],
      }),
    );
    expect(screen.getByTestId('report-title').textContent).toBe('Alteração com divergência');
    expect(screen.getByTestId('execution-report').textContent).not.toContain('Alteração concluída');
    const mismatch = screen.getByTestId('step-mismatch');
    expect(mismatch.textContent).toContain('ESPERADO');
    expect(mismatch.textContent).toContain('OBSERVADO');
    expect(mismatch.textContent).toContain('Novo');
    expect(mismatch.textContent).toContain('Outro');
    expect(mismatch.className).toContain('danger');
  });

  it.each([
    ['PARTIALLY_VERIFIED', 'success', 'Alteração executada — verificação parcial'],
    ['UNVERIFIED', 'success', 'Não foi possível verificar'],
    ['VERIFIED', 'partial', 'Alteração parcial'],
    ['VERIFIED', 'failed', 'A alteração falhou'],
  ] as const)('titles %s/%s without "concluída"', async (verification, status, title) => {
    await run(report({ verification, status }));
    expect(screen.getByTestId('report-title').textContent).toBe(title);
  });

  it('says "não foi possível reler" without observed, and never shows expected as AGORA', async () => {
    await run(
      report({
        verification: 'UNVERIFIED',
        steps: [
          {
            key: { CODPARC: 1 },
            outcome: 'ok',
            before: { NOMEPARC: 'Antigo' },
            expected: { NOMEPARC: 'Esperado-XYZ' },
          },
        ],
      }),
    );
    const now = screen.getByTestId('step-now');
    expect(now.textContent).toContain('não foi possível reler');
    expect(screen.getByTestId('execution-step').textContent).not.toContain('Esperado-XYZ');
  });

  it('says the values are not available in a replay that omits them', async () => {
    await run({ ...report(), valuesTruncated: true });
    expect(screen.getByTestId('values-unavailable').textContent).toContain(
      'limites do registro de auditoria',
    );
  });

  it('paginates the steps of a large report', async () => {
    await run(
      report({
        steps: Array.from({ length: 45 }, (_, i) => ({
          key: { CODPARC: i + 1 },
          outcome: 'ok' as const,
          verified: true,
        })),
      }),
    );
    expect(screen.getAllByTestId('execution-step')).toHaveLength(20);
    expect(screen.getByTestId('execution-report').textContent).toContain('Página 1 de 3');
  });
});

describe('MutationDialog unknown outcome', () => {
  it('shows RESULTADO DESCONHECIDO and never retries on its own', async () => {
    vi.mocked(executePlan).mockRejectedValue(
      new ApiError(0, { code: 'NETWORK_ERROR', message: 'x' }),
    );
    render(
      <MutationDialog
        preview={preview({ requires: noPhrase })}
        sql="x"
        onClose={() => {}}
        newKey={() => 'same-key'}
      />,
    );
    fireEvent.click(execButton());
    const warning = await screen.findByTestId('outcome-unknown');
    expect(warning.textContent).toContain('RESULTADO DESCONHECIDO');
    expect(warning.textContent).toContain(
      'A alteração pode ter sido executada. Não repita a operação antes de conferir o registro.',
    );
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(executePlan).toHaveBeenCalledTimes(1);
    expect(execButton().textContent).toBe('Consultar resultado');
    fireEvent.click(execButton());
    await waitFor(() => expect(executePlan).toHaveBeenCalledTimes(2));
    expect(vi.mocked(executePlan).mock.calls.map((c) => c[0].idempotencyKey)).toEqual([
      'same-key',
      'same-key',
    ]);
  });
});

describe('MutationDialog review fixes', () => {
  it('lets the server operation decide a removal, not the empty `after`', () => {
    render(
      <MutationDialog
        preview={preview({
          operation: 'UPDATE',
          preview: {
            affected: 1,
            targets: [
              { key: { CODPARC: 1 }, before: { CODPARC: 1, NOMEPARC: 'Antigo' }, after: {} },
            ],
          },
        })}
        sql="x"
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('mutation-diff').textContent).not.toContain('REGISTRO SERÁ REMOVIDO');
  });

  it('shows a DELETE target as removed even when `after` carries columns', () => {
    render(
      <MutationDialog
        preview={preview({
          operation: 'DELETE',
          preview: {
            affected: 1,
            targets: [
              {
                key: { ID: 1 },
                before: { ID: 1, NOME: 'Linha um' },
                after: { ID: null, NOME: null },
              },
            ],
          },
        })}
        sql="x"
        onClose={() => {}}
      />,
    );
    const diff = screen.getByTestId('mutation-diff').textContent ?? '';
    expect(diff).toContain('REGISTRO SERÁ REMOVIDO');
    expect(diff).toContain('Linha um');
    expect(diff).not.toContain('NULL');
  });

  it('points aria-controls only at a rendered card body', () => {
    render(
      <MutationDialog
        preview={preview({ preview: { affected: 6, targets: rows(6) } })}
        sql="x"
        onClose={() => {}}
      />,
    );
    const [open, closed] = screen.getAllByTestId('diff-card-toggle');
    const id = open!.getAttribute('aria-controls');
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)).not.toBeNull();
    expect(closed!.hasAttribute('aria-controls')).toBe(false);
  });

  it('shows AGORA "registro removido" for a DELETE step without read-back', async () => {
    vi.mocked(executePlan).mockResolvedValue(
      report({
        steps: [{ key: { ID: 1 }, outcome: 'ok', verified: true, before: { NOME: 'Linha um' } }],
      }),
    );
    render(
      <MutationDialog
        preview={preview({
          operation: 'DELETE',
          requires: noPhrase,
          preview: {
            affected: 1,
            targets: [{ key: { ID: 1 }, before: { ID: 1, NOME: 'Linha um' }, after: {} }],
          },
        })}
        sql="x"
        onClose={() => {}}
      />,
    );
    fireEvent.click(execButton());
    await screen.findByTestId('execution-report');
    const now = screen.getByTestId('step-now').textContent;
    expect(now).toContain('registro removido');
    expect(now).not.toContain('não foi possível reler');
  });

  it('keeps "não foi possível reler" for an UPDATE step without read-back', async () => {
    vi.mocked(executePlan).mockResolvedValue(
      report({
        verification: 'UNVERIFIED',
        steps: [{ key: { CODPARC: 1 }, outcome: 'ok', before: { NOMEPARC: 'Antigo' } }],
      }),
    );
    render(
      <MutationDialog
        preview={preview({ operation: 'UPDATE', requires: noPhrase })}
        sql="x"
        onClose={() => {}}
      />,
    );
    fireEvent.click(execButton());
    await screen.findByTestId('execution-report');
    expect(screen.getByTestId('step-now').textContent).toContain('não foi possível reler');
  });
});

describe('MutationDialog scratch DDL (tmp_*)', () => {
  const ddl = (over: Partial<MutationPreview>, preview: Partial<MutationPreview['preview']>) =>
    preview_({
      capability: { class: 'SCRATCH_ONLY', route: 'SCRATCH', reason: 'scratch' },
      previewKind: 'TRANSACTIONAL_DRY_RUN',
      previewLabels: ['TRANSACTIONAL_DRY_RUN'],
      impact: { entities: ['TMP_P'], rows: 1, environment: 'SCRATCH' },
      requires: { strongConfirmation: null, approval: false },
      ...over,
      preview: { affected: 1, targets: [], ...preview },
    });
  const preview_ = preview;

  it('shows the structure AFTER of a CREATE, the Sankhya parts cut, and "Confirmar criação"', () => {
    render(
      <MutationDialog
        preview={ddl(
          { operation: 'CREATE_TABLE' },
          {
            structure: {
              table: 'tmp_p',
              before: null,
              after: {
                name: 'tmp_p',
                rows: 2,
                columns: [
                  { name: 'codparc', type: 'integer' },
                  { name: 'nomeparc', type: 'text' },
                ],
              },
            },
            sankhyaParts: [{ tables: ['TGFPAR'], rows: 2, truncated: true }],
          },
        )}
        sql="CREATE TABLE tmp_p AS SELECT CODPARC, NOMEPARC FROM TGFPAR"
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('impact-rows').textContent).toBe(
      'A tabela tmp_p será criada com 2 linhas',
    );
    expect(screen.queryByTestId('structure-before')).toBeNull();
    const after = screen.getByTestId('structure-after').textContent;
    expect(after).toContain('codparc');
    expect(after).toContain('integer');
    expect(after).toContain('2 linhas');
    expect(screen.getByTestId('structure-sankhya-parts').textContent).toContain(
      'A parte do Sankhya (TGFPAR) foi cortada em 2 linhas',
    );
    expect(screen.queryByTestId('mutation-diff')).toBeNull();
    expect(execButton().textContent).toBe('Confirmar criação');
  });

  it('shows BEFORE and AFTER of an ALTER', () => {
    const s = (columns: { name: string; type: string }[]) => ({ name: 'tmp_a', rows: 3, columns });
    render(
      <MutationDialog
        preview={ddl(
          { operation: 'ALTER_TABLE' },
          {
            structure: {
              table: 'tmp_a',
              before: s([{ name: 'id', type: 'integer' }]),
              after: s([
                { name: 'id', type: 'integer' },
                { name: 'note', type: 'text' },
              ]),
            },
          },
        )}
        sql="ALTER TABLE tmp_a ADD COLUMN note text"
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('impact-rows').textContent).toBe(
      'A estrutura da tabela tmp_a será alterada',
    );
    expect(screen.getByTestId('structure-before').textContent).not.toContain('note');
    expect(screen.getByTestId('structure-after').textContent).toContain('note');
    expect(execButton().textContent).toBe('Confirmar alteração');
  });

  it('warns that a DROP loses its rows and asks "Confirmar exclusão" in danger', () => {
    render(
      <MutationDialog
        preview={ddl(
          { operation: 'DROP_TABLE' },
          {
            structure: {
              table: 'tmp_a',
              before: { name: 'tmp_a', rows: 3, columns: [{ name: 'id', type: 'integer' }] },
              after: null,
            },
            lostRows: 3,
          },
        )}
        sql="DROP TABLE tmp_a"
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('impact-rows').textContent).toBe('A tabela tmp_a será apagada');
    expect(screen.getByTestId('structure-lost-rows').textContent).toBe('3 linhas serão perdidas');
    expect(screen.getByTestId('structure-after').textContent).toContain('tabela removida');
    expect(execButton().textContent).toBe('Confirmar exclusão');
    expect(execButton().className).toContain('btn-danger');
  });
});
