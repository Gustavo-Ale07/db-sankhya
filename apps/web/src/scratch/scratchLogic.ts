/** Mirrors the server rule (SCRATCH_TABLE_NAME): the server stays the authority. */
export const SCRATCH_TABLE_NAME = /^tmp_[a-z0-9_]{1,59}$/;

export function isScratchTableName(name: string): boolean {
  return SCRATCH_TABLE_NAME.test(name);
}

/**
 * The materialize source: a SELECT is sent as typed (without a trailing `;`), and a bare
 * table name becomes `SELECT * FROM <name>`. Empty input yields null.
 */
export function sourceToSql(input: string): string | null {
  const text = input.trim().replace(/;\s*$/, '').trim();
  if (!text) return null;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return `SELECT * FROM ${text}`;
  return text;
}

export interface MaterializeResult {
  table: string;
  rows: number;
  truncated: boolean;
}

export function describeMaterialize(r: MaterializeResult): string {
  const n = `${r.rows} linha${r.rows === 1 ? '' : 's'}`;
  return r.truncated
    ? `Tabela ${r.table} criada com ${n} (truncado pelo limite de linhas da cópia).`
    : `Tabela ${r.table} criada com ${n}.`;
}
