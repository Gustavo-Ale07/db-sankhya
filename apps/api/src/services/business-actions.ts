/**
 * Typed business actions (Task 11.3): the only gateway services, besides `DatasetSP.save`, the
 * API may call to change data. Nothing outside this registry can be called: there is no generic
 * "call any service" path.
 *
 * Each action changes one row of one entity. It runs through the same plan lifecycle as a SQL
 * write (MutationService): PolicyEngine with `entities = [entity]`, preview of the real row,
 * confirmation, re-authorization, kill switches, one non-idempotent call, read-back and audit.
 *
 * The request bodies below are written against the gateway mock only. Before an action is
 * enabled on a live connection (BUSINESS_ACTIONS_ENABLED), its request body and its expected
 * effect must be validated against the official gateway documentation of the target version.
 */
import { z } from 'zod';
import type { Permission } from '@dbx/shared';
import type { GatewayModule } from '@dbx/sankhya-client';

export type ActionValue = string | number | null;

export interface BusinessAction<I extends Record<string, unknown> = Record<string, unknown>> {
  /** The gateway service name, also the action id in the URL (`/api/actions/:id`). */
  id: string;
  module: GatewayModule;
  permission: Permission;
  /** The table (catalog name) of the one row the action changes. */
  entity: string;
  description: string;
  input: z.ZodType<I>;
  /** Primary key of the row the action changes. */
  key(input: I): Record<string, number | string>;
  /** Columns read for the preview, besides the key. */
  columns: string[];
  /** Values the row must hold after the action; read back to verify. */
  effect(input: I): Record<string, ActionValue>;
  /** Gateway request body. NOT validated against a live gateway: see the module comment. */
  requestBody(input: I): unknown;
}

const cancelarNotaInput = z
  .object({
    nunota: z.number().int().positive(),
    justificativa: z.string().min(15).max(255),
  })
  .strict();

type CancelarNotaInput = z.infer<typeof cancelarNotaInput>;

const cancelarNota: BusinessAction<CancelarNotaInput> = {
  id: 'CACSP.cancelarNota',
  module: 'mgecom',
  permission: 'SANKHYA.BUSINESS_ACTION.EXECUTE',
  entity: 'TGFCAB',
  description: 'Cancels one invoice header (nota) with a justification.',
  input: cancelarNotaInput,
  key: (i) => ({ NUNOTA: i.nunota }),
  columns: ['STATUSNOTA'],
  // The mock marks a cancelled header with STATUSNOTA = 'C'; a real gateway may differ (the row
  // may be moved elsewhere), which the read-back then reports as FAILED, never as VERIFIED.
  effect: () => ({ STATUSNOTA: 'C' }),
  requestBody: (i) => ({
    notasCanceladas: { nunota: [{ $: String(i.nunota) }], justificativa: i.justificativa },
  }),
};

const REGISTRY: ReadonlyMap<string, BusinessAction> = new Map(
  [cancelarNota as unknown as BusinessAction].map((a) => [a.id, a]),
);

/** The registered action, or undefined (an exact, case-sensitive id match). */
export function findAction(id: string): BusinessAction | undefined {
  return REGISTRY.get(id);
}

export function listActions(): BusinessAction[] {
  return [...REGISTRY.values()];
}

/** Live connections run only the actions listed in BUSINESS_ACTIONS_ENABLED; mock ones run all. */
export function actionEnabled(
  action: BusinessAction,
  mode: 'live' | 'mock',
  enabled: readonly string[],
): boolean {
  return mode !== 'live' || enabled.includes(action.id);
}

/** A word for the plan summary and the strong phrase: `CACSP.cancelarNota` → `CACSP_CANCELARNOTA`. */
export function actionWord(action: BusinessAction): string {
  return action.id.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

/** Key-order independent JSON of a validated input. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

const STATEMENT = /^ACTION ([A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*) (\{[\s\S]*\})$/;

/**
 * The statement a plan stores for an action (its `sql`, hashed into the plan): the action id and
 * the canonical JSON of the validated input. It is never sent anywhere.
 */
export function actionStatement(action: BusinessAction, input: Record<string, unknown>): string {
  return `ACTION ${action.id} ${canonicalJson(input)}`;
}

/**
 * Parses a stored action statement back, validating the input again. Undefined for anything that
 * is not exactly a statement of a registered action with a valid input (fail closed).
 */
export function parseActionStatement(
  sql: string,
): { action: BusinessAction; input: Record<string, unknown> } | undefined {
  const m = STATEMENT.exec(sql);
  if (!m) return undefined;
  const action = findAction(m[1]!);
  if (!action) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(m[2]!);
  } catch {
    return undefined;
  }
  const parsed = action.input.safeParse(raw);
  if (!parsed.success) return undefined;
  if (actionStatement(action, parsed.data) !== sql) return undefined;
  return { action, input: parsed.data };
}
