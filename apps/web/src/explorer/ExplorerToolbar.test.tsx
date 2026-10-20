import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../api/client';
import { previewMutation } from '../api/mutations';
import type { QueryResult, SavedQuery, User } from '../api/types';
import { SessionContext } from '../app/session';
import { ExplorerPage, SCHEMA_WIDTH_MAX, SCHEMA_WIDTH_MIN } from './ExplorerPage';

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
}));

// jsdom does not implement <dialog> modality.
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
  this.removeAttribute('open');
};

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

const SAVED: SavedQuery[] = [
  {
    id: 's1',
    name: 'Parceiros ativos',
    sql: "SELECT CODPARC FROM TGFPAR WHERE ATIVO = 'S'",
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 's2',
    name: 'Produtos',
    sql: 'SELECT CODPROD FROM TGFPRO',
    description: 'Cadastro de produtos',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

const queryResult = (): QueryResult => ({
  type: 'result',
  executionId: 'e1',
  connectionId: 'env',
  kind: 'select',
  resource: 'TGFPAR',
  columns: [{ name: 'CODPARC', type: 'NUMBER' }],
  rows: [[1]],
  rowCount: 1,
  truncated: false,
  apiCalls: 1,
  durationMs: 3,
  messages: [],
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const noop = () => Promise.resolve();
  return render(
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={{ user: USER, meta: undefined, logout: noop, refresh: noop }}>
        <ExplorerPage theme="light" active openRequest={null} connectionId="env" />
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}

const editorTabs = () => screen.getByRole('tablist', { name: 'Abas do editor' });
const panel = () => screen.getByRole('complementary', { name: 'Schema' });
const handle = () => screen.getByRole('separator', { name: 'Redimensionar painel de tabelas' });

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(api.get).mockImplementation((path: string) =>
    Promise.resolve(
      path === '/api/saved-queries'
        ? { items: SAVED }
        : { connectionId: 'env', catalog: { tables: [] } },
    ),
  );
  vi.mocked(api.post).mockResolvedValue(queryResult());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('ExplorerPage toolbar', () => {
  it('"Nova consulta" adds an editor tab and selects it', () => {
    renderPage();
    expect(within(editorTabs()).getAllByRole('tab')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Nova consulta' }));
    const tabs = within(editorTabs()).getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[1]!.textContent).toBe('Consulta 2');
  });

  it('"Consultas salvas" opens a picker; the filter narrows it and a choice opens a new tab', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir consultas salvas' }));
    const dialog = await screen.findByRole('dialog', { name: 'Consultas salvas' });
    await within(dialog).findByText('Parceiros ativos');
    // Focus lands on the filter, not on the dialog's close button.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByLabelText('Filtrar consultas salvas'),
      ),
    );
    expect(within(dialog).getAllByTestId('saved-picker-item')).toHaveLength(2);
    fireEvent.change(within(dialog).getByLabelText('Filtrar consultas salvas'), {
      target: { value: 'produtos' },
    });
    const items = within(dialog).getAllByTestId('saved-picker-item');
    expect(items).toHaveLength(1);
    fireEvent.click(items[0]!);
    expect(screen.queryByRole('dialog', { name: 'Consultas salvas' })).toBeNull();
    const tabs = within(editorTabs()).getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[1]!.textContent).toBe('Produtos');
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    // The new tab holds the saved SQL: running it sends exactly that.
    fireEvent.click(screen.getByTestId('run-query'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/api/query',
        expect.objectContaining({ sql: 'SELECT CODPROD FROM TGFPRO' }),
        expect.anything(),
      ),
    );
  });

  it('closes the picker with Escape without opening a tab', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir consultas salvas' }));
    const dialog = await screen.findByRole('dialog', { name: 'Consultas salvas' });
    // The browser fires "cancel" on the dialog for Escape.
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog', { name: 'Consultas salvas' })).toBeNull();
    expect(within(editorTabs()).getAllByRole('tab')).toHaveLength(1);
  });

  it('runs a SELECT through /api/query and opens no mutation dialog', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('run-query'));
    await screen.findByTestId('result-grid');
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.post).mock.calls[0]![0]).toBe('/api/query');
    expect(previewMutation).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mutation-dialog')).toBeNull();
  });
});

describe('ExplorerPage schema panel', () => {
  it('resizes by dragging the handle, within limits, and remembers the width', () => {
    renderPage();
    expect(panel().style.width).toBe('256px');
    fireEvent.pointerDown(handle(), { clientX: 256 });
    fireEvent.pointerMove(window, { clientX: 356 });
    fireEvent.pointerUp(window);
    expect(panel().style.width).toBe('356px');
    expect(window.localStorage.getItem('dbx.schemaWidth')).toBe('356');
    fireEvent.pointerDown(handle(), { clientX: 356 });
    fireEvent.pointerMove(window, { clientX: 5000 });
    fireEvent.pointerUp(window);
    expect(panel().style.width).toBe(`${SCHEMA_WIDTH_MAX}px`);
    cleanup();
    renderPage();
    expect(panel().style.width).toBe(`${SCHEMA_WIDTH_MAX}px`);
  });

  it('saves the width once at the end of a drag, and stops on pointercancel', () => {
    renderPage();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const widthWrites = () => setItem.mock.calls.filter(([k]) => k === 'dbx.schemaWidth');
    fireEvent.pointerDown(handle(), { clientX: 256 });
    fireEvent.pointerMove(window, { clientX: 266 });
    fireEvent.pointerMove(window, { clientX: 276 });
    fireEvent.pointerMove(window, { clientX: 286 });
    expect(widthWrites()).toHaveLength(0);
    fireEvent.pointerCancel(window);
    expect(widthWrites()).toEqual([['dbx.schemaWidth', '286']]);
    // The cancelled drag left no listener behind.
    fireEvent.pointerMove(window, { clientX: 400 });
    expect(panel().style.width).toBe('286px');
  });

  it('caps the width at half a narrow window and reports that cap', () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
    try {
      renderPage();
      expect(handle().getAttribute('aria-valuemax')).toBe('300');
      fireEvent.keyDown(handle(), { key: 'End' });
      expect(panel().style.width).toBe('300px');
      expect(handle().getAttribute('aria-valuenow')).toBe('300');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
    }
  });

  it('resizes with the arrow keys and clamps at the minimum', () => {
    renderPage();
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(panel().style.width).toBe('272px');
    expect(handle().getAttribute('aria-valuenow')).toBe('272');
    fireEvent.keyDown(handle(), { key: 'Home' });
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(panel().style.width).toBe(`${SCHEMA_WIDTH_MIN}px`);
  });

  it('still works when web storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    renderPage();
    expect(panel().style.width).toBe('256px');
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(panel().style.width).toBe('272px');
  });

  it('collapses and reopens with the toggle', () => {
    renderPage();
    const toggle = screen.getByRole('button', { name: 'Painel de tabelas' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    expect(screen.queryByRole('complementary', { name: 'Schema' })).toBeNull();
    expect(screen.queryByRole('separator', { name: 'Redimensionar painel de tabelas' })).toBeNull();
    fireEvent.click(toggle);
    expect(panel()).toBeTruthy();
  });
});
