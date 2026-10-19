export {
  DDL_DATA_TYPES,
  assertCustomTable,
  assertIdentifier,
  mapDataType,
  tableFromCreate,
  tableFromCreateSql,
  validateTableModel,
  type DdlDataType,
  type FieldModel,
  type ModelOptions,
  type SourceType,
  type TableModel,
} from './model';
export {
  diffTable,
  worstSeverity,
  type DdlChange,
  type DdlChangeKind,
  type DdlDiff,
  type DdlSeverity,
} from './diff';
export { escapeXml, toAutoDdlXml } from './autoddl';
export { cdata, toDbScriptXml, type DbScriptOptions, type DbScriptResult } from './dbscript';
