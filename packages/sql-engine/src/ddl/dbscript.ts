/**
 * Add-on Studio dbscript file (`V<n>.xml`, audit §3.3): one `<sql>` element per
 * statement, each with an `<oracle>` and an `<mssql>` body in a CDATA section.
 *
 *   <?xml version="1.0" encoding="UTF-8"?>
 *   <scripts version="3">
 *     <sql nomeTabela="AD_X" ordem="1" executar="SE_NAO_EXISTIR" tipoObjeto="COLUNA" nomeObjeto="NOVO">
 *       <oracle><![CDATA[ALTER TABLE AD_X ADD (NOVO DATE)]]></oracle>
 *       <mssql><![CDATA[ALTER TABLE AD_X ADD NOVO DATETIME]]></mssql>
 *     </sql>
 *   </scripts>
 *
 * `toDbScriptXml` takes the current and the desired model and computes the
 * changes itself (a caller's change list is never trusted). `tipoObjeto` is
 * TABELA, COLUNA or CONSTRAINT. The raw file never contains `;`: bodies are
 * built only from validated identifiers and defaults, and are checked again
 * before they are written. Statements are emitted in a safe order: renames,
 * primary-key drop, field drops, field adds, field changes, defaults,
 * primary-key add. Description-only changes produce no statement (they belong
 * to the AutoDDL dictionary). Changes that the target databases cannot apply
 * in place are refused with SQL_UNSUPPORTED instead of producing a script that
 * fails half-way. Nothing here is ever executed by DB-Sankhya.
 */
import { AppError } from '@dbx/shared';
import { escapeXml } from './autoddl';
import { diffTable, type DdlChange, type DdlSeverity } from './diff';
import { validateTableModel, type FieldModel, type ModelOptions, type TableModel } from './model';

export interface DbScriptOptions extends ModelOptions {
  /** The dbscript version, `n` in `V<n>.xml`; a positive integer. */
  version: number;
}

export interface DbScriptResult {
  xml: string;
  /** The worst severity of the computed changes. */
  severity: DdlSeverity;
  /** The changes the script applies, as computed by `diffTable`. */
  changes: DdlChange[];
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

/** What the statement builders need besides the change itself. */
interface Context {
  desired: TableModel;
  /** Current fields keyed by their name in the desired model (renames applied). */
  currentByNewName: Map<string, FieldModel>;
  /** The current primary key, in desired-model names. */
  currentPrimaryKey: string[];
  /** Whether the change list drops the primary key before altering columns. */
  dropsPrimaryKey: boolean;
}

const invalid = (message: string): AppError => new AppError('VALIDATION_ERROR', message);
const unsupported = (message: string): AppError => new AppError('SQL_UNSUPPORTED', message);

/** Wraps a statement body in CDATA; refuses text that would end the section or contains `;`. */
export function cdata(body: string): string {
  if (body.includes(']]>')) throw invalid('A generated statement contains "]]>".');
  // Defence in depth: validated input can never produce a ';'.
  if (body.includes(';')) throw invalid('A generated statement contains ";".');
  return `<![CDATA[${body}]]>`;
}

function oracleType(f: FieldModel): string {
  switch (f.dataType) {
    case 'TEXTO':
      return `VARCHAR2(${f.size ?? 1})`;
    case 'INTEIRO':
      return `NUMBER(${f.size ?? 10})`;
    case 'DECIMAL':
      return `NUMBER(${f.size ?? 10},${f.scale ?? 0})`;
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
      return `DECIMAL(${f.size ?? 10},${f.scale ?? 0})`;
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

/**
 * Runs `ALTER TABLE <table> DROP CONSTRAINT <name>` for a constraint name found
 * at run time. The statement is built into a variable first: T-SQL does not
 * accept a function call such as QUOTENAME inside EXEC('…').
 */
function mssqlDropNamedConstraint(variable: string, table: string, lookup: string): string {
  return (
    `DECLARE @${variable} SYSNAME, @sql NVARCHAR(400) ${lookup} ` +
    `IF @${variable} IS NOT NULL BEGIN ` +
    `SET @sql = N'ALTER TABLE ${table} DROP CONSTRAINT ' + QUOTENAME(@${variable}) ` +
    'EXEC(@sql) END'
  );
}

function mssqlDropPk(table: string): string {
  return mssqlDropNamedConstraint(
    'pk',
    table,
    `SELECT @pk = name FROM sys.key_constraints ` +
      `WHERE parent_object_id = OBJECT_ID(${sqlString(table)}) AND type = 'PK'`,
  );
}

function mssqlDropDefault(table: string, field: string): string {
  return mssqlDropNamedConstraint(
    'df',
    table,
    `SELECT @df = dc.name FROM sys.default_constraints dc ` +
      `JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id ` +
      `WHERE dc.parent_object_id = OBJECT_ID(${sqlString(table)}) AND c.name = ${sqlString(field)}`,
  );
}

/** The MSSQL type without its size part: INT, NUMERIC, DECIMAL, VARCHAR, ... */
function mssqlBaseType(f: FieldModel): string {
  return mssqlType(f).replace(/\(.*\)$/, '');
}

const LOB_TYPES: ReadonlySet<string> = new Set(['CAIXA_TEXTO', 'ARQUIVO']);

/** Refuses column alterations that Oracle or SQL Server cannot apply in place. */
function assertAlterable(change: DdlChange, f: FieldModel, ctx: Context): void {
  const before = ctx.currentByNewName.get(f.name);
  if (change.kind === 'CHANGE_TYPE' && before) {
    if (LOB_TYPES.has(before.dataType) || LOB_TYPES.has(f.dataType)) {
      throw unsupported(
        `Changing ${f.name} from ${before.dataType} to ${f.dataType} is not supported: Oracle ` +
          'cannot MODIFY a column to or from CLOB/BLOB. Add a new field and migrate the data.',
      );
    }
  }
  if (
    before &&
    (change.kind === 'CHANGE_TYPE' ||
      ((change.kind === 'WIDEN_SIZE' || change.kind === 'NARROW_SIZE') &&
        mssqlBaseType(before) !== mssqlBaseType(f))) &&
    (before.default !== undefined || f.default !== undefined)
  ) {
    // e.g. an unsized INTEIRO (INT) becoming sized (NUMERIC(n,0)) is a base-type change.
    throw unsupported(
      `Changing ${f.name} from SQL Server ${mssqlType(before)} to ${mssqlType(f)} is not ` +
        'supported while it has a default: SQL Server refuses ALTER COLUMN to another type on a ' +
        'column bound to a default constraint. Remove the default first.',
    );
  }
  if (ctx.currentPrimaryKey.includes(f.name) && !ctx.dropsPrimaryKey) {
    throw unsupported(
      `Altering ${f.name} is not supported while it is part of the primary key: SQL Server ` +
        'refuses ALTER COLUMN on a primary-key column. Change the primary key in the same script.',
    );
  }
}

function statementsFor(change: DdlChange, ctx: Context): Statement[] {
  const m = ctx.desired;
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
          `${mssqlDropDefault(t, f)} ALTER TABLE ${t} DROP COLUMN ${f}`,
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
      assertAlterable(change, f, ctx);
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
      assertAlterable(change, f, ctx);
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
      const out: Statement[] = [];
      if ((change.previousPrimaryKey ?? []).length > 0) {
        out.push({
          phase: 2,
          nomeTabela: t,
          executar: 'SEMPRE',
          tipoObjeto: 'CONSTRAINT',
          nomeObjeto: t,
          oracle: `ALTER TABLE ${t} DROP PRIMARY KEY`,
          mssql: mssqlDropPk(t),
        });
      }
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

/**
 * Builds the dbscript that turns `current` (null for a new table) into
 * `desired`. Both models are validated; the changes come from `diffTable`.
 */
export function toDbScriptXml(
  current: TableModel | null,
  desired: TableModel,
  opts: DbScriptOptions,
): DbScriptResult {
  const { version } = opts;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw invalid('The dbscript version must be a positive integer.');
  }
  const cur = current === null ? null : validateTableModel(current, opts);
  const m = validateTableModel(desired, opts);
  const { changes, severity } = diffTable(cur, m);

  const renamedTo = new Map<string, string>();
  for (const c of changes) {
    if (c.kind === 'RENAME_FIELD' && c.from !== undefined && c.field !== undefined) {
      renamedTo.set(c.from, c.field);
    }
  }
  const ctx: Context = {
    desired: m,
    currentByNewName: new Map(
      (cur?.fields ?? []).map((f) => [renamedTo.get(f.name) ?? f.name, f] as const),
    ),
    currentPrimaryKey: (cur?.primaryKey ?? []).map((k) => renamedTo.get(k) ?? k),
    dropsPrimaryKey: changes.some(
      (c) => c.kind === 'CHANGE_PRIMARY_KEY' && (c.previousPrimaryKey ?? []).length > 0,
    ),
  };

  const statements = changes
    .flatMap((c) => statementsFor(c, ctx))
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.phase - b.s.phase || a.i - b.i)
    .map(({ s }) => s);
  if (statements.length === 0) throw invalid('There are no changes to script.');

  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<scripts version="${version}">`];
  statements.forEach((s, i) => {
    lines.push(
      `  <sql nomeTabela="${escapeXml(s.nomeTabela)}" ordem="${i + 1}" executar="${s.executar}" ` +
        `tipoObjeto="${s.tipoObjeto}" nomeObjeto="${escapeXml(s.nomeObjeto)}">`,
      `    <oracle>${cdata(s.oracle)}</oracle>`,
      `    <mssql>${cdata(s.mssql)}</mssql>`,
      '  </sql>',
    );
  });
  lines.push('</scripts>');
  const xml = `${lines.join('\n')}\n`;
  // Defence in depth: attributes are escaped, so the only ';' could come from an entity.
  if (xml.replace(/&(amp|lt|gt|quot|apos);/g, '').includes(';')) {
    throw invalid('The generated dbscript contains ";".');
  }
  return { xml, severity, changes };
}
