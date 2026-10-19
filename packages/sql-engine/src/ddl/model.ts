/**
 * Table model for Add-on Studio DDL artifacts (audit §3.3). DB-Sankhya never
 * executes DDL: a CREATE TABLE is turned into this model, which the AutoDDL and
 * dbscript generators render as files the customer deploys through Add-on
 * Studio. Every identifier and default is untrusted: identifiers must match
 * `^[A-Z][A-Z0-9_]*$` after upper-casing, defaults are restricted to a safe
 * literal alphabet, and only custom-prefixed tables are accepted.
 */
import parserPkg from 'node-sql-parser';
import { AppError } from '@dbx/shared';
import { classifyStatement } from '../classify';

const { Parser } = parserPkg;
const parser = new Parser();

export const DDL_DATA_TYPES = [
  'TEXTO',
  'INTEIRO',
  'DECIMAL',
  'DATA',
  'DATA_HORA',
  'HORA',
  'CHECKBOX',
  'CAIXA_TEXTO',
  'ARQUIVO',
] as const;

export type DdlDataType = (typeof DDL_DATA_TYPES)[number];

export interface FieldModel {
  name: string;
  /** Free text, only ever written XML-escaped into the AutoDDL file. */
  description?: string;
  dataType: DdlDataType;
  /** Length (TEXTO) or precision (INTEIRO / DECIMAL). */
  size?: number;
  /** Decimal places (DECIMAL only). */
  scale?: number;
  required: boolean;
  /** Literal default value (unquoted). */
  default?: string;
}

export interface TableModel {
  name: string;
  description?: string;
  primaryKey: string[];
  fields: FieldModel[];
}

export interface ModelOptions {
  /** Allowed custom table prefixes (default `['AD_']`). */
  customPrefixes?: readonly string[];
}

export const DEFAULT_CUSTOM_PREFIXES: readonly string[] = ['AD_'];

const IDENTIFIER_RE = /^[A-Z][A-Z0-9_]*$/;
const MAX_IDENTIFIER = 128;
const MAX_DESCRIPTION = 255;
const MAX_SIZE = 4000;
/** Letters (incl. accents), digits, space and a few punctuation marks; never `;`, quotes or `<&`. */
const SAFE_TEXT_DEFAULT_RE = /^[\p{L}\p{N} _.,:/@#+-]*$/u;
const NUMERIC_DEFAULT_RE = /^-?\d{1,30}(\.\d{1,30})?$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const unsupported = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError('SQL_UNSUPPORTED', message, details);
const invalid = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError('VALIDATION_ERROR', message, details);

/** Upper-cases and checks an untrusted identifier; throws VALIDATION_ERROR otherwise. */
export function assertIdentifier(value: unknown, what: string): string {
  if (typeof value !== 'string') throw invalid(`The ${what} name must be a string.`);
  const upper = value.toUpperCase();
  if (upper.length > MAX_IDENTIFIER || !IDENTIFIER_RE.test(upper)) {
    throw invalid(`The ${what} name must match ^[A-Z][A-Z0-9_]*$.`, { [what]: value });
  }
  return upper;
}

/**
 * Checks that `name` is a custom table (starts with one of the prefixes and has
 * something after it). A native table name is SQL_UNSUPPORTED: native ERP tables
 * must never be altered.
 */
export function assertCustomTable(
  name: unknown,
  customPrefixes: readonly string[] = DEFAULT_CUSTOM_PREFIXES,
): string {
  const table = assertIdentifier(name, 'table');
  const ok = customPrefixes.some((p) => {
    const prefix = p.toUpperCase();
    return prefix !== '' && table.startsWith(prefix) && table.length > prefix.length;
  });
  if (!ok) {
    throw unsupported(
      `Native DDL is forbidden: ${table} does not start with an allowed custom prefix.`,
      { table, customPrefixes: [...customPrefixes] },
    );
  }
  return table;
}

function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_SIZE;
}

function checkDescription(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > MAX_DESCRIPTION || CONTROL_RE.test(value)) {
    throw invalid(`The description of ${where} must be plain text of at most 255 characters.`);
  }
  return value;
}

function checkDefault(field: FieldModel, name: string): string | undefined {
  const value: unknown = field.default;
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(`The default of ${name} must be a string.`);
  switch (field.dataType) {
    case 'INTEIRO':
      if (!/^-?\d{1,30}$/.test(value)) throw invalid(`The default of ${name} must be an integer.`);
      return value;
    case 'DECIMAL':
      if (!NUMERIC_DEFAULT_RE.test(value)) {
        throw invalid(`The default of ${name} must be a number.`);
      }
      return value;
    case 'TEXTO':
    case 'CHECKBOX': {
      if (!SAFE_TEXT_DEFAULT_RE.test(value)) {
        throw invalid(`The default of ${name} contains characters that are not allowed.`);
      }
      const max = field.dataType === 'CHECKBOX' ? 1 : (field.size ?? 0);
      if (value.length > max) throw invalid(`The default of ${name} is longer than the field.`);
      return value;
    }
    default:
      throw unsupported(`A default value is not supported for ${field.dataType} (${name}).`);
  }
}

function checkField(raw: FieldModel): FieldModel {
  if (typeof raw !== 'object' || raw === null) throw invalid('A field must be an object.');
  const name = assertIdentifier(raw.name, 'field');
  if (!(DDL_DATA_TYPES as readonly string[]).includes(raw.dataType)) {
    throw invalid(`Field ${name} has an unknown data type.`, { dataType: raw.dataType });
  }
  if (typeof raw.required !== 'boolean') throw invalid(`Field ${name}: required must be boolean.`);
  const out: FieldModel = { name, dataType: raw.dataType, required: raw.required };
  const description = checkDescription(raw.description, `field ${name}`);
  if (description !== undefined) out.description = description;

  const { size, scale } = raw;
  if (size !== undefined && !isPositiveInt(size)) {
    throw invalid(`Field ${name}: size must be a positive integer.`);
  }
  if (scale !== undefined && !(Number.isInteger(scale) && scale >= 0 && scale <= (size ?? 0))) {
    throw invalid(`Field ${name}: scale must be an integer between 0 and the size.`);
  }
  if ((raw.dataType === 'INTEIRO' || raw.dataType === 'DECIMAL') && (size ?? 0) > 38) {
    throw invalid(`Field ${name}: numeric precision is at most 38.`);
  }
  switch (raw.dataType) {
    case 'TEXTO':
      if (size === undefined) throw invalid(`Field ${name}: TEXTO requires a size.`);
      out.size = size;
      break;
    case 'INTEIRO':
      if (scale !== undefined) throw invalid(`Field ${name}: INTEIRO has no scale.`);
      if (size !== undefined) out.size = size;
      break;
    case 'DECIMAL':
      if (size !== undefined) out.size = size;
      if (scale !== undefined) out.scale = scale;
      break;
    default:
      if (size !== undefined || scale !== undefined) {
        throw invalid(`Field ${name}: ${raw.dataType} takes no size.`);
      }
  }
  const def = checkDefault({ ...raw, size: out.size }, name);
  if (def !== undefined) out.default = def;
  return out;
}

/**
 * Validates and normalizes (upper-cases) a model from any source. Throws
 * SQL_UNSUPPORTED for a native table, VALIDATION_ERROR for anything malformed.
 */
export function validateTableModel(model: TableModel, opts: ModelOptions = {}): TableModel {
  if (typeof model !== 'object' || model === null) throw invalid('The model must be an object.');
  const name = assertCustomTable(model.name, opts.customPrefixes);
  if (!Array.isArray(model.fields) || model.fields.length === 0) {
    throw invalid(`Table ${name} must have at least one field.`);
  }
  const fields = model.fields.map(checkField);
  const names = new Set<string>();
  for (const f of fields) {
    if (names.has(f.name)) throw invalid(`Field ${f.name} is defined twice.`);
    names.add(f.name);
  }
  if (!Array.isArray(model.primaryKey)) throw invalid('primaryKey must be an array.');
  const primaryKey = model.primaryKey.map((k) => assertIdentifier(k, 'primary key'));
  if (new Set(primaryKey).size !== primaryKey.length) {
    throw invalid('The primary key lists a field twice.');
  }
  for (const k of primaryKey) {
    const field = fields.find((f) => f.name === k);
    if (!field) throw invalid(`Primary key field ${k} is not a field of ${name}.`);
    if (!field.required) throw invalid(`Primary key field ${k} must be required.`);
  }
  const out: TableModel = { name, primaryKey, fields };
  const description = checkDescription(model.description, `table ${name}`);
  if (description !== undefined) out.description = description;
  return out;
}

export interface SourceType {
  dataType: string;
  length?: number | null;
  scale?: number | null;
}

/**
 * Maps a SQL column type to an AutoDDL type: VARCHAR(n) → TEXTO,
 * INT/INTEGER/NUMBER(p,0) → INTEIRO, DECIMAL/NUMERIC/NUMBER(p,s) → DECIMAL,
 * DATE → DATA, TIMESTAMP/DATETIME → DATA_HORA, TIME → HORA, CHAR(1) → CHECKBOX,
 * CLOB/TEXT → CAIXA_TEXTO, BLOB/VARBINARY → ARQUIVO. Anything else is
 * SQL_UNSUPPORTED.
 */
export function mapDataType(def: SourceType): Pick<FieldModel, 'dataType' | 'size' | 'scale'> {
  const type = String(def.dataType).toUpperCase();
  const length = def.length ?? undefined;
  const scale = def.scale ?? undefined;
  const fail = (): never => {
    const shown =
      length === undefined
        ? type
        : `${type}(${[length, scale].filter((v) => v !== undefined).join(',')})`;
    throw unsupported(`Column type ${shown} has no Add-on Studio equivalent.`, { type: shown });
  };
  switch (type) {
    case 'VARCHAR':
    case 'VARCHAR2':
    case 'NVARCHAR':
    case 'NVARCHAR2':
      if (length === undefined) return fail();
      return { dataType: 'TEXTO', size: length };
    case 'INT':
    case 'INTEGER':
      return { dataType: 'INTEIRO' };
    case 'NUMBER':
      if (length === undefined) return fail();
      if (scale === undefined || scale === 0) return { dataType: 'INTEIRO', size: length };
      return { dataType: 'DECIMAL', size: length, scale };
    case 'DECIMAL':
    case 'NUMERIC':
      if (length === undefined) return { dataType: 'DECIMAL' };
      return scale === undefined
        ? { dataType: 'DECIMAL', size: length }
        : { dataType: 'DECIMAL', size: length, scale };
    case 'DATE':
      return { dataType: 'DATA' };
    case 'TIMESTAMP':
    case 'DATETIME':
      return { dataType: 'DATA_HORA' };
    case 'TIME':
      return { dataType: 'HORA' };
    case 'CHAR':
      if (length !== 1) return fail();
      return { dataType: 'CHECKBOX' };
    case 'CLOB':
    case 'TEXT':
      return { dataType: 'CAIXA_TEXTO' };
    case 'BLOB':
    case 'VARBINARY':
      return { dataType: 'ARQUIVO' };
    default:
      return fail();
  }
}

type Node = Record<string, unknown>;

function isNode(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNil(v: unknown): boolean {
  return v === null || v === undefined;
}

/** True when an AST attribute is absent (null, undefined, '' or an empty array). */
function isEmpty(v: unknown): boolean {
  return isNil(v) || v === '' || (Array.isArray(v) && v.length === 0);
}

/** Column name from a column_ref (pg: `{expr:{value}}`; mysql / T-SQL: a plain string). */
function columnName(ref: unknown): unknown {
  if (!isNode(ref)) return undefined;
  const col = ref.column;
  if (typeof col === 'string') return col;
  if (isNode(col) && isNode(col.expr)) return col.expr.value;
  return undefined;
}

function stringLiteral(v: unknown): string | undefined {
  if (!isNode(v)) return undefined;
  if (v.type === 'single_quote_string' || v.type === 'string') {
    return typeof v.value === 'string' ? v.value : undefined;
  }
  return undefined;
}

function defaultFrom(defaultVal: unknown, field: string): string | undefined {
  if (isNil(defaultVal)) return undefined;
  const value = isNode(defaultVal) ? defaultVal.value : undefined;
  if (isNode(value)) {
    if (value.type === 'null') return undefined;
    if (
      value.type === 'number' &&
      (typeof value.value === 'number' || typeof value.value === 'string')
    ) {
      return String(value.value);
    }
    const s = stringLiteral(value);
    if (s !== undefined) return s;
  }
  throw unsupported(`The default of ${field} must be a plain number or string literal.`);
}

const COLUMN_KEYS = new Set([
  'column',
  'definition',
  'resource',
  'default_val',
  'nullable',
  'primary_key',
  'comment',
]);
const TYPE_KEYS = new Set(['dataType', 'length', 'scale', 'parentheses', 'suffix']);

function columnFrom(def: Node, pk: string[]): FieldModel {
  const name = assertIdentifier(columnName(def.column), 'field');
  for (const [k, v] of Object.entries(def)) {
    if (!COLUMN_KEYS.has(k) && !isEmpty(v)) {
      throw unsupported(
        `Column ${name}: ${k.replace(/_/g, ' ')} is not supported by Add-on Studio.`,
      );
    }
  }
  const typeDef = def.definition;
  if (!isNode(typeDef) || typeof typeDef.dataType !== 'string') {
    throw unsupported(`Column ${name} has no recognisable type.`);
  }
  for (const [k, v] of Object.entries(typeDef)) {
    if (!TYPE_KEYS.has(k) && !isEmpty(v))
      throw unsupported(`Column ${name}: unsupported type option ${k}.`);
  }
  if (!isEmpty(typeDef.suffix))
    throw unsupported(`Column ${name}: type modifiers are not supported.`);
  const length = typeof typeDef.length === 'number' ? typeDef.length : undefined;
  const scale = typeof typeDef.scale === 'number' ? typeDef.scale : undefined;
  const mapped = mapDataType({ dataType: typeDef.dataType, length, scale });

  const field: FieldModel = { name, dataType: mapped.dataType, required: false };
  if (mapped.size !== undefined) field.size = mapped.size;
  if (mapped.scale !== undefined) field.scale = mapped.scale;
  const nullable = def.nullable;
  if (isNode(nullable) && nullable.type === 'not null') field.required = true;
  if (!isEmpty(def.primary_key)) {
    pk.push(name);
    field.required = true;
  }
  const comment = isNode(def.comment) ? stringLiteral(def.comment.value) : undefined;
  if (!isNil(def.comment) && comment === undefined) {
    throw unsupported(`Column ${name}: the comment must be a string literal.`);
  }
  if (comment !== undefined) field.description = comment;
  const dflt = defaultFrom(def.default_val, name);
  if (dflt !== undefined) field.default = dflt;
  return field;
}

/**
 * Builds a TableModel from a CREATE TABLE AST (as returned by
 * `classifyStatement(sql).ast`). Only plain columns, NOT NULL, literal defaults,
 * comments and one primary key are accepted; anything AutoDDL cannot express
 * (unique, foreign keys, checks, CREATE … AS SELECT, temporary tables) is
 * SQL_UNSUPPORTED. The result is validated, including the custom prefix.
 */
export function tableFromCreate(ast: unknown, opts: ModelOptions = {}): TableModel {
  if (!isNode(ast) || ast.type !== 'create' || ast.keyword !== 'table') {
    throw unsupported('Only CREATE TABLE can be turned into an Add-on Studio artifact.');
  }
  if (!isEmpty(ast.temporary)) throw unsupported('Temporary tables are not Add-on Studio objects.');
  if (!isEmpty(ast.as) || !isEmpty(ast.query_expr)) {
    throw unsupported('CREATE TABLE … AS SELECT is not supported.');
  }
  if (!isEmpty(ast.like)) throw unsupported('CREATE TABLE … LIKE is not supported.');
  if (!isEmpty(ast.table_options)) throw unsupported('Table options are not supported.');
  const tables = Array.isArray(ast.table) ? ast.table : [];
  const ref = tables.length === 1 ? tables[0] : undefined;
  if (!isNode(ref) || !isNil(ref.db) || !isNil(ref.schema)) {
    throw unsupported('CREATE TABLE must name exactly one unqualified table.');
  }
  const name = assertCustomTable(ref.table, opts.customPrefixes);
  const defs = Array.isArray(ast.create_definitions) ? ast.create_definitions : [];

  const pk: string[] = [];
  let tablePk: string[] | undefined;
  const fields: FieldModel[] = [];
  for (const def of defs) {
    if (!isNode(def)) throw unsupported('Unrecognised table element.');
    if (def.resource === 'column') {
      fields.push(columnFrom(def, pk));
    } else if (def.resource === 'constraint' && def.constraint_type === 'primary key') {
      if (tablePk) throw unsupported('A table can only have one primary key.');
      const cols = Array.isArray(def.definition) ? def.definition : [];
      tablePk = cols.map((c) => assertIdentifier(columnName(c), 'primary key'));
    } else {
      const what =
        typeof def.constraint_type === 'string' ? def.constraint_type : String(def.resource);
      throw unsupported(`${what.toUpperCase()} is not supported by Add-on Studio AutoDDL.`);
    }
  }
  if (tablePk && pk.length > 0) throw unsupported('A table can only have one primary key.');
  if (pk.length > 1) throw unsupported('Use a table-level PRIMARY KEY (…) for composite keys.');
  const primaryKey = tablePk ?? pk;
  for (const f of fields) if (primaryKey.includes(f.name)) f.required = true;
  return validateTableModel({ name, primaryKey, fields }, opts);
}

/**
 * Parses a single CREATE TABLE and builds its model. The statement is
 * classified with the engine's classifier (PostgreSQL grammar). Types that
 * grammar lacks (BLOB, VARBINARY) are retried with the MySQL and T-SQL
 * grammars; the AST is held to the same rules either way.
 */
export function tableFromCreateSql(sql: string, opts: ModelOptions = {}): TableModel {
  const c = classifyStatement(sql);
  if (c.kind === 'CREATE_TABLE') return tableFromCreate(c.ast, opts);
  if (c.kind !== 'UNKNOWN') {
    throw unsupported('Only CREATE TABLE can be turned into an Add-on Studio artifact.');
  }
  for (const database of ['mysql', 'transactsql']) {
    let ast: unknown;
    try {
      ast = parser.parse(sql, { database }).ast;
    } catch {
      continue;
    }
    const list = Array.isArray(ast) ? ast : [ast];
    if (list.length !== 1) throw unsupported('Exactly one statement is allowed.');
    return tableFromCreate(list[0], opts);
  }
  throw new AppError('SQL_PARSE_ERROR', c.reason);
}
