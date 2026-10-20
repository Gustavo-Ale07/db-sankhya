import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
});
