import type { GlobalWriteState, PolicyLimits, PolicyRule } from '../api/types';

/** Comma or newline separated text to a trimmed list without blanks or duplicates. */
export function parseList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

export const listText = (items: readonly string[]) => items.join(', ');

/** Blank means "not set" (the rule leaves the limit alone); anything else must be a non-negative integer. */
export function parseLimit(text: string): number | undefined | 'invalid' {
  const t = text.trim();
  if (!t) return undefined;
  if (!/^\d+$/.test(t)) return 'invalid';
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : 'invalid';
}

export interface PolicyForm {
  name: string;
  effect: 'ALLOW' | 'DENY';
  subjectType: 'user' | 'group' | 'everyone';
  subjectId: string;
  environments: string[];
  connectionIds: string;
  actions: string[];
  entities: string;
  columns: string;
  maxReadRows: string;
  maxWriteRows: string;
  requireWhere: boolean;
  requirePreview: boolean;
  requireConfirmation: boolean;
  requireStrongConfirmation: boolean;
  requireApproval: boolean;
  /** Kept as loaded (no form control yet), so editing a rule never turns snapshots back on. */
  auditSnapshots: boolean;
  overrideWhereRequired: boolean;
  enabled: boolean;
}

export const EMPTY_POLICY: PolicyForm = {
  name: '',
  effect: 'ALLOW',
  subjectType: 'everyone',
  subjectId: '',
  environments: [],
  connectionIds: '',
  actions: [],
  entities: '',
  columns: '',
  maxReadRows: '',
  maxWriteRows: '',
  requireWhere: false,
  requirePreview: false,
  requireConfirmation: false,
  requireStrongConfirmation: false,
  requireApproval: false,
  auditSnapshots: true,
  overrideWhereRequired: false,
  enabled: true,
};

export const LIMIT_FLAGS = [
  ['requireWhere', 'Exigir WHERE'],
  ['requirePreview', 'Exigir preview'],
  ['requireConfirmation', 'Exigir confirmação'],
  ['requireStrongConfirmation', 'Exigir confirmação forte'],
  ['requireApproval', 'Exigir aprovação (dois olhos)'],
] as const;

export function formFromRule(r: PolicyRule): PolicyForm {
  return {
    name: r.name,
    effect: r.effect,
    subjectType: r.subjectType,
    subjectId: r.subjectId ?? '',
    environments: r.environments,
    connectionIds: listText(r.connectionIds),
    actions: r.actions,
    entities: listText(r.entities),
    columns: listText(r.columns),
    maxReadRows: r.limits.maxReadRows?.toString() ?? '',
    maxWriteRows: r.limits.maxWriteRows?.toString() ?? '',
    requireWhere: r.limits.requireWhere === true,
    requirePreview: r.limits.requirePreview === true,
    requireConfirmation: r.limits.requireConfirmation === true,
    requireStrongConfirmation: r.limits.requireStrongConfirmation === true,
    requireApproval: r.limits.requireApproval === true,
    auditSnapshots: r.limits.auditSnapshots !== false,
    overrideWhereRequired: r.overrideWhereRequired,
    enabled: r.enabled,
  };
}

/**
 * The request body for a rule. Only the checks the form itself needs (blank name, limit syntax,
 * missing subject) are done here; the rule's real validation stays on the server.
 */
export function policyPayload(f: PolicyForm): {
  body?: Record<string, unknown>;
  problems: string[];
} {
  const problems: string[] = [];
  if (!f.name.trim()) problems.push('Informe o nome da regra.');
  if (f.subjectType !== 'everyone' && !f.subjectId.trim())
    problems.push('Informe o identificador do usuário ou grupo.');
  if (f.actions.length === 0) problems.push('Selecione ao menos uma ação.');
  const read = parseLimit(f.maxReadRows);
  const write = parseLimit(f.maxWriteRows);
  if (read === 'invalid') problems.push('Máximo de linhas lidas deve ser um inteiro não negativo.');
  if (write === 'invalid')
    problems.push('Máximo de linhas escritas deve ser um inteiro não negativo.');
  if (problems.length > 0) return { problems };
  const limits: PolicyLimits = {};
  if (typeof read === 'number') limits.maxReadRows = read;
  if (typeof write === 'number') limits.maxWriteRows = write;
  for (const [k] of LIMIT_FLAGS) if (f[k]) limits[k] = true;
  if (!f.auditSnapshots) limits.auditSnapshots = false;
  return {
    problems,
    body: {
      name: f.name.trim(),
      effect: f.effect,
      subjectType: f.subjectType,
      subjectId: f.subjectType === 'everyone' ? null : f.subjectId.trim(),
      environments: f.environments,
      connectionIds: parseList(f.connectionIds),
      actions: f.actions,
      entities: parseList(f.entities),
      columns: parseList(f.columns),
      limits,
      overrideWhereRequired: f.overrideWhereRequired,
      enabled: f.enabled,
    },
  };
}

export interface SecurityView {
  tone: 'ok' | 'warn' | 'danger';
  /** Whether the toggle can currently make a difference. */
  canEnable: boolean;
  summary: string;
  note: string | null;
}

/** What the kill switch state means, in pt-BR. effective = env AND runtime. */
export function describeSecurity(s: GlobalWriteState): SecurityView {
  if (!s.env) {
    return {
      tone: 'danger',
      canEnable: false,
      summary: 'Gravações desligadas pelo ambiente (GLOBAL_WRITE_ENABLED=false).',
      note: s.runtime
        ? 'A chave em tempo de execução está ligada, mas não habilita nada: o ambiente do servidor mantém as gravações desligadas e só pode ser alterado na configuração do servidor.'
        : 'Mesmo ligando a chave em tempo de execução, as gravações continuam desligadas enquanto o ambiente do servidor as bloquear.',
    };
  }
  if (!s.runtime) {
    return {
      tone: 'warn',
      canEnable: true,
      summary: 'Gravações desligadas pela chave de emergência (em tempo de execução).',
      note: null,
    };
  }
  return { tone: 'ok', canEnable: true, summary: 'Gravações permitidas.', note: null };
}

export const ENVIRONMENT_OPTIONS = ['PRODUCTION', 'HOMOLOGATION', 'SANDBOX'] as const;
