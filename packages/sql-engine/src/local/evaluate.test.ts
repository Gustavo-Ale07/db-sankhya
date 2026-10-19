import { describe, expect, it } from 'vitest';
import { isAppError } from '@dbx/shared';
import type { SelectStatement } from '../ast';
import { parseSql } from '../parser';
import type { Row } from '../values';
import { DEFAULT_LOCAL_LIMITS, evaluateSelect } from './evaluate';
import type { LocalLimits, LocalSource, QueryResult } from './evaluate';

const ESTADOS = ['SP', 'RJ', 'MG', 'PR', 'Ácre'];

function clientes(): LocalSource {
  const rows: Row[] = [];
  for (let i = 1; i <= 60; i++) {
    rows.push([
      i,
      `Cliente ${String(i).padStart(2, '0')}`,
      ESTADOS[i % ESTADOS.length] as string,
      i % 7 === 0 ? null : i * 100.5,
    ]);
  }
  return {
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'nome', type: 'string' },
      { name: 'estado', type: 'string' },
      { name: 'limite', type: 'number' },
    ],
    rows,
  };
}

const produtos: LocalSource = {
  columns: [
    { name: 'codigo', type: 'integer' },
    { name: 'descricao', type: 'string' },
    { name: 'preco', type: 'number' },
    { name: 'detalhe', type: 'string' },
  ],
  rows: [
    [1, 'Parafuso sextavado', 12.5, 'aço'],
    [2, 'Parafuso fenda', 20, null],
    [3, 'Porca', 8, '<script>alert(1)</script>'],
    [4, 'parafuso longo', 49.9, null],
    [5, 'Arruela', 60, null],
  ],
};

const pedidos: LocalSource = {
  columns: [
    { name: 'numero', type: 'integer' },
    { name: 'cliente_id', type: 'integer' },
    { name: 'faturado_em', type: 'date' },
  ],
  rows: [
    [100, 1, '2026-06-01'],
    [101, 2, null],
    [102, 1, null],
    [103, 999, '2026-06-03'],
  ],
};

function run(sql: string, limits?: Partial<LocalLimits>): QueryResult {
  return evaluateSelect(
    parseSql(sql) as SelectStatement,
    { clientes: clientes(), produtos, pedidos },
    { ...DEFAULT_LOCAL_LIMITS, ...limits },
  );
}

function errorOf(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (err) {
    if (isAppError(err)) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error('expected an error');
}

const col = (r: QueryResult, name: string) => {
  const i = r.columns.findIndex((c) => c.name === name);
  return r.rows.map((row) => row[i]);
};

describe('evaluateSelect · binding', () => {
  it('suggests a table name for typos', () => {
    const e = errorOf(() => run('SELECT * FROM cliente'));
    expect(e.code).toBe('RESOURCE_NOT_FOUND');
    expect(e.message).toContain('Did you mean "clientes"');
  });

  it('matches table names case-insensitively', () => {
    expect(run('SELECT COUNT(*) FROM CLIENTES').rows).toEqual([[60]]);
  });

  it('reports unknown and ambiguous columns', () => {
    expect(errorOf(() => run('SELECT nmoe FROM clientes')).message).toContain('nome');
    const amb = errorOf(() => run('SELECT id FROM clientes c JOIN clientes d ON d.id = c.id'));
    expect(amb.code).toBe('AMBIGUOUS_COLUMN');
  });

  it('returns the declared columns and no rows for SELECT * over an empty source', () => {
    const vazio: LocalSource = {
      columns: [
        { name: 'codigo', type: 'integer' },
        { name: 'nome', type: 'string' },
      ],
      rows: [],
    };
    const r = evaluateSelect(
      parseSql('SELECT * FROM vazio') as SelectStatement,
      { vazio },
      DEFAULT_LOCAL_LIMITS,
    );
    expect(r.columns.map((c) => c.name)).toEqual(['codigo', 'nome']);
    expect(r.rows).toEqual([]);
    expect(r.rowCount).toBe(0);
  });

  it('evaluates a SELECT without FROM as a single row', () => {
    const r = evaluateSelect(parseSql('SELECT 1 + 1 AS x') as SelectStatement, {});
    expect(r.columns.map((c) => c.name)).toEqual(['x']);
    expect(r.rows).toEqual([[2]]);
  });

  it('rejects a repeated alias', () => {
    expect(errorOf(() => run('SELECT 1 FROM clientes JOIN clientes ON 1 = 1')).code).toBe(
      'SQL_UNSUPPORTED',
    );
  });
});

describe('evaluateSelect · SQL semantics', () => {
  it('filters with three-valued logic, BETWEEN, LIKE and NOT IN', () => {
    const r = run(
      "SELECT codigo, descricao, preco FROM produtos WHERE preco BETWEEN 10 AND 50 AND descricao LIKE 'parafuso%' AND codigo NOT IN (2)",
    );
    expect(col(r, 'codigo')).toEqual([1, 4]);
    const nulls = run('SELECT COUNT(*) FROM pedidos WHERE faturado_em IS NULL');
    const notNulls = run('SELECT COUNT(*) FROM pedidos WHERE faturado_em IS NOT NULL');
    expect(nulls.rows).toEqual([[2]]);
    expect(notNulls.rows).toEqual([[2]]);
    expect(run('SELECT codigo FROM produtos WHERE detalhe <> 1 OR detalhe = 1').rowCount).toBe(2);
  });

  it('groups, aggregates, filters with HAVING and orders by alias', () => {
    const r = run(
      'SELECT estado, COUNT(*) AS n, AVG(limite) media, MAX(nome) FROM clientes GROUP BY estado HAVING COUNT(*) >= 12 ORDER BY n DESC, estado',
    );
    const ns = col(r, 'n') as number[];
    expect(ns.every((n) => n >= 12)).toBe(true);
    expect([...ns].sort((a, b) => b - a)).toEqual(ns);
    expect(r.columns.map((c) => c.name)).toEqual(['estado', 'n', 'media', 'MAX(nome)']);
    expect(r.rowCount).toBe(5);
  });

  it('returns one row for aggregates over an empty set', () => {
    expect(run("SELECT COUNT(*), SUM(limite) FROM clientes WHERE estado = 'XX'").rows).toEqual([
      [0, null],
    ]);
  });

  it('rejects non-grouped columns and aggregates in WHERE', () => {
    expect(
      errorOf(() => run('SELECT estado, nome, COUNT(*) FROM clientes GROUP BY estado')).code,
    ).toBe('SQL_UNSUPPORTED');
    expect(errorOf(() => run('SELECT * FROM clientes WHERE COUNT(*) > 1')).code).toBe(
      'SQL_UNSUPPORTED',
    );
    expect(errorOf(() => run('SELECT *, COUNT(*) FROM clientes')).code).toBe('SQL_UNSUPPORTED');
  });

  it('applies DISTINCT, ORDER BY with pt-BR collation, OFFSET and LIMIT', () => {
    const all = run('SELECT DISTINCT estado FROM clientes ORDER BY estado');
    const states = col(all, 'estado') as string[];
    expect(states).toEqual(['Ácre', 'MG', 'PR', 'RJ', 'SP']);
    const page = run('SELECT DISTINCT estado FROM clientes ORDER BY estado LIMIT 2 OFFSET 1');
    expect(col(page, 'estado')).toEqual(states.slice(1, 3));
  });

  it('evaluates arithmetic without floating-point noise', () => {
    expect(run('SELECT 0.1 + 0.2 AS x, 10 / 4 AS y, 1 / 0 AS z').rows).toEqual([[0.3, 2.5, null]]);
  });

  it('keeps HTML-like content only as data (no interpretation)', () => {
    const r = run("SELECT detalhe FROM produtos WHERE detalhe LIKE '%<script>%'");
    expect(r.rows).toEqual([['<script>alert(1)</script>']]);
  });
});

describe('evaluateSelect · joins', () => {
  it('joins on an equality and keeps unmatched rows in LEFT JOIN', () => {
    const inner = run(
      'SELECT p.numero, c.nome FROM pedidos p INNER JOIN clientes c ON c.id = p.cliente_id ORDER BY 1',
    );
    expect(inner.rows).toEqual([
      [100, 'Cliente 01'],
      [101, 'Cliente 02'],
      [102, 'Cliente 01'],
    ]);
    const left = run(
      'SELECT p.numero, c.nome FROM pedidos p LEFT JOIN clientes c ON c.id = p.cliente_id ORDER BY 1',
    );
    expect(left.rows.at(-1)).toEqual([103, null]);
    expect(left.rowCount).toBe(pedidos.rows.length);
  });

  it('evaluates non-equality ON conditions', () => {
    const r = run(
      'SELECT a.codigo, b.codigo FROM produtos a JOIN produtos b ON b.preco > a.preco WHERE a.codigo = 5',
    );
    expect(r.rowCount).toBe(0);
  });

  it('fails with JOIN_CARDINALITY_LIMIT on the output-row cap instead of silently truncating', () => {
    const e = errorOf(() =>
      run('SELECT a.id FROM clientes a JOIN clientes b ON a.estado = b.estado', {
        maxMaterializedRows: 100,
      }),
    );
    expect(e.code).toBe('JOIN_CARDINALITY_LIMIT');
    expect(e.message).toContain('produces more than 100 rows');
  });

  it('fails with JOIN_CARDINALITY_LIMIT on the pair cap for a join without equality', () => {
    // 60 x 60 = 3600 pairs > 20 x 100.
    const e = errorOf(() =>
      run('SELECT a.id FROM clientes a JOIN clientes b ON a.id < b.id', {
        maxMaterializedRows: 100,
      }),
    );
    expect(e.code).toBe('JOIN_CARDINALITY_LIMIT');
    expect(e.message).toContain('too many row pairs');
  });
});

describe('evaluateSelect · limits', () => {
  it('applies the implicit row limit and flags truncation', () => {
    const r = run('SELECT id FROM clientes', { maxRows: 50 });
    expect(r.rowCount).toBe(50);
    expect(r.truncated).toBe(true);
    expect(r.messages.join(' ')).toContain('truncated');
  });

  it('rejects a LIMIT above the row cap', () => {
    expect(errorOf(() => run('SELECT * FROM clientes LIMIT 51', { maxRows: 50 })).code).toBe(
      'QUERY_ROW_LIMIT_EXCEEDED',
    );
  });

  it('fails when a source is larger than the materialization cap', () => {
    expect(
      errorOf(() => run('SELECT COUNT(*) FROM clientes', { maxMaterializedRows: 10 })).code,
    ).toBe('QUERY_LIMIT_EXCEEDED');
  });
});
