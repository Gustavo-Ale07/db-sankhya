import { describe, expect, it } from 'vitest';
import { parseSql, statementKind } from './parser';
import type { SelectStatement } from './ast';

const sel = (sql: string) => parseSql(sql) as SelectStatement;
const code = (sql: string) => {
  try {
    parseSql(sql);
  } catch (e) {
    return (e as { code: string }).code;
  }
  return 'OK';
};

describe('parseSql', () => {
  it('parses SHOW / DESCRIBE forms', () => {
    expect(parseSql('SHOW TABLES')).toEqual({ type: 'showTables' });
    expect(parseSql('show columns from Clientes;')).toEqual({
      type: 'describe',
      table: 'clientes',
    });
    expect(parseSql('DESCRIBE produtos')).toEqual({ type: 'describe', table: 'produtos' });
    expect(parseSql('desc `estoque`')).toEqual({ type: 'describe', table: 'estoque' });
    expect(code('SHOW DATABASES')).toBe('SQL_PARSE_ERROR');
  });

  it('parses a SELECT with aliases, where, order and limit', () => {
    const s = sel(
      "SELECT c.codigo_cliente_id AS id, razao_social FROM clientes c WHERE estado = 'SP' AND inativo <> 'S' ORDER BY razao_social DESC LIMIT 10 OFFSET 20",
    );
    expect(s.from).toEqual({ name: 'clientes', alias: 'c' });
    expect(s.columns[0]).toMatchObject({
      kind: 'expr',
      alias: 'id',
      expr: { kind: 'column', table: 'c', name: 'codigo_cliente_id' },
    });
    expect(s.where).toMatchObject({ kind: 'and' });
    expect(s.orderBy).toEqual([{ expr: { kind: 'column', name: 'razao_social' }, desc: true }]);
    expect(s.limit).toBe(10);
    expect(s.offset).toBe(20);
  });

  it('handles MySQL LIMIT offset, count', () => {
    const s = sel('SELECT * FROM clientes LIMIT 5, 10');
    expect(s.limit).toBe(10);
    expect(s.offset).toBe(5);
  });

  it('parses IN, BETWEEN, LIKE ESCAPE, IS NULL and NOT', () => {
    const s = sel(
      "SELECT * FROM produtos WHERE codigo IN ('A', 'B') AND valor_unitario BETWEEN 1 AND 2.5 AND descricao LIKE 'x!%%' ESCAPE '!' AND ncm IS NOT NULL AND NOT (inativo = 'S')",
    );
    const text = JSON.stringify(s.where);
    expect(text).toContain('"kind":"in"');
    expect(text).toContain('"kind":"between"');
    expect(text).toContain('"escape":"!"');
    expect(text).toContain('"kind":"isNull","expr":{"kind":"column","name":"ncm"},"negated":true');
    expect(text).toContain('"kind":"not"');
  });

  it('parses aggregates, group by and having', () => {
    const s = sel(
      'SELECT estado, COUNT(*) AS n, SUM(valor_limite_credito) FROM clientes GROUP BY estado HAVING COUNT(*) > 2 ORDER BY 2 DESC',
    );
    expect(s.columns[1]).toMatchObject({
      expr: { kind: 'aggregate', fn: 'COUNT', arg: '*' },
      alias: 'n',
    });
    expect(s.groupBy).toEqual([{ kind: 'column', name: 'estado' }]);
    expect(s.having).toMatchObject({ kind: 'compare', op: '>' });
    expect(s.orderBy[0]).toEqual({ expr: { kind: 'position', index: 2 }, desc: true });
    expect(sel('SELECT COUNT(DISTINCT estado) FROM clientes').columns[0]).toMatchObject({
      expr: { distinct: true },
    });
  });

  it('parses joins', () => {
    const s = sel(
      'SELECT p.numero_pedido, c.razao_social FROM pedidos_venda p LEFT JOIN clientes c ON c.codigo_cliente_id = p.codigo_cliente',
    );
    expect(s.joins).toHaveLength(1);
    expect(s.joins[0]).toMatchObject({
      type: 'LEFT',
      table: { name: 'clientes', alias: 'c' },
      on: { kind: 'compare', op: '=' },
    });
    expect(sel('SELECT * FROM a JOIN b ON a.x = b.y').joins[0]!.type).toBe('INNER');
  });

  it('unescapes string literals', () => {
    const s = sel(
      "SELECT * FROM clientes WHERE razao_social = 'D''Avila' OR razao_social = 'O\\'Neil'",
    );
    expect(JSON.stringify(s.where)).toContain("D'Avila");
    expect(JSON.stringify(s.where)).toContain("O'Neil");
  });

  it('supports SELECT without FROM and arithmetic', () => {
    const s = sel('SELECT 1 + 1 AS dois, -3');
    expect(s.from).toBeUndefined();
    expect(s.columns[0]).toMatchObject({ alias: 'dois', expr: { kind: 'arith', op: '+' } });
    expect(s.columns[1]).toMatchObject({ expr: { kind: 'literal', value: -3 } });
  });

  it('parses INSERT, UPDATE and DELETE', () => {
    expect(
      parseSql(
        "INSERT INTO clientes (codigo_cliente_integracao, razao_social) VALUES ('X1', 'Empresa')",
      ),
    ).toEqual({
      type: 'insert',
      table: 'clientes',
      columns: ['codigo_cliente_integracao', 'razao_social'],
      values: [
        { kind: 'literal', value: 'X1' },
        { kind: 'literal', value: 'Empresa' },
      ],
    });
    expect(
      parseSql("UPDATE clientes SET cidade = 'Campinas' WHERE codigo_cliente_id = 1"),
    ).toMatchObject({
      type: 'update',
      table: { name: 'clientes' },
      set: [{ column: 'cidade', value: { kind: 'literal', value: 'Campinas' } }],
      where: { kind: 'compare' },
    });
    expect(parseSql('DELETE FROM clientes WHERE codigo_cliente_id = 1')).toMatchObject({
      type: 'delete',
      table: { name: 'clientes' },
    });
    expect(parseSql('UPDATE clientes SET cidade = 1')).not.toHaveProperty('where');
  });

  it('parses EXPLAIN', () => {
    expect(parseSql('EXPLAIN SELECT * FROM clientes')).toMatchObject({
      type: 'explain',
      statement: { type: 'select' },
    });
    expect(
      parseSql("explain update clientes set cidade='x' where codigo_cliente_id=1"),
    ).toMatchObject({
      type: 'explain',
      statement: { type: 'update' },
    });
    expect(code('EXPLAIN SHOW TABLES')).toBe('SQL_UNSUPPORTED');
    expect(code('EXPLAIN')).toBe('SQL_PARSE_ERROR');
  });

  it('rejects transactions, DDL and multiple statements', () => {
    for (const s of ['BEGIN', 'START TRANSACTION', 'COMMIT', 'ROLLBACK', 'SAVEPOINT a'])
      expect(code(s)).toBe('SQL_UNSUPPORTED');
    for (const s of [
      'CREATE TABLE x (a int)',
      'DROP TABLE clientes',
      'ALTER TABLE clientes ADD x int',
      'TRUNCATE clientes',
    ]) {
      expect(code(s)).toBe('SQL_UNSUPPORTED');
    }
    expect(code('SELECT 1; SELECT 2')).toBe('SQL_UNSUPPORTED');
    expect(code('SELECT 1; DROP TABLE clientes')).toBe('SQL_UNSUPPORTED');
    expect(code('SELECT 1;;')).toBe('OK');
    expect(code('GRANT ALL ON x TO y')).toBe('SQL_UNSUPPORTED');
  });

  it('rejects unsupported SQL features', () => {
    const cases = [
      'SELECT * FROM (SELECT * FROM clientes) t',
      'SELECT * FROM clientes WHERE codigo_cliente_id IN (SELECT codigo_cliente FROM pedidos_venda)',
      'SELECT * FROM clientes UNION SELECT * FROM clientes',
      'WITH t AS (SELECT 1) SELECT * FROM t',
      'SELECT UPPER(razao_social) FROM clientes',
      'SELECT CASE WHEN 1 = 1 THEN 1 END FROM clientes',
      'SELECT CAST(1 AS CHAR) FROM clientes',
      'SELECT * FROM clientes, produtos',
      'SELECT * FROM clientes RIGHT JOIN produtos ON 1 = 1',
      'SELECT * FROM clientes CROSS JOIN produtos',
      'SELECT * FROM db.clientes',
      'SELECT * FROM clientes WHERE codigo_cliente_id = ?',
      'SELECT * FROM clientes WHERE inativo IS TRUE',
      "INSERT INTO clientes VALUES ('a')",
      "INSERT INTO clientes (razao_social) VALUES ('a'), ('b')",
      'INSERT INTO clientes (razao_social) SELECT razao_social FROM clientes',
      'UPDATE clientes SET cidade = 1 LIMIT 1',
      'SELECT * FROM clientes FOR UPDATE',
    ];
    for (const s of cases) expect([s, code(s)]).toEqual([s, 'SQL_UNSUPPORTED']);
  });

  it('reports syntax errors with location', () => {
    let err: unknown;
    try {
      parseSql('SELECT FROM WHERE');
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'SQL_PARSE_ERROR', details: { line: 1 } });
    expect(code("SELECT 'abc")).toBe('SQL_PARSE_ERROR');
    expect(code('SELECT /* x')).toBe('SQL_PARSE_ERROR');
    expect(code('')).toBe('SQL_PARSE_ERROR');
    expect(code('   -- only a comment')).toBe('SQL_PARSE_ERROR');
    expect(code('SELECT 1 '.repeat(5000))).toBe('SQL_PARSE_ERROR');
  });

  it('classifies statement kinds', () => {
    expect(statementKind(parseSql('SELECT 1'))).toBe('SELECT');
    expect(statementKind(parseSql('SHOW TABLES'))).toBe('SHOW');
    expect(statementKind(parseSql('DESC clientes'))).toBe('DESCRIBE');
    expect(statementKind(parseSql('EXPLAIN SELECT 1'))).toBe('EXPLAIN');
    expect(statementKind(parseSql('DELETE FROM x WHERE a = 1'))).toBe('DELETE');
  });
});
