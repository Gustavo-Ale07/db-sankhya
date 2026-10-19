/**
 * Add-on Studio dbscript file (`V<n>.xml`, audit §3.3): one `<sql>` element per
 * statement, each with an `<oracle>` and an `<mssql>` body.
 *
 *   <?xml version="1.0" encoding="UTF-8"?>
 *   <scripts version="3">
 *     <sql nomeTabela="AD_X" ordem="1" executar="SE_NAO_EXISTIR" tipoObjeto="COLUNA" nomeObjeto="NOVO">
 *       <oracle>ALTER TABLE AD_X ADD (NOVO DATE)</oracle>
 *       <mssql>ALTER TABLE AD_X ADD NOVO DATETIME</mssql>
 *     </sql>
 *   </scripts>
 *
 * `tipoObjeto` is TABELA, COLUNA or CONSTRAINT. Bodies never contain `;`
 * (dbscripts must not end in one, and every identifier and default is validated
 * against an alphabet without it). Statements are emitted in a safe order:
 * renames, primary-key drop, field drops, field adds, field changes, defaults,
 * primary-key add. Description-only changes produce no statement (they belong
 * to the AutoDDL dictionary). Nothing here is ever executed by DB-Sankhya.
 */
import { AppError } from '@dbx/shared';
import { escapeXml } from './autoddl';
import type { DdlChange, DdlChangeKind } from './diff';
import {
  assertCustomTable,
  assertIdentifier,
  validateTableModel,
  type FieldModel,
  type ModelOptions,
  type TableModel,
} from './model';

export interface DbScriptOptions extends ModelOptions {
  /** The dbscript version, `n` in `V<n>.xml`; a positive integer. */
  version: number;
}

type Executar = 'SE_NAO_EXISTIR' | 'SE_EXISTIR' | 'SEMPRE';
type TipoObjeto = 'TABELA' | 'COLUNA' | 'CONSTRAINT';

interface Statement {
  phase: number;
  nomeTabela: string;
  executar: Executar;
  tipoObjeto: TipoObjeto;
  nomeObjeto: string;
  oracle: string;
  mssql: string;
}

const KINDS: readonly DdlChangeKind[] = [
  'CREATE_TABLE',
  'RENAME_TABLE',
  'ADD_FIELD',
  'DROP_FIELD',
  'RENAME_FIELD',
  'CHANGE_TYPE',
  'WIDEN_SIZE',
  'NARROW_SIZE',
  'CHANGE_REQUIRED',
  'CHANGE_DEFAULT',
  'CHANGE_DESCRIPTION',
  'CHANGE_PRIMARY_KEY',
];

const invalid = (message: string): AppError => new AppError('VALIDATION_ERROR', message);

function oracleType(f: FieldModel): string {
  switch (f.dataType) {
    case 'TEXTO':
      return `VARCHAR2(${f.size ?? 1})`;
    case 'INTEIRO':
      return `NUMBER(${f.size ?? 10})`;
    case 'DECIMAL':
      if (f.size === undefined) return 'NUMBER';
      return f.scale === undefined ? `NUMBER(${f.size})` : `NUMBER(${f.size},${f.scale})`;
    case 'DATA':
    case 'DATA_HORA':
    case 'HORA':
      return 'DATE';
    case 'CHECKBOX':
      return 'CHAR(1)';
    case 'CAIXA_TEXTO':
      return 'CLOB';
    case 'ARQUIVO':
      return 'BLOB';
  }
}

function mssqlType(f: FieldModel): string {
  switch (f.dataType) {
    case 'TEXTO':
      return `VARCHAR(${f.size ?? 1})`;
    case 'INTEIRO':
      return f.size === undefined ? 'INT' : `NUMERIC(${f.size},0)`;
    case 'DECIMAL':
      if (f.size === undefined) return 'FLOAT';
      return f.scale === undefined ? `DECIMAL(${f.size})` : `DECIMAL(${f.size},${f.scale})`;
    case 'DATA':
    case 'DATA_HORA':
    case 'HORA':
      return 'DATETIME';
    case 'CHECKBOX':
      return 'CHAR(1)';
    case 'CAIXA_TEXTO':
      return 'VARCHAR(MAX)';
    case 'ARQUIVO':
      return 'VARBINARY(MAX)';
  }
}

/** A validated default as a SQL literal (numbers bare, text single-quoted). */
function literal(f: FieldModel): string | undefined {
  if (f.default === undefined) return undefined;
  return f.dataType === 'INTEIRO' || f.dataType === 'DECIMAL' ? f.default : `'${f.default}'`;
}

function columnDef(f: FieldModel, type: string): string {
  const def = literal(f);
  return [f.name, type, def === undefined ? '' : `DEFAULT ${def}`, f.required ? 'NOT NULL' : '']
    .filter((s) => s !== '')
    .join(' ');
}

function sqlString(value: string): string {
  return `'${value}'`;
}

function mssqlDropPk(table: string): string {
  return (
    `DECLARE @pk SYSNAME SELECT @pk = name FROM sys.key_constraints ` +
    `WHERE parent_object_id = OBJECT_ID(${sqlString(table)}) AND type = 'PK' ` +
    `IF @pk IS NOT NULL EXEC('ALTER TABLE ${table} DROP CONSTRAINT ' + QUOTENAME(@pk))`
  );
}

function mssqlDropDefault(table: string, field: string): string {
  return (
    `DECLARE @df SYSNAME SELECT @df = dc.name FROM sys.default_constraints dc ` +
    `JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id ` +
    `WHERE dc.parent_object_id = OBJECT_ID(${sqlString(table)}) AND c.name = ${sqlString(field)} ` +
    `IF @df IS NOT NULL EXEC('ALTER TABLE ${table} DROP CONSTRAINT ' + QUOTENAME(@df))`
  );
}

function checkChange(change: DdlChange, opts: ModelOptions): DdlChange {
  if (typeof change !== 'object' || change === null || !KINDS.includes(change.kind)) {
    throw invalid('Unknown DDL change.');
  }
  const out: DdlChange = { ...change };
  if (change.field !== undefined) out.field = assertIdentifier(change.field, 'field');
  if (change.from !== undefined) {
    out.from =
      change.kind === 'RENAME_TABLE'
        ? assertCustomTable(change.from, opts.customPrefixes)
        : assertIdentifier(change.from, 'field');
  }
  return out;
}

function statementsFor(change: DdlChange, m: TableModel): Statement[] {
  const t = m.name;
  const fieldOf = (): FieldModel => {
    const f = m.fields.find((x) => x.name === change.field);
    if (!f) throw invalid(`${change.kind} refers to a field that is not in ${t}.`);
    return f;
  };
  const needField = (): string => {
    if (change.field === undefined) throw invalid(`${change.kind} needs a field.`);
    return change.field;
  };
  const needFrom = (): string => {
    if (change.from === undefined) throw invalid(`${change.kind} needs the previous name.`);
    return change.from;
  };
  const col = (
    phase: number,
    executar: Executar,
    nomeObjeto: string,
    oracle: string,
    mssql: string,
  ): Statement => ({
    phase,
    nomeTabela: t,
    executar,
    tipoObjeto: 'COLUNA',
    nomeObjeto,
    oracle,
    mssql,
  });

  switch (change.kind) {
    case 'CREATE_TABLE': {
      const pk = m.primaryKey.length > 0 ? `, PRIMARY KEY (${m.primaryKey.join(', ')})` : '';
      const body = (type: (f: FieldModel) => string): string =>
        `CREATE TABLE ${t} (${m.fields.map((f) => columnDef(f, type(f))).join(', ')}${pk})`;
      return [
        {
          phase: 0,
          nomeTabela: t,
          executar: 'SE_NAO_EXISTIR',
          tipoObjeto: 'TABELA',
          nomeObjeto: t,
          oracle: body(oracleType),
          mssql: body(mssqlType),
        },
      ];
    }
    case 'RENAME_TABLE': {
      const from = needFrom();
      return [
        {
          phase: 0,
          nomeTabela: from,
          executar: 'SE_EXISTIR',
          tipoObjeto: 'TABELA',
          nomeObjeto: from,
          oracle: `ALTER TABLE ${from} RENAME TO ${t}`,
          mssql: `EXEC sp_rename ${sqlString(from)}, ${sqlString(t)}`,
        },
      ];
    }
    case 'RENAME_FIELD': {
      const from = needFrom();
      const to = fieldOf().name;
      return [
        col(
          1,
          'SE_EXISTIR',
          from,
          `ALTER TABLE ${t} RENAME COLUMN ${from} TO ${to}`,
          `EXEC sp_rename ${sqlString(`${t}.${from}`)}, ${sqlString(to)}, 'COLUMN'`,
        ),
      ];
    }
    case 'DROP_FIELD': {
      const f = needField();
      return [
        col(
          3,
          'SE_EXISTIR',
          f,
          `ALTER TABLE ${t} DROP COLUMN ${f}`,
          `ALTER TABLE ${t} DROP COLUMN ${f}`,
        ),
      ];
    }
    case 'ADD_FIELD': {
      const f = fieldOf();
      return [
        col(
          4,
          'SE_NAO_EXISTIR',
          f.name,
          `ALTER TABLE ${t} ADD (${columnDef(f, oracleType(f))})`,
          `ALTER TABLE ${t} ADD ${columnDef(f, mssqlType(f))}`,
        ),
      ];
    }
    case 'CHANGE_TYPE':
    case 'WIDEN_SIZE':
    case 'NARROW_SIZE': {
      const f = fieldOf();
      const nullability = f.required ? 'NOT NULL' : 'NULL';
      return [
        col(
          5,
          'SE_EXISTIR',
          f.name,
          `ALTER TABLE ${t} MODIFY (${f.name} ${oracleType(f)})`,
          `ALTER TABLE ${t} ALTER COLUMN ${f.name} ${mssqlType(f)} ${nullability}`,
        ),
      ];
    }
    case 'CHANGE_REQUIRED': {
      const f = fieldOf();
      const nullability = f.required ? 'NOT NULL' : 'NULL';
      return [
        col(
          6,
          'SE_EXISTIR',
          f.name,
          `ALTER TABLE ${t} MODIFY (${f.name} ${nullability})`,
          `ALTER TABLE ${t} ALTER COLUMN ${f.name} ${mssqlType(f)} ${nullability}`,
        ),
      ];
    }
    case 'CHANGE_DEFAULT': {
      const f = fieldOf();
      const def = literal(f);
      const add = def === undefined ? '' : ` ALTER TABLE ${t} ADD DEFAULT ${def} FOR ${f.name}`;
      return [
        col(
          7,
          'SE_EXISTIR',
          f.name,
          `ALTER TABLE ${t} MODIFY (${f.name} DEFAULT ${def ?? 'NULL'})`,
          `${mssqlDropDefault(t, f.name)}${add}`,
        ),
      ];
    }
    case 'CHANGE_PRIMARY_KEY': {
      const out: Statement[] = [
        {
          phase: 2,
          nomeTabela: t,
          executar: 'SEMPRE',
          tipoObjeto: 'CONSTRAINT',
          nomeObjeto: t,
          oracle: `ALTER TABLE ${t} DROP PRIMARY KEY`,
          mssql: mssqlDropPk(t),
        },
      ];
      if (m.primaryKey.length > 0) {
        const add = `ALTER TABLE ${t} ADD PRIMARY KEY (${m.primaryKey.join(', ')})`;
        out.push({
          phase: 8,
          nomeTabela: t,
          executar: 'SEMPRE',
          tipoObjeto: 'CONSTRAINT',
          nomeObjeto: t,
          oracle: add,
          mssql: add,
        });
      }
      return out;
    }
    case 'CHANGE_DESCRIPTION':
      return [];
  }
}

export function toDbScriptXml(
  changes: DdlChange[],
  model: TableModel,
  opts: DbScriptOptions,
): string {
  const { version } = opts;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw invalid('The dbscript version must be a positive integer.');
  }
  if (!Array.isArray(changes)) throw invalid('changes must be an array.');
  const m = validateTableModel(model, opts);
  const statements = changes
    .map((c) => checkChange(c, opts))
    .flatMap((c) => statementsFor(c, m))
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.phase - b.s.phase || a.i - b.i)
    .map(({ s }) => s);
  if (statements.length === 0) throw invalid('There are no changes to script.');

  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<scripts version="${version}">`];
  statements.forEach((s, i) => {
    for (const body of [s.oracle, s.mssql]) {
      // Defence in depth: validated input can never produce a ';'.
      if (body.includes(';')) throw invalid('A generated statement contains ";".');
    }
    lines.push(
      `  <sql nomeTabela="${escapeXml(s.nomeTabela)}" ordem="${i + 1}" executar="${s.executar}" ` +
        `tipoObjeto="${s.tipoObjeto}" nomeObjeto="${escapeXml(s.nomeObjeto)}">`,
      `    <oracle>${escapeXml(s.oracle)}</oracle>`,
      `    <mssql>${escapeXml(s.mssql)}</mssql>`,
      '  </sql>',
    );
  });
  lines.push('</scripts>');
  return `${lines.join('\n')}\n`;
}
