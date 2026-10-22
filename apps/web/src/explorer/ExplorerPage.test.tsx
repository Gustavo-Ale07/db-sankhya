import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, api } from '../api/client';
import { executePlan, previewMutation, requestApproval } from '../api/mutations';
import type { ExecutionReport, MutationPreview, PreparedPlan } from '../api/mutations';
import type { User } from '../api/types';
import { SessionContext } from '../app/session';
import { setCompletionSchema } from '../editor/monaco';
import { ExplorerPage } from './ExplorerPage';
import type { OpenPlanRequest } from './ExplorerPage';
import { clearPendingPlans } from './pendingPlans';

// Monaco stays out of jsdom: the editor and its completion are not under test here.
vi.mock('../editor/monaco', () => ({ setCompletionSchema: vi.fn() }));
vi.mock('./SqlEditor', () => ({ SqlEditor: () => <div data-testid="editor-stub" /> }));
vi.mock('../api/client', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));
vi.mock('../api/mutations', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  previewMutation: vi.fn(),
  executePlan: vi.fn(),
  requestApproval: vi.fn(),
}));

const TOKEN = 'plan-token-secret';
const SQL = "UPDATE TGFPAR SET NOMEPARC = 'Novo' WHERE CODPARC = 1";

const USER: User = {
  id: 'u1',
  email: 'operator@example.com',
  name: 'Pessoa Exemplo',
  roles: ['OPERATOR'],
  permissions: ['QUERY.SELECT'],
  active: true,
  mustChangePassword: false,
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function prepared(over: Partial<PreparedPlan> = {}): PreparedPlan {
  return {
    planId: '00000000-0000-4000-8000-000000000001',
    token: TOKEN,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    capability: { class: 'SUPPORTED', route: 'SANKHYA_SAVE', reason: 'Native entity' },
    previewKind: 'IMPACT_ANALYSIS',
    previewLabels: ['IMPACT_ANALYSIS'],
    preview: { affected: 1, targets: [] },
    impact: { entities: ['TGFPAR'], rows: 1, environment: 'PRODUCTION' },
    requires: { strongConfirmation: null, approval: false },
    ...over,
  };
}

const preview = (over: Partial<PreparedPlan> = {}): MutationPreview => ({
  ...prepared(over),
  type: 'preview',
  execution: { available: true, safeMode: false, globalWriteEnabled: true, writeToSankhya: true },
});

const report: ExecutionReport = {
  type: 'execution',
  planId: '00000000-0000-4000-8000-000000000001',
  status: 'success',
  verification: 'VERIFIED',
  steps: [{ key: { CODPARC: 1 }, outcome: 'ok', verified: true }],
};

type PageProps = Parameters<typeof ExplorerPage>[0];

function renderPage(props: Partial<PageProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const noop = () => Promise.resolve();
  const ui = (p: Partial<PageProps>) => (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={{ user: USER, meta: undefined, logout: noop, refresh: noop }}>
        <ExplorerPage theme="light" active openRequest={null} connectionId="env" {...p} />
      </SessionContext.Provider>
    </QueryClientProvider>
  );
  const view = render(ui(props));
  return { ...view, rerenderWith: (p: Partial<PageProps>) => view.rerender(ui(p)) };
}

/** Runs SQL through /api/query, which points at the preview; the dialog then opens. */
async function openPreviewedPlan(extra: Partial<PageProps> = {}) {
  const view = renderPage({ openRequest: { sql: SQL, run: true, nonce: 1 }, ...extra });
  await screen.findByTestId('mutation-dialog');
  return view;
}

const execButton = () => screen.getByTestId('mutation-execute') as HTMLButtonElement;
const closeDialog = () => fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
const reopen = () => fireEvent.click(screen.getByRole('button', { name: 'Reabrir prévia' }));

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.mocked(api.get).mockResolvedValue({ connectionId: 'env', catalog: { tables: [] } });
  vi.mocked(api.post).mockRejectedValue(
    new ApiError(400, {
      code: 'SQL_UNSUPPORTED',
      message: 'preview it',
      details: { preview: '/api/query/preview' },
    }),
  );
  vi.mocked(previewMutation).mockResolvedValue(preview());
});
afterEach(() => {
  cleanup();
  clearPendingPlans();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('ExplorerPage pending plans', () => {
  it('reopens a closed plan from the status area, without a second preview', async () => {
    await openPreviewedPlan();
    closeDialog();
    expect(screen.queryByTestId('mutation-dialog')).toBeNull();
    reopen();
    expect(await screen.findByTestId('mutation-dialog')).toBeTruthy();
    expect(previewMutation).toHaveBeenCalledTimes(1);
  });

  it('after an unknown outcome, resends with the same idempotency key once reopened', async () => {
    vi.mocked(executePlan)
      .mockRejectedValueOnce(new ApiError(0, { code: 'NETWORK_ERROR', message: 'x' }))
      .mockResolvedValueOnce(report);
    await openPreviewedPlan();
    fireEvent.click(execButton());
    await waitFor(() => expect(execButton().textContent).toBe('Consultar resultado'));
    closeDialog();
    expect(screen.getByTestId('mutation-outcome-unknown').textContent).toContain('NÃO repita');
    reopen();
    await screen.findByTestId('mutation-dialog');
    expect(execButton().textContent).toBe('Consultar resultado');
    fireEvent.click(execButton());
    await screen.findByTestId('execution-report');
    const calls = vi.mocked(executePlan).mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.idempotencyKey).toBe(calls[0]!.idempotencyKey);
    expect(calls[1]!.token).toBe(TOKEN);
    // A final outcome forgets the plan: nothing left to reopen.
    fireEvent.click(screen.getAllByRole('button', { name: 'Fechar' }).at(-1)!);
    expect(screen.queryByRole('button', { name: 'Reabrir prévia' })).toBeNull();
  });

  it('lets the requester run the plan after the approval, from a reopened dialog', async () => {
    vi.mocked(previewMutation).mockResolvedValue(
      preview({ requires: { strongConfirmation: null, approval: true } }),
    );
    vi.mocked(requestApproval).mockResolvedValue({ approval: { id: 'a1', expiresAt: 'x' } });
    vi.mocked(executePlan).mockResolvedValue(report);
    await openPreviewedPlan();
    fireEvent.click(screen.getByRole('button', { name: 'Solicitar aprovação' }));
    await screen.findByTestId('approval-requested');
    closeDialog();
    reopen();
    expect(await screen.findByTestId('approval-requested')).toBeTruthy();
    fireEvent.click(execButton());
    await screen.findByTestId('execution-report');
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(executePlan).toHaveBeenCalledTimes(1);
  });

  it('does not reopen a plan while another connection is selected', async () => {
    const view = await openPreviewedPlan();
    closeDialog();
    view.rerenderWith({ openRequest: { sql: SQL, run: true, nonce: 1 }, connectionId: 'other' });
    const button = screen.getByRole('button', { name: 'Reabrir prévia' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('forgets the plan when its TTL expires', async () => {
    vi.mocked(previewMutation).mockResolvedValue(
      preview({ expiresAt: new Date(Date.now() + 1_000).toISOString() }),
    );
    await openPreviewedPlan();
    closeDialog();
    expect(screen.getByRole('button', { name: 'Reabrir prévia' })).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 1_100)));
    expect(screen.queryByRole('button', { name: 'Reabrir prévia' })).toBeNull();
  });

  it('never writes the plan token or the idempotency key to web storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    vi.mocked(executePlan).mockRejectedValueOnce(
      new ApiError(0, { code: 'NETWORK_ERROR', message: 'x' }),
    );
    await openPreviewedPlan();
    fireEvent.click(execButton());
    await waitFor(() => expect(executePlan).toHaveBeenCalledTimes(1));
    const key = vi.mocked(executePlan).mock.calls[0]![0].idempotencyKey;
    closeDialog();
    reopen();
    await screen.findByTestId('mutation-dialog');
    const written = JSON.stringify(setItem.mock.calls);
    expect(written).not.toContain(TOKEN);
    expect(written).not.toContain(key);
  });
});

describe('ExplorerPage connection switch', () => {
  it('cancels the running query and ignores its late answer when the connection changes', async () => {
    let answer!: (r: unknown) => void;
    let signal: AbortSignal | undefined;
    vi.mocked(api.post).mockImplementation((path, _body, opts) => {
      if (path === '/api/query') {
        signal = opts?.signal;
        return new Promise((resolve) => (answer = resolve));
      }
      return Promise.resolve({});
    });
    const view = renderPage({
      connectionId: 'a',
      openRequest: { sql: 'SELECT CODPARC FROM TGFPAR', run: true, nonce: 1 },
    });
    await waitFor(() => expect(signal).toBeDefined());
    view.rerenderWith({
      connectionId: 'b',
      openRequest: { sql: 'SELECT CODPARC FROM TGFPAR', run: true, nonce: 1 },
    });
    await waitFor(() => expect(signal!.aborted).toBe(true));
    await act(async () => {
      answer({
        type: 'result',
        kind: 'SELECT',
        connectionId: 'a',
        columns: [{ name: 'CODPARC', type: 'number' }],
        rows: [['valor-da-conexao-a']],
        rowCount: 1,
        truncated: false,
        durationMs: 1,
        executionId: 'e1',
        resource: 'TGFPAR',
        apiCalls: 1,
        messages: [],
      });
    });
    expect(screen.queryByText('valor-da-conexao-a')).toBeNull();
    expect(screen.queryByText(/Cancelled by the user/)).toBeNull();
  });

  it('ignores an answer for another connection', async () => {
    vi.mocked(api.post).mockImplementation((path) =>
      path === '/api/query'
        ? Promise.resolve({
            type: 'result',
            kind: 'SELECT',
            connectionId: 'outra',
            columns: [{ name: 'CODPARC', type: 'number' }],
            rows: [['valor-de-outra']],
            rowCount: 1,
            truncated: false,
            durationMs: 1,
            executionId: 'e1',
            resource: 'TGFPAR',
            apiCalls: 1,
            messages: [],
          })
        : Promise.resolve({}),
    );
    renderPage({
      connectionId: 'a',
      openRequest: { sql: 'SELECT CODPARC FROM TGFPAR', run: true, nonce: 1 },
    });
    await waitFor(() =>
      expect(vi.mocked(api.post).mock.calls.some((c) => c[0] === '/api/query')).toBe(true),
    );
    await act(async () => {});
    expect(screen.queryByText('valor-de-outra')).toBeNull();
  });

  it('reads an incomplete catalog again from the schema tree', async () => {
    vi.mocked(api.get).mockResolvedValue({
      connectionId: 'env',
      catalog: { tables: [], degraded: ['TDDTAB:truncated'] },
    });
    vi.mocked(api.post).mockResolvedValue({
      connectionId: 'env',
      catalog: { tables: [{ name: 'TGFPAR', columns: [], foreignKeys: [] }] },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Recarregar catálogo' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/api/schema/refresh',
        {},
        expect.objectContaining({ query: { connectionId: 'env' } }),
      ),
    );
    await waitFor(() => expect(screen.queryByTestId('schema-degraded')).toBeNull());
  });
});

describe('ExplorerPage server-prepared plan (assisted rollback)', () => {
  const request = (over: Partial<OpenPlanRequest> = {}): OpenPlanRequest => ({
    plan: prepared({ planId: '00000000-0000-4000-8000-0000000000aa', token: 'rollback-token' }),
    sql: SQL,
    title: 'Rollback assistido',
    connectionId: 'env',
    nonce: 1,
    ...over,
  });

  it('opens the dialog on that plan, executes it, and never prepares a second one', async () => {
    vi.mocked(executePlan).mockResolvedValue(report);
    renderPage({ planRequest: request() });
    await screen.findByTestId('mutation-dialog');
    expect(previewMutation).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(execButton());
    await screen.findByTestId('execution-report');
    expect(executePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: '00000000-0000-4000-8000-0000000000aa',
        token: 'rollback-token',
      }),
    );
  });

  it('opening the same plan again reuses its idempotency key', async () => {
    vi.mocked(executePlan).mockRejectedValue(
      new ApiError(0, { code: 'NETWORK_ERROR', message: 'x' }),
    );
    const view = renderPage({ planRequest: request() });
    await screen.findByTestId('mutation-dialog');
    fireEvent.click(execButton());
    await waitFor(() => expect(execButton().textContent).toBe('Consultar resultado'));
    closeDialog();
    view.rerenderWith({ planRequest: request({ nonce: 2 }) });
    await screen.findByTestId('mutation-dialog');
    fireEvent.click(execButton());
    await waitFor(() => expect(executePlan).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(executePlan).mock.calls.map((c) => c[0]);
    expect(second!.idempotencyKey).toBe(first!.idempotencyKey);
  });

  it('opens nothing while the selected connection is not the plan connection', () => {
    renderPage({ planRequest: request({ connectionId: 'prod' }), connectionId: 'env' });
    expect(screen.queryByTestId('mutation-dialog')).toBeNull();
  });
});

describe('ExplorerPage tmp_ tables (A5)', () => {
  const SCRATCH = {
    ttlMinutes: 60,
    tables: [{ name: 'tmp_p', rows: 5, columns: [{ name: 'codparc', type: 'integer' }] }],
  };
  const getScratch = () =>
    vi.mocked(api.get).mock.calls.filter((c) => c[0] === '/api/scratch/tables');

  beforeEach(() => {
    vi.mocked(api.get).mockImplementation((path) =>
      Promise.resolve(
        path === '/api/scratch/tables'
          ? SCRATCH
          : {
              connectionId: 'env',
              catalog: { tables: [{ name: 'TGFPAR', columns: [], foreignKeys: [] }] },
            },
      ),
    );
  });

  it('shows the Temporárias group and feeds tmp_ tables to the autocomplete', async () => {
    renderPage();
    expect(await screen.findByTestId('schema-table-tmp_p')).toBeTruthy();
    expect(getScratch()[0]![1]).toEqual({ query: { columns: '1' } });
    await waitFor(() => {
      const last = vi.mocked(setCompletionSchema).mock.calls.at(-1)!;
      expect(last[0].map((t) => t.name)).toEqual(['tmp_p', 'TGFPAR']);
    });
  });

  it('reads the tmp_ tables again once a plan reports its outcome', async () => {
    vi.mocked(executePlan).mockResolvedValue(report);
    await openPreviewedPlan();
    await screen.findByTestId('schema-table-tmp_p');
    const before = getScratch().length;
    fireEvent.click(execButton());
    await screen.findByTestId('execution-report');
    await waitFor(() => expect(getScratch().length).toBeGreaterThan(before));
  });
});
