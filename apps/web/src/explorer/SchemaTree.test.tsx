import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CatalogTable } from '../api/types';
import { SchemaTree } from './SchemaTree';

const TABLES: CatalogTable[] = [
  {
    name: 'TGFPAR',
    description: 'Parceiros',
    columns: [
      { name: 'CODPARC', type: 'NUMBER', pk: true },
      { name: 'NOMEPARC', type: 'VARCHAR', pk: false },
      { name: 'CODCID', type: 'NUMBER', pk: false },
    ],
    foreignKeys: [{ column: 'CODCID', refTable: 'TSICID', refColumn: 'CODCID' }],
  },
  {
    name: 'TGFPRO',
    columns: [{ name: 'CODPROD', type: 'NUMBER', pk: true }],
    foreignKeys: [],
  },
  {
    name: 'TSICID',
    columns: [{ name: 'NOMECID', type: 'VARCHAR', pk: false }],
    foreignKeys: [],
  },
];

function renderTree(...args: [CatalogTable[] | undefined] | []) {
  const tables = args.length === 0 ? TABLES : args[0];
  const onSelectQuery = vi.fn();
  const onInsertText = vi.fn();
  render(
    <SchemaTree
      tables={tables}
      loading={false}
      onSelectQuery={onSelectQuery}
      onInsertText={onInsertText}
    />,
  );
  return { onSelectQuery, onInsertText };
}

afterEach(cleanup);

describe('SchemaTree', () => {
  it('shows the "Tabelas" header with the number of tables it received', () => {
    renderTree();
    expect(screen.getByText('Tabelas')).toBeTruthy();
    expect(screen.getByTestId('schema-count').textContent).toBe('3');
  });

  it('renders only the tables the API returned', () => {
    renderTree([TABLES[1]!]);
    fireEvent.click(screen.getByTestId('schema-group-TGF'));
    const tree = screen.getByRole('tree', { name: 'Tabelas' });
    expect(within(tree).getByTestId('schema-table-TGFPRO')).toBeTruthy();
    expect(within(tree).queryByTestId('schema-table-TGFPAR')).toBeNull();
    expect(within(tree).queryByTestId('schema-group-TSI')).toBeNull();
    expect(screen.getByTestId('schema-count').textContent).toBe('1');
  });

  it('filters by table or column name and counts the visible tables', () => {
    renderTree();
    fireEvent.change(screen.getByPlaceholderText('Filtrar tabelas e colunas…'), {
      target: { value: 'nomecid' },
    });
    expect(screen.getByTestId('schema-table-TSICID')).toBeTruthy();
    expect(screen.queryByTestId('schema-table-TGFPAR')).toBeNull();
    expect(screen.getByTestId('schema-count').textContent).toBe('1/3');
  });

  it('expands a table to its columns and inserts a column name on click', () => {
    const { onInsertText, onSelectQuery } = renderTree();
    fireEvent.click(screen.getByTestId('schema-group-TGF'));
    expect(screen.queryByTestId('schema-columns-TGFPAR')).toBeNull();
    fireEvent.click(screen.getByTestId('schema-table-TGFPAR'));
    const cols = screen.getByTestId('schema-columns-TGFPAR');
    expect(within(cols).getAllByRole('listitem')).toHaveLength(3);
    expect(cols.textContent).toContain('NOMEPARC');
    fireEvent.click(within(cols).getByRole('button', { name: /NOMEPARC/ }));
    expect(onInsertText).toHaveBeenCalledWith('NOMEPARC');
    fireEvent.click(screen.getByRole('button', { name: 'Consultar TGFPAR (SELECT *)' }));
    expect(onSelectQuery).toHaveBeenCalledWith('SELECT *\nFROM TGFPAR', 'TGFPAR');
  });

  it('shows no count while the catalog is not loaded', () => {
    renderTree(undefined);
    expect(screen.queryByTestId('schema-count')).toBeNull();
    expect(screen.getByText('Nenhuma tabela encontrada.')).toBeTruthy();
  });
  describe('an incomplete catalog', () => {
    it('says so, lists what was lost in the title and reads the catalog again on demand', () => {
      const onRefresh = vi.fn();
      render(
        <SchemaTree
          tables={TABLES}
          loading={false}
          onSelectQuery={vi.fn()}
          onInsertText={vi.fn()}
          degraded={['TDDCAM:truncated', 'PK:failed']}
          onRefresh={onRefresh}
        />,
      );
      const badge = screen.getByTestId('schema-degraded');
      expect(badge.textContent).toContain('Catálogo incompleto');
      expect(badge.getAttribute('title')).toContain('TDDCAM:truncated');
      expect(badge.getAttribute('title')).toContain('PK:failed');
      fireEvent.click(screen.getByRole('button', { name: 'Recarregar catálogo' }));
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('disables the refresh button while the catalog is read again', () => {
      render(
        <SchemaTree
          tables={TABLES}
          loading={false}
          onSelectQuery={vi.fn()}
          onInsertText={vi.fn()}
          degraded={['TDDTAB:truncated']}
          onRefresh={vi.fn()}
          refreshing
        />,
      );
      const button = screen.getByRole('button', { name: 'Recarregar catálogo' });
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });

    it('shows nothing when the catalog is whole', () => {
      renderTree();
      expect(screen.queryByTestId('schema-degraded')).toBeNull();
    });
  });

  describe('with a catalog that lost columns (loadTable)', () => {
    const CUT: CatalogTable[] = [
      {
        name: 'TGFPAR',
        columns: [{ name: 'CODPARC', type: 'NUMBER', pk: true }],
        foreignKeys: [],
      },
    ];
    const FULL: CatalogTable = { ...TABLES[0]!, foreignKeys: [] };
    const expand = () => {
      fireEvent.click(screen.getByTestId('schema-group-TGF'));
      fireEvent.click(screen.getByTestId('schema-table-TGFPAR'));
    };
    const tree = (loadTable: (name: string) => Promise<CatalogTable>) => (
      <SchemaTree
        tables={CUT}
        loading={false}
        onSelectQuery={vi.fn()}
        onInsertText={vi.fn()}
        loadTable={loadTable}
      />
    );

    it('reads the columns of an expanded table on demand, once', async () => {
      const loadTable = vi.fn(() => Promise.resolve(FULL));
      render(tree(loadTable));
      expand();
      expect(screen.getByText('Carregando colunas…')).toBeTruthy();
      await waitFor(() =>
        expect(screen.getByTestId('schema-columns-TGFPAR').textContent).toContain('NOMEPARC'),
      );
      expect(loadTable).toHaveBeenCalledWith('TGFPAR');
      fireEvent.click(screen.getByTestId('schema-table-TGFPAR'));
      fireEvent.click(screen.getByTestId('schema-table-TGFPAR'));
      expect(loadTable).toHaveBeenCalledTimes(1);
    });

    it('shows an error instead of the partial column list when the read fails', async () => {
      render(tree(() => Promise.reject(new Error('boom'))));
      expand();
      await waitFor(() =>
        expect(screen.getByText('Não foi possível ler as colunas desta tabela.')).toBeTruthy(),
      );
      expect(screen.queryByTestId('schema-columns-TGFPAR')).toBeNull();
    });

    it('filters by the columns read on their own only, never by the partial list', async () => {
      render(tree(() => Promise.resolve(FULL)));
      const input = screen.getByLabelText('Filtrar tabelas') as HTMLInputElement;
      expect(input.placeholder).toMatch(/colunas só das tabelas abertas/);
      // CODPARC is in the partial list: matching it would hide the tables whose list lost theirs.
      fireEvent.change(input, { target: { value: 'CODPARC' } });
      expect(screen.queryByTestId('schema-table-TGFPAR')).toBeNull();
      fireEvent.change(input, { target: { value: 'tgfp' } });
      fireEvent.click(screen.getByTestId('schema-table-TGFPAR'));
      await waitFor(() =>
        expect(screen.getByTestId('schema-columns-TGFPAR').textContent).toContain('NOMEPARC'),
      );
      fireEvent.change(input, { target: { value: 'NOMEPARC' } });
      expect(screen.getByTestId('schema-table-TGFPAR')).toBeTruthy();
    });

    it('never shows the columns another connection answered', async () => {
      let answer!: (t: CatalogTable) => void;
      const first = vi.fn(() => new Promise<CatalogTable>((resolve) => (answer = resolve)));
      const { rerender } = render(tree(first));
      expand();
      const second = vi.fn(() => Promise.resolve({ ...FULL, columns: [FULL.columns[0]!] }));
      rerender(tree(second));
      answer(FULL);
      await waitFor(() => expect(second).toHaveBeenCalledWith('TGFPAR'));
      await waitFor(() => expect(screen.queryByText('Carregando colunas…')).toBeNull());
      expect(screen.getByTestId('schema-columns-TGFPAR').textContent).not.toContain('NOMEPARC');
    });
  });
});

describe('SchemaTree "Temporárias (tmp_*)" group', () => {
  const SCRATCH = {
    ttlMinutes: 60,
    tables: [
      {
        name: 'tmp_p',
        rows: 5,
        columns: [
          { name: 'codparc', type: 'integer' },
          { name: 'nomeparc', type: 'text' },
        ],
      },
    ],
  };

  it('comes first, says it is yours and when it goes, and lists rows and columns', () => {
    const loadTable = vi.fn();
    const onSelectQuery = vi.fn();
    render(
      <SchemaTree
        tables={TABLES}
        loading={false}
        onSelectQuery={onSelectQuery}
        onInsertText={() => {}}
        loadTable={loadTable}
        scratch={SCRATCH}
      />,
    );
    const groups = screen.getAllByRole('group');
    expect(groups[0]!.getAttribute('aria-label')).toBe('Temporárias (tmp_*)');
    expect(screen.getByTestId('schema-scratch-note').textContent).toBe(
      'Só sua; apagada após 60 min de inatividade.',
    );
    expect(screen.getByTestId('schema-scratch-rows-tmp_p').textContent).toBe('5 linhas');
    fireEvent.click(screen.getByTestId('schema-table-tmp_p'));
    const cols = screen.getByTestId('schema-columns-tmp_p').textContent;
    expect(cols).toContain('codparc');
    expect(cols).toContain('integer');
    // A tmp_ table is never read from the Sankhya dictionary.
    expect(loadTable).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByTestId('schema-table-tmp_p'));
    expect(onSelectQuery).toHaveBeenCalledWith('SELECT *\nFROM tmp_p', 'tmp_p');
  });

  it('shows the group empty, with a hint, when there is no tmp_ table', () => {
    render(
      <SchemaTree
        tables={TABLES}
        loading={false}
        onSelectQuery={() => {}}
        onInsertText={() => {}}
        scratch={{ ttlMinutes: 30, tables: [] }}
      />,
    );
    expect(screen.getByTestId('schema-scratch-empty').textContent).toContain('CREATE TABLE tmp_');
  });

  it('filters tmp_ tables like the others', () => {
    render(
      <SchemaTree
        tables={TABLES}
        loading={false}
        onSelectQuery={() => {}}
        onInsertText={() => {}}
        scratch={SCRATCH}
      />,
    );
    fireEvent.change(screen.getByLabelText('Filtrar tabelas'), { target: { value: 'TGFPRO' } });
    expect(screen.queryByTestId('schema-table-tmp_p')).toBeNull();
    fireEvent.change(screen.getByLabelText('Filtrar tabelas'), { target: { value: 'nomeparc' } });
    expect(screen.getByTestId('schema-table-tmp_p')).toBeTruthy();
  });
});
